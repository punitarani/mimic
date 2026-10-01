import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  argmax,
  canonicalPredictorId,
  DEFAULT_CONFIG,
  type EvalRunRecord,
  type Gateway,
  itemAcrossPeople,
  mean,
  parsePredictorId,
  probeMetaOf,
  quantile,
  RELEVANT_K,
  STATE_VIEWS,
  type StateView,
  seededRng,
  ulid,
  viewState,
} from '@mimic/core';
import { openLocalEngine } from './local';
import { type Loaded, loadData, loadOptsOf, positive, recordRun } from './optimize/commands';
import {
  BudgetStop,
  type Candidate,
  type EvalRecord,
  evaluateCandidate,
  groupBy,
  Meter,
  metricsOf,
  pairedDelta,
  resolveCandidate,
} from './optimize/evaluate';
import type { EvalInstance } from './optimize/instances';
import { itemValue, predictedValue } from './replay';
import { renderReport } from './report';

/**
 * E6 (docs/EVIDENCE.md, ADR-0053): does the mimic learn from a person's answers, and from what form of them? Each arm
 * is a predictor shown one view of the same sealed state (`viewState`): the context alone, the state as served, the
 * answers without derived traits and insights, the derived data without the answers, or the answers most related to
 * the question. Every arm predicts the identical instances, one question per request, so arms differ only by what the
 * predictor is shown. The verdict applies EVIDENCE_RULE, fixed before the first run.
 */

/** The production primary as its rows are stored (`decision:`; the config spells it `jev:`, ADR-0054). */
export const DEFAULT_JEV = canonicalPredictorId(DEFAULT_CONFIG.predictor.primary);
export const DEFAULT_LLM = 'llm:deepseek/deepseek-v4.1-flash@predict.v2';
export const JEV_VIEWS: StateView[] = ['context', 'full', 'answers', 'derived', 'relevant'];
export const LLM_VIEWS: StateView[] = ['context', 'full', 'answers'];
export const SERVED = 'served';
export const twinKey = (k: number) => `twin@${k}`;

/**
 * Pre-registered (docs/EVIDENCE.md §5). A view replaces `full` for the primary only if, against `full`:
 * - on served questions: the log-loss change has its 90% interval (by question) below 0, at least `minPeopleShare` of
 *   people improve, and item accuracy drops by at most `maxAccuracyDrop`, on at least `minServedInstances` questions
 *   from `minServedPeople` people;
 * - on Twin-2K-500 at k = `twinK`, for the views Twin can test (`twinViews`; its people have no traits or insights,
 *   so `answers` equals `full` there and `derived` equals `context`): the log-loss interval by person is below 0 and
 *   accuracy drops by at most `maxAccuracyDrop`, on at least `minTwinPeople` people.
 * A predictor "learns" on a dataset when `full` against `context` lowers log loss with the interval below 0 (by
 * question on served questions, by person on Twin) and raises mean item accuracy. That is measured only with as much
 * data as the view checks need (`minServedInstances` from `minServedPeople` people served; `minTwinPeople` on Twin);
 * an outcome that depends on a measurement with less (a spend cap, `--llm none`, no Twin data) is `insufficient`.
 */
export const EVIDENCE_RULE = {
  twinK: 30,
  twinViews: ['relevant'] as StateView[],
  maxAccuracyDrop: 0.01,
  minPeopleShare: 2 / 3,
  minServedInstances: 200,
  minServedPeople: 5,
  minTwinPeople: 30,
} as const;

/** One question per Jev request, for every arm. */
const ONE_QUESTION = 1;
const RESAMPLES = 2000;

export interface Arm {
  dataset: string;
  predictor: string;
  view: StateView;
  label: string;
  /** Scored on the original instance IDs, so arms pair by question. */
  records: EvalRecord[];
}

export interface Interval {
  mean: number;
  ciLow: number;
  ciHigh: number;
}

export interface Delta {
  n: number;
  people: number;
  /** People whose mean change is an improvement, and a deterioration (ties count as neither). */
  better: number;
  worse: number;
  itemAcc: Interval & { byQuestion: [number, number] };
  logLoss: Interval & { byQuestion: [number, number] };
}

/**
 * b − a over the instances both arms scored. The interval resamples people (2,000 resamples, seeded, 5th–95th
 * percentile), since questions from one person are not independent; the by-question interval (the same 2,000
 * resamples) is reported beside it.
 */
export function clusteredDelta(a: EvalRecord[], b: EvalRecord[], seed: string): Delta {
  const bi = new Map(b.map((r) => [r.instanceId, r]));
  const pairs = a.filter((r) => bi.has(r.instanceId)).map((r) => ({ r, s: bi.get(r.instanceId)! }));
  const byPerson = groupBy(pairs, (p) => p.r.mimicId);
  const people = [...byPerson.values()].map((ps) => ({
    acc: ps.map((p) => p.s.itemAcc - p.r.itemAcc),
    ll: ps.map((p) => p.s.logLoss - p.r.logLoss),
  }));
  const interval = (pick: (p: (typeof people)[number]) => number[], tag: string): Interval => {
    const all = people.flatMap(pick);
    if (!all.length) return { mean: 0, ciLow: 0, ciHigh: 0 };
    const rng = seededRng(`${seed}:${tag}`);
    const samples: number[] = [];
    for (let s = 0; s < RESAMPLES; s++) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < people.length; i++) {
        const xs = pick(people[Math.floor(rng() * people.length)]!);
        for (const x of xs) sum += x;
        n += xs.length;
      }
      samples.push(n ? sum / n : 0);
    }
    return { mean: mean(all), ciLow: quantile(samples, 0.05), ciHigh: quantile(samples, 0.95) };
  };
  const recA = pairs.map((p) => p.r);
  const recB = pairs.map((p) => p.s);
  const qAcc = pairedDelta(recA, recB, 'itemAcc', `${seed}:qacc`, RESAMPLES);
  const qLl = pairedDelta(recA, recB, 'logLoss', `${seed}:qll`, RESAMPLES);
  return {
    n: pairs.length,
    people: people.length,
    better: people.filter((p) => mean(p.ll) < 0).length,
    worse: people.filter((p) => mean(p.ll) > 0).length,
    itemAcc: { ...interval((p) => p.acc, 'acc'), byQuestion: [qAcc.ciLow, qAcc.ciHigh] },
    logLoss: { ...interval((p) => p.ll, 'll'), byQuestion: [qLl.ciLow, qLl.ciHigh] },
  };
}

export interface ArmRow {
  dataset: string;
  predictor: string;
  view: StateView;
  n: number;
  people: number;
  logLoss: number;
  itemAcc: number;
  top1: number;
  ece: number;
  failed: number;
  stateTokens: number;
  costUsd: number;
  p50LatencyMs: number;
  /** Across-person item metrics (PLAN §12.3): individuation, and compression toward a stereotype. */
  acrossPeople: ReturnType<typeof itemAcrossPeople>;
}

export interface LiftRow {
  dataset: string;
  predictor: string;
  view: StateView;
  against: StateView;
  /** The view shows the predictor exactly what `against` shows, on every instance (no information to compare). */
  identical: boolean;
  delta: Delta;
}

export interface CurvePoint {
  dataset: string;
  predictor: string;
  view: StateView;
  /** Answers in the served state (a bucket's lower bound) or the Twin checkpoint k. */
  at: number;
  label: string;
  n: number;
  itemAcc: number;
  logLoss: number;
}

export interface Checks {
  /** The context arm sees exactly the stored baseline's state, and picks what it picked. */
  context: { stateMatch: number; top1Agreement: number; n: number };
  /** The full arm sees exactly the stored primary's state, and picks what it picked. */
  full: { stateMatch: number; top1Agreement: number; n: number };
  /** Full-arm rows holding the same answers as the stored primary's state: the check a scrubbed export can pass. */
  evidence?: { match: number | null; n: number };
}

export interface RuleCheck {
  view: StateView;
  dataset: string;
  name: string;
  pass: boolean;
  detail: string;
}

export type Outcome = 'ship' | 'learns' | 'model' | 'questions' | 'none' | 'insufficient';

export interface EvidenceVerdict {
  ship: StateView | null;
  outcome: Outcome;
  summary: string;
  checks: RuleCheck[];
  /** `enough`: the measurement has the data the rule needs; without it, `learns` decides nothing. */
  learns: Array<{ predictor: string; dataset: string; learns: boolean; enough: boolean; detail: string }>;
}

export interface EvidenceReport {
  jev: string;
  llm: string | null;
  datasets: Array<{ key: string; people: number; instances: number }>;
  rows: ArmRow[];
  lift: LiftRow[];
  againstFull: LiftRow[];
  curve: CurvePoint[];
  checks: Checks | null;
  verdict: EvidenceVerdict;
  costUsd: number;
  stopReason: string | null;
  offline: boolean;
}

const short = (predictor: string) => {
  const spec = parsePredictorId(predictor);
  return spec.kind === 'decision' ? 'Jev' : (spec.model.split('/')[1] ?? spec.model);
};
export const armLabel = (predictor: string, view: StateView) => `${short(predictor)} · ${view}`;

function find(arms: Arm[], dataset: string, predictor: string, view: StateView): Arm | undefined {
  return arms.find((a) => a.dataset === dataset && a.predictor === predictor && a.view === view);
}

function sameStates(a: Arm, b: Arm): boolean {
  const bi = new Map(b.records.map((r) => [r.instanceId, r.stateHash]));
  return a.records.length > 0 && a.records.every((r) => bi.get(r.instanceId) === r.stateHash);
}

function liftRows(arms: Arm[], against: StateView, only?: (a: Arm) => boolean): LiftRow[] {
  const out: LiftRow[] = [];
  for (const a of arms) {
    if (a.view === against || (only && !only(a))) continue;
    const base = find(arms, a.dataset, a.predictor, against);
    if (!base) continue;
    out.push({
      dataset: a.dataset,
      predictor: a.predictor,
      view: a.view,
      against,
      identical: sameStates(a, base),
      delta: clusteredDelta(base.records, a.records, `${a.dataset}:${a.predictor}:${a.view}-${against}`),
    });
  }
  return out;
}

const BUCKETS = [0, 10, 20, 40] as const;
const bucketOf = (n: number) => [...BUCKETS].reverse().find((b) => n >= b) ?? 0;

/** Dose–response: lift over context by answers in the served state, and by checkpoint k on Twin. */
function curve(arms: Arm[], instances: Map<string, EvalInstance>): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (const a of arms) {
    if (a.view === 'context') continue;
    const base = find(arms, a.dataset, a.predictor, 'context');
    // An arm that shows exactly what context shows (`derived` for people without derived data) has no curve.
    if (!base || sameStates(a, base)) continue;
    const bi = new Map(base.records.map((r) => [r.instanceId, r]));
    const pairs = a.records.filter((r) => bi.has(r.instanceId));
    const groups =
      a.dataset === SERVED
        ? groupBy(pairs, (r) => String(bucketOf(instances.get(r.instanceId)?.state.evidence.length ?? 0)))
        : new Map([[a.dataset.slice('twin@'.length), pairs]]);
    for (const [at, rs] of groups) {
      const lo = Number(at);
      const hi = BUCKETS[BUCKETS.indexOf(lo as (typeof BUCKETS)[number]) + 1];
      out.push({
        dataset: a.dataset,
        predictor: a.predictor,
        view: a.view,
        at: lo,
        label: a.dataset === SERVED ? (hi === undefined ? `${lo}+` : `${lo}–${hi - 1}`) : `k = ${lo}`,
        n: rs.length,
        itemAcc: mean(rs.map((r) => r.itemAcc - bi.get(r.instanceId)!.itemAcc)),
        logLoss: mean(rs.map((r) => r.logLoss - bi.get(r.instanceId)!.logLoss)),
      });
    }
  }
  return out.sort(
    (x, y) =>
      x.predictor.localeCompare(y.predictor) ||
      STATE_VIEWS.indexOf(x.view) - STATE_VIEWS.indexOf(y.view) ||
      Number(x.dataset !== SERVED) - Number(y.dataset !== SERVED) ||
      x.at - y.at,
  );
}

function armRow(a: Arm, instances: Map<string, EvalInstance>): ArmRow {
  const m = metricsOf(a.records);
  const across: Array<{ itemKey: string; predicted: number; actual: number }> = [];
  for (const r of a.records) {
    const q = instances.get(r.instanceId)?.question;
    if (!q?.itemKey) continue;
    const pv = predictedValue(q, r.dist);
    const av = itemValue(q, r.answer);
    if (pv !== null && av !== null) across.push({ itemKey: q.itemKey, predicted: pv, actual: av });
  }
  const lat = a.records.filter((r) => r.ok).map((r) => r.latencyMs);
  return {
    dataset: a.dataset,
    predictor: a.predictor,
    view: a.view,
    n: a.records.length,
    people: new Set(a.records.map((r) => r.mimicId)).size,
    logLoss: m.logLoss,
    itemAcc: m.itemAcc,
    top1: m.top1,
    ece: m.ece,
    failed: a.records.filter((r) => !r.ok).length,
    stateTokens: mean(a.records.map((r) => r.stateTokens)),
    costUsd: a.records.reduce((s, r) => s + r.costUsd, 0),
    p50LatencyMs: lat.length ? quantile(lat, 0.5) : 0,
    acrossPeople: itemAcrossPeople(across),
  };
}

/** Does the harness see and pick what production did? Context against the stored baseline, full against the primary. */
export function reproductionChecks(
  arms: Arm[],
  jev: string,
  instances: Map<string, EvalInstance>,
): Checks | null {
  const check = (view: StateView, role: 'baseline' | 'primary') => {
    const arm = find(arms, SERVED, jev, view);
    let n = 0;
    let state = 0;
    let top1 = 0;
    for (const r of arm?.records ?? []) {
      const stored = instances.get(r.instanceId)?.stored.find((p) => p.role === role && p.ok && !p.fallback);
      if (!stored || !r.ok) continue;
      n++;
      if (stored.stateHash === r.stateHash) state++;
      if (argmax(stored.dist) === argmax(r.dist)) top1++;
    }
    return { stateMatch: n ? state / n : 0, top1Agreement: n ? top1 / n : 0, n };
  };
  if (!find(arms, SERVED, jev, 'context') && !find(arms, SERVED, jev, 'full')) return null;
  // The full arm reads the instance's rebuilt state as it is, so its evidence is the instance's.
  let n = 0;
  let same = 0;
  for (const r of find(arms, SERVED, jev, 'full')?.records ?? []) {
    const inst = instances.get(r.instanceId);
    const stored = inst?.stored.find((p) => p.role === 'primary' && p.ok && !p.fallback);
    const rebuilt = inst?.state.meta.evidenceHash;
    if (!stored?.evidenceHash || !rebuilt) continue;
    n++;
    if (stored.evidenceHash === rebuilt) same++;
  }
  return {
    context: check('context', 'baseline'),
    full: check('full', 'primary'),
    evidence: { match: n ? same / n : null, n },
  };
}

const peopleN = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const pts = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
const nats = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)}`;

function learnsOn(
  lift: LiftRow[],
  predictor: string,
  dataset: string,
  rule: typeof EVIDENCE_RULE,
): EvidenceVerdict['learns'][number] | null {
  const row = lift.find((l) => l.predictor === predictor && l.dataset === dataset && l.view === 'full');
  if (!row) return null;
  const d = row.delta;
  const hi = dataset === SERVED ? d.logLoss.byQuestion[1] : d.logLoss.ciHigh;
  // A spend cap can cut an arm short; a person bootstrap over one or two people has no width at all.
  const enough =
    dataset === SERVED
      ? d.n >= rule.minServedInstances && d.people >= rule.minServedPeople
      : d.people >= rule.minTwinPeople;
  const learns = d.n > 0 && hi < 0 && d.itemAcc.mean > 0;
  return {
    predictor,
    dataset,
    learns,
    enough,
    detail: `full − context: log loss ${nats(d.logLoss.mean)} (90% CI upper ${nats(hi)}), item accuracy ${pts(d.itemAcc.mean)} points, n = ${d.n} from ${peopleN(d.people)}${enough ? '' : ' (too little data to decide)'}`,
  };
}

/** Applies EVIDENCE_RULE (see its comment and docs/EVIDENCE.md §5). */
export function decideEvidence(
  againstFull: LiftRow[],
  lift: LiftRow[],
  jev: string,
  llm: string | null,
  rule = EVIDENCE_RULE,
): EvidenceVerdict {
  const twin = twinKey(rule.twinK);
  const checks: RuleCheck[] = [];
  const passed: Array<{ view: StateView; served: number }> = [];
  const candidates = STATE_VIEWS.filter((v) => v !== 'full' && v !== 'context');
  for (const view of candidates) {
    const s = againstFull.find((l) => l.predictor === jev && l.dataset === SERVED && l.view === view);
    const viewChecks: RuleCheck[] = [];
    if (!s) {
      viewChecks.push({
        view,
        dataset: SERVED,
        name: 'ran',
        pass: false,
        detail: 'not run on served questions',
      });
    } else {
      const d = s.delta;
      const need = Math.ceil(rule.minPeopleShare * d.people);
      viewChecks.push(
        {
          view,
          dataset: SERVED,
          name: 'enough data',
          pass: d.n >= rule.minServedInstances && d.people >= rule.minServedPeople,
          detail: `${d.n} questions from ${peopleN(d.people)} (needs ${rule.minServedInstances} from ${peopleN(rule.minServedPeople)})`,
        },
        {
          view,
          dataset: SERVED,
          name: 'better log loss',
          pass: d.logLoss.byQuestion[1] < 0,
          detail: `Δ ${nats(d.logLoss.mean)} [${nats(d.logLoss.byQuestion[0])}, ${nats(d.logLoss.byQuestion[1])}] by question (the interval must be below 0)`,
        },
        {
          view,
          dataset: SERVED,
          name: 'most people better',
          pass: d.better >= need && d.people > 0,
          detail: `${d.better} of ${peopleN(d.people)} improve (needs ${need})`,
        },
        {
          view,
          dataset: SERVED,
          name: 'accuracy held',
          pass: d.itemAcc.mean >= -rule.maxAccuracyDrop,
          detail: `Δ ${pts(d.itemAcc.mean)} points of item accuracy (no worse than −${(rule.maxAccuracyDrop * 100).toFixed(1)})`,
        },
      );
    }
    if (rule.twinViews.includes(view)) {
      const t = againstFull.find((l) => l.predictor === jev && l.dataset === twin && l.view === view);
      if (!t)
        viewChecks.push({
          view,
          dataset: twin,
          name: 'ran',
          pass: false,
          detail: `not run on Twin at k = ${rule.twinK}`,
        });
      else {
        const d = t.delta;
        viewChecks.push(
          {
            view,
            dataset: twin,
            name: 'enough data',
            pass: d.people >= rule.minTwinPeople,
            detail: `${d.n} questions from ${peopleN(d.people)} (needs ${peopleN(rule.minTwinPeople)})`,
          },
          {
            view,
            dataset: twin,
            name: 'better log loss',
            pass: d.logLoss.ciHigh < 0,
            detail: `Δ ${nats(d.logLoss.mean)} [${nats(d.logLoss.ciLow)}, ${nats(d.logLoss.ciHigh)}] by person (the interval must be below 0)`,
          },
          {
            view,
            dataset: twin,
            name: 'accuracy held',
            pass: d.itemAcc.mean >= -rule.maxAccuracyDrop,
            detail: `Δ ${pts(d.itemAcc.mean)} points of item accuracy`,
          },
        );
      }
    }
    checks.push(...viewChecks);
    if (viewChecks.every((c) => c.pass)) passed.push({ view, served: s?.delta.logLoss.mean ?? 0 });
  }

  const learns = [jev, ...(llm ? [llm] : [])]
    .flatMap((p) => [learnsOn(lift, p, SERVED, rule), learnsOn(lift, p, twin, rule)])
    .filter((x): x is NonNullable<typeof x> => !!x);
  const at = (p: string | null, dataset: string) =>
    p ? learns.find((l) => l.predictor === p && l.dataset === dataset) : undefined;
  // An outcome below `learns` rules predictors out, so it needs each one measured with enough data: one that wasn't run
  // (a spend cap, `--llm none`, no Twin data) is unknown, not a predictor that doesn't learn.
  const measured = (p: string | null, dataset: string) => !!at(p, dataset)?.enough;
  const did = (p: string | null, dataset: string) => measured(p, dataset) && !!at(p, dataset)?.learns;

  const served = lift.find((l) => l.predictor === jev && l.dataset === SERVED && l.view === 'full')?.delta;
  const best = passed.sort((a, b) => a.served - b.served)[0]?.view ?? null;
  let outcome: Outcome;
  let summary: string;
  if (!served || served.n < rule.minServedInstances || served.people < rule.minServedPeople) {
    outcome = 'insufficient';
    summary = `Too little served data for a verdict (needs ${rule.minServedInstances} questions from ${rule.minServedPeople} people).`;
  } else if (best) {
    outcome = 'ship';
    summary = `Ship the \`${best}\` view: register it as a Jev prompt version, backfill it as a shadow, and promote it in a new default config if it holds on new people.`;
  } else if (did(jev, SERVED)) {
    outcome = 'learns';
    summary =
      'The primary learns from the answers as served, and no view beats the full state. Selection experiments (E3b) can start.';
  } else if (!measured(llm, SERVED)) {
    outcome = 'insufficient';
    summary = `Jev doesn't learn from Mimic's answers, and the LLM wasn't measured on enough served questions (needs ${rule.minServedInstances} from ${rule.minServedPeople} people) to tell the model from the state as the limit.`;
  } else if (did(llm, SERVED)) {
    outcome = 'model';
    summary =
      "Jev doesn't learn from Mimic's answers, and the LLM does from the same states: the model, not the state, is the limit. Next: E7, an LLM or pooled primary within the latency budget.";
  } else if (!measured(jev, twin)) {
    outcome = 'insufficient';
    summary = `Neither predictor learns from Mimic's answers, and Jev wasn't measured on Twin at k = ${rule.twinK} (needs ${rule.minTwinPeople} people) to tell the questions from the harness as the limit.`;
  } else if (did(jev, twin)) {
    outcome = 'questions';
    summary =
      "Jev learns from survey answers but not from Mimic's: the questions asked are the limit. Next: generation and selection, before E3b's between-people arms.";
  } else {
    outcome = 'none';
    summary =
      'No predictor learns from the answers it is shown. Check the harness first, then the questions.';
  }
  // Only a `ship` outcome names a view: one that passed its checks while the served data overall fell short does not.
  return { ship: outcome === 'ship' ? best : null, outcome, summary, checks, learns };
}

export function analyze(
  arms: Arm[],
  instances: Map<string, EvalInstance>,
  opts: { jev: string; llm: string | null; costUsd: number; stopReason: string | null; offline: boolean },
): EvidenceReport {
  const datasets = [...groupBy(arms, (a) => a.dataset).entries()].map(([key, as]) => ({
    key,
    people: new Set(as.flatMap((a) => a.records.map((r) => r.mimicId))).size,
    instances: Math.max(...as.map((a) => a.records.length)),
  }));
  const lift = liftRows(arms, 'context');
  const againstFull = liftRows(arms, 'full', (a) => a.predictor === opts.jev && a.view !== 'context');
  return {
    jev: opts.jev,
    llm: opts.llm,
    datasets,
    rows: arms.map((a) => armRow(a, instances)),
    lift,
    againstFull,
    curve: curve(arms, instances),
    checks: reproductionChecks(arms, opts.jev, instances),
    verdict: decideEvidence(againstFull, lift, opts.jev, opts.llm),
    costUsd: opts.costUsd,
    stopReason: opts.stopReason,
    offline: opts.offline,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f3 = (x: number | null) => (x === null ? '—' : x.toFixed(3));
const datasetTitle = (key: string) =>
  key === SERVED ? 'Mimic, served questions' : `Twin-2K-500, after k = ${key.slice('twin@'.length)} answers`;

function deltaCells(d: Delta, byPerson: boolean): string {
  const acc = byPerson
    ? `[${pts(d.itemAcc.ciLow)}, ${pts(d.itemAcc.ciHigh)}]`
    : `[${pts(d.itemAcc.byQuestion[0])}, ${pts(d.itemAcc.byQuestion[1])}]`;
  const ll = byPerson
    ? `[${nats(d.logLoss.ciLow)}, ${nats(d.logLoss.ciHigh)}]`
    : `[${nats(d.logLoss.byQuestion[0])}, ${nats(d.logLoss.byQuestion[1])}]`;
  return `${d.n} | ${pts(d.itemAcc.mean)} ${acc} | ${nats(d.logLoss.mean)} ${ll} | ${d.better} / ${d.worse} of ${d.people}`;
}

function liftTable(rows: LiftRow[], dataset: string): string[] {
  const rs = rows.filter((r) => r.dataset === dataset);
  if (!rs.length) return [];
  // Served questions come from a handful of people: their interval is by question. Twin's is by person.
  const byPerson = dataset !== SERVED;
  return [
    `| Arm | Against | n | Δ item accuracy, points [90% CI by ${byPerson ? 'person' : 'question'}] | Δ log loss [90% CI] | People better / worse (log loss) |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...rs.map(
      (r) =>
        `| ${armLabel(r.predictor, r.view)} | ${r.against} | ${r.identical ? `${r.delta.n} | identical states | — | —` : deltaCells(r.delta, byPerson)} |`,
    ),
    '',
  ];
}

export function renderEvidence(r: EvidenceReport): string[] {
  const out: string[] = [];
  if (r.offline)
    out.push('> Offline run with fake providers: this checks the machinery. None of it is a result.', '');
  out.push(
    "E6 asks whether the mimic learns from a person's answers, and from what form of them (docs/EVIDENCE.md). Every arm predicts the same sealed questions, one per request, from one view of the same state:",
    `\`context\` (intake and sourced facts only, as the baseline sees), \`full\` (as served), \`answers\` (no derived traits or insights), \`derived\` (traits and insights, no answers) and \`relevant\` (the ${RELEVANT_K} answers most related to the question).`,
    '',
    `Predictors: \`${r.jev}\`${r.llm ? ` and \`${r.llm}\`` : ''} · spend $${r.costUsd.toFixed(4)}${r.stopReason ? ` · stopped early: ${r.stopReason}` : ''}`,
    '',
    '| Dataset | People | Questions |',
    '| --- | --- | --- |',
    ...r.datasets.map((d) => `| ${datasetTitle(d.key)} | ${d.people} | ${d.instances} |`),
    '',
    `## Verdict: ${r.verdict.outcome}`,
    '',
    r.verdict.summary,
    '',
  );
  if (r.verdict.learns.length)
    out.push(
      '| Predictor | Dataset | Learns from answers | Detail |',
      '| --- | --- | --- | --- |',
      ...r.verdict.learns.map(
        (l) =>
          `| ${short(l.predictor)} | ${datasetTitle(l.dataset)} | ${l.enough ? (l.learns ? 'yes' : 'no') : 'too little data'} | ${l.detail} |`,
      ),
      '',
    );
  out.push(
    '| View | Dataset | Check | Pass | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...r.verdict.checks.map(
      (c) =>
        `| ${c.view} | ${datasetTitle(c.dataset)} | ${c.name} | ${c.pass ? 'yes' : 'no'} | ${c.detail} |`,
    ),
    '',
    'The rule is EVIDENCE_RULE in packages/eval/src/evidence.ts, fixed before the first run.',
    '',
  );
  if (r.checks)
    out.push(
      '## Reproduction checks (served questions)',
      '',
      "Whether the harness shows Jev what production showed it, and gets the same pick. States can match only on an internal `--keep-identity` export. A scrubbed export (the workflow's) replaces names and drops locations (ADR-0018), so its states never match; the answers they hold still can, and the evidence check compares them wherever the stored row carries an evidence hash. Production asked each question in a batch with other candidates; here it is asked alone, so a pick can differ.",
      '',
      '| Arm | Stored prediction | n | Same state | Same top pick |',
      '| --- | --- | --- | --- | --- |',
      `| Jev · context | baseline | ${r.checks.context.n} | ${pct(r.checks.context.stateMatch)} | ${pct(r.checks.context.top1Agreement)} |`,
      `| Jev · full | primary | ${r.checks.full.n} | ${pct(r.checks.full.stateMatch)} | ${pct(r.checks.full.top1Agreement)} |`,
      '',
      r.checks.evidence?.match != null
        ? `Same answers in the state as the stored primary's: ${pct(r.checks.evidence.match)} of ${r.checks.evidence.n} rows with an evidence hash.`
        : 'Same answers in the state: — (no stored row carries an evidence hash; rows written before it existed have none).',
      '',
    );
  for (const d of r.datasets) {
    out.push(
      `## ${datasetTitle(d.key)}`,
      '',
      '| Arm | n | People | Log loss | Item accuracy | Top-1 | ECE | Failed | State tokens | Across-person r | Dispersion | $ | p50 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...r.rows
        .filter((x) => x.dataset === d.key)
        .map(
          (x) =>
            `| ${armLabel(x.predictor, x.view)} | ${x.n} | ${x.people} | ${x.logLoss.toFixed(4)} | ${pct(x.itemAcc)} | ${pct(x.top1)} | ${x.ece.toFixed(3)} | ${x.failed} | ${Math.round(x.stateTokens)} | ${f3(x.acrossPeople.meanCorrelation)} (${x.acrossPeople.items} items) | ${f3(x.acrossPeople.meanDispersionRatio)} | $${x.costUsd.toFixed(4)} | ${Math.round(x.p50LatencyMs)} ms |`,
        ),
      '',
      '### What the answers add (each view against `context`, same predictor)',
      '',
      ...liftTable(r.lift, d.key),
    );
    if (r.againstFull.some((x) => x.dataset === d.key))
      out.push(
        '### Against the primary as served (Jev views against `full`)',
        '',
        ...liftTable(r.againstFull, d.key),
      );
  }
  if (r.curve.length)
    out.push(
      '## Dose and response',
      '',
      'Lift over `context` by how many answers the state held: buckets of served questions, and Twin checkpoints. A predictor that uses answers gains more as they accumulate.',
      '',
      '| Arm | Dataset | Answers | n | Δ item accuracy, points | Δ log loss |',
      '| --- | --- | --- | --- | --- | --- |',
      ...r.curve.map(
        (c) =>
          `| ${armLabel(c.predictor, c.view)} | ${c.dataset === SERVED ? 'served' : 'Twin'} | ${c.label} | ${c.n} | ${pts(c.itemAcc)} | ${nats(c.logLoss)} |`,
      ),
      '',
    );
  out.push(
    'Failed predictions count as uniform. Across-person r is the mean per-item correlation between predicted and actual answers across people (items answered by 5 or more), and dispersion is SD(predicted) ÷ SD(actual): the mega-study of digital twins found personal data shows up here more than in accuracy. Intervals are seeded bootstraps (2,000 resamples, 5th–95th percentile).',
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------------------------

interface Cell {
  dataset: string;
  predictor: string;
  view: StateView;
  instances: EvalInstance[];
}

const csv = (v: string) => [
  ...new Set(
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

function views(v: string | undefined, fallback: StateView[]): StateView[] {
  if (!v) return fallback;
  // Deduplicated: a repeated view would add a second arm under the same key, and twice its rows to the report.
  const out = csv(v);
  for (const x of out)
    if (!(STATE_VIEWS as readonly string[]).includes(x))
      throw new Error(`Unknown view ${x}: use ${STATE_VIEWS.join(', ')}`);
  if (!out.includes('context'))
    throw new Error('The views must include context: every lift is measured against it');
  return out as StateView[];
}

/** The first `n` people of a dataset, in load order (seeded). */
function firstPeople(instances: EvalInstance[], n: number): EvalInstance[] {
  const keep = new Set([...new Set(instances.map((i) => i.mimicId))].slice(0, n));
  return instances.filter((i) => keep.has(i.mimicId));
}

/**
 * Cells in priority order, so a spend cap cuts the least important first: the primary on served questions, the primary
 * on Twin at the decision's k, the LLM on served questions, the LLM on Twin, then the rest of Twin's curve.
 */
export function planCells(
  served: EvalInstance[],
  twin: Map<number, EvalInstance[]>,
  o: {
    jev: string;
    llm: string | null;
    jevViews: StateView[];
    llmViews: StateView[];
    llmPeople: number;
    llmK: number[];
  },
): Cell[] {
  const cells: Cell[] = [];
  const add = (dataset: string, predictor: string, vs: StateView[], instances: EvalInstance[]) => {
    if (instances.length) for (const view of vs) cells.push({ dataset, predictor, view, instances });
  };
  const k0 = twin.has(EVIDENCE_RULE.twinK) ? EVIDENCE_RULE.twinK : [...twin.keys()][0];
  add(SERVED, o.jev, o.jevViews, served);
  if (k0 !== undefined) add(twinKey(k0), o.jev, o.jevViews, twin.get(k0)!);
  if (o.llm) {
    add(SERVED, o.llm, o.llmViews, served);
    for (const k of o.llmK)
      if (twin.has(k)) add(twinKey(k), o.llm, o.llmViews, firstPeople(twin.get(k)!, o.llmPeople));
  }
  for (const [k, instances] of twin) if (k !== k0) add(twinKey(k), o.jev, o.jevViews, instances);
  return cells;
}

async function runCell(
  cell: Cell,
  c: Candidate,
  opts: { gateway: Gateway; meter: Meter; cache: Map<string, EvalRecord>; concurrency: number },
): Promise<{ records: EvalRecord[]; stop: BudgetStop | null }> {
  const viewed = cell.instances.map((inst) => {
    const state = viewState(inst.state, cell.view, inst.question);
    // The view's hash is in the ID, so arms that show the same state (e.g. `answers` and `full` for a person with no
    // traits or insights) share one cached prediction instead of paying twice.
    return { inst, v: { ...inst, id: `${inst.id}~${state.meta.stateHash.slice(0, 16)}`, state } };
  });
  const key = (id: string) => `${c.hash}|${id}`;
  // A prediction an earlier arm paid for (the same state) costs this arm nothing, so the arms' $ add up to the spend.
  const reused = new Set(viewed.filter((x) => opts.cache.has(key(x.v.id))).map((x) => x.v.id));
  const back = (r: EvalRecord, id: string): EvalRecord =>
    reused.has(r.instanceId) ? { ...r, instanceId: id, costUsd: 0 } : { ...r, instanceId: id };
  try {
    const recs = await evaluateCandidate(
      c,
      viewed.map((x) => x.v),
      {
        gateway: opts.gateway,
        meter: opts.meter,
        concurrency: opts.concurrency,
        cache: opts.cache,
        purpose: 'eval.evidence',
        maxQuestionsPerRequest: ONE_QUESTION,
      },
    );
    const orig = new Map(viewed.map((x) => [x.v.id, x.inst.id]));
    return { records: recs.map((r) => back(r, orig.get(r.instanceId)!)), stop: null };
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    const records = viewed
      .map((x) => {
        const hit = opts.cache.get(key(x.v.id));
        return hit ? back(hit, x.inst.id) : null;
      })
      .filter((r): r is EvalRecord => !!r);
    return { records, stop: e };
  }
}

export async function evidenceCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      split: { type: 'string', default: 'all' },
      k: { type: 'string', default: '10,30,100' },
      limit: { type: 'string' },
      'max-targets': { type: 'string', default: '20' },
      jev: { type: 'string', default: DEFAULT_JEV },
      llm: { type: 'string', default: DEFAULT_LLM },
      views: { type: 'string' },
      'llm-views': { type: 'string' },
      'llm-people': { type: 'string', default: '40' },
      'llm-k': { type: 'string', default: String(EVIDENCE_RULE.twinK) },
      'max-usd': { type: 'string', default: '4' },
      /** Served questions that are E7 probes only (ADR-0062), so the views are compared on the probe yardstick. */
      'probes-only': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '8' },
      seed: { type: 'string', default: 'evidence' },
      name: { type: 'string' },
      out: { type: 'string' },
      summary: { type: 'string' },
      publish: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required');
  // Checked before anything is spent, not after the run when the report is published.
  if (values.publish && !['local', 'preview', 'prod'].includes(values.publish))
    throw new Error('--publish must be local, preview or prod');
  const ks = csv(values.k)
    .map((x) => positive('k', x))
    .sort((a, b) => a - b);
  const llm = values.llm === 'none' ? null : values.llm;
  if (parsePredictorId(values.jev).kind !== 'decision')
    throw new Error(`--jev must be a decision predictor: ${values.jev}`);
  if (llm && parsePredictorId(llm).kind !== 'llm')
    throw new Error(`--llm must be an LLM predictor or none: ${llm}`);
  const o = {
    // Named canonically, so the arms, the verdict and the stored spec agree whichever spelling was given (ADR-0054).
    jev: canonicalPredictorId(values.jev),
    llm,
    jevViews: views(values.views, JEV_VIEWS),
    llmViews: views(values['llm-views'], LLM_VIEWS),
    llmPeople: positive('llm-people', values['llm-people']),
    llmK: csv(values['llm-k']).map((x) => positive('llm-k', x)),
  };

  // Served instances don't depend on k; Twin people are loaded once per checkpoint.
  let first: Loaded | null = null;
  let served: EvalInstance[] = [];
  const twin = new Map<number, EvalInstance[]>();
  for (const k of ks) {
    const loaded = await loadData(values.data, loadOptsOf({ ...values, k: String(k), seed: values.seed }));
    if (!first) {
      first = loaded;
      served = loaded.instances.filter(
        (i) => i.mode === 'online' && (!values['probes-only'] || probeMetaOf(i.question) !== null),
      );
    }
    const held = loaded.instances.filter((i) => i.mode === 'heldout');
    if (held.length) twin.set(k, held);
  }
  if (!first) throw new Error('no data loaded');
  const instances = new Map<string, EvalInstance>([
    ...served.map((i) => [i.id, i] as const),
    ...[...twin.values()].flat().map((i) => [i.id, i] as const),
  ]);
  const cells = planCells(served, twin, o);
  if (!cells.length) throw new Error('No consented, answered questions in --data: nothing to predict');
  console.log(
    `E6 plan: ${cells.length} cells over ${served.length} served questions and Twin at k = ${[...twin.keys()].join(', ') || 'none'}`,
  );
  for (const c of cells)
    console.log(`  ${c.dataset}: ${armLabel(c.predictor, c.view)} × ${c.instances.length}`);

  const runDir = resolve(values.out ?? `data/evidence/${ulid()}`);
  const engine = await openLocalEngine({
    db: join(runDir, 'calls.sqlite'),
    blobsDir: join(runDir, 'traces'),
    providers: values.offline ? 'offline' : 'live',
  });
  const meter = new Meter(positive('max-usd', values['max-usd'], false));
  const concurrency = positive('concurrency', values.concurrency);
  const arms: Arm[] = [];
  const caches = new Map<string, Map<string, EvalRecord>>();
  let stopReason: string | null = null;
  try {
    for (const cell of cells) {
      const c = resolveCandidate({ predictor: cell.predictor, label: cell.predictor });
      const cache = caches.get(cell.predictor) ?? new Map<string, EvalRecord>();
      caches.set(cell.predictor, cache);
      const { records, stop } = await runCell(cell, c, {
        gateway: engine.deps.gateway,
        meter,
        cache,
        concurrency,
      });
      if (records.length)
        arms.push({
          dataset: cell.dataset,
          predictor: cell.predictor,
          view: cell.view,
          label: armLabel(cell.predictor, cell.view),
          records,
        });
      console.log(
        `${cell.dataset} ${armLabel(cell.predictor, cell.view)}: ${records.length} scored, log loss ${metricsOf(records).logLoss.toFixed(4)} ($${meter.usd.toFixed(4)} so far)`,
      );
      if (stop) {
        stopReason = `${stop.message}; ${armLabel(cell.predictor, cell.view)} on ${cell.dataset} scored ${records.length} of ${cell.instances.length}, later cells not run`;
        console.warn(`stopped: ${stopReason}`);
        break;
      }
    }
  } finally {
    engine.close();
  }

  const report = analyze(arms, instances, {
    jev: o.jev,
    llm: o.llm,
    costUsd: meter.usd,
    stopReason,
    offline: values.offline,
  });
  const run: EvalRunRecord = {
    id: ulid(),
    name: values.name ?? 'E6: what the mimic learns from',
    spec: {
      kind: 'evidence',
      split: values.split,
      k: ks,
      maxTargets: values['max-targets'],
      jev: o.jev,
      llm: o.llm,
      views: o.jevViews,
      llmViews: o.llmViews,
      llmPeople: o.llmPeople,
      llmK: o.llmK,
      limit: values.limit ?? null,
      probesOnly: values['probes-only'],
      maxUsd: values['max-usd'],
      seed: values.seed,
      stopReason,
    },
    datasetHash: first.datasetHash,
    status: 'done',
    // The provider snapshots behind the verdict (PLAN §12.3), as replay and benchmark record them.
    metrics: {
      report,
      modelSnapshots: [
        ...new Set(arms.flatMap((a) => a.records.filter((r) => r.ok).map((r) => r.modelSnapshot))),
      ].sort(),
    },
    r2ReportKey: null,
    createdAt: Date.now(),
  };
  const md = await recordRun(run, first, { publish: values.publish, summary: values.summary });
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${md}; calls and traces in ${runDir} (local only)`);
}

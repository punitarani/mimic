import { seededRng } from '@mimic/core';
import {
  type EvalRecord,
  looTemperatures,
  metricsOf,
  type PersonDelta,
  pairedByPerson,
  rescaled,
} from '../optimize/evaluate';

/**
 * E9's analysis (docs/CURVES.md §5): every (policy, k) cell calibrated on its own, with a temperature fitted leaving
 * each person out; learning curves; the area under each policy's log-loss curve (AULC); paired differences by person;
 * the rule; questions saved at equal accuracy; fidelity against the people's own test–retest consistency.
 */

/**
 * Fixed before any E9 run (docs/CURVES.md §6). A policy beats the reference if, on at least `minPeople` people, its
 * AULC interval by person (90%) lies below the reference's and its accuracy after the last checkpoint is no more than
 * `maxAccuracyDrop` below it.
 */
export const CURVES_RULE = {
  reference: 'random',
  aulcKs: [3, 6, 10, 15, 20, 25, 30],
  minPeople: 30,
  maxAccuracyDrop: 0.01,
} as const;

export interface CurveRecord {
  policy: string;
  k: number;
  /** The target's survey block (`Product Preferences - Pricing`, …). */
  block: string;
  rec: EvalRecord;
}

export interface CurvePoint {
  policy: string;
  k: number;
  n: number;
  people: number;
  logLoss: number;
  itemAcc: number;
  top1: number;
  ece: number;
  /** Temperature fitted on everyone in the cell (each person was scored at their leave-one-out fit). */
  t: number;
  /** Mean accuracy ÷ the same people's mean test–retest agreement on these targets. */
  fidelity: number | null;
}

export interface PolicySummary {
  policy: string;
  people: number;
  aulcLogLoss: number;
  aulcItemAcc: number;
  /** Log loss and accuracy at the first checkpoint after 0 and at the last. */
  first: { k: number; logLoss: number; itemAcc: number };
  last: { k: number; logLoss: number; itemAcc: number };
  /** Questions this policy needed to reach `order`'s accuracy at the last checkpoint (null: never within the curve). */
  questionsToOrderAcc: { mean: number | null; ciLow: number | null; ciHigh: number | null };
  costUsd: { selection: number; scoring: number };
  requests: number;
}

export interface PolicyDelta {
  policy: string;
  against: string;
  aulcLogLoss: PersonDelta;
  aulcItemAcc: PersonDelta;
  lastItemAcc: PersonDelta;
  lastLogLoss: PersonDelta;
}

export type CurvesOutcome = 'better' | 'level' | 'worse' | 'insufficient';

export interface CurvesVerdict {
  policy: string;
  outcome: CurvesOutcome;
  reason: string;
}

export interface BlockRow {
  policy: string;
  group: string;
  n: number;
  logLoss: number;
  itemAcc: number;
}

/**
 * A stopping rule (H8, docs/RESEARCH.md §1.6): stop before the next question once the policy's own score for it
 * falls below τ (never before 3 answers). Compared with a fixed length asking the same mean number of questions.
 */
export interface StopRow {
  policy: string;
  tau: number;
  meanQuestions: number;
  /** Mean over people of their accuracy where they stopped (interpolated between checkpoints). */
  accAtStop: number;
  /** The policy's mean accuracy at a fixed length equal to `meanQuestions`. */
  accFixed: number;
}

export interface TrajectoryRow {
  policy: string;
  /** Share of the first 10 and of all asked items per pool block. */
  firstTen: Record<string, number>;
  all: Record<string, number>;
  /** The items most often asked first, with how many people got them first. */
  openers: Array<{ key: string; prompt: string; count: number }>;
}

export interface CurvesReport {
  role: string;
  policies: string[];
  checkpoints: number[];
  rule: typeof CURVES_RULE;
  people: number;
  points: CurvePoint[];
  summaries: PolicySummary[];
  deltas: PolicyDelta[];
  verdicts: CurvesVerdict[];
  blocks: BlockRow[];
  trajectories: TrajectoryRow[];
  stopping: StopRow[];
  /** The population reader (no Jev): what each policy's answers say about the targets. */
  reader: Array<{
    policy: string;
    aulcLogLoss: number;
    aulcItemAcc: number;
    points: Array<{ k: number; logLoss: number; itemAcc: number }>;
  }>;
  consistency: number | null;
  audit: Record<string, unknown>;
  costUsd: number;
  cache: { hits: number; misses: number; savedUsd: number };
  stopReason: string | null;
  knobs: Record<string, unknown>;
  offline: boolean;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Target blocks grouped as the report reads them. */
export const targetGroup = (block: string) =>
  block.startsWith('Product Preferences') ? 'pricing' : 'heuristics and biases';

/** Each (policy, k) cell rescored at its leave-one-person-out temperature. */
export function calibrateCells(records: CurveRecord[]): { records: CurveRecord[]; t: Map<string, number> } {
  const cells = new Map<string, CurveRecord[]>();
  for (const r of records) {
    const key = `${r.policy}|${r.k}`;
    const xs = cells.get(key) ?? [];
    xs.push(r);
    cells.set(key, xs);
  }
  const out: CurveRecord[] = [];
  const t = new Map<string, number>();
  for (const [key, xs] of cells) {
    const fit = looTemperatures(xs.map((x) => x.rec));
    t.set(key, fit.all);
    for (const x of xs) out.push({ ...x, rec: rescaled(x.rec, fit.byPerson.get(x.rec.mimicId) ?? 1) });
  }
  return { records: out, t };
}

/** One record per person and target: the mean over `ks` of its calibrated log loss and accuracy (the AULC unit). */
export function aulcRecords(records: CurveRecord[], policy: string, ks: readonly number[]): EvalRecord[] {
  const want = new Set(ks);
  const by = new Map<string, EvalRecord[]>();
  for (const r of records) {
    if (r.policy !== policy || !want.has(r.k)) continue;
    const id = `${r.rec.mimicId}|${r.rec.instanceId.split('|').slice(2).join('|')}`;
    const xs = by.get(id) ?? [];
    xs.push(r.rec);
    by.set(id, xs);
  }
  return [...by.entries()]
    .filter(([, xs]) => xs.length === want.size)
    .map(([id, xs]) => ({
      ...xs[0]!,
      instanceId: id,
      logLoss: mean(xs.map((x) => x.logLoss)),
      itemAcc: mean(xs.map((x) => x.itemAcc)),
    }));
}

const atK = (records: CurveRecord[], policy: string, k: number) =>
  records
    .filter((r) => r.policy === policy && r.k === k)
    .map((r) => ({
      ...r.rec,
      instanceId: `${r.rec.instanceId.split('|').slice(2).join('|')}|${r.rec.mimicId}`,
    }));

/** Per person, per k: mean accuracy over their targets (for the questions-saved bootstrap). */
function personCurves(records: CurveRecord[], policy: string): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number[]>>();
  for (const r of records) {
    if (r.policy !== policy) continue;
    const m = out.get(r.rec.mimicId) ?? new Map<number, number[]>();
    const xs = m.get(r.k) ?? [];
    xs.push(r.rec.itemAcc);
    m.set(r.k, xs);
    out.set(r.rec.mimicId, m);
  }
  return new Map([...out].map(([p, m]) => [p, new Map([...m].map(([k, xs]) => [k, mean(xs)]))]));
}

/** A curve's value at k, linear between its points and flat beyond them. */
export function interpolate(curve: Array<[number, number]>, k: number): number {
  if (!curve.length) return Number.NaN;
  if (k <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [k1, y1] = curve[i]!;
    if (k <= k1) {
      const [k0, y0] = curve[i - 1]!;
      return y0 + ((k - k0) / (k1 - k0)) * (y1 - y0);
    }
  }
  return curve[curve.length - 1]![1];
}

const MIN_STOP = 3;

export function stoppingRows(
  records: CurveRecord[],
  scores: Map<string, Array<number | null>>,
  policy: string,
  checkpoints: number[],
): StopRow[] {
  const curves = personCurves(records, policy);
  const people = [...curves.keys()].filter((p) => scores.get(p)?.some((x) => x !== null));
  if (!people.length) return [];
  const observed = people
    .flatMap((p) => scores.get(p)!.slice(MIN_STOP))
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  if (!observed.length) return [];
  const steps = Math.max(...checkpoints);
  const curveOf = (p: string): Array<[number, number]> =>
    checkpoints.filter((k) => curves.get(p)!.has(k)).map((k) => [k, curves.get(p)!.get(k)!]);
  const meanCurve: Array<[number, number]> = checkpoints.map((k) => [
    k,
    mean(people.map((p) => curves.get(p)!.get(k)).filter((x): x is number => x !== undefined)),
  ]);
  const taus = [
    ...new Set([0.1, 0.25, 0.5, 0.75, 0.9].map((q) => observed[Math.floor(q * (observed.length - 1))]!)),
  ];
  return taus.map((tau) => {
    const stops = people.map((p) => {
      const s = scores.get(p)!;
      let k = Math.min(steps, s.length);
      for (let t = MIN_STOP; t < Math.min(steps, s.length); t++) {
        const x = s[t];
        if (x !== null && x !== undefined && x < tau) {
          k = t;
          break;
        }
      }
      return { k, acc: interpolate(curveOf(p), k) };
    });
    const meanQuestions = mean(stops.map((x) => x.k));
    return {
      policy,
      tau,
      meanQuestions,
      accAtStop: mean(stops.map((x) => x.acc)),
      accFixed: interpolate(meanCurve, meanQuestions),
    };
  });
}

/** The first k (linear between checkpoints) at which a curve reaches `target`; null if it never does. */
export function firstReach(curve: Array<[number, number]>, target: number): number | null {
  for (let i = 0; i < curve.length; i++) {
    const [k, y] = curve[i]!;
    if (y >= target) {
      if (i === 0) return k;
      const [k0, y0] = curve[i - 1]!;
      return y === y0 ? k : k0 + ((target - y0) / (y - y0)) * (k - k0);
    }
  }
  return null;
}

function questionsToReach(
  records: CurveRecord[],
  policy: string,
  reference: string,
  checkpoints: number[],
  seed: string,
  resamples = 1000,
): PolicySummary['questionsToOrderAcc'] {
  const last = checkpoints[checkpoints.length - 1]!;
  const mine = personCurves(records, policy);
  const ref = personCurves(records, reference);
  const people = [...mine.keys()].filter((p) => ref.has(p));
  if (!people.length) return { mean: null, ciLow: null, ciHigh: null };
  const curveOf = (curves: Map<string, Map<number, number>>, ps: string[]): Array<[number, number]> =>
    checkpoints.map((k) => [k, mean(ps.map((p) => curves.get(p)?.get(k) ?? 0))]);
  const once = (ps: string[]) => {
    const target = curveOf(ref, ps).find(([k]) => k === last)![1];
    return firstReach(curveOf(mine, ps), target - 1e-12);
  };
  const point = once(people);
  const rng = seededRng(`${seed}:reach:${policy}`);
  const samples: number[] = [];
  let never = 0;
  for (let s = 0; s < resamples; s++) {
    const ps = people.map(() => people[Math.floor(rng() * people.length)]!);
    const x = once(ps);
    if (x === null) never++;
    else samples.push(x);
  }
  samples.sort((a, b) => a - b);
  // A resample that never reaches the target counts as past the last checkpoint.
  const q = (p: number) => {
    const i = Math.floor(p * resamples);
    return i < samples.length ? samples[i]! : null;
  };
  return { mean: point, ciLow: q(0.05), ciHigh: never > 0.05 * resamples ? null : q(0.95) };
}

export interface AnalyzeInput {
  role: string;
  records: CurveRecord[];
  /** The population reader's predictions from the same asked answers (no Jev), when there are train people. */
  reader?: CurveRecord[];
  policies: string[];
  checkpoints: number[];
  /** Person (mimic ID) → their mean test–retest agreement on the scored targets. */
  consistency: Map<string, number>;
  costs: Record<string, { selection: number; scoring: number; requests: number }>;
  trajectories: Map<string, Map<string, Array<{ key: string; block: string; prompt: string }>>>;
  /** Policy → person (mimic ID) → each step's selection score. */
  scores?: Map<string, Map<string, Array<number | null>>>;
  audit: Record<string, unknown>;
  costUsd: number;
  cache: { hits: number; misses: number; savedUsd: number };
  stopReason: string | null;
  knobs: Record<string, unknown>;
  offline: boolean;
  seed: string;
}

export function analyzeCurves(input: AnalyzeInput, rule = CURVES_RULE): CurvesReport {
  const { records: cal, t } = calibrateCells(input.records);
  const ks = input.checkpoints;
  const last = ks[ks.length - 1]!;
  const firstK = ks.find((k) => k > 0) ?? last;
  const aulcKs = rule.aulcKs.filter((k) => ks.includes(k));
  const people = new Set(cal.map((r) => r.rec.mimicId));

  const points: CurvePoint[] = [];
  for (const policy of input.policies)
    for (const k of ks) {
      const rs = cal.filter((r) => r.policy === policy && r.k === k).map((r) => r.rec);
      if (!rs.length) continue;
      const m = metricsOf(rs);
      const who = [...new Set(rs.map((r) => r.mimicId))];
      const cons = who.map((p) => input.consistency.get(p)).filter((x): x is number => x !== undefined);
      points.push({
        policy,
        k,
        n: rs.length,
        people: who.length,
        logLoss: m.logLoss,
        itemAcc: m.itemAcc,
        top1: m.top1,
        ece: m.ece,
        t: t.get(`${policy}|${k}`) ?? 1,
        fidelity: cons.length ? m.itemAcc / mean(cons) : null,
      });
    }

  const point = (policy: string, k: number) => points.find((p) => p.policy === policy && p.k === k);
  const summaries: PolicySummary[] = input.policies.map((policy) => {
    const aulc = aulcRecords(cal, policy, aulcKs);
    const f = point(policy, firstK);
    const l = point(policy, last);
    return {
      policy,
      people: new Set(aulc.map((r) => r.mimicId)).size,
      aulcLogLoss: mean(aulc.map((r) => r.logLoss)),
      aulcItemAcc: mean(aulc.map((r) => r.itemAcc)),
      first: { k: firstK, logLoss: f?.logLoss ?? Number.NaN, itemAcc: f?.itemAcc ?? Number.NaN },
      last: { k: last, logLoss: l?.logLoss ?? Number.NaN, itemAcc: l?.itemAcc ?? Number.NaN },
      questionsToOrderAcc: input.policies.includes('order')
        ? questionsToReach(cal, policy, 'order', ks, input.seed)
        : { mean: null, ciLow: null, ciHigh: null },
      costUsd: {
        selection: input.costs[policy]?.selection ?? 0,
        scoring: input.costs[policy]?.scoring ?? 0,
      },
      requests: input.costs[policy]?.requests ?? 0,
    };
  });

  const deltas: PolicyDelta[] = [];
  for (const against of [rule.reference, 'order'])
    for (const policy of input.policies) {
      if (policy === against || !input.policies.includes(against)) continue;
      const seed = `curves:${input.seed}:${against}:${policy}`;
      const a = aulcRecords(cal, against, aulcKs);
      const b = aulcRecords(cal, policy, aulcKs);
      deltas.push({
        policy,
        against,
        aulcLogLoss: pairedByPerson(a, b, 'logLoss', `${seed}:ll`),
        aulcItemAcc: pairedByPerson(a, b, 'itemAcc', `${seed}:acc`),
        lastItemAcc: pairedByPerson(
          atK(cal, against, last),
          atK(cal, policy, last),
          'itemAcc',
          `${seed}:lacc`,
        ),
        lastLogLoss: pairedByPerson(
          atK(cal, against, last),
          atK(cal, policy, last),
          'logLoss',
          `${seed}:lll`,
        ),
      });
    }

  const verdicts: CurvesVerdict[] = input.policies
    .filter((p) => p !== rule.reference)
    .map((policy) => {
      const d = deltas.find((x) => x.policy === policy && x.against === rule.reference);
      if (!d) return { policy, outcome: 'insufficient', reason: `no ${rule.reference} arm to compare with` };
      if (d.aulcLogLoss.people < rule.minPeople)
        return {
          policy,
          outcome: 'insufficient',
          reason: `${d.aulcLogLoss.people} people (needs ${rule.minPeople})`,
        };
      const ll = d.aulcLogLoss;
      const accDrop = d.lastItemAcc.mean;
      if (ll.ciHigh < 0 && accDrop >= -rule.maxAccuracyDrop)
        return {
          policy,
          outcome: 'better',
          reason: `AULC Δ ${ll.mean.toFixed(4)} [${ll.ciLow.toFixed(4)}, ${ll.ciHigh.toFixed(4)}]; accuracy at ${last} ${(accDrop * 100).toFixed(1)} points`,
        };
      if (ll.ciLow > 0)
        return {
          policy,
          outcome: 'worse',
          reason: `AULC Δ ${ll.mean.toFixed(4)} [${ll.ciLow.toFixed(4)}, ${ll.ciHigh.toFixed(4)}]`,
        };
      return {
        policy,
        outcome: 'level',
        reason: `AULC Δ ${ll.mean.toFixed(4)} [${ll.ciLow.toFixed(4)}, ${ll.ciHigh.toFixed(4)}]${ll.ciHigh < 0 ? `; accuracy at ${last} ${(accDrop * 100).toFixed(1)} points` : ''}`,
      };
    });

  const blocks: BlockRow[] = [];
  for (const policy of input.policies)
    for (const group of ['pricing', 'heuristics and biases']) {
      const rs = cal.filter((r) => r.policy === policy && r.k === last && targetGroup(r.block) === group);
      if (!rs.length) continue;
      const m = metricsOf(rs.map((r) => r.rec));
      blocks.push({ policy, group, n: rs.length, logLoss: m.logLoss, itemAcc: m.itemAcc });
    }

  const trajectories: TrajectoryRow[] = input.policies.map((policy) => {
    const per = [...(input.trajectories.get(policy)?.values() ?? [])];
    const share = (xs: Array<{ block: string }>) => {
      const counts: Record<string, number> = {};
      for (const x of xs) counts[x.block] = (counts[x.block] ?? 0) + 1;
      return Object.fromEntries(Object.entries(counts).map(([b, c]) => [b, c / Math.max(1, xs.length)]));
    };
    const openers = new Map<string, { key: string; prompt: string; count: number }>();
    for (const tr of per) {
      const o = tr[0];
      if (!o) continue;
      const cur = openers.get(o.key) ?? { key: o.key, prompt: o.prompt, count: 0 };
      cur.count++;
      openers.set(o.key, cur);
    }
    return {
      policy,
      firstTen: share(per.flatMap((tr) => tr.slice(0, 10))),
      all: share(per.flat()),
      openers: [...openers.values()].sort((a, b) => b.count - a.count).slice(0, 3),
    };
  });

  const stopping = input.policies.flatMap((policy) => {
    const s = input.scores?.get(policy);
    return s ? stoppingRows(cal, s, policy, ks) : [];
  });
  const readerCal = input.reader?.length ? calibrateCells(input.reader).records : [];
  const reader = readerCal.length
    ? input.policies.map((policy) => {
        const a = aulcRecords(readerCal, policy, aulcKs);
        return {
          policy,
          aulcLogLoss: mean(a.map((r) => r.logLoss)),
          aulcItemAcc: mean(a.map((r) => r.itemAcc)),
          points: ks.map((k) => {
            const m = metricsOf(readerCal.filter((r) => r.policy === policy && r.k === k).map((r) => r.rec));
            return { k, logLoss: m.logLoss, itemAcc: m.itemAcc };
          }),
        };
      })
    : [];
  const cons = [...input.consistency.entries()].filter(([p]) => people.has(p)).map(([, c]) => c);
  return {
    role: input.role,
    policies: input.policies,
    checkpoints: ks,
    rule,
    people: people.size,
    points,
    summaries,
    deltas,
    verdicts,
    blocks,
    trajectories,
    stopping,
    reader,
    consistency: cons.length ? mean(cons) : null,
    audit: input.audit,
    costUsd: input.costUsd,
    cache: input.cache,
    stopReason: input.stopReason,
    knobs: input.knobs,
    offline: input.offline,
  };
}

const f4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : '—');
const pct = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);
const sgn = (x: number, d = 4) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const iv = (d: PersonDelta, f: (x: number) => string) => `${f(d.mean)} [${f(d.ciLow)}, ${f(d.ciHigh)}]`;

export function renderCurves(r: CurvesReport): string[] {
  const out: string[] = [];
  const last = r.checkpoints[r.checkpoints.length - 1]!;
  out.push(
    `E9 asks which question to ask next. Each policy asks a Twin-2K-500 person up to ${last} of their own recorded wave 1–3 answers, one at a time; after ${r.checkpoints.join(', ')} answers Jev predicts their wave 4 targets (T) from a sealed state holding exactly the answers asked. Every (policy, k) cell gets its own temperature, fitted leaving each person out. AULC is mean log loss over k = ${r.rule.aulcKs.filter((k) => r.checkpoints.includes(k)).join(', ')}.`,
    '',
    `People: ${r.people} (${r.role}). Twin answers rank policies for Jev on Twin's questions; they never stand in for a Mimic user (docs/RESEARCH.md §8).${r.offline ? ' **Offline fakes: not a result.**' : ''}`,
    '',
  );
  if (r.stopReason) out.push(`**Stopped:** ${r.stopReason}`, '');
  out.push(
    `## Verdict against \`${r.rule.reference}\``,
    '',
    '| Policy | Outcome | Detail |',
    '| --- | --- | --- |',
  );
  for (const v of r.verdicts) out.push(`| ${v.policy} | ${v.outcome} | ${v.reason} |`);
  out.push(
    '',
    `The rule is CURVES_RULE in packages/eval/src/curves/analyze.ts, fixed before the first run (docs/CURVES.md §6): the AULC interval by person (90%) below 0, accuracy at the last checkpoint at most ${r.rule.maxAccuracyDrop * 100} point below, at least ${r.rule.minPeople} people.`,
    '',
    '## Policies',
    '',
    `| Policy | AULC log loss | AULC accuracy | Log loss at ${r.summaries[0]?.first.k ?? ''} / ${last} | Accuracy at ${r.summaries[0]?.first.k ?? ''} / ${last} | Questions to \`order\`'s accuracy at ${last} | $ selection / scoring |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const s of [...r.summaries].sort((a, b) => a.aulcLogLoss - b.aulcLogLoss)) {
    const q = s.questionsToOrderAcc;
    const qs =
      q.mean === null
        ? 'not within the curve'
        : `${q.mean.toFixed(1)}${q.ciLow !== null ? ` [${q.ciLow.toFixed(1)}, ${q.ciHigh === null ? `>${last}` : q.ciHigh.toFixed(1)}]` : ''}`;
    out.push(
      `| ${s.policy} | ${f4(s.aulcLogLoss)} | ${pct(s.aulcItemAcc)} | ${f4(s.first.logLoss)} / ${f4(s.last.logLoss)} | ${pct(s.first.itemAcc)} / ${pct(s.last.itemAcc)} | ${qs} | $${s.costUsd.selection.toFixed(3)} / $${s.costUsd.scoring.toFixed(3)} |`,
    );
  }
  for (const against of [r.rule.reference, 'order']) {
    const ds = r.deltas.filter((d) => d.against === against);
    if (!ds.length) continue;
    out.push(
      '',
      `### Against \`${against}\` (policy − ${against}; 90% intervals by person)`,
      '',
      `| Policy | AULC Δ log loss | AULC Δ accuracy, points | Δ log loss at ${last} | Δ accuracy at ${last}, points | People better / worse |`,
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const d of ds)
      out.push(
        `| ${d.policy} | ${iv(d.aulcLogLoss, sgn)} | ${iv(d.aulcItemAcc, pts)} | ${iv(d.lastLogLoss, sgn)} | ${iv(d.lastItemAcc, pts)} | ${d.aulcLogLoss.better} / ${d.aulcLogLoss.worse} |`,
      );
  }
  out.push(
    '',
    '## Learning curves (calibrated log loss / accuracy)',
    '',
    `| Policy | ${r.checkpoints.map((k) => `k = ${k}`).join(' | ')} |`,
    `| --- | ${r.checkpoints.map(() => '---').join(' | ')} |`,
  );
  for (const policy of r.policies)
    out.push(
      `| ${policy} | ${r.checkpoints
        .map((k) => {
          const p = r.points.find((x) => x.policy === policy && x.k === k);
          return p ? `${p.logLoss.toFixed(3)} / ${pct(p.itemAcc)}` : '—';
        })
        .join(' | ')} |`,
    );
  if (r.consistency !== null) {
    out.push(
      '',
      `## Fidelity (accuracy ÷ the people's own test–retest agreement on the same targets, ${pct(r.consistency)})`,
      '',
      `| Policy | ${r.checkpoints.map((k) => `k = ${k}`).join(' | ')} |`,
      `| --- | ${r.checkpoints.map(() => '---').join(' | ')} |`,
    );
    for (const policy of r.policies)
      out.push(
        `| ${policy} | ${r.checkpoints.map((k) => pct(r.points.find((x) => x.policy === policy && x.k === k)?.fidelity ?? null)).join(' | ')} |`,
      );
  }
  out.push(
    '',
    `## By target group at k = ${last}`,
    '',
    '| Policy | Group | n | Log loss | Accuracy |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const b of r.blocks)
    out.push(`| ${b.policy} | ${b.group} | ${b.n} | ${f4(b.logLoss)} | ${pct(b.itemAcc)} |`);
  if (r.reader?.length) {
    out.push(
      '',
      '## What the answers say, read without Jev (the persona posterior over train people; a yardstick, never served)',
      '',
      `| Policy | AULC log loss | AULC accuracy | ${r.checkpoints.map((k) => `k = ${k}`).join(' | ')} |`,
      `| --- | --- | --- | ${r.checkpoints.map(() => '---').join(' | ')} |`,
    );
    for (const x of [...r.reader].sort((a, b) => a.aulcLogLoss - b.aulcLogLoss))
      out.push(
        `| ${x.policy} | ${f4(x.aulcLogLoss)} | ${pct(x.aulcItemAcc)} | ${x.points.map((p) => `${p.logLoss.toFixed(3)} / ${pct(p.itemAcc)}`).join(' | ')} |`,
      );
  }
  if (r.stopping?.length) {
    out.push(
      '',
      "## Stopping on the policy's own score (stop before the next question once its score falls below τ; never before 3)",
      '',
      '| Policy | τ | Mean questions | Accuracy where people stopped | Accuracy at a fixed length of that many | Δ points |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const x of r.stopping)
      out.push(
        `| ${x.policy} | ${x.tau.toPrecision(3)} | ${x.meanQuestions.toFixed(1)} | ${pct(x.accAtStop)} | ${pct(x.accFixed)} | ${pts(x.accAtStop - x.accFixed)} |`,
      );
  }
  out.push(
    '',
    '## What each policy asked',
    '',
    '| Policy | Blocks in the first 10 | Blocks overall | Most common first question |',
    '| --- | --- | --- | --- |',
  );
  const shares = (x: Record<string, number>) =>
    Object.entries(x)
      .sort((a, b) => b[1] - a[1])
      .map(([b, s]) => `${b} ${Math.round(s * 100)}%`)
      .join(', ');
  for (const tr of r.trajectories)
    out.push(
      `| ${tr.policy} | ${shares(tr.firstTen)} | ${shares(tr.all)} | ${tr.openers.map((o) => `${o.prompt.slice(0, 60)}${o.prompt.length > 60 ? '…' : ''} (${o.count})`).join('; ')} |`,
    );
  out.push(
    '',
    '## Run',
    '',
    `- Spend: $${r.costUsd.toFixed(4)}; request cache ${r.cache.hits} hits ($${r.cache.savedUsd.toFixed(4)} not re-spent), ${r.cache.misses} misses.`,
    `- Knobs: \`${JSON.stringify(r.knobs)}\``,
    `- Audit: \`${JSON.stringify(r.audit)}\``,
  );
  return out;
}

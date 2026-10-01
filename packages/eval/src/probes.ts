import {
  type Distribution,
  type EngineDeps,
  type EvalRunRecord,
  expectedCalibrationError,
  itemAcrossPeople,
  mean,
  type ProbeTier,
  populationOf,
  probeMetaOf,
  type QuestionRecord,
  quantile,
  scorePrediction,
  seededRng,
  ulid,
} from '@mimic/core';
import { itemValue, predictedValue } from './replay';

/**
 * `pnpm eval -- probes` (E7, ADR-0062, docs/PROBE.md): what the mimic has learned, read on the probes the session
 * served at fixed points. A probe carries the stored primary, baseline and shadow predictions of any served question,
 * so the readout makes no calls. Each predictor is paired with the context-only baseline on the same probes, per
 * distance tier and per slot, with intervals that resample people.
 */
export interface ProbeSpec {
  name: string;
  /** Real people only (the default), or every consented mimic (scripted ones: machinery checks only). */
  population: 'real' | 'all';
  seed: string;
}

/** PROBE_RULE (docs/PROBE.md §5), fixed before the first readout. */
export const PROBE_RULE = {
  /** People with probes before any tier is read. */
  minPeople: 30,
  /** People before a tier that never helps sends the work to compaction. */
  minPeopleNever: 60,
  /** E3b's arm size, and the lift difference it must detect (80% power, two-sided α = 0.05), in item accuracy. */
  e3bPerArm: 64,
  e3bDetectable: 0.03,
  /** Other people a shared item's mean needs. */
  minItemPeople: 5,
  /** Largest per-option difference at which the primary's and the baseline's predictions count as the same. */
  insensitive: 0.01,
  /** The mimic individuates when shared-item correlation rises this much (interval above 0) or dispersion this much. */
  individuationR: 0.05,
  individuationDispersion: 0.1,
} as const;

const RESAMPLES = 2000;
const TIER_ORDER: ProbeTier[] = ['shared', 'repeat', 'near', 'mid', 'far'];

interface Row {
  mimicId: string;
  questionId: string;
  tier: ProbeTier;
  slot: number;
  role: string;
  predictorId: string;
  itemAcc: number;
  logLoss: number;
  top1: number;
  confidence: number;
  dist: Distribution;
  answer: string;
  question: QuestionRecord;
}

export interface Interval90 {
  mean: number;
  low: number;
  high: number;
}

export interface ProbeDelta {
  n: number;
  people: number;
  /** People whose mean log loss improves, and worsens (ties count as neither). */
  better: number;
  worse: number;
  itemAcc: Interval90;
  logLoss: Interval90;
  /** SD across people of each person's mean item-accuracy difference: E3b's power rests on it. */
  personSd: number;
}

type Scored = Pick<Row, 'mimicId' | 'questionId' | 'itemAcc' | 'logLoss'>;

/** b − a paired by question, with 90% intervals that resample people (one person's questions are not independent). */
export function personDelta(a: Scored[], b: Scored[], seed: string): ProbeDelta {
  const bi = new Map(b.map((r) => [`${r.mimicId}|${r.questionId}`, r]));
  const byPerson = new Map<string, Array<{ acc: number; ll: number }>>();
  for (const r of a) {
    const s = bi.get(`${r.mimicId}|${r.questionId}`);
    if (!s) continue;
    const xs = byPerson.get(r.mimicId) ?? [];
    xs.push({ acc: s.itemAcc - r.itemAcc, ll: s.logLoss - r.logLoss });
    byPerson.set(r.mimicId, xs);
  }
  const people = [...byPerson.values()];
  const all = people.flat();
  const interval = (pick: (x: { acc: number; ll: number }) => number, tag: string): Interval90 => {
    if (!all.length) return { mean: 0, low: 0, high: 0 };
    const rng = seededRng(`${seed}:${tag}`);
    const samples: number[] = [];
    for (let s = 0; s < RESAMPLES; s++) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < people.length; i++) {
        const xs = people[Math.floor(rng() * people.length)]!;
        for (const x of xs) sum += pick(x);
        n += xs.length;
      }
      samples.push(n ? sum / n : 0);
    }
    return { mean: mean(all.map(pick)), low: quantile(samples, 0.05), high: quantile(samples, 0.95) };
  };
  const perPerson = people.map((xs) => mean(xs.map((x) => x.acc)));
  const m = mean(perPerson);
  const personSd =
    perPerson.length > 1
      ? Math.sqrt(perPerson.reduce((acc, x) => acc + (x - m) ** 2, 0) / (perPerson.length - 1))
      : 0;
  return {
    n: all.length,
    people: people.length,
    better: people.filter((xs) => mean(xs.map((x) => x.ll)) < 0).length,
    worse: people.filter((xs) => mean(xs.map((x) => x.ll)) > 0).length,
    itemAcc: interval((x) => x.acc, 'acc'),
    logLoss: interval((x) => x.ll, 'll'),
    personSd,
  };
}

export interface ProbeGroup {
  group: string;
  n: number;
  people: number;
  primary: { itemAcc: number; logLoss: number; ece: number };
  baseline: { itemAcc: number; logLoss: number; ece: number };
  /** Primary − baseline: what the person's answers add on these probes. */
  delta: ProbeDelta;
}

export type ProbeVerdict = 'insufficient' | 'measuring' | 'e3b-ready' | 'compaction-first';

export interface ProbeReport {
  people: number;
  probes: number;
  tiers: ProbeGroup[];
  slots: ProbeGroup[];
  /** Each shadow against the same baseline, over every probe it predicted. */
  shadows: Array<{ predictorId: string; delta: ProbeDelta }>;
  shared: {
    items: number;
    /** Primary − leave-one-out item mean on the shared items: lift beyond what anyone would answer. */
    residual: ProbeDelta | null;
    acrossPeople: {
      primary: ReturnType<typeof itemAcrossPeople>;
      baseline: ReturnType<typeof itemAcrossPeople>;
    };
    /** Primary − baseline across-person correlation, its interval resampling people, and the dispersion change. */
    individuation: { r: Interval90; dispersion: number; individuates: boolean } | null;
  };
  /** Repeat consistency, the person's own ceiling; probe fidelity is the primary's accuracy over it. */
  repeat: { n: number; people: number; consistency: number | null; fidelity: number | null };
  /** Share of probes on which the person's answers did not move the primary's prediction at all. */
  insensitiveShare: number | null;
  rule: {
    verdict: ProbeVerdict;
    helps: Partial<Record<ProbeTier, boolean>>;
    /** Mid and far probes at the last slot: the yardstick E3b would use. */
    yardstick: { people: number; personSd: number; detectable: number | null } | null;
    reason: string;
  };
}

function group(label: string, rows: Row[], seed: string): ProbeGroup | null {
  const primary = rows.filter((r) => r.role === 'primary');
  const baseline = rows.filter((r) => r.role === 'baseline');
  if (!primary.length || !baseline.length) return null;
  const summary = (rs: Row[]) => ({
    itemAcc: mean(rs.map((r) => r.itemAcc)),
    logLoss: mean(rs.map((r) => r.logLoss)),
    ece: expectedCalibrationError(rs.map((r) => ({ confidence: r.confidence, correct: r.top1 }))),
  });
  const delta = personDelta(baseline, primary, `${seed}:${label}`);
  return {
    group: label,
    n: delta.n,
    people: delta.people,
    primary: summary(primary),
    baseline: summary(baseline),
    delta,
  };
}

/** A shared item's answer distribution among everyone else (Laplace-smoothed), or null under the group minimum. */
function itemMean(rows: Row[], itemKey: string, mimicId: string, keys: string[]): Distribution | null {
  const others = new Map<string, string>();
  for (const r of rows)
    if (r.role === 'baseline' && r.question.itemKey === itemKey && r.mimicId !== mimicId)
      others.set(r.mimicId, r.answer);
  if (others.size < PROBE_RULE.minItemPeople) return null;
  const counts = Object.fromEntries(keys.map((k) => [k, 1]));
  for (const a of others.values()) counts[a] = (counts[a] ?? 1) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k) => [k, counts[k]! / total]));
}

export async function probeReadout(
  deps: EngineDeps,
  spec: ProbeSpec,
  datasetHash: string,
): Promise<{ run: EvalRunRecord; report: ProbeReport }> {
  const all = await deps.store.listMimics({ consentResearch: true });
  const mimics = all.filter((m) => spec.population === 'all' || populationOf(m.participantId) === 'real');
  const rows: Row[] = [];
  const repeats: Array<{ mimicId: string; same: boolean }> = [];
  for (const m of mimics) {
    const questions = await deps.store.listQuestions(m.id);
    const probes = new Map(
      questions.flatMap((q) => {
        const meta = probeMetaOf(q);
        return meta && q.status === 'answered' ? [[q.id, { q, meta }] as const] : [];
      }),
    );
    if (!probes.size) continue;
    const answers = new Map((await deps.store.listAnswers(m.id)).map((a) => [a.questionId, a.value]));
    for (const { q, meta } of probes.values())
      if (meta.sourceId && answers.has(meta.sourceId) && answers.has(q.id))
        repeats.push({ mimicId: m.id, same: answers.get(meta.sourceId) === answers.get(q.id) });
    for (const s of await deps.store.listScoredPredictions(m.id, ['primary', 'baseline', 'shadow'])) {
      const probe = probes.get(s.prediction.questionId);
      const answer = answers.get(s.prediction.questionId);
      if (!probe || answer === undefined || !s.prediction.ok || s.prediction.fallback) continue;
      const dist = s.prediction.dist;
      rows.push({
        mimicId: m.id,
        questionId: probe.q.id,
        tier: probe.meta.tier,
        slot: probe.meta.slot,
        role: s.prediction.role,
        predictorId: s.prediction.predictorId,
        itemAcc: s.score.itemAcc,
        logLoss: s.score.logLoss,
        top1: s.score.top1,
        confidence: Math.max(0, ...Object.values(dist)),
        dist,
        answer,
        question: probe.q,
      });
    }
  }

  const people = new Set(rows.map((r) => r.mimicId)).size;
  const tiers = TIER_ORDER.flatMap(
    (t) =>
      group(
        t,
        rows.filter((r) => r.tier === t),
        spec.seed,
      ) ?? [],
  );
  const slots = [...new Set(rows.map((r) => r.slot))]
    .sort((a, b) => a - b)
    .flatMap(
      (k) =>
        group(
          `after ${k}`,
          rows.filter((r) => r.slot === k),
          spec.seed,
        ) ?? [],
    );
  const baseline = rows.filter((r) => r.role === 'baseline');
  const shadows = [...new Set(rows.filter((r) => r.role === 'shadow').map((r) => r.predictorId))]
    .sort()
    .map((predictorId) => ({
      predictorId,
      delta: personDelta(
        baseline,
        rows.filter((r) => r.role === 'shadow' && r.predictorId === predictorId),
        `${spec.seed}:${predictorId}`,
      ),
    }));

  // Shared items: a leave-one-out item mean is the stereotype's best guess; the primary has to beat it.
  const shared = rows.filter((r) => r.tier === 'shared');
  const meanRows: Scored[] = [];
  const primaryShared: Scored[] = [];
  for (const r of shared.filter((x) => x.role === 'primary')) {
    const keys = r.question.options.map((o) => o.key);
    const im = r.question.itemKey ? itemMean(rows, r.question.itemKey, r.mimicId, keys) : null;
    if (!im) continue;
    const s = scorePrediction(r.question.type, im, r.answer);
    meanRows.push({ mimicId: r.mimicId, questionId: r.questionId, itemAcc: s.itemAcc, logLoss: s.logLoss });
    primaryShared.push(r);
  }
  const valuesOf = (rs: Row[], role: string) =>
    rs.flatMap((r) => {
      if (r.role !== role || !r.question.itemKey) return [];
      const predicted = predictedValue(r.question, r.dist);
      const actual = itemValue(r.question, r.answer);
      return predicted === null || actual === null
        ? []
        : [{ itemKey: r.question.itemKey, predicted, actual }];
    });
  const across = (role: string) => itemAcrossPeople(valuesOf(shared, role), PROBE_RULE.minItemPeople);
  const individuation = (() => {
    const p = across('primary');
    const b = across('baseline');
    if (p.meanCorrelation === null || b.meanCorrelation === null) return null;
    // Resample people with replacement; each draw keeps a person's shared answers together.
    const byPerson = [...new Set(shared.map((r) => r.mimicId))].map((id) =>
      shared.filter((r) => r.mimicId === id),
    );
    const rng = seededRng(`${spec.seed}:individuation`);
    const diffs: number[] = [];
    for (let s = 0; s < RESAMPLES; s++) {
      const draw = byPerson.flatMap((_, i) =>
        byPerson[Math.floor(rng() * byPerson.length)]!.map((r) => ({ ...r, mimicId: `${r.mimicId}#${i}` })),
      );
      const dp = itemAcrossPeople(valuesOf(draw, 'primary'), PROBE_RULE.minItemPeople).meanCorrelation;
      const db = itemAcrossPeople(valuesOf(draw, 'baseline'), PROBE_RULE.minItemPeople).meanCorrelation;
      if (dp !== null && db !== null) diffs.push(dp - db);
    }
    const r: Interval90 = {
      mean: p.meanCorrelation - b.meanCorrelation,
      low: diffs.length ? quantile(diffs, 0.05) : 0,
      high: diffs.length ? quantile(diffs, 0.95) : 0,
    };
    const dispersion = (p.meanDispersionRatio ?? 0) - (b.meanDispersionRatio ?? 0);
    return {
      r,
      dispersion,
      individuates:
        (r.mean >= PROBE_RULE.individuationR && r.low > 0) ||
        dispersion >= PROBE_RULE.individuationDispersion,
    };
  })();

  // State-insensitive probes: the answers changed nothing in the primary's prediction.
  const byQ = new Map<string, { p?: Distribution; b?: Distribution }>();
  for (const r of rows) {
    if (r.role !== 'primary' && r.role !== 'baseline') continue;
    const e = byQ.get(r.questionId) ?? {};
    if (r.role === 'primary') e.p = r.dist;
    else e.b = r.dist;
    byQ.set(r.questionId, e);
  }
  const pairs = [...byQ.values()].filter((e) => e.p && e.b);
  const insensitive = pairs.filter((e) =>
    Object.keys(e.b!).every((k) => Math.abs((e.p![k] ?? 0) - (e.b![k] ?? 0)) < PROBE_RULE.insensitive),
  ).length;

  const helps: Partial<Record<ProbeTier, boolean>> = {};
  for (const g of tiers)
    helps[g.group as ProbeTier] =
      g.people >= PROBE_RULE.minPeople && g.delta.logLoss.high < 0 && g.delta.itemAcc.mean >= 0;
  const lastSlot = Math.max(-1, ...rows.map((r) => r.slot));
  const yard = group(
    'yardstick',
    rows.filter((r) => r.slot === lastSlot && (r.tier === 'mid' || r.tier === 'far')),
    spec.seed,
  );
  const detectable =
    yard && yard.people > 1 ? 2.8 * yard.delta.personSd * Math.sqrt(2 / PROBE_RULE.e3bPerArm) : null;
  const farLast = group(
    'far-last',
    rows.filter((r) => r.slot === lastSlot && r.tier === 'far'),
    spec.seed,
  );
  let verdict: ProbeVerdict = 'measuring';
  let reason = '';
  if (people < PROBE_RULE.minPeople) {
    verdict = 'insufficient';
    reason = `${people} people with probes; the rule reads tiers from ${PROBE_RULE.minPeople}.`;
  } else if (farLast && farLast.people >= PROBE_RULE.minPeopleNever && farLast.delta.logLoss.low > 0) {
    verdict = 'compaction-first';
    reason =
      'Far probes at the last slot get worse with the answers: the state does not carry what they need.';
  } else if (
    yard &&
    yard.people >= PROBE_RULE.minPeople &&
    detectable !== null &&
    detectable <= PROBE_RULE.e3bDetectable
  ) {
    verdict = 'e3b-ready';
    reason = `Mid and far probes at the last slot let E3b detect ${(detectable * 100).toFixed(1)} points with ${PROBE_RULE.e3bPerArm} people per arm.`;
  } else {
    reason =
      detectable === null
        ? 'No mid or far probes at the last slot yet.'
        : `E3b could detect ${(detectable * 100).toFixed(1)} points; it needs ${(PROBE_RULE.e3bDetectable * 100).toFixed(0)}.`;
  }

  const consistency = repeats.length ? mean(repeats.map((r) => (r.same ? 1 : 0))) : null;
  const report: ProbeReport = {
    people,
    probes: byQ.size,
    tiers,
    slots,
    shadows,
    shared: {
      items: new Set(shared.map((r) => r.question.itemKey)).size,
      residual: meanRows.length ? personDelta(meanRows, primaryShared, `${spec.seed}:residual`) : null,
      acrossPeople: { primary: across('primary'), baseline: across('baseline') },
      individuation,
    },
    repeat: {
      n: repeats.length,
      people: new Set(repeats.map((r) => r.mimicId)).size,
      consistency,
      fidelity: consistency
        ? mean(rows.filter((r) => r.role === 'primary').map((r) => r.itemAcc)) / consistency
        : null,
    },
    insensitiveShare: pairs.length ? insensitive / pairs.length : null,
    rule: {
      verdict,
      helps,
      yardstick: yard ? { people: yard.people, personSd: yard.delta.personSd, detectable } : null,
      reason,
    },
  };
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { ...spec, kind: 'probes' },
    datasetHash,
    status: 'done',
    metrics: { report },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, report };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pts = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
const nats = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)}`;
const ci = (i: Interval90, f: (x: number) => string) => `${f(i.mean)} [${f(i.low)}, ${f(i.high)}]`;

/** Markdown for a probe readout (`renderReport`). */
export function renderProbes(r: ProbeReport): string[] {
  const table = (title: string, gs: ProbeGroup[]) => [
    `### ${title}`,
    '',
    '| Group | n | People | Baseline acc | Primary acc | Δ accuracy, points [90% CI] | Δ log loss [90% CI] | Better / worse | Primary ECE |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...gs.map(
      (g) =>
        `| ${g.group} | ${g.n} | ${g.people} | ${pct(g.baseline.itemAcc)} | ${pct(g.primary.itemAcc)} | ${ci(g.delta.itemAcc, pts)} | ${ci(g.delta.logLoss, nats)} | ${g.delta.better} / ${g.delta.worse} | ${g.primary.ece.toFixed(3)} |`,
    ),
    '',
  ];
  const a = r.shared.acrossPeople;
  const f3 = (x: number | null) => (x === null ? '—' : x.toFixed(3));
  return [
    `## Verdict (PROBE_RULE): \`${r.rule.verdict}\``,
    '',
    r.rule.reason,
    '',
    `People: ${r.people} · probes: ${r.probes} · state-insensitive: ${r.insensitiveShare === null ? '—' : pct(r.insensitiveShare)} · repeat consistency: ${r.repeat.consistency === null ? '—' : `${pct(r.repeat.consistency)} (${r.repeat.n} repeats)`} · probe fidelity: ${r.repeat.fidelity === null ? '—' : pct(r.repeat.fidelity)}`,
    '',
    ...table('By distance (primary − context-only baseline)', r.tiers),
    ...table('By slot', r.slots),
    '### Shared items',
    '',
    `${r.shared.items} items. Residual (primary − leave-one-out item mean): ${r.shared.residual ? `${ci(r.shared.residual.itemAcc, pts)} points, log loss ${ci(r.shared.residual.logLoss, nats)} over ${r.shared.residual.people} people` : '— (each item needs answers from 5 other people)'}.`,
    `Across-person r: primary ${f3(a.primary.meanCorrelation)}, baseline ${f3(a.baseline.meanCorrelation)}; dispersion: primary ${f3(a.primary.meanDispersionRatio)}, baseline ${f3(a.baseline.meanDispersionRatio)}.`,
    r.shared.individuation
      ? `Individuation: Δr ${ci(r.shared.individuation.r, (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)}`)}, Δ dispersion ${nats(r.shared.individuation.dispersion)}: ${r.shared.individuation.individuates ? 'the mimic individuates' : 'not shown'}.`
      : 'Individuation: — (each shared item needs answers from 5 people).',
    '',
    '### Shadows against the same baseline',
    '',
    '| Shadow | n | People | Δ accuracy, points [90% CI] | Δ log loss [90% CI] |',
    '| --- | --- | --- | --- | --- |',
    ...r.shadows.map(
      (s) =>
        `| \`${s.predictorId}\` | ${s.delta.n} | ${s.delta.people} | ${ci(s.delta.itemAcc, pts)} | ${ci(s.delta.logLoss, nats)} |`,
    ),
    '',
    'Intervals resample people (2,000 seeded resamples, 5th–95th percentile). Scripted and imported people prove the machinery only.',
  ];
}

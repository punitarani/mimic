import {
  type EngineDeps,
  type EvalRunRecord,
  FIDELITY_TARGET,
  mean,
  type Population,
  populationOf,
  quantile,
  questionsToSustain,
  seededRng,
  ulid,
} from '@mimic/core';

/**
 * `mimic-eval arms` (ADR-0045): an experiment's arms compared on the E3 metrics (PLAN §12.7), with 95% bootstrap
 * intervals, so a difference is read with its uncertainty and never from two means alone.
 *
 * - Fidelity at 20 (primary): mean fidelity after 20 answered questions, over people who answered at least 20.
 * - Questions to sustain fidelity 0.75: the answered count after which fidelity stays at or above 0.75 through the
 *   person's last answer (`questionsToSustain`); the median over people who got there, with the share who did.
 *
 * Each arm is resampled on its own (people are independent across arms); the difference of every arm against the
 * control is resampled the same way. An interval that spans 0 is reported as "not significant". Real people only by
 * default: scripted and imported people test the machinery and are never results.
 */

export const AT = 20;
export const RESAMPLES = 2000;

export interface ArmPerson {
  mimicId: string;
  arm: string;
  population: Population;
  answered: number;
  fidelityAt20: number | null;
  toSustain: number | null;
}

export interface Interval {
  estimate: number | null;
  low: number | null;
  high: number | null;
  n: number;
}

export interface ArmSummary {
  arm: string;
  config: string;
  people: number;
  fidelityAt20: Interval;
  /** Share of the arm's people whose fidelity settled at or above the target. */
  reached: Interval;
  /** Median questions to sustain the target, over the people who reached it. */
  toSustain: Interval;
}

export interface ArmDifference {
  arm: string;
  control: string;
  fidelityAt20: Interval & { significant: boolean };
  reached: Interval & { significant: boolean };
  toSustain: Interval & { significant: boolean };
}

export interface ArmsReport {
  experimentId: string | null;
  experimentName: string | null;
  population: 'real' | 'all';
  control: string | null;
  arms: ArmSummary[];
  differences: ArmDifference[];
}

type Stat = (xs: number[]) => number;
const median: Stat = (xs) => quantile(xs, 0.5);

/** Percentile bootstrap (seeded) of `stat` over `xs`. */
export function bootstrap(xs: number[], stat: Stat, seed: string, resamples = RESAMPLES): Interval {
  if (!xs.length) return { estimate: null, low: null, high: null, n: 0 };
  const rng = seededRng(seed);
  const samples: number[] = [];
  for (let s = 0; s < resamples; s++) samples.push(stat(resample(xs, rng)));
  return { estimate: stat(xs), low: quantile(samples, 0.025), high: quantile(samples, 0.975), n: xs.length };
}

/** Percentile bootstrap of stat(b) − stat(a), each group resampled on its own. */
export function bootstrapDifference(
  a: number[],
  b: number[],
  stat: Stat,
  seed: string,
  resamples = RESAMPLES,
): Interval & { significant: boolean } {
  if (!a.length || !b.length)
    return { estimate: null, low: null, high: null, n: Math.min(a.length, b.length), significant: false };
  const rng = seededRng(seed);
  const samples: number[] = [];
  for (let s = 0; s < resamples; s++) samples.push(stat(resample(b, rng)) - stat(resample(a, rng)));
  const low = quantile(samples, 0.025);
  const high = quantile(samples, 0.975);
  return {
    estimate: stat(b) - stat(a),
    low,
    high,
    n: Math.min(a.length, b.length),
    significant: low > 0 || high < 0,
  };
}

function resample(xs: number[], rng: () => number): number[] {
  const out = new Array<number>(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rng() * xs.length)]!;
  return out;
}

/** One person's E3 numbers from their fidelity series (one value per answered question). */
export function armPerson(
  m: { id: string; arm: string | null; participantId: string },
  series: number[],
): ArmPerson {
  return {
    mimicId: m.id,
    arm: m.arm ?? 'default',
    population: populationOf(m.participantId),
    answered: series.length,
    fidelityAt20: series.length >= AT ? series[AT - 1]! : null,
    toSustain: questionsToSustain(series, FIDELITY_TARGET),
  };
}

/** Summaries per arm, and each arm against the control (the arm named `control`, else the first). */
export function compareArms(
  people: ArmPerson[],
  configs: Map<string, string>,
  opts: { control?: string; seed?: string } = {},
): Pick<ArmsReport, 'control' | 'arms' | 'differences'> {
  const seed = opts.seed ?? 'arms';
  const byArm = new Map<string, ArmPerson[]>();
  for (const p of people) byArm.set(p.arm, [...(byArm.get(p.arm) ?? []), p]);
  const names = [...byArm.keys()].sort();
  const control = opts.control ?? (names.includes('control') ? 'control' : (names[0] ?? null));
  const at20 = (ps: ArmPerson[]) => ps.flatMap((p) => (p.fidelityAt20 === null ? [] : [p.fidelityAt20]));
  const reached = (ps: ArmPerson[]) => ps.map((p) => (p.toSustain === null ? 0 : 1));
  const toSustain = (ps: ArmPerson[]) => ps.flatMap((p) => (p.toSustain === null ? [] : [p.toSustain]));
  const arms: ArmSummary[] = names.map((arm) => {
    const ps = byArm.get(arm)!;
    return {
      arm,
      config: configs.get(arm) ?? '',
      people: ps.length,
      fidelityAt20: bootstrap(at20(ps), mean, `${seed}:${arm}:f20`),
      reached: bootstrap(reached(ps), mean, `${seed}:${arm}:reached`),
      toSustain: bootstrap(toSustain(ps), median, `${seed}:${arm}:sustain`),
    };
  });
  const differences: ArmDifference[] = [];
  const base = control ? byArm.get(control) : undefined;
  if (control && base)
    for (const arm of names) {
      if (arm === control) continue;
      const ps = byArm.get(arm)!;
      differences.push({
        arm,
        control,
        fidelityAt20: bootstrapDifference(at20(base), at20(ps), mean, `${seed}:${arm}-${control}:f20`),
        reached: bootstrapDifference(reached(base), reached(ps), mean, `${seed}:${arm}-${control}:reached`),
        toSustain: bootstrapDifference(
          toSustain(base),
          toSustain(ps),
          median,
          `${seed}:${arm}-${control}:sustain`,
        ),
      });
    }
  return { control, arms, differences };
}

/**
 * Reads an experiment's people from a database (an export, or a local cohort) and compares its arms. Research consent
 * gates use (PLAN §3.8). Without `experimentId`, the experiment with the most people is used.
 */
export async function armsRun(
  deps: EngineDeps,
  spec: { name: string; experimentId?: string; population?: 'real' | 'all'; seed?: string },
  datasetHash: string,
): Promise<{ run: EvalRunRecord; report: ArmsReport; people: ArmPerson[] }> {
  const population = spec.population ?? 'real';
  const mimics = (await deps.store.listMimics({ consentResearch: true })).filter(
    (m) => m.experimentId !== null && (population === 'all' || populationOf(m.participantId) === 'real'),
  );
  const counts = new Map<string, number>();
  for (const m of mimics) counts.set(m.experimentId!, (counts.get(m.experimentId!) ?? 0) + 1);
  const experimentId =
    spec.experimentId ??
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const experiment = experimentId
    ? ((await deps.store.listExperiments()).find((e) => e.id === experimentId) ?? null)
    : null;
  const configLabels = new Map(
    (await deps.store.listConfigs()).map((c) => [c.hash, c.label ?? c.hash.slice(0, 12)]),
  );
  const configs = new Map(
    (experiment?.arms ?? []).map((a) => [a.arm, configLabels.get(a.configHash) ?? a.configHash.slice(0, 12)]),
  );
  const people: ArmPerson[] = [];
  for (const m of mimics) {
    if (m.experimentId !== experimentId) continue;
    const series = (await deps.store.listFidelity(m.id)).map((f) => f.fidelity);
    people.push(armPerson(m, series));
  }
  const report: ArmsReport = {
    experimentId: experimentId ?? null,
    experimentName: experiment?.name ?? null,
    population,
    ...compareArms(people, configs, spec.seed ? { seed: spec.seed } : {}),
  };
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { kind: 'arms', experimentId: report.experimentId, population, seed: spec.seed ?? 'arms' },
    datasetHash,
    status: 'done',
    metrics: { report, people },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, report, people };
}

const num = (x: number | null, d = 2) => (x === null ? '—' : x.toFixed(d));
const share = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const ci = (i: Interval, f: (x: number | null) => string) =>
  i.estimate === null ? '—' : `${f(i.estimate)} [${f(i.low)}, ${f(i.high)}]`;
const signed = (d: number) => (x: number | null) => (x === null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
const signedShare = (x: number | null) =>
  x === null ? '—' : `${x > 0 ? '+' : ''}${Math.round(x * 100)} pts`;

/** Markdown for an arms run. Everything but real people is labelled "not a result". */
export function renderArms(r: ArmsReport): string[] {
  const who =
    r.population === 'real'
      ? 'Real people only.'
      : 'Includes scripted and imported people: a check of the machinery, not a result.';
  const lines = [
    '## Arms (ADR-0045)',
    '',
    `${r.experimentName ?? r.experimentId ?? 'No experiment'} · ${who} 95% bootstrap intervals (${RESAMPLES} resamples, seeded).`,
    '',
  ];
  if (!r.arms.length) {
    lines.push(
      r.population === 'real'
        ? 'No real people in this data yet. Scripted and imported people are left out (`--population all` shows them, labelled).'
        : 'No people in this experiment.',
      '',
    );
    return lines;
  }
  lines.push(
    '| Arm | Config | People | Fidelity at 20 | Reached 0.75 and stayed | Questions to sustain 0.75 (median) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.arms.map(
      (a) =>
        `| ${a.arm} | ${a.config} | ${a.people} | ${ci(a.fidelityAt20, (x) => num(x))} (n ${a.fidelityAt20.n}) | ${ci(a.reached, share)} | ${ci(a.toSustain, (x) => num(x, 1))} (n ${a.toSustain.n}) |`,
    ),
    '',
  );
  if (r.differences.length) {
    const verdict = (d: { significant: boolean; estimate: number | null }) =>
      d.estimate === null ? 'no data' : d.significant ? 'significant' : 'not significant';
    lines.push(
      `Against ${r.control}. Higher fidelity and fewer questions are better.`,
      '',
      '| Arm | Fidelity at 20 | Reached | Questions to sustain |',
      '| --- | --- | --- | --- |',
      ...r.differences.map(
        (d) =>
          `| ${d.arm} − ${d.control} | ${ci(d.fidelityAt20, signed(3))}, ${verdict(d.fidelityAt20)} | ${ci(d.reached, signedShare)}, ${verdict(d.reached)} | ${ci(d.toSustain, signed(1))}, ${verdict(d.toSustain)} |`,
      ),
      '',
    );
  }
  return lines;
}

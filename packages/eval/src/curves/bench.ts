import { seededRng, temperatureScale } from '@mimic/core';
import { BudgetStop } from '../optimize/evaluate';
import type { ChoiceNote } from './choosers';
import { stateOf, type TwinItem, type TwinPerson } from './data';
import {
  batchOf,
  type JevOracle,
  openItems,
  POLICY_DEFAULTS,
  type Policy,
  parsePolicySpec,
} from './policies';
import { PersonaPosterior, type Population } from './population';

/**
 * E10's decision-point bench (docs/CHOOSER.md §4), for screening only. Each person is walked by a reference policy
 * (`custom-random`); at a few points along the walk every candidate of a fixed batch is scored by what its answer
 * would do for Jev on the person's targets (T): the change in tempered log loss and accuracy when that one answer
 * joins the state. Each chooser is then asked to pick from that same state and batch, and is scored by the gain of
 * its pick over the batch's mean (what a random pick gets on average). T answers score here and nowhere else: no
 * chooser sees them. One step ahead only, so the full walks decide.
 */

export interface BenchOptions {
  people: TwinPerson[];
  reference: Policy;
  policies: Policy[];
  /** Answers already asked at each point (8: the pick after E9's opening). */
  points: number[];
  /** Candidates measured at each point: every batch a chooser draws there is the start of this one. */
  batch: number;
  ramp: number;
  seed: string;
  /** Temperature on Jev's raw probabilities when scoring (Jev's served temperature is 4). */
  t: number;
  jev: JevOracle;
  pop: Population | null;
  vectors?: ReadonlyMap<string, number[]>;
  concurrency: number;
}

interface Score {
  logLoss: number;
  acc: number;
}

export interface BenchPoint {
  pid: string;
  point: number;
  base: Score;
  /** Each measured candidate's change from `base` (negative log loss is better). */
  gains: Array<{ key: string; dLogLoss: number; dAcc: number }>;
  picks: Array<{ policy: string; key: string; dLogLoss: number; dAcc: number; note?: ChoiceNote }>;
}

export interface Interval {
  mean: number;
  ciLow: number;
  ciHigh: number;
  people: number;
}

export interface BenchRow {
  policy: string;
  /** The pick's gain minus the mean gain of the batch the policy drew from (negative log loss: better than random). */
  vsRandom: { logLoss: Interval; acc: Interval };
  /** The pick's gain minus the batch's best (0 is perfect). */
  regret: { logLoss: Interval; acc: Interval };
  /** The share of picks that were the batch's best by log loss. */
  bestShare: number;
}

export interface BenchReport {
  people: number;
  points: number[];
  batch: number;
  /** What a perfect chooser gains over random, for batches of each size (the start of the measured batch). */
  oracle: Array<{ b: number; logLoss: Interval; acc: Interval }>;
  /** How much the measured candidates differ at all: the mean gain of a random pick. */
  randomGain: { logLoss: Interval; acc: Interval };
  rows: BenchRow[];
  costUsd: number;
}

function scoreOf(items: readonly TwinItem[], dists: ReadonlyArray<Record<string, number> | null>, t: number) {
  let ll = 0;
  let acc = 0;
  let n = 0;
  items.forEach((it, i) => {
    const d = dists[i];
    if (!d) return;
    const p = temperatureScale(d, t);
    ll += -Math.log(Math.max(p[it.answer] ?? 0, 1e-6));
    const top = Object.entries(d).sort((a, b) => b[1] - a[1])[0]?.[0];
    acc += top === it.answer ? 1 : 0;
    n++;
  });
  return n === items.length && n > 0 ? { logLoss: ll / n, acc: acc / n } : null;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Mean of per-person values, with a 90% bootstrap interval over people. */
export function personInterval(
  values: ReadonlyMap<string, number[]>,
  seed: string,
  resamples = 2000,
): Interval {
  const per = [...values.values()].filter((v) => v.length).map(mean);
  if (!per.length) return { mean: 0, ciLow: 0, ciHigh: 0, people: 0 };
  const rng = seededRng(seed);
  const samples: number[] = [];
  for (let s = 0; s < resamples; s++) {
    let sum = 0;
    for (let i = 0; i < per.length; i++) sum += per[Math.floor(rng() * per.length)]!;
    samples.push(sum / per.length);
  }
  samples.sort((a, b) => a - b);
  return {
    mean: mean(per),
    ciLow: samples[Math.floor(0.05 * (resamples - 1))]!,
    ciHigh: samples[Math.ceil(0.95 * (resamples - 1))]!,
    people: per.length,
  };
}

async function gainOf(
  o: BenchOptions,
  person: TwinPerson,
  prefix: readonly TwinItem[],
  c: TwinItem,
  base: Score,
) {
  const s = scoreOf(
    person.targets,
    await o.jev.predict(person.pid, stateOf(person, [...prefix, c]), person.targets),
    o.t,
  );
  return s ? { key: c.key, dLogLoss: s.logLoss - base.logLoss, dAcc: s.acc - base.acc } : null;
}

export async function runBench(
  o: BenchOptions,
): Promise<{ points: BenchPoint[]; stopReason: string | null }> {
  const out: BenchPoint[] = [];
  const last = Math.max(...o.points);
  let next = 0;
  let stopReason: string | null = null;
  const work = async () => {
    for (let i = next++; i < o.people.length && !stopReason; i = next++) {
      const person = o.people[i]!;
      try {
        out.push(...(await benchPerson(o, person, last)));
      } catch (e) {
        if (!(e instanceof BudgetStop)) throw e;
        stopReason = `${e.message}; people from the ${i + 1}th on were not all benched`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, work));
  return {
    points: out.sort((a, b) => a.pid.localeCompare(b.pid) || a.point - b.point),
    stopReason,
  };
}

async function benchPerson(o: BenchOptions, person: TwinPerson, last: number): Promise<BenchPoint[]> {
  const out: BenchPoint[] = [];
  {
    const walked = await walkTo(o, person, last);
    for (const point of o.points) {
      if (walked.length < point) continue;
      const prefix = walked.slice(0, point);
      const remaining = person.pool.filter((it) => !prefix.includes(it));
      const open = openItems(remaining, point, o.ramp);
      const measured = batchOf(open, o.batch, o.seed, person.pid, point);
      const base = scoreOf(
        person.targets,
        await o.jev.predict(person.pid, stateOf(person, prefix), person.targets),
        o.t,
      );
      if (!base) continue;
      const gains = (await Promise.all(measured.map((c) => gainOf(o, person, prefix, c, base)))).filter(
        (g): g is NonNullable<typeof g> => !!g,
      );
      if (gains.length < measured.length) continue;
      const picks: BenchPoint['picks'] = [];
      for (const policy of o.policies) {
        let note: ChoiceNote | undefined;
        const posterior =
          policy.usesPopulation && o.pop
            ? (policy.posteriorOf?.() ?? new PersonaPosterior(o.pop, undefined, policy.beta ?? 1))
            : null;
        if (posterior)
          for (const g of [...person.given, ...prefix]) posterior.observe(g.key, posterior.indexOf(g));
        const item = await policy.next({
          person,
          asked: prefix,
          remaining,
          state: stateOf(person, prefix),
          rng: seededRng(`${o.seed}:${policy.name}:${person.pid}:bench:${point}`),
          jev: o.jev,
          pop: o.pop,
          posterior,
          ...(o.vectors ? { vectors: o.vectors } : {}),
          log: (n) => {
            note = n;
          },
        });
        const g = gains.find((x) => x.key === item.key) ?? (await gainOf(o, person, prefix, item, base));
        if (g) picks.push({ policy: policy.name, ...g, ...(note ? { note } : {}) });
      }
      out.push({ pid: person.pid, point, base, gains, picks });
    }
  }
  return out;
}

async function walkTo(o: BenchOptions, person: TwinPerson, steps: number): Promise<TwinItem[]> {
  const rng = seededRng(`${o.seed}:${o.reference.name}:${person.pid}`);
  const asked: TwinItem[] = [];
  let remaining = [...person.pool];
  for (let t = 0; t < Math.min(steps, person.pool.length); t++) {
    const item = await o.reference.next({
      person,
      asked,
      remaining,
      state: stateOf(person, asked),
      rng,
      jev: o.jev,
      pop: o.pop,
      posterior: null,
    });
    asked.push(item);
    remaining = remaining.filter((i) => i !== item);
  }
  return asked;
}

/** The batch a policy draws from at a bench point: the start of the measured batch (`b` from its spec; 0: all of it). */
const batchSizeOf = (policy: string, measured: number) => {
  try {
    const b = parsePolicySpec(policy).knobs.batch ?? POLICY_DEFAULTS.batch;
    return b > 0 ? Math.min(b, measured) : measured;
  } catch {
    return measured;
  }
};

export function analyzeBench(
  points: readonly BenchPoint[],
  o: Pick<BenchOptions, 'points' | 'batch' | 'seed'>,
  costUsd: number,
): BenchReport {
  const people = new Set(points.map((p) => p.pid));
  const collect = (f: (p: BenchPoint) => number | null) => {
    const m = new Map<string, number[]>();
    for (const p of points) {
      const v = f(p);
      if (v === null || !Number.isFinite(v)) continue;
      m.set(p.pid, [...(m.get(p.pid) ?? []), v]);
    }
    return m;
  };
  const sizes = [...new Set([6, 12, o.batch].filter((b) => b <= o.batch))].sort((a, b) => a - b);
  const oracle = sizes.map((b) => ({
    b,
    logLoss: personInterval(
      collect((p) => {
        const g = p.gains.slice(0, b);
        return Math.min(...g.map((x) => x.dLogLoss)) - mean(g.map((x) => x.dLogLoss));
      }),
      `${o.seed}:bench:oracle:${b}:ll`,
    ),
    acc: personInterval(
      collect((p) => {
        const g = p.gains.slice(0, b);
        return Math.max(...g.map((x) => x.dAcc)) - mean(g.map((x) => x.dAcc));
      }),
      `${o.seed}:bench:oracle:${b}:acc`,
    ),
  }));
  const randomGain = {
    logLoss: personInterval(
      collect((p) => mean(p.gains.map((x) => x.dLogLoss))),
      `${o.seed}:bench:rand:ll`,
    ),
    acc: personInterval(
      collect((p) => mean(p.gains.map((x) => x.dAcc))),
      `${o.seed}:bench:rand:acc`,
    ),
  };
  const policies = [...new Set(points.flatMap((p) => p.picks.map((x) => x.policy)))];
  const rows: BenchRow[] = policies.map((policy) => {
    const b = batchSizeOf(policy, o.batch);
    const pick = (p: BenchPoint) => p.picks.find((x) => x.policy === policy);
    const g = (p: BenchPoint) => p.gains.slice(0, b);
    let best = 0;
    let n = 0;
    for (const p of points) {
      const x = pick(p);
      if (!x) continue;
      n++;
      if (x.dLogLoss <= Math.min(...g(p).map((y) => y.dLogLoss)) + 1e-12) best++;
    }
    const seed = `${o.seed}:bench:${policy}`;
    return {
      policy,
      vsRandom: {
        logLoss: personInterval(
          collect((p) => {
            const x = pick(p);
            return x ? x.dLogLoss - mean(g(p).map((y) => y.dLogLoss)) : null;
          }),
          `${seed}:ll`,
        ),
        acc: personInterval(
          collect((p) => {
            const x = pick(p);
            return x ? x.dAcc - mean(g(p).map((y) => y.dAcc)) : null;
          }),
          `${seed}:acc`,
        ),
      },
      regret: {
        logLoss: personInterval(
          collect((p) => {
            const x = pick(p);
            return x ? x.dLogLoss - Math.min(...g(p).map((y) => y.dLogLoss)) : null;
          }),
          `${seed}:rll`,
        ),
        acc: personInterval(
          collect((p) => {
            const x = pick(p);
            return x ? Math.max(...g(p).map((y) => y.dAcc)) - x.dAcc : null;
          }),
          `${seed}:racc`,
        ),
      },
      bestShare: n ? best / n : 0,
    };
  });
  return { people: people.size, points: o.points, batch: o.batch, oracle, randomGain, rows, costUsd };
}

const ivs = (x: Interval, d = 4) =>
  `${x.mean >= 0 ? '+' : ''}${x.mean.toFixed(d)} [${x.ciLow >= 0 ? '+' : ''}${x.ciLow.toFixed(d)}, ${x.ciHigh >= 0 ? '+' : ''}${x.ciHigh.toFixed(d)}]`;
const ivp = (x: Interval) =>
  ivs({ ...x, mean: x.mean * 100, ciLow: x.ciLow * 100, ciHigh: x.ciHigh * 100 }, 2);

export function renderBench(r: BenchReport): string[] {
  const out = [
    `E10 bench: ${r.people} people, a pick after ${r.points.join(', ')} answers, ${r.batch} candidates measured at each (each one's one-step gain on the person's targets, tempered log loss and accuracy). Screening only; the full walks decide (docs/CHOOSER.md §4).`,
    '',
    `- A random pick's mean gain: log loss ${ivs(r.randomGain.logLoss)}, accuracy ${ivp(r.randomGain.acc)} points.`,
    '',
    '## Headroom: a perfect chooser against random (90% intervals by person)',
    '',
    '| Batch | Δ log loss | Δ accuracy, points |',
    '| --- | --- | --- |',
    ...r.oracle.map((x) => `| ${x.b} | ${ivs(x.logLoss)} | ${ivp(x.acc)} |`),
    '',
    '## Choosers against a random pick from the same batch',
    '',
    '| Policy | Δ log loss vs random | Δ accuracy vs random, points | Regret (log loss) | Regret (accuracy, points) | Picked the best |',
    '| --- | --- | --- | --- | --- | --- |',
    ...[...r.rows]
      .sort((a, b) => a.vsRandom.logLoss.mean - b.vsRandom.logLoss.mean)
      .map(
        (x) =>
          `| ${x.policy} | ${ivs(x.vsRandom.logLoss)} | ${ivp(x.vsRandom.acc)} | ${ivs(x.regret.logLoss)} | ${ivp(x.regret.acc)} | ${(x.bestShare * 100).toFixed(0)}% |`,
      ),
    '',
    `Spend: $${r.costUsd.toFixed(4)}.`,
  ];
  return out;
}

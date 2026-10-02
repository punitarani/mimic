import { seededRng, shuffle, temperatureScale } from '@mimic/core';
import { stateOf, type TwinItem, type TwinPerson } from './data';
import type { JevOracle } from './policies';

/**
 * Jev's own measure of what a question is worth (`jev-lift`, docs/CURVES.md §4): for a seeded sample of train people,
 * the change in Jev's log loss on their reference questions (R) when one candidate answer joins what is given,
 * against what is given alone. The population ranks which questions carry information; this asks whether Jev reads
 * it. Train people only, and only their R answers: a dev or test person's answers never choose a question.
 */

export interface LiftRow {
  key: string;
  /** Mean change in log loss on R (negative: the answer helps Jev). */
  lift: number;
  se: number;
  n: number;
}

export interface LiftOptions {
  train: readonly TwinPerson[];
  /** Item keys to measure. */
  candidates: readonly string[];
  jev: JevOracle;
  people: number;
  seed: string;
  /** Temperature on Jev's raw probabilities, as the Jev policies plan with. */
  tSel: number;
  concurrency: number;
}

/** Mean log loss of tempered predictions on the items' recorded answers; null when any prediction failed. */
function logLoss(items: readonly TwinItem[], dists: ReadonlyArray<Record<string, number> | null>, t: number) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const d = dists[i];
    if (!d) return null;
    const p = temperatureScale(d, t)[items[i]!.answer] ?? 0;
    total += -Math.log(Math.max(p, 1e-6));
  }
  return items.length ? total / items.length : null;
}

export async function jevLift(opts: LiftOptions): Promise<LiftRow[]> {
  const sample = shuffle([...opts.train], seededRng(`${opts.seed}:lift`)).slice(0, opts.people);
  const wanted = new Set(opts.candidates);
  const diffs = new Map<string, number[]>(opts.candidates.map((k) => [k, []]));
  let next = 0;
  const work = async () => {
    for (let i = next++; i < sample.length; i = next++) {
      const p = sample[i]!;
      const refs = p.reference;
      if (!refs.length) continue;
      const base = logLoss(refs, await opts.jev.predict(p.pid, stateOf(p, []), refs), opts.tSel);
      if (base === null) continue;
      const items = p.pool.filter((it) => wanted.has(it.key));
      const lls = await Promise.all(
        items.map(async (it) =>
          logLoss(refs, await opts.jev.predict(p.pid, stateOf(p, [it]), refs), opts.tSel),
        ),
      );
      items.forEach((it, j) => {
        const ll = lls[j];
        if (ll !== null && ll !== undefined) diffs.get(it.key)!.push(ll - base);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, work));
  return [...diffs]
    .filter(([, xs]) => xs.length > 0)
    .map(([key, xs]) => {
      const n = xs.length;
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
      return { key, lift: mean, se: n > 1 ? sd / Math.sqrt(n) : 0, n };
    })
    .sort((a, b) => a.lift - b.lift || a.key.localeCompare(b.key));
}

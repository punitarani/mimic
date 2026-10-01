import { describe, expect, it } from 'vitest';
import {
  cholesky,
  conditionalAnswer,
  drawKey,
  fitCopula,
  leakR2,
  nearest,
  normalCdf,
  normalInv,
  realism,
  sampleCopula,
  seededRng,
  solve,
} from '../src';

/** n people over 3 dims: the second tracks the first, the third is independent. */
function cohort(n: number, seed = 'cohort'): number[][] {
  const rng = seededRng(seed);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = rng();
    rows.push([a, Math.min(1, Math.max(0, 0.8 * a + 0.2 * rng())), rng()]);
  }
  return rows;
}

describe('population synthesis math (ADR-0055)', () => {
  it('inverts the normal CDF and factors a matrix', () => {
    for (const p of [0.001, 0.1, 0.5, 0.9, 0.999]) expect(normalCdf(normalInv(p))).toBeCloseTo(p, 5);
    const L = cholesky([
      [4, 2],
      [2, 3],
    ]);
    expect(L[0]![0]).toBeCloseTo(2);
    expect(L[1]![0]).toBeCloseTo(1);
    expect(L[1]![1]).toBeCloseTo(Math.sqrt(2));
    expect(
      solve(
        [
          [2, 1],
          [1, 3],
        ],
        [3, 5],
      ),
    ).toEqual([0.8, 1.4].map((x) => expect.closeTo(x, 9)));
  });

  it('fits a copula that keeps the marginals and the correlation structure, shrunk by the cohort size', () => {
    const dims = ['a', 'b', 'c'];
    const real = cohort(400);
    const fit = fitCopula(dims, real, { kappa: 0 });
    expect(fit.rawCorrelation[0]![1]).toBeGreaterThan(0.8);
    expect(Math.abs(fit.rawCorrelation[0]![2]!)).toBeLessThan(0.15);
    const synth = sampleCopula(fit, 2000, 'draw');
    const r = realism(dims, real, synth);
    for (const d of r.dims) {
      expect(d.dispersionRatio).toBeGreaterThan(0.85);
      expect(d.dispersionRatio).toBeLessThan(1.15);
      expect(d.caricature).toBeLessThan(0.15);
    }
    expect(r.structureDistance).toBeLessThan(0.1);
    // A small cohort exports its correlations only as far as the data support: weight n / (n + kappa).
    const small = fitCopula(dims, cohort(10), { kappa: 10 });
    expect(small.weight).toBeCloseTo(0.5);
    expect(Math.abs(small.correlation[0]![1]!)).toBeLessThan(Math.abs(small.rawCorrelation[0]![1]!) + 1e-9);
    // Deterministic from the seed.
    expect(sampleCopula(fit, 5, 'x')).toEqual(sampleCopula(fit, 5, 'x'));
    expect(sampleCopula(fit, 5, 'x')).not.toEqual(sampleCopula(fit, 5, 'y'));
  });

  it('skips missing values pairwise and tolerates constant dims', () => {
    const rows = cohort(50).map((r, i) => (i % 3 === 0 ? [Number.NaN, r[1]!, 0.5] : [r[0]!, r[1]!, 0.5]));
    const fit = fitCopula(['a', 'b', 'c'], rows, { kappa: 0 });
    expect(fit.marginals[0]!.length).toBe(rows.filter((r) => Number.isFinite(r[0]!)).length);
    expect(fit.rawCorrelation[0]![1]).toBeGreaterThan(0.5);
    const synth = sampleCopula(fit, 20, 's');
    expect(synth.every((r) => r.every((x) => Number.isFinite(x)))).toBe(true);
    expect(synth.every((r) => r[2] === 0.5)).toBe(true);
  });

  it('measures identifiability and coverage against the real cohort', () => {
    const dims = ['a', 'b', 'c'];
    const real = cohort(30);
    // A synthetic population that copies the cohort re-identifies everyone; one far away covers no one.
    const copy = realism(dims, real, real);
    expect(copy.identifiability).toBe(1);
    expect(copy.coverage).toBe(1);
    const far = realism(
      dims,
      real,
      real.map((r) => r.map((x) => x + 10)),
    );
    expect(far.identifiability).toBe(0);
    expect(far.coverage).toBe(0);
    expect(
      nearest(
        [0, 0, 0],
        [
          [1, 1, 1],
          [0.1, 0, 0],
          [0.5, 0.5, 0.5],
        ],
        2,
      ),
    ).toEqual([1, 2]);
  });

  it('finds linear leakage and draws answers from neighbours shrunk toward the population', () => {
    const rng = seededRng('leak');
    const rows = Array.from({ length: 40 }, () => {
      const a = rng();
      const b = rng();
      return [a, b, 0.5 * a + 0.5 * b, rng()];
    });
    expect(leakR2(rows, [0, 1], 2)).toBeGreaterThan(0.9);
    expect(leakR2(rows, [0, 1], 3)).toBeLessThan(0.3);
    const dist = conditionalAnswer(['a', 'a', 'b'], ['a', 'b', 'b', 'b', 'c'], ['a', 'b', 'c'], 2);
    expect(dist.a!).toBeGreaterThan(dist.b!);
    expect(dist.b!).toBeGreaterThan(dist.c!);
    expect(dist.a! + dist.b! + dist.c!).toBeCloseTo(1);
    const draws = Array.from({ length: 200 }, () => drawKey(dist, rng));
    expect(draws.filter((d) => d === 'a').length).toBeGreaterThan(draws.filter((d) => d === 'c').length);
  });
});

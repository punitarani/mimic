import { seededRng } from './hash';
import { pearson } from './metrics';

/**
 * Population synthesis and realism metrics (ADR-0059): the pure math behind `pnpm eval -- population`. Everything
 * here is deterministic given a seed and works on numbers only; what the numbers mean (facets, people, consent) is
 * the eval command's business. No cross-person data leaves this module except as aggregates (PLAN §3.8): a
 * correlation matrix, marginals and sampled vectors.
 *
 * The model is a Gaussian copula over facet means in [0, 1]: each person's facet vector is mapped to normal scores
 * by its empirical rank, a correlation matrix is estimated and shrunk toward the identity (or a supplied norm), new
 * vectors are drawn and mapped back through the empirical marginals. Small cohorts therefore export their marginals
 * faithfully and their correlation structure only as far as the data support it (James–Stein style shrinkage with
 * weight n / (n + κ)).
 */

export interface CopulaFit {
  dims: string[];
  n: number;
  /** Sorted sample per dimension: the empirical marginal. */
  marginals: number[][];
  /** Shrunk correlation matrix, row-major dims × dims. */
  correlation: number[][];
  /** The raw (unshrunk) correlation, for the structure-distance metrics. */
  rawCorrelation: number[][];
  /** Shrinkage weight applied to the raw correlation (the rest comes from the prior). */
  weight: number;
  /** Lower-triangular Cholesky factor of `correlation`. */
  chol: number[][];
}

/** Inverse normal CDF (Acklam's rational approximation; relative error about 1e-9). */
export function normalInv(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [
    -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472,
    2.50662827745924,
  ];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497,
    2.93816398269878,
  ];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const lo = 0.02425;
  const hi = 1 - lo;
  let q: number;
  if (p < lo) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > hi) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; absolute error under 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x >= 0 ? y : -y));
}

/** A standard normal draw from a unit RNG (Box–Muller). */
export function normalDraw(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Mid-rank of x among xs, as a probability in (0, 1): the empirical CDF with a ½ offset (van der Waerden). */
export function rankScore(x: number, sorted: number[]): number {
  let below = 0;
  let equal = 0;
  for (const y of sorted) {
    if (y < x) below++;
    else if (y === x) equal++;
  }
  return (below + equal / 2 + 0.5) / (sorted.length + 1);
}

/** Inverse of the empirical marginal at probability p (linear interpolation between order statistics). */
export function quantileOf(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = Math.min(sorted.length - 1, Math.max(0, p * sorted.length - 0.5));
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Cholesky factor of a symmetric positive-definite matrix; a tiny ridge keeps near-singular matrices factorable. */
export function cholesky(m: number[][]): number[][] {
  const n = m.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) L[i]![j] = Math.sqrt(Math.max(s, 1e-9));
      else L[i]![j] = s / L[j]![j]!;
    }
  }
  return L;
}

export interface CopulaOptions {
  /** Prior weight in people: the raw correlation gets weight n / (n + kappa); default 10. */
  kappa?: number;
  /** Prior correlation to shrink toward, dims × dims; the identity when absent. */
  prior?: number[][];
}

/** Fits the copula to a matrix of people × dims (values in [0, 1]; a missing value is NaN and skipped per pair). */
export function fitCopula(dims: string[], rows: number[][], opts: CopulaOptions = {}): CopulaFit {
  const n = rows.length;
  const d = dims.length;
  const kappa = opts.kappa ?? 10;
  const marginals = dims.map((_, j) =>
    rows
      .map((r) => r[j]!)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b),
  );
  // Normal scores per person and dim; NaN where missing.
  const z = rows.map((r) =>
    r.map((x, j) => (Number.isFinite(x) ? normalInv(rankScore(x, marginals[j]!)) : Number.NaN)),
  );
  const raw = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i++) {
    raw[i]![i] = 1;
    for (let j = i + 1; j < d; j++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of z) {
        if (Number.isFinite(r[i]!) && Number.isFinite(r[j]!)) {
          xs.push(r[i]!);
          ys.push(r[j]!);
        }
      }
      const c = pearson(xs, ys) ?? 0;
      raw[i]![j] = c;
      raw[j]![i] = c;
    }
  }
  const weight = n / (n + kappa);
  const prior =
    opts.prior ?? Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? 1 : 0)));
  const correlation = raw.map((row, i) =>
    row.map((c, j) => (i === j ? 1 : weight * c + (1 - weight) * (prior[i]?.[j] ?? 0))),
  );
  return { dims, n, marginals, correlation, rawCorrelation: raw, weight, chol: cholesky(correlation) };
}

/** Draws `m` facet vectors from the fitted copula, each a row over `fit.dims` in the data's own marginals. */
export function sampleCopula(fit: CopulaFit, m: number, seed: string): number[][] {
  const rng = seededRng(seed);
  const d = fit.dims.length;
  const out: number[][] = [];
  for (let s = 0; s < m; s++) {
    const e = Array.from({ length: d }, () => normalDraw(rng));
    const row: number[] = [];
    for (let i = 0; i < d; i++) {
      let zi = 0;
      for (let k = 0; k <= i; k++) zi += fit.chol[i]![k]! * e[k]!;
      row.push(quantileOf(fit.marginals[i]!, normalCdf(zi)));
    }
    out.push(row);
  }
  return out;
}

/** Euclidean distance over the dims both rows have. */
export function distance(a: number[], b: number[]): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!Number.isFinite(a[i]!) || !Number.isFinite(b[i]!)) continue;
    s += (a[i]! - b[i]!) ** 2;
    n++;
  }
  return n ? Math.sqrt(s / n) : Number.POSITIVE_INFINITY;
}

/** The k nearest rows of `pool` to `x`, by index, closest first. */
export function nearest(x: number[], pool: number[][], k: number): number[] {
  return pool
    .map((p, i) => ({ i, d: distance(x, p) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, k)
    .map((r) => r.i);
}

// ---------------------------------------------------------------------------------------------------------------
// Realism metrics
// ---------------------------------------------------------------------------------------------------------------

export interface RealismMetrics {
  /** Per dim: real mean and SD, synthetic mean and SD, dispersion ratio (synthetic SD / real SD), caricature index. */
  dims: Array<{
    dim: string;
    realMean: number;
    realSd: number;
    synthMean: number;
    synthSd: number;
    dispersionRatio: number;
    /** |synthetic mean − real mean| / real SD: exaggeration of the dim. */
    caricature: number;
  }>;
  /** Mean dispersion ratio over dims (1 is right; below 1 is the under-dispersion that twins show). */
  meanDispersionRatio: number;
  /** Frobenius distance between the synthetic and the raw real correlation matrices, per off-diagonal entry. */
  structureDistance: number;
  /** Share of real people whose nearest synthetic neighbour is closer than their nearest real neighbour. */
  coverage: number;
  /**
   * Re-identification: share of real people whose single nearest synthetic agent is closer than any other real
   * person to them; a value near 1 means the synthetic population copies individuals, near 0 that it ignores them.
   */
  identifiability: number;
}

function meanSd(xs: number[]): { mean: number; sd: number } {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { mean: 0, sd: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean, sd };
}

export function realism(dims: string[], real: number[][], synth: number[][]): RealismMetrics {
  const rows = dims.map((dim, j) => {
    const r = meanSd(real.map((x) => x[j]!));
    const s = meanSd(synth.map((x) => x[j]!));
    return {
      dim,
      realMean: r.mean,
      realSd: r.sd,
      synthMean: s.mean,
      synthSd: s.sd,
      dispersionRatio: r.sd > 0 ? s.sd / r.sd : 1,
      caricature: r.sd > 0 ? Math.abs(s.mean - r.mean) / r.sd : 0,
    };
  });
  const rawReal = fitCopula(dims, real, { kappa: 0 }).rawCorrelation;
  const rawSynth = fitCopula(dims, synth, { kappa: 0 }).rawCorrelation;
  let sq = 0;
  let pairs = 0;
  for (let i = 0; i < dims.length; i++)
    for (let j = i + 1; j < dims.length; j++) {
      sq += (rawReal[i]![j]! - rawSynth[i]![j]!) ** 2;
      pairs++;
    }
  let covered = 0;
  let identified = 0;
  for (let i = 0; i < real.length; i++) {
    const others = real.filter((_, k) => k !== i);
    const dReal = others.length
      ? Math.min(...others.map((o) => distance(real[i]!, o)))
      : Number.POSITIVE_INFINITY;
    const dSynth = synth.length
      ? Math.min(...synth.map((s) => distance(real[i]!, s)))
      : Number.POSITIVE_INFINITY;
    if (dSynth <= dReal) covered++;
    if (dSynth < dReal) identified++;
  }
  return {
    dims: rows,
    meanDispersionRatio: rows.length ? rows.reduce((a, r) => a + r.dispersionRatio, 0) / rows.length : 1,
    structureDistance: pairs ? Math.sqrt(sq / pairs) : 0,
    coverage: real.length ? covered / real.length : 0,
    identifiability: real.length ? identified / real.length : 0,
  };
}

/**
 * How well a set of dims predicts another linearly, as a cross-validated R² (leave-one-out ridge): used to check
 * that a synthetic population leaks no more about sensitive facets from the others than the real cohort does.
 */
export function leakR2(rows: number[][], from: number[], to: number, ridge = 1): number {
  const data = rows.filter((r) => Number.isFinite(r[to]!) && from.every((j) => Number.isFinite(r[j]!)));
  const n = data.length;
  if (n < 4) return 0;
  const yMean = data.reduce((a, r) => a + r[to]!, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let hold = 0; hold < n; hold++) {
    const train = data.filter((_, i) => i !== hold);
    const w = ridgeFit(
      train.map((r) => from.map((j) => r[j]!)),
      train.map((r) => r[to]!),
      ridge,
    );
    const x = from.map((j) => data[hold]![j]!);
    const pred = w[0]! + x.reduce((a, v, i) => a + v * w[i + 1]!, 0);
    ssRes += (data[hold]![to]! - pred) ** 2;
    ssTot += (data[hold]![to]! - yMean) ** 2;
  }
  return ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
}

/** Ridge regression with an intercept (unpenalised): returns [b0, b1..bd]. */
export function ridgeFit(X: number[][], y: number[], ridge: number): number[] {
  const d = X[0]?.length ?? 0;
  const n = X.length;
  // Normal equations on centred data.
  const xm = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j]!, 0) / n);
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < d; j++) {
      const xj = X[i]![j]! - xm[j]!;
      b[j]! += xj * (y[i]! - ym);
      for (let k = 0; k < d; k++) A[j]![k]! += xj * (X[i]![k]! - xm[k]!);
    }
  for (let j = 0; j < d; j++) A[j]![j]! += ridge;
  const w = solve(A, b);
  const b0 = ym - w.reduce((a, wj, j) => a + wj * xm[j]!, 0);
  return [b0, ...w];
}

/** Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const pivot = M[c]![c]!;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / pivot;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** Smoothed answer frequencies over the k nearest exemplars, shrunk toward the population's (weight `prior`). */
export function conditionalAnswer(
  neighbourAnswers: string[],
  populationAnswers: string[],
  keys: string[],
  prior: number,
): Record<string, number> {
  const count = (xs: string[]) => {
    const c: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const x of xs) if (x in c) c[x]!++;
    return c;
  };
  const nb = count(neighbourAnswers);
  const pop = count(populationAnswers);
  const nN = neighbourAnswers.length;
  const nP = populationAnswers.length || 1;
  const out: Record<string, number> = {};
  let total = 0;
  for (const k of keys) {
    const v = nb[k]! + prior * (pop[k]! / nP) + 1e-3;
    out[k] = v;
    total += v;
  }
  for (const k of keys) out[k] = out[k]! / (total || 1);
  void nN;
  return out;
}

/** Draws one key from a distribution with a unit RNG. */
export function drawKey(dist: Record<string, number>, rng: () => number): string {
  let u = rng();
  const entries = Object.entries(dist);
  for (const [k, p] of entries) {
    u -= p;
    if (u <= 0) return k;
  }
  return entries.at(-1)![0];
}

import { seededRng } from '@mimic/core';
import type { TwinItem, TwinPerson } from './data';
import type { Population } from './population';

/**
 * A latent-class model of the train people (docs/CURVES.md §4): K classes, each a distribution over every item's
 * options, fitted by EM. It stands in for the train people themselves in the persona posterior, so what selection
 * needs is aggregate only (K profiles, no person's answers), the form production could ship beside `item_stats`.
 * Selection only, as with the population: nothing here reaches a prompt or a state (invariant 8).
 */

export interface ClassModel {
  k: number;
  /** Item keys the model covers, and each one's number of options. */
  keys: string[];
  options: number[];
  /** Class weights (sum to 1). */
  weights: number[];
  /** theta[c][i][a]: class c's probability of option a on item i. */
  theta: number[][][];
  /** Mean log likelihood per train person at the end of fitting. */
  logLik: number;
}

export interface FitOptions {
  k: number;
  seed: string;
  iters?: number;
  /** Dirichlet smoothing per option, in answers. */
  alpha?: number;
  /** Stop when the mean log likelihood per person improves by less than this. */
  tol?: number;
}

/**
 * Fits the classes on train people's coded answers to `keys` (as `pop` codes them). Deterministic for a seed: the
 * responsibilities start from a seeded random split and EM runs to `tol` or `iters`.
 */
export function fitClasses(pop: Population, keys: readonly string[], opts: FitOptions): ClassModel {
  const K = opts.k;
  const alpha = opts.alpha ?? 0.5;
  const items = keys.map((key) => pop.item(key)).filter((x) => x !== undefined);
  const kept = keys.filter((key) => pop.item(key));
  const n = pop.n;
  const rng = seededRng(`${opts.seed}:classes:${K}`);
  // Responsibilities r[j * K + c], from a seeded random start.
  const r = new Float64Array(n * K);
  for (let j = 0; j < n; j++) {
    let z = 0;
    for (let c = 0; c < K; c++) {
      const x = 0.5 + rng();
      r[j * K + c] = x;
      z += x;
    }
    for (let c = 0; c < K; c++) r[j * K + c]! /= z;
  }
  const weights = new Float64Array(K);
  const theta = items.map((it) => new Float64Array(K * it.k));
  let logLik = Number.NEGATIVE_INFINITY;
  for (let iter = 0; iter < (opts.iters ?? 200); iter++) {
    // M step.
    weights.fill(0);
    for (let j = 0; j < n; j++) for (let c = 0; c < K; c++) weights[c]! += r[j * K + c]!;
    for (let c = 0; c < K; c++) weights[c] = (weights[c]! + 1) / (n + K);
    items.forEach((it, i) => {
      const t = theta[i]!;
      t.fill(alpha);
      for (let j = 0; j < n; j++) {
        const a = it.codes[j]!;
        if (a < 0) continue;
        for (let c = 0; c < K; c++) t[c * it.k + a]! += r[j * K + c]!;
      }
      for (let c = 0; c < K; c++) {
        let z = 0;
        for (let a = 0; a < it.k; a++) z += t[c * it.k + a]!;
        for (let a = 0; a < it.k; a++) t[c * it.k + a]! /= z;
      }
    });
    // E step, in logs.
    const logT = theta.map((t) => t.map(Math.log));
    const logW = Array.from(weights, Math.log);
    let total = 0;
    const lp = new Float64Array(K);
    for (let j = 0; j < n; j++) {
      for (let c = 0; c < K; c++) lp[c] = logW[c]!;
      items.forEach((it, i) => {
        const a = it.codes[j]!;
        if (a < 0) return;
        const lt = logT[i]!;
        for (let c = 0; c < K; c++) lp[c]! += lt[c * it.k + a]!;
      });
      let max = Number.NEGATIVE_INFINITY;
      for (let c = 0; c < K; c++) if (lp[c]! > max) max = lp[c]!;
      let z = 0;
      for (let c = 0; c < K; c++) {
        const x = Math.exp(lp[c]! - max);
        r[j * K + c] = x;
        z += x;
      }
      for (let c = 0; c < K; c++) r[j * K + c]! /= z;
      total += max + Math.log(z);
    }
    const ll = total / n;
    const done = ll - logLik < (opts.tol ?? 1e-4);
    logLik = ll;
    if (done) break;
  }
  return {
    k: K,
    keys: kept,
    options: items.map((it) => it.k),
    weights: Array.from(weights),
    theta: Array.from({ length: K }, (_, c) =>
      items.map((it, i) => Array.from(theta[i]!.subarray(c * it.k, (c + 1) * it.k))),
    ),
    logLik,
  };
}

/** The item keys a class model is fitted on: what a policy may ask and the reference, never the scored targets. */
export const classKeys = (train: readonly TwinPerson[]) => [
  ...new Set(train.flatMap((p) => [...p.given, ...p.pool, ...p.reference].map((i) => i.key))),
];

const entropy = (p: ArrayLike<number>) => {
  let h = 0;
  for (let i = 0; i < p.length; i++) if (p[i]! > 0) h -= p[i]! * Math.log(p[i]!);
  return h;
};

function mutualInformation(joint: Float64Array, rows: number, cols: number): number {
  const pr = new Float64Array(rows);
  const pc = new Float64Array(cols);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      pr[i]! += joint[i * cols + j]!;
      pc[j]! += joint[i * cols + j]!;
    }
  let mi = 0;
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const x = joint[i * cols + j]!;
      if (x > 1e-15) mi += x * Math.log(x / (pr[i]! * pc[j]!));
    }
  return Math.max(0, mi);
}

/**
 * The persona posterior over classes instead of train people: w_c ∝ π_c Π θ_c(a)^β. Same interface and the same
 * closed forms as `PersonaPosterior`, with each class's answer distribution in place of a train person's emission.
 */
export class ClassPosterior {
  private readonly index: Map<string, number>;
  private readonly logw: Float64Array;

  constructor(
    private readonly model: ClassModel,
    readonly beta = 1,
  ) {
    this.index = new Map(model.keys.map((k, i) => [k, i]));
    this.logw = Float64Array.from(model.weights, Math.log);
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  /** The option index of an item's answer (option order as the model was fitted). */
  indexOf(it: Pick<TwinItem, 'key' | 'options' | 'answer'>): number {
    const i = this.index.get(it.key);
    if (i === undefined) return -1;
    const idx = it.options.findIndex((o) => o.key === it.answer);
    return idx < this.model.options[i]! ? idx : -1;
  }

  observe(key: string, v: number): void {
    const i = this.index.get(key);
    if (i === undefined || v < 0 || v >= this.model.options[i]!) return;
    for (let c = 0; c < this.model.k; c++)
      this.logw[c]! += this.beta * Math.log(this.model.theta[c]![i]![v]!);
  }

  weights(): Float64Array {
    let max = Number.NEGATIVE_INFINITY;
    for (const x of this.logw) if (x > max) max = x;
    const w = new Float64Array(this.model.k);
    let z = 0;
    for (let c = 0; c < w.length; c++) {
      w[c] = Math.exp(this.logw[c]! - max);
      z += w[c]!;
    }
    for (let c = 0; c < w.length; c++) w[c] = w[c]! / z;
    return w;
  }

  predictive(key: string, w = this.weights()): Float64Array | null {
    const i = this.index.get(key);
    if (i === undefined) return null;
    const p = new Float64Array(this.model.options[i]!);
    for (let c = 0; c < this.model.k; c++) {
      const row = this.model.theta[c]![i]!;
      for (let a = 0; a < p.length; a++) p[a]! += w[c]! * row[a]!;
    }
    return p;
  }

  /** Σ_r I(A_c; A_r) under the class mixture: both answers drawn from the same class. */
  eig(candidate: string, reference: readonly string[], w = this.weights()): number {
    const ci = this.index.get(candidate);
    if (ci === undefined) return 0;
    const kc = this.model.options[ci]!;
    let total = 0;
    for (const ref of reference) {
      const ri = this.index.get(ref);
      if (ri === undefined || ri === ci) continue;
      const kr = this.model.options[ri]!;
      const joint = new Float64Array(kc * kr);
      for (let c = 0; c < this.model.k; c++) {
        const wc = w[c]!;
        if (wc < 1e-12) continue;
        const pc = this.model.theta[c]![ci]!;
        const pr = this.model.theta[c]![ri]!;
        for (let v = 0; v < kc; v++) {
          const x = wc * pc[v]!;
          for (let u = 0; u < kr; u++) joint[v * kr + u]! += x * pr[u]!;
        }
      }
      total += mutualInformation(joint, kc, kr);
    }
    return total;
  }

  /** I(A_c; class): how much the answer says about which class the person is in. */
  identity(candidate: string, w = this.weights()): number {
    const i = this.index.get(candidate);
    if (i === undefined) return 0;
    const p = this.predictive(candidate, w)!;
    let cond = 0;
    for (let c = 0; c < this.model.k; c++) cond += w[c]! * entropy(this.model.theta[c]![i]!);
    return Math.max(0, entropy(p) - cond);
  }
}

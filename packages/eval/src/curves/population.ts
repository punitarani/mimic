import { type QType, seededRng, shuffle } from '@mimic/core';
import type { TwinItem, TwinPerson } from './data';

/**
 * A population model for selection only (docs/CURVES.md §4, ADR-0071): train people's answers, as option indices,
 * and a persona posterior over them. A person's answers so far weight the train people who answered alike; the
 * expected information an item's answer carries about the reference questions follows in closed form. Nothing here
 * reaches a prompt or a state (invariant 8): it only orders the pool, as `item_stats` ranks candidates.
 */

export interface PopulationOptions {
  /** Answer noise: a train person's answer predicts the same answer with 1 − ε, any option with ε/K. */
  eps: number;
  /** Spread of a scale's emission over neighbouring levels (in levels); 0 makes scales exact like choices. */
  scaleSigma: number;
}

export const POPULATION_DEFAULTS: PopulationOptions = { eps: 0.15, scaleSigma: 0.6 };

interface ItemCodes {
  type: QType;
  k: number;
  /** Per train person: the answer's option index, or −1 when they have none. */
  codes: Int8Array;
  /** k × k, row a: the distribution of an answer given a train person answered a (rows sum to 1). */
  emission: Float64Array;
}

export class Population {
  readonly n: number;
  private readonly items = new Map<string, ItemCodes>();

  constructor(
    train: readonly TwinPerson[],
    readonly opts: PopulationOptions = POPULATION_DEFAULTS,
  ) {
    this.n = train.length;
    const optionOrder = new Map<string, { type: QType; keys: string[] }>();
    const all = (p: TwinPerson) => [...p.given, ...p.pool, ...p.reference, ...p.targets];
    for (const p of train)
      for (const it of all(p))
        if (!optionOrder.has(it.key))
          optionOrder.set(it.key, { type: it.type, keys: it.options.map((o) => o.key) });
    for (const [key, o] of optionOrder) {
      const k = o.keys.length;
      this.items.set(key, {
        type: o.type,
        k,
        codes: new Int8Array(this.n).fill(-1),
        emission: emissionMatrix(o.type, k, opts),
      });
    }
    train.forEach((p, j) => {
      for (const it of all(p)) {
        const c = this.items.get(it.key)!;
        const idx = optionOrder.get(it.key)!.keys.indexOf(it.answer);
        if (idx >= 0 && idx < c.k && it.type === c.type) c.codes[j] = idx;
      }
    });
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  item(key: string): ItemCodes | undefined {
    return this.items.get(key);
  }

  /** The option index of an answer key for this item, as the train people were coded. */
  indexOf(it: Pick<TwinItem, 'key' | 'options' | 'answer'>): number {
    const c = this.items.get(it.key);
    if (!c) return -1;
    const idx = it.options.findIndex((o) => o.key === it.answer);
    return idx < c.k ? idx : -1;
  }
}

function emissionMatrix(type: QType, k: number, opts: PopulationOptions): Float64Array {
  const e = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    const row = new Float64Array(k);
    if (type === 'score' && opts.scaleSigma > 0) {
      let z = 0;
      for (let v = 0; v < k; v++) {
        row[v] = Math.exp(-((a - v) ** 2) / (2 * opts.scaleSigma ** 2));
        z += row[v]!;
      }
      for (let v = 0; v < k; v++) row[v] = row[v]! / z;
    } else row[a] = 1;
    for (let v = 0; v < k; v++) e[a * k + v] = (1 - opts.eps) * row[v]! + opts.eps / k;
  }
  return e;
}

/** Mutual information of a joint table (rows × cols, summing to 1), in nats. */
function mutualInformation(joint: Float64Array, rows: number, cols: number): number {
  const pr = new Float64Array(rows);
  const pc = new Float64Array(cols);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const x = joint[i * cols + j]!;
      pr[i]! += x;
      pc[j]! += x;
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
 * What a policy selects with: a posterior over train people (`PersonaPosterior`) or over latent classes of them
 * (`ClassPosterior`, `classes.ts`), with the same closed forms.
 */
export interface Posterior {
  readonly beta: number;
  has(key: string): boolean;
  /** The option index of an item's answer, as the posterior codes it (−1 when it can't). */
  indexOf(it: Pick<TwinItem, 'key' | 'options' | 'answer'>): number;
  observe(key: string, v: number): void;
  weights(): Float64Array;
  predictive(key: string, w?: Float64Array): Float64Array | null;
  /** Σ_r I(A_candidate; A_r): information about the reference. */
  eig(candidate: string, reference: readonly string[], w?: Float64Array): number;
  /** I(A_candidate; who they answer like): information about the person. */
  identity(candidate: string, w?: Float64Array): number;
}

/**
 * Weights over the train people for one person, updated by each of their answers: w_j ∝ Π E[a_j][v]. A train person
 * without an answer to the item keeps their weight. `exclude` drops one train person (a probe scoring itself).
 */
export class PersonaPosterior implements Posterior {
  private readonly logw: Float64Array;

  /**
   * `beta` tempers the likelihood (w_j ∝ Π E^β): below 1 the posterior concentrates more slowly, so a few look-alike
   * train people don't take all the weight (docs/RESEARCH.md §1.7, calibrate before planning).
   */
  constructor(
    private readonly pop: Population,
    exclude?: number,
    readonly beta = 1,
  ) {
    this.logw = new Float64Array(pop.n);
    if (exclude !== undefined) this.logw[exclude] = Number.NEGATIVE_INFINITY;
  }

  has(key: string): boolean {
    return this.pop.has(key);
  }

  indexOf(it: Pick<TwinItem, 'key' | 'options' | 'answer'>): number {
    return this.pop.indexOf(it);
  }

  identity(candidate: string, w = this.weights()): number {
    return identityGain(this, this.pop, candidate, w);
  }

  clone(): PersonaPosterior {
    const c = new PersonaPosterior(this.pop, undefined, this.beta);
    c.logw.set(this.logw);
    return c;
  }

  /** Conditions on an answer (an option index); unknown items and answers change nothing. */
  observe(key: string, v: number): void {
    const c = this.pop.item(key);
    if (!c || v < 0 || v >= c.k) return;
    for (let j = 0; j < this.pop.n; j++) {
      const a = c.codes[j]!;
      if (a >= 0) this.logw[j]! += this.beta * Math.log(c.emission[a * c.k + v]!);
    }
  }

  weights(): Float64Array {
    let max = Number.NEGATIVE_INFINITY;
    for (const x of this.logw) if (x > max) max = x;
    const w = new Float64Array(this.pop.n);
    if (!Number.isFinite(max)) return w;
    let z = 0;
    for (let j = 0; j < w.length; j++) {
      w[j] = Math.exp(this.logw[j]! - max);
      z += w[j]!;
    }
    for (let j = 0; j < w.length; j++) w[j] = w[j]! / z;
    return w;
  }

  /** The predictive distribution of an item's answer (option indices). */
  predictive(key: string, w = this.weights()): Float64Array | null {
    const c = this.pop.item(key);
    if (!c) return null;
    const p = new Float64Array(c.k);
    for (let j = 0; j < this.pop.n; j++) {
      const wj = w[j]!;
      if (!wj) continue;
      const a = c.codes[j]!;
      if (a < 0) for (let u = 0; u < c.k; u++) p[u]! += wj / c.k;
      else for (let u = 0; u < c.k; u++) p[u]! += wj * c.emission[a * c.k + u]!;
    }
    return p;
  }

  /**
   * Expected information gain of asking `candidate` about the reference items: Σ_r I(A_c; A_r) under the posterior
   * mixture, where both answers are drawn through their emissions from the same train person. Closed form over the
   * train people, grouped by their answer to the candidate.
   */
  eig(candidate: string, reference: readonly string[], w = this.weights()): number {
    const c = this.pop.item(candidate);
    if (!c) return 0;
    const refs = reference.map((r) => this.pop.item(r)).filter((x): x is ItemCodes => !!x);
    if (!refs.length) return 0;
    const groups = c.k + 1; // group 0: no answer to the candidate
    const kMax = Math.max(...refs.map((r) => r.k));
    const counts = new Float64Array(groups * refs.length * kMax);
    const missing = new Float64Array(groups * refs.length);
    const groupW = new Float64Array(groups);
    for (let j = 0; j < this.pop.n; j++) {
      const wj = w[j]!;
      if (wj < 1e-12) continue;
      const g = c.codes[j]! + 1;
      groupW[g]! += wj;
      for (let r = 0; r < refs.length; r++) {
        const a = refs[r]!.codes[j]!;
        if (a >= 0) counts[(g * refs.length + r) * kMax + a]! += wj;
        else missing[g * refs.length + r]! += wj;
      }
    }
    let total = 0;
    for (let r = 0; r < refs.length; r++) {
      const ref = refs[r]!;
      const joint = new Float64Array(c.k * ref.k);
      for (let g = 0; g < groups; g++) {
        if (!groupW[g]) continue;
        // The reference answer's distribution within this group, through its emission.
        const s = new Float64Array(ref.k);
        for (let a = 0; a < ref.k; a++) {
          const x = counts[(g * refs.length + r) * kMax + a]!;
          if (x) for (let u = 0; u < ref.k; u++) s[u]! += x * ref.emission[a * ref.k + u]!;
        }
        const m = missing[g * refs.length + r]!;
        if (m) for (let u = 0; u < ref.k; u++) s[u]! += m / ref.k;
        for (let v = 0; v < c.k; v++) {
          const ev = g === 0 ? 1 / c.k : c.emission[(g - 1) * c.k + v]!;
          for (let u = 0; u < ref.k; u++) joint[v * ref.k + u]! += ev * s[u]!;
        }
      }
      total += mutualInformation(joint, c.k, ref.k);
    }
    return total;
  }
}

/**
 * Information about the person rather than about any decision (`ref=id`): I(A_c; J), the mutual information between
 * the item's answer and which train person they answer like, H(Σ_j w_j E_j) − Σ_j w_j H(E_j). A train person without
 * an answer to the item emits uniformly.
 */
export function identityGain(
  post: PersonaPosterior,
  pop: Population,
  key: string,
  w = post.weights(),
): number {
  const c = pop.item(key);
  if (!c) return 0;
  const p = post.predictive(key, w);
  if (!p) return 0;
  const h = (row: ArrayLike<number>) => {
    let x = 0;
    for (let u = 0; u < row.length; u++) if (row[u]! > 0) x -= row[u]! * Math.log(row[u]!);
    return x;
  };
  const rowH = Array.from({ length: c.k }, (_, a) => h(c.emission.subarray(a * c.k, (a + 1) * c.k)));
  const uniformH = Math.log(c.k);
  let cond = 0;
  for (let j = 0; j < pop.n; j++) {
    const wj = w[j]!;
    if (!wj) continue;
    const a = c.codes[j]!;
    cond += wj * (a >= 0 ? rowH[a]! : uniformH);
  }
  return Math.max(0, h(p) - cond);
}

/**
 * The best fixed questionnaire for the population (`pop-static`): greedy, each next item the one with the highest
 * expected information about the reference, averaged over probe train people who answer it as they did, each scored
 * against everyone else. The same sequence for everyone, chosen without any dev or test answer.
 */
export function staticSequence(
  pop: Population,
  train: readonly TwinPerson[],
  reference: readonly string[],
  opts: { steps: number; probes: number; seed: string; beta?: number },
): string[] {
  const probes = shuffle(
    train.map((_, j) => j),
    seededRng(`${opts.seed}:static`),
  ).slice(0, Math.min(opts.probes, train.length));
  const posts = probes.map((j) => new PersonaPosterior(pop, j, opts.beta ?? 1));
  const poolKeys = [...new Set(train.flatMap((p) => p.pool.map((i) => i.key)))].filter((k) => pop.has(k));
  const seq: string[] = [];
  for (let t = 0; t < Math.min(opts.steps, poolKeys.length); t++) {
    const ws = posts.map((p) => p.weights());
    let best = '';
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const key of poolKeys) {
      if (seq.includes(key)) continue;
      let s = 0;
      posts.forEach((p, i) => {
        s += p.eig(key, reference, ws[i]);
      });
      if (s > bestScore + 1e-12) {
        bestScore = s;
        best = key;
      }
    }
    seq.push(best);
    probes.forEach((j, i) => {
      const code = pop.item(best)!.codes[j]!;
      if (code >= 0) posts[i]!.observe(best, code);
    });
  }
  return seq;
}

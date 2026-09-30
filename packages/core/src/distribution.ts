import type { Distribution, Question } from './types';

export const P_FLOOR = 1e-4;

/** Normalize, clip to [1e-4, 1], renormalize (PLAN §9.6). Missing keys get the floor; unknown keys are dropped. */
export function normalizeDist(raw: Record<string, number>, keys: readonly string[]): Distribution {
  const vals = keys.map((k) => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  });
  const sum = vals.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? vals.map((v) => v / sum) : vals.map(() => 1 / keys.length);
  const clipped = base.map((v) => Math.min(1, Math.max(P_FLOOR, v)));
  const s2 = clipped.reduce((a, b) => a + b, 0);
  const out: Distribution = {};
  keys.forEach((k, i) => {
    out[k] = clipped[i]! / s2;
  });
  return out;
}

export function uniform(keys: readonly string[]): Distribution {
  return Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
}

export function argmax(dist: Distribution): string {
  let best = '';
  let bestP = -1;
  for (const [k, p] of Object.entries(dist)) {
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

/** Shannon entropy in nats. */
export function entropy(dist: Distribution): number {
  let h = 0;
  for (const p of Object.values(dist)) if (p > 0) h -= p * Math.log(p);
  return h;
}

/** Entropy divided by log|options|, in [0, 1]. */
export function normalizedEntropy(dist: Distribution): number {
  const n = Object.keys(dist).length;
  return n > 1 ? entropy(dist) / Math.log(n) : 0;
}

/** E[index] for a score distribution keyed "0".."4". */
export function expectedIndex(dist: Distribution): number {
  let e = 0;
  for (const [k, p] of Object.entries(dist)) e += Number(k) * p;
  return e;
}

export function meanDist(dists: Distribution[], keys: readonly string[]): Distribution {
  const out: Distribution = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const d of dists) for (const k of keys) out[k]! += (d[k] ?? 0) / dists.length;
  return out;
}

export function optionKeys(q: Pick<Question, 'options'>): string[] {
  return q.options.map((o) => o.key);
}

/**
 * Post-hoc temperature calibration: p ∝ max(p, P_FLOOR)^(1/t). t > 1 softens an overconfident distribution, t < 1
 * sharpens; the argmax never changes. Nothing is sent to a provider.
 */
export function temperatureScale(dist: Distribution, t: number): Distribution {
  if (t === 1) return dist;
  const keys = Object.keys(dist);
  return normalizeDist(
    Object.fromEntries(keys.map((k) => [k, Math.max(dist[k]!, P_FLOOR) ** (1 / t)])),
    keys,
  );
}

/**
 * The inverse of `temperatureScale(·, t)`: p ∝ q^t. Exact, except that a probability `temperatureScale` floored at
 * P_FLOOR comes back as about P_FLOOR, so scores differ by under 1e-4 (ADR-0048).
 */
export function uncalibrate(dist: Distribution, t: number): Distribution {
  if (t === 1) return dist;
  const keys = Object.keys(dist);
  return normalizeDist(Object.fromEntries(keys.map((k) => [k, dist[k]! ** t])), keys);
}

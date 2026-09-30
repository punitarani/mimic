import { seededRng } from './hash';

export type FidelityState = 'calibrating' | 'learning' | 'stable';

export interface FidelityInput {
  /** Most recent scored primary predictions (anchor + adaptive), oldest first, with the matching baseline. */
  scored: Array<{ itemAcc: number; baselineItemAcc: number | null }>;
  /** Agreement in [0,1] for each repeat pair. */
  repeatAgreements: number[];
  /** Seed for the bootstrap, so a fidelity row is reproducible. */
  seed: string;
}

export interface FidelityResult {
  acc: number;
  accBaseline: number | null;
  selfConsistency: number;
  fidelity: number;
  ciLow: number;
  ciHigh: number;
  nScored: number;
  nRepeats: number;
  state: FidelityState;
}

export const FIDELITY_WINDOW = 30;
export const CONSISTENCY_PRIOR = 0.8;
export const CONSISTENCY_PRIOR_WEIGHT = 5;
export const CALIBRATING_BELOW = 12;
export const STABLE_HALF_WIDTH = 0.05;
export const BOOTSTRAP_RESAMPLES = 1000;

export function selfConsistency(agreements: number[]): number {
  const sum = agreements.reduce((a, b) => a + b, 0);
  return (
    (sum + CONSISTENCY_PRIOR_WEIGHT * CONSISTENCY_PRIOR) / (agreements.length + CONSISTENCY_PRIOR_WEIGHT)
  );
}

/** PLAN §9.10. */
export function computeFidelity(input: FidelityInput): FidelityResult {
  const S = input.scored.slice(-FIDELITY_WINDOW);
  const c = selfConsistency(input.repeatAgreements);
  const n = S.length;
  const acc = n ? mean(S.map((s) => s.itemAcc)) : 0;
  const baselines = S.map((s) => s.baselineItemAcc).filter((v): v is number => v !== null);
  const accBaseline = baselines.length ? mean(baselines) : null;
  const fidelity = Math.min(1, acc / c);

  let ciLow = 0;
  let ciHigh = 1;
  if (n > 0) {
    const rng = seededRng(input.seed);
    const samples: number[] = [];
    for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += S[Math.floor(rng() * n)]!.itemAcc;
      samples.push(Math.min(1, s / n / c));
    }
    samples.sort((a, b) => a - b);
    ciLow = quantile(samples, 0.05);
    ciHigh = quantile(samples, 0.95);
  }
  const state: FidelityState =
    n < CALIBRATING_BELOW ? 'calibrating' : (ciHigh - ciLow) / 2 <= STABLE_HALF_WIDTH ? 'stable' : 'learning';
  return {
    acc,
    accBaseline,
    selfConsistency: c,
    fidelity,
    ciLow,
    ciHigh,
    nScored: n,
    nRepeats: input.repeatAgreements.length,
    state,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

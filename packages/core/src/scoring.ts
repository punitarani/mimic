import { argmax, expectedIndex, P_FLOOR } from './distribution';
import type { Distribution, QType } from './types';

export interface ScoreRow {
  top1: number;
  itemAcc: number;
  logLoss: number;
  brier: number;
}

/** PLAN §9.7. `answer` is the chosen option key. */
export function scorePrediction(type: QType, dist: Distribution, answer: string): ScoreRow {
  const top1 = argmax(dist) === answer ? 1 : 0;
  const itemAcc = type === 'score' ? 1 - Math.abs(expectedIndex(dist) - Number(answer)) / 4 : top1;
  const logLoss = -Math.log(Math.max(dist[answer] ?? 0, P_FLOOR));
  let brier = 0;
  for (const [k, p] of Object.entries(dist)) brier += (p - (k === answer ? 1 : 0)) ** 2;
  if (!(answer in dist)) brier += 1;
  return { top1, itemAcc, logLoss, brier };
}

/** Agreement between two answers to the same item (PLAN §9.10). */
export function repeatAgreement(type: QType, a1: string, a2: string): number {
  if (type === 'score') return 1 - Math.abs(Number(a1) - Number(a2)) / 4;
  return a1 === a2 ? 1 : 0;
}

/** Expected calibration error over top-1 confidence, 10 equal-width bins. */
export function expectedCalibrationError(
  rows: Array<{ confidence: number; correct: number }>,
  bins = 10,
): number {
  if (rows.length === 0) return 0;
  const acc = new Array<number>(bins).fill(0);
  const conf = new Array<number>(bins).fill(0);
  const n = new Array<number>(bins).fill(0);
  for (const r of rows) {
    const b = Math.min(bins - 1, Math.floor(r.confidence * bins));
    acc[b]! += r.correct;
    conf[b]! += r.confidence;
    n[b]! += 1;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    if (n[b]! > 0) ece += (n[b]! / rows.length) * Math.abs(acc[b]! / n[b]! - conf[b]! / n[b]!);
  }
  return ece;
}

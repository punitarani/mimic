import { readFileSync } from 'node:fs';
import { GATES, type Gate, type Gateway, gateQuestions, JEV_MODEL } from '@mimic/core';
import { z } from 'zod';

const Labeled = z.object({
  id: z.string(),
  items: z.array(
    z.object({
      prompt: z.string(),
      type: z.enum(['choice', 'noul', 'score']),
      options: z.array(z.string()),
      labels: z.object({
        ambiguous: z.boolean(),
        sensitive: z.boolean(),
        leading: z.boolean(),
        quick: z.boolean(),
      }),
    }),
  ),
});

export interface GateCalibration {
  gate: Gate;
  auc: number;
  /** Best threshold by balanced accuracy; for `quick` the candidate fails when p < threshold, otherwise p > threshold. */
  threshold: number;
  balancedAccuracy: number;
  positives: number;
  negatives: number;
}

/** Area under the ROC curve (probability that a random positive scores above a random negative). */
export function auc(scores: Array<{ p: number; y: boolean }>): number {
  const pos = scores.filter((s) => s.y);
  const neg = scores.filter((s) => !s.y);
  if (!pos.length || !neg.length) return Number.NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function bestThreshold(scores: Array<{ p: number; y: boolean }>): {
  threshold: number;
  balancedAccuracy: number;
} {
  let best = { threshold: 0.5, balancedAccuracy: 0 };
  for (let t = 0.05; t <= 0.951; t += 0.01) {
    const tp = scores.filter((s) => s.y && s.p > t).length;
    const tn = scores.filter((s) => !s.y && s.p <= t).length;
    const P = scores.filter((s) => s.y).length || 1;
    const N = scores.filter((s) => !s.y).length || 1;
    const ba = (tp / P + tn / N) / 2;
    if (ba > best.balancedAccuracy + 1e-9)
      best = { threshold: Math.round(t * 100) / 100, balancedAccuracy: ba };
  }
  return best;
}

/** Runs the four gates on a hand-labeled set and reports per-gate AUC and the best threshold (PLAN §9.4). */
export async function calibrateGates(gateway: Gateway, path: string): Promise<GateCalibration[]> {
  const set = Labeled.parse(JSON.parse(readFileSync(path, 'utf8')));
  const questions = gateQuestions();
  const rows = await Promise.all(
    set.items.map(async (item) => {
      const res = await gateway.decide(
        { purpose: 'eval.gates' },
        {
          model: JEV_MODEL,
          state: { question: { prompt: item.prompt, type: item.type, options: item.options } },
          questions,
        },
      );
      const p = Object.fromEntries(
        GATES.map((g) => {
          const a = res.answers[g];
          return [g, a?.type === 'noul' ? a.p : Number.NaN];
        }),
      ) as Record<Gate, number>;
      return { item, p };
    }),
  );
  return GATES.map((gate) => {
    // For `quick` the bad outcome is "not quick", so score the complement.
    const scores = rows.map((r) => ({
      p: gate === 'quick' ? 1 - r.p[gate] : r.p[gate],
      y: gate === 'quick' ? !r.item.labels.quick : r.item.labels[gate],
    }));
    const best = bestThreshold(scores);
    return {
      gate,
      auc: auc(scores),
      threshold: gate === 'quick' ? Math.round((1 - best.threshold) * 100) / 100 : best.threshold,
      balancedAccuracy: best.balancedAccuracy,
      positives: scores.filter((s) => s.y).length,
      negatives: scores.filter((s) => !s.y).length,
    };
  });
}

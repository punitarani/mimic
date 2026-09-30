import { expectedCalibrationError } from './scoring';

/** One scored prediction, as used by /lab and the eval CLI. */
export interface ScoredRow {
  mimicId: string;
  questionId: string;
  predictorId: string;
  role: 'primary' | 'baseline' | 'shadow' | 'hypothesis';
  itemAcc: number;
  top1: number;
  logLoss: number;
  brier: number;
  /** Top-1 probability, for calibration. */
  confidence: number;
  costUsd: number;
  latencyMs: number;
}

export interface PredictorMetrics {
  predictorId: string;
  role: string;
  n: number;
  accuracy: number;
  top1: number;
  logLoss: number;
  brier: number;
  ece: number;
  /** Mean paired difference in item accuracy vs the baseline on the same questions. */
  lift: number | null;
  failures: number;
  failureRate: number;
  usdPer1k: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Per-predictor metrics (PLAN §12.3): accuracy (item_acc), log loss, Brier, ECE (10 bins), lift over the baseline
 * (paired by question), failure rate, $/1k predictions and latency. Failed predictions are excluded from the
 * accuracy metrics and counted separately.
 */
export function predictorMetrics(
  rows: ScoredRow[],
  failures: Array<{ predictorId: string; role: string }> = [],
) {
  const baselineByQ = new Map(
    rows.filter((r) => r.role === 'baseline').map((r) => [r.questionId, r.itemAcc]),
  );
  const groups = new Map<string, ScoredRow[]>();
  for (const r of rows) {
    const key = `${r.predictorId}|${r.role}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: PredictorMetrics[] = [];
  for (const [key, g] of groups) {
    const [predictorId, role] = key.split('|') as [string, string];
    const nFail = failures.filter((f) => f.predictorId === predictorId && f.role === role).length;
    const paired = role === 'baseline' ? [] : g.filter((r) => baselineByQ.has(r.questionId));
    out.push({
      predictorId,
      role,
      n: g.length,
      accuracy: mean(g.map((r) => r.itemAcc)),
      top1: mean(g.map((r) => r.top1)),
      logLoss: mean(g.map((r) => r.logLoss)),
      brier: mean(g.map((r) => r.brier)),
      ece: expectedCalibrationError(g.map((r) => ({ confidence: r.confidence, correct: r.top1 }))),
      lift: paired.length ? mean(paired.map((r) => r.itemAcc - baselineByQ.get(r.questionId)!)) : null,
      failures: nFail,
      failureRate: nFail / (g.length + nFail || 1),
      usdPer1k: (1000 * g.reduce((a, r) => a + r.costUsd, 0)) / (g.length || 1),
      p50LatencyMs: quantile(
        g.map((r) => r.latencyMs),
        0.5,
      ),
      p95LatencyMs: quantile(
        g.map((r) => r.latencyMs),
        0.95,
      ),
    });
  }
  const order = { primary: 0, baseline: 1, shadow: 2, hypothesis: 3 } as Record<string, number>;
  return out.sort(
    (a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.predictorId.localeCompare(b.predictorId),
  );
}

export interface CallRow {
  purpose: string;
  model: string;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
}

export interface CallMetrics {
  purpose: string;
  n: number;
  costUsd: number;
  meanCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;
  models: string[];
}

/** Cost and latency per call type, from `model_calls`. */
export function callMetrics(calls: CallRow[]): CallMetrics[] {
  const groups = new Map<string, CallRow[]>();
  for (const c of calls) groups.set(c.purpose, [...(groups.get(c.purpose) ?? []), c]);
  return [...groups.entries()]
    .map(([purpose, g]) => {
      const cost = g.reduce((a, c) => a + c.costUsd, 0);
      return {
        purpose,
        n: g.length,
        costUsd: cost,
        meanCostUsd: cost / g.length,
        p50LatencyMs: quantile(
          g.map((c) => c.latencyMs),
          0.5,
        ),
        p95LatencyMs: quantile(
          g.map((c) => c.latencyMs),
          0.95,
        ),
        errorRate: g.filter((c) => !c.ok).length / g.length,
        models: [...new Set(g.map((c) => c.model))].sort(),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

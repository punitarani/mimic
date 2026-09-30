import { describe, expect, it } from 'vitest';
import { callMetrics, predictorMetrics, type ScoredRow } from '../src';

const row = (q: string, predictorId: string, role: ScoredRow['role'], itemAcc: number): ScoredRow => ({
  mimicId: 'm',
  questionId: q,
  predictorId,
  role,
  itemAcc,
  top1: itemAcc >= 0.5 ? 1 : 0,
  logLoss: 1 - itemAcc,
  brier: 1 - itemAcc,
  confidence: 0.6,
  costUsd: 0.001,
  latencyMs: 100,
});

describe('lab metrics', () => {
  it('computes paired lift over the baseline, failure rate and $/1k', () => {
    const rows = [
      row('q1', 'jev:x', 'primary', 1),
      row('q2', 'jev:x', 'primary', 1),
      row('q1', 'jev:x', 'baseline', 0),
      row('q2', 'jev:x', 'baseline', 1),
      row('q1', 'llm:y', 'shadow', 0),
    ];
    const m = predictorMetrics(rows, [{ predictorId: 'llm:y', role: 'shadow' }]);
    const primary = m.find((x) => x.role === 'primary')!;
    expect(primary.accuracy).toBe(1);
    expect(primary.lift).toBeCloseTo(0.5, 12);
    expect(primary.usdPer1k).toBeCloseTo(1, 12);
    expect(m.find((x) => x.role === 'baseline')!.lift).toBeNull();
    const shadow = m.find((x) => x.role === 'shadow')!;
    expect(shadow.lift).toBeCloseTo(-0, 12);
    expect(shadow.failures).toBe(1);
    expect(shadow.failureRate).toBeCloseTo(0.5, 12);
    expect(m.map((x) => x.role)).toEqual(['primary', 'baseline', 'shadow']);
  });

  it('aggregates calls by purpose', () => {
    const c = callMetrics([
      { purpose: 'a', model: 'm1', costUsd: 1, latencyMs: 10, ok: true },
      { purpose: 'a', model: 'm2', costUsd: 3, latencyMs: 30, ok: false },
      { purpose: 'b', model: 'm1', costUsd: 0.5, latencyMs: 5, ok: true },
    ]);
    expect(c[0]).toMatchObject({
      purpose: 'a',
      n: 2,
      costUsd: 4,
      meanCostUsd: 2,
      errorRate: 0.5,
      models: ['m1', 'm2'],
    });
    expect(c[0]!.p50LatencyMs).toBe(20);
  });
});

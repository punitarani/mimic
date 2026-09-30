import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, SPAN_MODEL } from '@mimic/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BenchmarkRow,
  benchmarkCmd,
  CHALLENGER,
  challengerOf,
  DECISION_RULE,
  decide,
  INCUMBENT,
  renderCsv,
  summarize,
} from '../src/benchmark';
import { openLocalEngine } from '../src/local';
import type { EvalRecord } from '../src/optimize/evaluate';
import { importTwin } from '../src/twin';

/** A scored prediction; `person` spreads records over people, `state` groups them into one request. */
function rec(i: number, o: Partial<EvalRecord> = {}): EvalRecord {
  return {
    candidate: 'c',
    predictorId: 'p',
    instanceId: `i${i}`,
    mimicId: `m${i % 6}`,
    split: 'test',
    type: 'choice',
    stateHash: `s${i % 6}`,
    evidenceSeqMax: 1,
    stateTokens: 1,
    modelSnapshot: 'snap',
    ok: true,
    error: null,
    transient: false,
    dist: { a: 0.6, b: 0.4 },
    answer: 'a',
    logLoss: 0.5,
    itemAcc: 0.8,
    top1: 1,
    brier: 0.2,
    confidence: 0.6,
    baselineItemAcc: null,
    value: -0.5,
    costUsd: 0.00001,
    latencyMs: 200,
    feedback: '',
    ...o,
  };
}

const N = 240;
const ids = Array.from({ length: N }, (_, i) => i);
/** Six requests (one per state), as jevRequests would group them. */
const requests = Array.from({ length: 6 }, (_, s) => ids.filter((i) => i % 6 === s).map((i) => `i${i}`));

function pair(chal: (i: number) => Partial<EvalRecord>) {
  const incRecs = ids.map((i) => rec(i));
  const chalRecs = ids.map((i) => rec(i, chal(i)));
  const inc = summarize('incumbent', INCUMBENT, incRecs, requests);
  const ch = summarize('challenger', CHALLENGER, chalRecs, requests);
  return { v: decide(inc, ch, incRecs, chalRecs), inc, ch };
}
const failed = (v: ReturnType<typeof decide>) => v.checks.filter((c) => !c.pass).map((c) => c.name);

describe('benchmark (ADR-0050)', () => {
  it('compares the production primary with the same predictor on span-01', () => {
    expect(INCUMBENT).toBe(DEFAULT_CONFIG.predictor.primary);
    expect(CHALLENGER).toBe(`jev:${SPAN_MODEL}@jev-predict.v2`);
    expect(challengerOf('jev:typesafe/jev-1.13')).toBe(`jev:${SPAN_MODEL}`);
    expect(() => challengerOf('llm:qwen/qwen3.8-flash')).toThrow();
  });

  it('summarizes per request: latency percentiles, cost per request and error rate', () => {
    const recs = ids.map((i) => rec(i, { latencyMs: 100 * ((i % 6) + 1), ok: i % 40 !== 0 }));
    const r = summarize('incumbent', 'p', recs, requests);
    expect(r).toMatchObject({
      predictions: N,
      requests: 6,
      answeredRequests: 6,
      errors: 6,
      errorRate: 6 / N,
    });
    expect(r.p50LatencyMs).toBe(350);
    expect(r.p95LatencyMs).toBe(575);
    expect(r.costPerRequestUsd).toBeCloseTo((N * 0.00001) / 6, 10);
  });

  it('enables span-01 only when it is better and nothing else regresses', () => {
    expect(pair(() => ({ logLoss: 0.4 })).v.enable).toBe(true);
    // Equal quality is not better.
    expect(failed(pair(() => ({})).v)).toEqual(['better log loss']);
    expect(failed(pair(() => ({ logLoss: 0.4, itemAcc: 0.7 })).v)).toEqual(['accuracy held']);
    expect(failed(pair(() => ({ logLoss: 0.4, latencyMs: 400 })).v)).toEqual(['latency']);
    expect(failed(pair(() => ({ logLoss: 0.4, costUsd: 0.00002 })).v)).toEqual(['cost']);
    expect(failed(pair((i) => ({ logLoss: 0.4, ok: i % 20 !== 0 })).v)).toEqual(['error rate']);
  });

  it('a challenger that never answered fails, whatever its latency and cost', () => {
    const { v, ch } = pair(() => ({ ok: false, latencyMs: 0, costUsd: 0, logLoss: 0.69, transient: true }));
    expect(ch.answeredRequests).toBe(0);
    expect(failed(v)).toEqual(['better log loss', 'error rate', 'latency', 'cost']);
  });

  it('needs enough paired predictions and people', () => {
    const few = ids.slice(0, DECISION_RULE.minPredictions - 1);
    const incRecs = few.map((i) => rec(i));
    const chalRecs = few.map((i) => rec(i, { logLoss: 0.4 }));
    const row = (role: BenchmarkRow['role'], rs: EvalRecord[]) => summarize(role, 'p', rs, requests);
    expect(failed(decide(row('incumbent', incRecs), row('challenger', chalRecs), incRecs, chalRecs))).toEqual(
      ['enough data'],
    );
  });

  it('writes a side-by-side CSV', () => {
    const { inc, ch } = pair(() => ({ logLoss: 0.4 }));
    const [header, a, b] = renderCsv([inc, ch]).trim().split('\n');
    expect(header).toContain('log_loss,item_acc');
    expect(header).toContain('p50_latency_ms,p95_latency_ms,cost_per_request_usd');
    expect(a!.startsWith('incumbent,jev:typesafe/jev-1.13@jev-predict.v2')).toBe(true);
    expect(b).toContain('0.4000');
  });

  const dir = mkdtempSync(join(tmpdir(), 'mimic-bench-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs end to end offline on the Twin sample, reproducibly', async () => {
    const data = join(dir, 'twin.sqlite');
    const engine = await openLocalEngine({ db: data, providers: 'offline' });
    await importTwin(engine.deps, { path: join(__dirname, '../fixtures/twin2k500.sample.jsonl') });
    engine.close();
    const run = async (out: string) => {
      await benchmarkCmd([
        '--data',
        data,
        '--split',
        'all',
        '--k',
        '8',
        '--offline',
        '--out',
        join(dir, out),
      ]);
      return JSON.parse(readFileSync(join(dir, out, 'benchmark.json'), 'utf8')) as {
        rows: BenchmarkRow[];
        verdict: { enable: boolean };
      };
    };
    const a = await run('a');
    const b = await run('b');
    expect(a.rows.map((r) => r.predictorId)).toEqual([INCUMBENT, CHALLENGER]);
    expect(a.rows[0]!.predictions).toBeGreaterThan(0);
    expect(a.verdict.enable).toBe(false);
    const quality = (r: BenchmarkRow) => [r.predictions, r.logLoss, r.itemAcc, r.errors];
    expect(b.rows.map(quality)).toEqual(a.rows.map(quality));
    expect(readFileSync(join(dir, 'a', 'benchmark.md'), 'utf8')).toContain('Offline run with fake providers');
  }, 60_000);
});

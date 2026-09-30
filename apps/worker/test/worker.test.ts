import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { PredictionRecord } from '@mimic/core';
import { engineDeps } from '@mimic/db/runtime';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('health', () => {
  it('reads D1, writes R2 and enqueues a no-op job', async () => {
    const res = await worker.fetch(new Request('http://worker/health'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; r2: string; enqueued: string };
    expect(body.ok).toBe(true);
    expect(await env.BLOBS.get(body.r2)).not.toBeNull();
    expect(body.enqueued).toMatch(/^noop:/);
  });
});

describe('queue consumer', () => {
  it('runs a job once and records it in the ledger', async () => {
    const batch = createMessageBatch('mimic-jobs', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: { type: 'noop', id: 'abc' } },
      { id: 'm2', timestamp: new Date(), attempts: 1, body: { type: 'noop', id: 'abc' } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(['m1', 'm2']);
    const row = await env.DB.prepare('select status from jobs where key = ?')
      .bind('noop:abc')
      .first<{ status: string }>();
    expect(row?.status).toBe('done');
  });

  it('runs every message of a batch larger than its concurrency', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const batch = createMessageBatch(
      'mimic-jobs',
      ids.map((id) => ({ id, timestamp: new Date(), attempts: 1, body: { type: 'noop', id } })),
    );
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual([...ids].sort());
  });

  it('acks malformed messages instead of retrying forever', async () => {
    const batch = createMessageBatch('mimic-jobs', [
      { id: 'bad', timestamp: new Date(), attempts: 1, body: { type: 'nope' } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    await waitOnExecutionContext(ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['bad']);
  });

  it('treats jobs for deleted mimics as no-ops', async () => {
    const batch = createMessageBatch('mimic-jobs', [
      {
        id: 'x',
        timestamp: new Date(),
        attempts: 1,
        body: { type: 'learn.answer', mimicId: 'missing', seq: 1 },
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['x']);
    expect(result.retryMessages).toEqual([]);
  });
});

describe('D1 store: backfill ledger and shadows (ADR-0037)', () => {
  const store = () => engineDeps(env).store;
  const shadow = (id: string, ok: boolean): PredictionRecord => ({
    id,
    questionId: 'Q1',
    mimicId: 'M1',
    predictorId: 'llm:acme/m',
    role: 'shadow',
    dist: ok ? { a: 1 } : {},
    confidence: null,
    stateHash: 'h',
    evidenceSeqMax: 0,
    configHash: 'c',
    promptVersion: 'predict.v1',
    modelSnapshot: 'acme/m@P',
    costUsd: 0,
    latencyMs: 0,
    ok,
    error: ok ? null : 'HTTP 429 from openrouter.ai',
    errorKind: ok ? null : 'transport',
    fallback: false,
    createdAt: 1,
  });

  it('stores one shadow per question and predictor, and swaps a failed call for its redo', async () => {
    const s = store();
    expect(await s.insertShadow(shadow('p1', false))).toBe(true);
    expect(await s.insertShadow(shadow('p2', true))).toBe(false); // the unique index
    expect(await s.insertShadow(shadow('p3', true), ['p1'])).toBe(true);
    const rows = await s.listPredictions({ questionId: 'Q1' });
    expect(rows.map((p) => [p.id, p.ok, p.errorKind])).toEqual([['p3', true, null]]);
  });

  it('upserts ledger rows in batches and lists them by key prefix through the index', async () => {
    const s = store();
    const rec = (key: string, status: 'queued' | 'done') => ({
      key,
      type: 'backfill.shadow',
      status,
      attempts: 0,
      lastError: null,
      updatedAt: 5,
    });
    await s.putJobs([
      rec('backfill.shadow:M1:Q1:llm:a/b', 'done'),
      rec('backfill.shadow:M10:Q1:llm:a/b', 'done'),
    ]);
    await s.putJobs([rec('backfill.shadow:M1:Q1:llm:a/b', 'queued')]);
    const rows = await s.listJobs('backfill.shadow:M1:');
    expect(rows.map((r) => [r.key, r.status])).toEqual([['backfill.shadow:M1:Q1:llm:a/b', 'queued']]);
  });

  it('sends a paced batch through the queue, each message with its own delay', async () => {
    await expect(
      engineDeps(env).jobs.enqueueBatch([
        { job: { type: 'noop', id: 'b1' } },
        { job: { type: 'noop', id: 'b2' }, delaySeconds: 2 },
      ]),
    ).resolves.toBeUndefined();
  });
});

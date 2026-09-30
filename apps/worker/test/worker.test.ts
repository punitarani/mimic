import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
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

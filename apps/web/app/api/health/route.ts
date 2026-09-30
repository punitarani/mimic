import { ulid } from '@mimic/core';
import { deps, handle, ok } from '@/lib/server';

/** M0 health check: reads D1, writes R2 and enqueues a no-op job the worker consumes. */
export const GET = handle(async () => {
  const { deps: d } = await deps();
  const id = ulid();
  const configs = await d.store.listConfigs();
  await d.blobs.put(`health/${id}.json`, JSON.stringify({ at: d.clock(), from: 'web' }));
  await d.jobs.enqueue({ type: 'noop', id });
  return ok({ ok: true, d1: { configs: configs.length }, r2: `health/${id}.json`, job: `noop:${id}` });
});

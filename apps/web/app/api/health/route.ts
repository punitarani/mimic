import { ulid } from '@mimic/core';
import { flagHealth, type MimicBindings } from '@mimic/db/runtime';
import { deps, handle, ok } from '@/lib/server';

/**
 * M0 health check: reads D1, writes R2 and enqueues a no-op job the worker consumes. It also evaluates every
 * registry flag through the FLAGS binding (ADR-0051), so the post-deploy smoke test proves this Worker can read each
 * one; `flags.ok` is false when one errors or serves a value the code can't use.
 */
export const GET = handle(async () => {
  const { deps: d, env } = await deps();
  const id = ulid();
  const [configs, flags] = await Promise.all([d.store.listConfigs(), flagHealth(env as MimicBindings)]);
  await d.blobs.put(`health/${id}.json`, JSON.stringify({ at: d.clock(), from: 'web' }));
  await d.jobs.enqueue({ type: 'noop', id });
  return ok({ ok: true, d1: { configs: configs.length }, r2: `health/${id}.json`, job: `noop:${id}`, flags });
});

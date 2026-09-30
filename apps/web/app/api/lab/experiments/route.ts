import { ulid } from '@mimic/core';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin';
import { body, deps, fail, handle, ok } from '@/lib/server';

/** GET /api/lab/experiments */
export const GET = handle(async () => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  return ok({ experiments: await d.store.listExperiments() });
});

const Upsert = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  status: z.enum(['draft', 'active', 'stopped']),
  arms: z
    .array(
      z.object({
        arm: z.string().min(1).max(40),
        configHash: z.string().length(64),
        weight: z.number().positive(),
      }),
    )
    .min(1),
});

/**
 * POST /api/lab/experiments — create or update an experiment. Only one experiment is active at a time; new mimics
 * are allocated to its arms by hash(mimicId) (PLAN §12.1). Existing mimics never change config.
 */
export const POST = handle(async (req: Request) => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  const input = await body(req, Upsert);
  for (const a of input.arms) {
    if (!(await d.store.getConfig(a.configHash))) return fail(400, `Unknown config ${a.configHash}`);
  }
  const existing = await d.store.listExperiments();
  if (input.status === 'active') {
    for (const e of existing) {
      if (e.status === 'active' && e.id !== input.id)
        await d.store.putExperiment({ ...e, status: 'stopped' });
    }
  }
  const prev = existing.find((e) => e.id === input.id);
  const rec = {
    id: input.id ?? ulid(),
    name: input.name,
    status: input.status,
    arms: input.arms,
    createdAt: prev?.createdAt ?? d.clock(),
  };
  await d.store.putExperiment(rec);
  return ok(rec, { status: prev ? 200 : 201 });
});

import { setupPreset } from '@mimic/core';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin';
import { body, deps, handle, ok } from '@/lib/server';

const Preset = z.object({ id: z.string().min(1).max(40) });

/**
 * POST /api/lab/experiments/preset — registers a preset's configs and saves it as a draft experiment (ADR-0045).
 * Idempotent by name; never starts anything: starting stays the admin's click on the draft.
 */
export const POST = handle(async (req: Request) => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  const { id } = await body(req, Preset);
  const { experiment, created } = await setupPreset(d, id);
  return ok({ experiment, created }, { status: created ? 201 : 200 });
});

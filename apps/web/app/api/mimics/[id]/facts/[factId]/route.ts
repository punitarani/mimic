import { setFactState } from '@mimic/core';
import { z } from 'zod';
import { body, deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

const Patch = z.object({ userState: z.enum(['removed', 'active']) });

/** PATCH /api/mimics/:id/facts/:factId — removed facts never enter any state. */
export const PATCH = handle(async (req: Request, ctx: RouteCtx<{ id: string; factId: string }>) => {
  const { id, factId } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  const { userState } = await body(req, Patch);
  await setFactState(d, id, factId, userState);
  return ok({ id: factId, userState });
});

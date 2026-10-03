import { deleteParticipant } from '@mimic/core';
import { requireAdmin } from '@/lib/admin';
import { deps, handle, ok, type RouteCtx } from '@/lib/server';

/** DELETE /api/lab/participants/:id — hard-deletes a person: each of their mimics, then the participant (ADR-0075). */
export const DELETE = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  return ok({ deleted: true, ...(await deleteParticipant(d, decodeURIComponent(id))) });
});

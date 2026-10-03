import { deleteMimic, labMimic } from '@mimic/core';
import { requireAdmin } from '@/lib/admin';
import { deps, handle, ok, type RouteCtx } from '@/lib/server';

/** GET /api/lab/mimics/:id — one mimic's questions, predictions, accuracy over time and cost (ADR-0076). */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  return ok(await labMimic(d, id));
});

/** DELETE /api/lab/mimics/:id — hard delete across D1, R2, Vectorize and KV. */
export const DELETE = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  await deleteMimic(d, id);
  return ok({ deleted: true });
});

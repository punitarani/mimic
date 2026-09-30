import { deleteMimic, uiSnapshot } from '@mimic/core';
import { deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id — profile, fidelity, facets, insights, KG and pool status. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  return ok(await uiSnapshot(d, id));
});

/** DELETE /api/mimics/:id — hard delete across D1, R2, Vectorize and KV. */
export const DELETE = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  await deleteMimic(d, id);
  return ok({ deleted: true });
});

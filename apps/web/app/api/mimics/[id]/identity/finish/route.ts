import { finishIdentity } from '@mimic/core';
import { deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/** POST /api/mimics/:id/identity/finish — done reviewing facts (or skipped); the session can start. */
export const POST = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  await finishIdentity(d, id);
  return ok({ ok: true });
});

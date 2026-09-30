import { writeSnapshot } from '@mimic/core';
import { deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/** POST /api/mimics/:id/stop — "Stop here": writes a snapshot so stopping never loses the mimic. */
export const POST = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  const version = await writeSnapshot(d, id);
  return ok({ snapshotVersion: version });
});

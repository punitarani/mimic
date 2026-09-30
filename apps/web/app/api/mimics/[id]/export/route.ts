import { exportMimic } from '@mimic/core';
import { deps, handle, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id/export — the latest mimic.json (schema mimic/1). */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  const doc = await exportMimic(d, id);
  return new Response(JSON.stringify(doc, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="mimic-${id}-v${doc.version}.json"`,
      'cache-control': 'no-store',
    },
  });
});

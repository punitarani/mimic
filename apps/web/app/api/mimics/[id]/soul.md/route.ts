import { exportSoul, SoulProfile } from '@mimic/core';
import { deps, handle, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id/soul.md — the curated SOUL.md, for any agent to read (ADR-0037). */
export const GET = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  // `?profile=core` leaves out the appendix, for system prompts with a small budget.
  const profile = SoulProfile.catch('full').parse(new URL(req.url).searchParams.get('profile'));
  return new Response(await exportSoul(d, id, profile), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="SOUL.md"',
      'cache-control': 'no-store',
    },
  });
});

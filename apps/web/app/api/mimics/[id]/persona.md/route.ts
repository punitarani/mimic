import { exportPersona } from '@mimic/core';
import { deps, handle, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id/persona.md — the curated Persona.md, for any agent to read (ADR-0027). */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  return new Response(await exportPersona(d, id), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="Persona.md"',
      'cache-control': 'no-store',
    },
  });
});

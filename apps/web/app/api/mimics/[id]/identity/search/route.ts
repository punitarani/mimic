import { HttpUrl, searchIdentityAgain } from '@mimic/core';
import { z } from 'zod';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

const SearchAgain = z.object({ link: HttpUrl });

/** POST /api/mimics/:id/identity/search — search again, led by a profile link the person gives. */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const { link } = await body(req, SearchAgain);
  await searchIdentityAgain(d, id, link);
  return ok({ ok: true });
});

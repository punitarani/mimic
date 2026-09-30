import { serveNext } from '@mimic/core';
import { deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

/** POST /api/mimics/:id/next — { question, seq }. Idempotent per seq; seals predictions before returning. */
export const POST = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env, serverTiming } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const started = Date.now();
  const r = await serveNext(d, id);
  return ok(r, { headers: { 'server-timing': `next;dur=${Date.now() - started}, ${serverTiming()}` } });
});

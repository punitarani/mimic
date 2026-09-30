import { RewindInput, rewindLastAnswer } from '@mimic/core';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

/**
 * POST /api/mimics/:id/rewind — { questionId } → { question, progress, previous }. Undoes the latest answer so the
 * question can be answered again (ADR-0027); 409 if that question isn't the latest answer.
 */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const input = await body(req, RewindInput);
  return ok(await rewindLastAnswer(d, id, input));
});

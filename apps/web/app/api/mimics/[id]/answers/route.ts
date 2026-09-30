import { AnswerInput, submitAnswer } from '@mimic/core';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

/** POST /api/mimics/:id/answers — { questionId, value, why?, latencyMs, idempotencyKey } → { reveal?, fidelity }. */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env, serverTiming } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const input = await body(req, AnswerInput);
  const started = Date.now();
  const r = await submitAnswer(d, id, input);
  return ok(r, { headers: { 'server-timing': `answer;dur=${Date.now() - started}, ${serverTiming()}` } });
});

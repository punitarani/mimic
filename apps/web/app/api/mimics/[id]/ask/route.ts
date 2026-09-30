import {
  DraftInput,
  draftFromScenario,
  FeedbackInput,
  listPlayground,
  predictPlayground,
  ScenarioInput,
  submitFeedback,
} from '@mimic/core';
import { z } from 'zod';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

const Ask = z.union([
  ScenarioInput,
  z.object({ question: DraftInput }),
  z.object({ feedback: FeedbackInput }),
]);

/**
 * POST /api/mimics/:id/ask (PLAN §9.11). `{ scenario }` → an editable typed question (LLM);
 * `{ question }` → the mimic's sealed prediction for it, stored as `kind = playground`;
 * `{ feedback }` → a question the person answers themselves, stored as `kind = feedback` for the mimic to learn
 * from (ADR-0032). No model call.
 */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const input = await body(req, Ask);
  if ('scenario' in input) return ok({ draft: await draftFromScenario(d, id, input.scenario) });
  if ('feedback' in input) return ok(await submitFeedback(d, id, input.feedback));
  return ok(await predictPlayground(d, id, input.question));
});

/** GET /api/mimics/:id/ask: the questions asked and answered on the mimic page, newest first. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  return ok(await listPlayground(d, id));
});

import { DraftInput, draftFromScenario, predictPlayground, ScenarioInput } from '@mimic/core';
import { z } from 'zod';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

const Ask = z.union([ScenarioInput, z.object({ question: DraftInput })]);

/**
 * POST /api/mimics/:id/ask (PLAN §9.11). `{ scenario }` → an editable typed question (LLM);
 * `{ question }` → the mimic's sealed prediction for it, stored as `kind = playground`.
 */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const input = await body(req, Ask);
  if ('scenario' in input) return ok({ draft: await draftFromScenario(d, id, input.scenario) });
  return ok(await predictPlayground(d, id, input.question));
});

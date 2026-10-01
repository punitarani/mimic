import { FootprintDoc, proposeFromFootprint } from '@mimic/core';
import { z } from 'zod';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

const Input = z.object({
  /** Documents the person's browser parsed from their own exports (`@mimic/core/footprint`), already cleaned. */
  docs: z.array(FootprintDoc).min(1).max(400),
  max: z.number().int().min(1).max(12).optional(),
});

/**
 * POST /api/mimics/:id/footprint (ADR-0059): pools questions the person's own documents imply answers to. The
 * implied answers are verified by asking, never stored as evidence. One LLM call plus the quality gates.
 */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const input = await body(req, Input);
  return ok(await proposeFromFootprint(d, id, input));
});

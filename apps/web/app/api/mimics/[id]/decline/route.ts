import { declineQuestion } from '@mimic/core';
import { z } from 'zod';
import { body, deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

const Decline = z.object({ questionId: z.string().min(1).max(64) });

/**
 * POST /api/mimics/:id/decline — "Prefer not to say" on the current sensitive question (ADR-0050). The question is
 * discarded unanswered and its sensitive facets are never asked about again, until the person allows them in Topics
 * and consent.
 */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  const { questionId } = await body(req, Decline);
  return ok(await declineQuestion(d, id, questionId));
});

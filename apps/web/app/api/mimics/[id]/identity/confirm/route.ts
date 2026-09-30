import { confirmIdentity } from '@mimic/core';
import { z } from 'zod';
import { body, deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

const Confirm = z.object({ candidateId: z.string().min(1).nullable() });

/** POST /api/mimics/:id/identity/confirm — the person picks a candidate or "None of these". */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  const { candidateId } = await body(req, Confirm);
  await confirmIdentity(d, id, candidateId);
  return ok({ ok: true });
});

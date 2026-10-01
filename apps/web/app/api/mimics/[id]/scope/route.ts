import { MimicScope, setScope, withResearchUse } from '@mimic/core';
import { body, deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/**
 * PATCH /api/mimics/:id/scope — what the person agrees to be asked about (ADR-0040, ADR-0043). Narrowing hides what
 * was learned in the withdrawn area and discards questions waiting in it; the next question already follows it. A
 * special-category area turned on joins research use when the person consented to research (ADR-0065).
 */
export const PATCH = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { mimic } = await ownMimic(d, env, id);
  const scope = await body(req, MimicScope);
  const change = await setScope(d, id, withResearchUse(scope, mimic.scope));
  return ok(change);
});

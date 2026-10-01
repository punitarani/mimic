import { importObservations, listObservations, ObservationBatch } from '@mimic/core';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

/**
 * POST /api/mimics/:id/observations (ADR-0058): an agent's observation ledger (`mimic-observations/1`). Each
 * observation is stored as a taught answer with the agent named in its provenance, and the mimic re-derives itself
 * from the evidence. No model call on this path; learning runs in the background like any taught answer.
 */
export const POST = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const batch = await body(req, ObservationBatch);
  return ok(await importObservations(d, id, batch));
});

/** GET /api/mimics/:id/observations: what agents have appended, newest first. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  return ok({ observations: await listObservations(d, id) });
});

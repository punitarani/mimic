import { curatePersona, draftPersona, getPersona, PersonaSave } from '@mimic/core';
import { body, deps, fail, handle, ok, ownMimic, type RouteCtx, rateLimited } from '@/lib/server';

/** GET /api/mimics/:id/persona — the Persona.md view: sections, items, curation and the rendered file. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  return ok(await getPersona(d, id));
});

/** POST /api/mimics/:id/persona — writes a new `persona.v1` draft from the latest snapshot (one LLM call). */
export const POST = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { pid } = await ownMimic(d, env, id);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  return ok(await draftPersona(d, id));
});

/**
 * PUT /api/mimics/:id/persona — `{ rev, curation }`: saves the person's choices (name, own words, sections, hidden
 * items, edits) unless a newer rev is already stored.
 */
export const PUT = handle(async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  await ownMimic(d, env, id);
  return ok(await curatePersona(d, id, await body(req, PersonaSave)));
});

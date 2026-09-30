import { MAX_CANDIDATES } from '@mimic/core';
import { hostLabel, profileKey } from '@mimic/core/links';
import { deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id/identity — { status, candidates, facts }. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { mimic } = await ownMimic(d, env, id);
  const [candidates, facts] = await Promise.all([d.store.listCandidates(id), d.store.listFacts(id)]);
  // The engine leads with the profile at the newest link only, so only that one is "Your link".
  const link = mimic.links[0] ? profileKey(mimic.links[0]) : null;
  return ok({
    status: mimic.identityState,
    // Only the latest search's candidates: earlier searches' are superseded, and rejected ones were declined.
    candidates: candidates
      .filter((c) => c.status === 'proposed' || c.status === 'confirmed')
      .slice(0, MAX_CANDIDATES)
      .map((c) => ({
        id: c.id,
        name: c.name,
        headline: c.headline,
        location: c.location,
        url: c.url,
        source: hostLabel(c.url),
        provider: c.provider,
        samePerson: c.jevSamePersonP,
        fromLink: link !== null && profileKey(c.url) === link,
        status: c.status,
      })),
    facts: facts.map((f) => ({
      id: f.id,
      predicate: f.predicate,
      object: f.object,
      source: f.source,
      sourceUrl: f.sourceUrl,
      userState: f.userState,
    })),
  });
});

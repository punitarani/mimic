import { profileKey } from '@mimic/core';
import { deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id/identity — { status, candidates, facts }. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { mimic } = await ownMimic(d, env, id);
  const [candidates, facts] = await Promise.all([d.store.listCandidates(id), d.store.listFacts(id)]);
  const links = new Set(mimic.links.map(profileKey));
  return ok({
    status: mimic.identityState,
    // Candidates set aside by "search with a link" stay rejected and out of view.
    candidates: candidates
      .filter((c) => c.status !== 'rejected')
      .slice(0, 8)
      .map((c) => ({
        id: c.id,
        name: c.name,
        headline: c.headline,
        location: c.location,
        url: c.url,
        source: hostOf(c.url),
        provider: c.provider,
        samePerson: c.jevSamePersonP,
        fromLink: links.has(profileKey(c.url)),
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

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

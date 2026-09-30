import { deps, handle, ok, ownMimic, type RouteCtx } from '@/lib/server';

/** GET /api/mimics/:id/identity — { status, candidates, facts }. */
export const GET = handle(async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { deps: d, env } = await deps();
  const { mimic } = await ownMimic(d, env, id);
  const [candidates, facts] = await Promise.all([d.store.listCandidates(id), d.store.listFacts(id)]);
  return ok({
    status: mimic.identityState,
    candidates: candidates.slice(0, 5).map((c) => ({
      id: c.id,
      name: c.name,
      headline: c.headline,
      location: c.location,
      url: c.url,
      source: hostOf(c.url),
      provider: c.provider,
      samePerson: c.jevSamePersonP,
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

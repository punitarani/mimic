import type { FixtureEnricher, FixturePeopleSearch } from '@mimic/adapters';
import {
  confirmIdentity,
  createMimic,
  exportMimic,
  finishIdentity,
  runIdentitySearch,
  searchCacheKey,
  searchIdentityAgain,
  serveNext,
  setFactState,
  submitAnswer,
} from '@mimic/core';
import type { MemoryBlobs } from '@mimic/db/local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

const intake = {
  name: 'Avery Quinn',
  location: 'San Francisco, US',
  occupation: 'Software engineer',
  attestSelf: true as const,
  consentResearch: false,
};

let engine: LocalEngine;
afterEach(() => engine?.close());

const search = () => engine.providers.search as FixturePeopleSearch;
const enricher = () => engine.providers.enricher as FixtureEnricher;

async function answerTurns(mimicId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const next = await serveNext(engine.deps, mimicId);
    if (next.status !== 'question') throw new Error(`no question: ${next.status}`);
    await engine.drain((j) => j.type !== 'snapshot.write');
    await submitAnswer(engine.deps, mimicId, {
      questionId: next.question.id,
      value: next.question.options[0]!.key,
      latencyMs: 1000,
      idempotencyKey: `k-${mimicId}-${i}`,
    });
    await engine.drain((j) => j.type !== 'snapshot.write');
  }
}

describe('identity (PLAN §9.2, M3)', () => {
  it('declining search makes zero search calls', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: false }, 'p1');
    await engine.drain();
    await runIdentitySearch(engine.deps, m.id); // even a stray job does nothing
    await answerTurns(m.id, 3);
    expect(search().calls).toBe(0);
    expect(enricher().calls).toBe(0);
    const calls = await engine.deps.store.listModelCalls({ mimicId: m.id });
    expect(calls.some((c) => c.purpose.startsWith('identity'))).toBe(false);
    expect((await engine.deps.store.getMimic(m.id))!.identityState).toBe('skipped');
    expect(await engine.deps.store.listCandidates(m.id)).toEqual([]);
  });

  it('searches, pre-ranks with Jev, and never auto-confirms', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    expect(m.status).toBe('identity');
    await engine.drain();
    const after = (await engine.deps.store.getMimic(m.id))!;
    expect(after.identityState).toBe('candidates');
    expect(after.status).toBe('identity');
    const candidates = await engine.deps.store.listCandidates(m.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.status === 'proposed' && c.jevSamePersonP !== null)).toBe(true);
    expect(search().calls).toBeGreaterThanOrEqual(2); // 2–3 query variants
    // Exa's people index is semantic: a quoted name is not a phrase match and wrecked recall (ADR-0029).
    expect(search().queries.every((q) => q.startsWith('Avery Quinn') && !q.includes('"'))).toBe(true);
    // Profiles with no name in common with the intake (Rowan Ellis) are never offered.
    expect(candidates.map((c) => c.name)).toEqual(['Avery Quinn']);
    expect(await engine.deps.blobs.list(`search/${m.id}/`)).not.toEqual([]);
    // The session can't start until the person decides.
    expect((await serveNext(engine.deps, m.id)).status).toBe('identity');
  });

  it("looks up the person's own link and leads with it", async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const link = 'https://linkedin.com/in/avery-quinn-example/';
    const m = await createMimic(engine.deps, { ...intake, link, consentSearch: true }, 'p1');
    await engine.drain();
    expect(search().lookups).toBe(1);
    const [top, ...rest] = await engine.deps.store.listCandidates(m.id);
    // Deduped with the same profile from search, under the person's exact URL.
    expect(top).toMatchObject({ name: 'Avery Quinn', url: link, rank: 1 });
    expect(rest.map((c) => c.url)).not.toContain('https://www.linkedin.com/in/avery-quinn-example');
    const calls = await engine.deps.store.listModelCalls({ mimicId: m.id });
    expect(calls.filter((c) => c.purpose === 'identity.lookup')).toHaveLength(1);
  });

  it('never caches an empty search', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, name: 'Nobody Known', consentSearch: true }, 'p1');
    await engine.drain();
    const after = (await engine.deps.store.getMimic(m.id))!;
    expect(after.identityState).toBe('none_found');
    expect(await engine.deps.kv.get(searchCacheKey(after))).toBeNull();
  });

  it('searches again with a link: earlier candidates are set aside and the new search leads with it', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    const [first] = await engine.deps.store.listCandidates(m.id);
    const link = 'https://www.linkedin.com/in/avery-quinn-example';

    await searchIdentityAgain(engine.deps, m.id, link);
    const searching = (await engine.deps.store.getMimic(m.id))!;
    expect(searching).toMatchObject({ identityState: 'searching', links: [link] });
    // A second request while that search runs is refused rather than queued twice.
    await expect(searchIdentityAgain(engine.deps, m.id, link)).rejects.toMatchObject({ code: 'conflict' });
    await engine.drain();

    const all = await engine.deps.store.listCandidates(m.id);
    const open = all.filter((c) => c.status === 'proposed');
    // Set aside, not judged: "superseded" never reads as the person saying "not me".
    expect(all.find((c) => c.id === first!.id)?.status).toBe('superseded');
    expect(open[0]).toMatchObject({ url: link, name: 'Avery Quinn' });
    expect((await engine.deps.store.getMimic(m.id))!.identityState).toBe('candidates');
    // Only a candidate from the latest search can be confirmed.
    await expect(confirmIdentity(engine.deps, m.id, first!.id)).rejects.toMatchObject({ code: 'not_found' });
    await confirmIdentity(engine.deps, m.id, open[0]!.id);
    expect((await engine.deps.store.getMimic(m.id))!.identityState).toBe('enriching');
    const after = await engine.deps.store.listCandidates(m.id);
    expect(after.find((c) => c.id === open[0]!.id)?.status).toBe('confirmed');
    expect(
      after.filter((c) => c.id !== open[0]!.id && open.some((o) => o.id === c.id)).map((c) => c.status),
    ).toEqual(open.slice(1).map(() => 'rejected'));
    expect(after.find((c) => c.id === first!.id)?.status).toBe('superseded'); // earlier searches stay as they were
    // Once a profile is confirmed, the search is over.
    await expect(searchIdentityAgain(engine.deps, m.id, link)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets only one of two concurrent searches again start a search', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    engine.queue.drain(); // nothing pending
    const results = await Promise.allSettled([
      searchIdentityAgain(engine.deps, m.id, 'https://linkedin.com/in/a'),
      searchIdentityAgain(engine.deps, m.id, 'https://linkedin.com/in/b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(engine.queue.drain().filter((j) => j.type === 'identity.search')).toHaveLength(1);
  });

  it('puts the choice back when the search job cannot be enqueued', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    const before = await engine.deps.store.listCandidates(m.id);
    vi.spyOn(engine.deps.jobs, 'enqueue').mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(searchIdentityAgain(engine.deps, m.id, 'https://linkedin.com/in/a')).rejects.toThrow(
      'queue unavailable',
    );
    // Not stuck in "searching" with no job: the person can pick from the same list, or try again.
    expect(await engine.deps.store.getMimic(m.id)).toMatchObject({ identityState: 'candidates', links: [] });
    expect(await engine.deps.store.listCandidates(m.id)).toEqual(before);
    await searchIdentityAgain(engine.deps, m.id, 'https://linkedin.com/in/a');
    expect((await engine.deps.store.getMimic(m.id))!.identityState).toBe('searching');
  });

  it('finishes a search whose candidates landed but whose state update was lost', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    const n = (await engine.deps.store.listCandidates(m.id)).length;
    // As if the job failed right after inserting its candidates and was delivered again.
    await engine.deps.store.updateMimic(m.id, { identityState: 'searching' });
    await runIdentitySearch(engine.deps, m.id);
    expect((await engine.deps.store.getMimic(m.id))!.identityState).toBe('candidates');
    expect(await engine.deps.store.listCandidates(m.id)).toHaveLength(n); // no second set
  });

  it('confirms only while a choice is pending', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    const [top] = await engine.deps.store.listCandidates(m.id);
    await engine.deps.store.updateMimic(m.id, { identityState: 'searching' });
    await expect(confirmIdentity(engine.deps, m.id, top!.id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await engine.deps.store.listCandidates(m.id)).every((c) => c.status === 'proposed')).toBe(true);
  });

  it('searches again only with consent and within a few links', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const off = await createMimic(engine.deps, { ...intake, consentSearch: false }, 'p1');
    await expect(searchIdentityAgain(engine.deps, off.id, 'https://x.dev')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const m = await createMimic(engine.deps, { ...intake, name: 'Nobody Known', consentSearch: true }, 'p2');
    await engine.drain();
    for (const i of [1, 2, 3, 4]) {
      await searchIdentityAgain(engine.deps, m.id, `https://site${i}.dev`);
      await engine.drain();
    }
    expect((await engine.deps.store.getMimic(m.id))!.links).toHaveLength(4);
    await expect(searchIdentityAgain(engine.deps, m.id, 'https://site5.dev')).rejects.toMatchObject({
      code: 'conflict',
    });
    // Repeating a link it already has is fine.
    await searchIdentityAgain(engine.deps, m.id, 'https://site2.dev');
    expect((await engine.deps.store.getMimic(m.id))!.links[0]).toBe('https://site2.dev');
  });

  it('confirms a candidate, enriches with sourced facts, and lets the person skip', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    const [top] = await engine.deps.store.listCandidates(m.id);
    await confirmIdentity(engine.deps, m.id, top!.id);
    await engine.drain();
    const state = (await engine.deps.store.getMimic(m.id))!;
    expect(state.identityState).toBe('review');
    const facts = await engine.deps.store.listFacts(m.id);
    expect(facts.find((f) => f.predicate === 'worksAt')).toMatchObject({
      object: 'Northwind Labs',
      source: 'search',
      sourceUrl: 'https://www.linkedin.com/in/avery-quinn-example',
    });
    expect(facts.every((f) => f.sourceUrl || f.source !== 'search')).toBe(true);
    const kg = await engine.deps.store.listKg(m.id);
    expect(kg.nodes.some((n) => n.type === 'Organization' && n.label === 'Northwind Labs')).toBe(true);
    await finishIdentity(engine.deps, m.id);
    expect((await engine.deps.store.getMimic(m.id))!.status).toBe('learning');
    expect((await serveNext(engine.deps, m.id)).status).toBe('question');

    // Skipping during search stops identity even if the search job finishes later.
    const m2 = await createMimic(engine.deps, { ...intake, name: 'Rowan Ellis', consentSearch: true }, 'p2');
    await finishIdentity(engine.deps, m2.id);
    await engine.drain();
    const s2 = (await engine.deps.store.getMimic(m2.id))!;
    expect(s2.status).toBe('learning');
    expect(s2.identityState).toBe('done');
  });

  it('removed facts never appear in any state, prompt or export', async () => {
    // Human pacing: sealed states see derived data older than STATE_SETTLE_MS, so time must move like a session's.
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    const m = await createMimic(engine.deps, { ...intake, consentSearch: true }, 'p1');
    await engine.drain();
    const [top] = await engine.deps.store.listCandidates(m.id);
    await confirmIdentity(engine.deps, m.id, top!.id);
    await engine.drain();
    const facts = await engine.deps.store.listFacts(m.id);
    // Remove every fact that mentions them (the candidate headline "… at Northwind Labs" is its own fact).
    const removed = facts.filter((f) => /Northwind Labs|Bouldering/.test(f.object));
    expect(removed.length).toBeGreaterThanOrEqual(3);
    for (const f of removed) await setFactState(engine.deps, m.id, f.id, 'removed');
    const kept = facts.find((f) => f.object === 'Contoso')!;
    await finishIdentity(engine.deps, m.id);
    await answerTurns(m.id, 12);

    const blobs = engine.deps.blobs as MemoryBlobs;
    const states = [...blobs.data.entries()].filter(([k]) => k.startsWith(`states/${m.id}/`));
    expect(states.length).toBeGreaterThan(10);
    for (const [, body] of states) {
      expect(body).not.toContain('Northwind Labs');
      expect(body).not.toContain('Bouldering');
    }
    expect(states.some(([, body]) => body.includes(kept.object))).toBe(true);

    // No prompt or Jev state sent after the removal mentions them (identity traces carry the raw search itself).
    const calls = await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 10_000 });
    const later = calls.filter(
      (c) => !c.purpose.startsWith('identity') && !c.purpose.startsWith('embed.fact'),
    );
    expect(later.length).toBeGreaterThan(20);
    for (const c of later) {
      const trace = JSON.parse((await blobs.get(c.r2TraceKey))!) as { request: unknown };
      const req = JSON.stringify(trace.request);
      expect(req, c.purpose).not.toContain('Northwind Labs');
      expect(req, c.purpose).not.toContain('Bouldering');
    }

    const doc = await exportMimic(engine.deps, m.id);
    expect(JSON.stringify(doc.facts)).not.toContain('Northwind Labs');
    expect(doc.facts.some((f) => f.object === 'Contoso')).toBe(true);
  });
});

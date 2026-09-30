import type { FixtureEnricher, FixturePeopleSearch } from '@mimic/adapters';
import {
  confirmIdentity,
  createMimic,
  exportMimic,
  finishIdentity,
  runIdentitySearch,
  serveNext,
  setFactState,
  submitAnswer,
} from '@mimic/core';
import type { MemoryBlobs } from '@mimic/db/local';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(await engine.deps.blobs.list(`search/${m.id}/`)).not.toEqual([]);
    // The session can't start until the person decides.
    expect((await serveNext(engine.deps, m.id)).status).toBe('identity');
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
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
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

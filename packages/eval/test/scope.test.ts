import {
  ANCHORS_V1,
  blockedFacetIds,
  facetsFor,
  loadConfig,
  loadMimicData,
  type MimicRecord,
  ONTOLOGY_V1,
  questionAllowed,
  setScope,
  uiSnapshot,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { continueSession, runSession, SessionScript } from '../src/session';

/**
 * Scope enforcement (ADR-0036), M9: a deselected category is never asked about or learned. Offline fakes; the
 * generator tags whatever it is told to target, so these tests check the machinery, not an LLM.
 */

let engine: LocalEngine;
const narrow: string[] = [];
let wide: string;

const script = (name: string, categories?: string[]) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch: true,
    seed: name,
    ...(categories ? { categories } : {}),
  });

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'scope-m9' });
  for (const n of ['Narrow 1', 'Narrow 2'])
    narrow.push((await runSession(engine, script(n, ['psychology', 'values']), { turns: 20 })).mimicId);
  wide = (await runSession(engine, script('Wide'), { turns: 12 })).mimicId;
}, 180_000);

afterAll(() => engine.close());

const BLOCKED = blockedFacetIds(
  { categories: ['psychology', 'values'], consents: {}, researchConsents: {} },
  ONTOLOGY_V1,
);

async function trace(key: string): Promise<{ request: unknown }> {
  return JSON.parse((await engine.deps.blobs.get(key))!) as { request: unknown };
}

describe('deselected categories (ADR-0036)', () => {
  it('stores the scope and seeds only anchors inside it, in the same per-person order', async () => {
    const allowedAnchors = ANCHORS_V1.filter((a) => questionAllowed(a, BLOCKED)).map((a) => a.itemKey);
    expect(allowedAnchors.length).toBe(7); // trust game, free Saturday and the work anchor are out
    for (const id of narrow) {
      const m = (await engine.deps.store.getMimic(id))!;
      expect(m.scope).toEqual({ categories: ['psychology', 'values'], consents: {}, researchConsents: {} });
      expect(m.scopeAt).toBeNull();
      const anchors = (await engine.deps.store.listQuestions(id)).filter((q) => q.kind === 'anchor');
      expect(anchors.map((q) => q.itemKey).sort()).toEqual([...allowedAnchors].sort());
    }
    const all = (await engine.deps.store.listQuestions(wide)).filter((q) => q.kind === 'anchor');
    expect(all).toHaveLength(10);
  });

  it('never serves, reads, reflects or builds a graph node on a blocked facet', async () => {
    const { store } = engine.deps;
    for (const id of narrow) {
      const served = (await store.listQuestions(id)).filter((q) => q.seq !== null);
      expect(served.length).toBeGreaterThanOrEqual(20);
      for (const q of served)
        expect(
          q.facetIds.filter((f) => BLOCKED.has(f)),
          q.prompt,
        ).toEqual([]);
      for (const t of await store.listTraitHistory(id)) expect(BLOCKED.has(t.facetId), t.facetId).toBe(false);
      for (const i of await store.listInsights(id))
        expect(i.facetIds.filter((f) => BLOCKED.has(f))).toEqual([]);
      for (const n of (await store.listKg(id)).nodes.filter((x) => x.type === 'Facet'))
        expect(BLOCKED.has(String(n.props.facetId))).toBe(false);
      // Occupation facets belong to "Work and money": none are generated when it is deselected.
      expect(await store.listMimicFacets(id)).toEqual([]);
      const snap = await uiSnapshot(engine.deps, id);
      expect(snap.facets.filter((f) => BLOCKED.has(f.id))).toEqual([]);
    }
    expect((await store.listMimicFacets(wide)).length).toBeGreaterThan(0);
  });

  it('never shows a blocked facet to the generator, the trait reader or the hypotheses', async () => {
    const { store } = engine.deps;
    for (const id of narrow) {
      const calls = await store.listModelCalls({ mimicId: id, limit: 10_000 });
      const gen = calls.filter((c) => c.purpose === 'pool.generate');
      const reads = calls.filter((c) => c.purpose === 'traits.read');
      expect(gen.length).toBeGreaterThan(0);
      expect(reads.length).toBeGreaterThan(0);
      for (const c of gen) {
        const req = (await trace(c.r2TraceKey)).request as {
          messages: Array<{ role: string; content: string }>;
        };
        const system = req.messages.find((m) => m.role === 'system')!.content;
        const ontology = system.slice(system.indexOf('ONTOLOGY'));
        const listed = [...ontology.matchAll(/^([a-z_]+) \|/gm)].map((m) => m[1]!);
        expect(listed.length).toBeGreaterThan(10);
        expect(listed.filter((f) => BLOCKED.has(f))).toEqual([]);
        const user = req.messages.find((m) => m.role === 'user')!.content;
        const targets = (user.match(/^Target facets: (.*)$/m)?.[1] ?? '').split(', ');
        expect(targets.filter((f) => BLOCKED.has(f))).toEqual([]);
      }
      for (const c of reads) {
        const req = (await trace(c.r2TraceKey)).request as { questions: Record<string, unknown> };
        const facets = Object.keys(req.questions).map((k) => k.replace(/^t_/, ''));
        expect(facets.filter((f) => BLOCKED.has(f))).toEqual([]);
      }
    }
  });
});

describe('changing the scope later (ADR-0036)', () => {
  let m: MimicRecord;

  it('shrinking discards pooled questions it put out of reach, stamps scopeAt and hides what was learned', async () => {
    const { store } = engine.deps;
    m = (await store.getMimic(wide))!;
    const before = await loadMimicData(engine.deps, m);
    const workFacets = new Set(ONTOLOGY_V1.filter((f) => f.category === 'work').map((f) => f.id));
    const answeredWork = before.data.evidence.filter((e) => e.facetIds.some((f) => workFacets.has(f)));
    expect(answeredWork.length).toBeGreaterThan(0); // the work anchor, at least

    const change = await setScope(engine.deps, wide, {
      categories: ['psychology', 'values', 'life'],
      consents: {},
      researchConsents: {},
    });
    expect(change.scopeAt).not.toBeNull();
    const after = (await store.getMimic(wide))!;
    expect(after.scope.categories).toEqual(['psychology', 'values', 'life']);
    const cfg = await loadConfig(engine.deps, after.configHash);
    const blocked = blockedFacetIds(after.scope, await facetsFor(engine.deps, after, cfg, { scoped: false }));
    const open = await store.listQuestions(wide, ['pooled', 'served']);
    for (const q of open) expect(questionAllowed(q, blocked), q.prompt).toBe(true);

    const view = await loadMimicData(engine.deps, after);
    expect(view.data.evidence.filter((e) => e.facetIds.some((f) => blocked.has(f)))).toEqual([]);
    expect(view.data.traits.filter((t) => blocked.has(t.facetId))).toEqual([]);
    expect(view.data.evidence.length).toBe(before.data.evidence.length - answeredWork.length);
    // Rows are kept (hard delete removes them); only views and states leave them out.
    expect((await store.listAnswers(wide)).length).toBe(before.answers.length);
  });

  it('serves nothing from the withdrawn category afterwards', async () => {
    const { store } = engine.deps;
    const cutoff = (await store.getMimic(wide))!.seqMax;
    await continueSession(engine, wide, script('Wide'), { turns: 10 });
    const later = (await store.listQuestions(wide)).filter((q) => q.seq !== null && q.seq > cutoff);
    expect(later.length).toBeGreaterThanOrEqual(8);
    const workFacets = new Set(ONTOLOGY_V1.filter((f) => f.category === 'work').map((f) => f.id));
    for (const q of later)
      expect(
        q.facetIds.filter((f) => workFacets.has(f)),
        q.prompt,
      ).toEqual([]);
  });

  it('growing the scope back does not stamp scopeAt and lets the category be asked again', async () => {
    const { store } = engine.deps;
    const stamped = (await store.getMimic(wide))!.scopeAt;
    const change = await setScope(engine.deps, wide, m.scope);
    expect(change.scopeAt).toBe(stamped);
    expect(change.discarded).toBe(0);
    expect((await store.getMimic(wide))!.scope.categories).toEqual(['psychology', 'values', 'life', 'work']);
  });
});

import {
  addFacts,
  type EngineDeps,
  type FactRecord,
  loadHypotheses,
  ONTOLOGY_V2,
  type QuestionRecord,
  SPECIAL_AREAS,
  type SpecialArea,
  setScope,
  specialAreaOfFact,
  uiSnapshot,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerNamedConfig } from '../src/configs';
import { scrubExport } from '../src/export';
import { ROGUE_REFLECTION } from '../src/fakes';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { reproduceOnline } from '../src/replay';
import { continueSession, runSession, SessionScript } from '../src/session';

/**
 * Leakage (ADR-0043, rubric R5): with the M10 candidate's sensitive facets, nothing reaches a person's questions,
 * traits, insights, facts, graph, hypotheses, views or research export that their scope and consents don't allow,
 * and a sensitive facet is only ever learned from a direct question. The offline reflector and hypothesis writer
 * infer religion from whatever they see, and the generator appends rogue drafts, so each guard has something to stop.
 */

let engine: LocalEngine;
let t = Date.now();
const ids = { none: '', consented: '', research: '', withdrawn: '' };
let withdrawnCutoff = 0;
const ALL = { politics: true, religion: true, sexuality: true, health: true, money: true };
const AREA = new Map(ONTOLOGY_V2.filter((f) => f.sensitive).map((f) => [f.id, f.sensitive!]));
const areaFacets = (a: string) => new Set([...AREA].filter(([, x]) => x === a).map(([f]) => f));
const SPECIAL = new Set(
  [...AREA].filter(([, a]) => (SPECIAL_AREAS as readonly string[]).includes(a)).map(([f]) => f),
);

const script = (
  name: string,
  consents: Record<string, boolean>,
  researchConsents: Record<string, boolean> = {},
) =>
  SessionScript.parse({
    intake: { name, location: 'Porto, PT', occupation: 'Teacher' },
    consentResearch: true,
    seed: name,
    consents,
    researchConsents,
  });

beforeAll(async () => {
  // Human pacing, so derived state is old enough to enter sealed states and replay can rebuild them (ADR-0017).
  engine = await openLocalEngine({
    db: ':memory:',
    providers: 'offline',
    seed: 'leak',
    clock: () => (t += 1_000),
  });
  const configHash = await registerNamedConfig(engine.deps, 'm10-candidate');
  ids.none = (await runSession(engine, script('None', {}), { turns: 24, configHash })).mimicId;
  ids.consented = (await runSession(engine, script('Consented', ALL), { turns: 30, configHash })).mimicId;
  ids.research = (
    await runSession(
      engine,
      script('Research', ALL, { politics: true, religion: true, sexuality: true, health: true }),
      {
        turns: 20,
        configHash,
      },
    )
  ).mimicId;
  const w = script('Withdrawn', { health: true });
  ids.withdrawn = (await runSession(engine, w, { turns: 12, configHash })).mimicId;
  const m = (await engine.deps.store.getMimic(ids.withdrawn))!;
  withdrawnCutoff = m.seqMax;
  await setScope(engine.deps, ids.withdrawn, { ...m.scope, consents: {} });
  await continueSession(engine, ids.withdrawn, { ...w, consents: {} }, { turns: 12 });
}, 240_000);

afterAll(() => engine.close());

async function answered(id: string): Promise<Map<number, QuestionRecord>> {
  const qs = await engine.deps.store.listQuestions(id);
  return new Map(qs.filter((q) => q.status === 'answered' && q.seq !== null).map((q) => [q.seq!, q]));
}

/** Seqs of answered questions that asked about `facets` directly. */
function directSeqs(byseq: Map<number, QuestionRecord>, facets: ReadonlySet<string>): Set<number> {
  return new Set([...byseq].filter(([, q]) => q.facetIds.some((f) => facets.has(f))).map(([s]) => s));
}

async function traces(deps: EngineDeps, id: string, purpose: string) {
  const calls = (await deps.store.listModelCalls({ mimicId: id, limit: 10_000 })).filter(
    (c) => c.purpose === purpose,
  );
  return Promise.all(
    calls.map(async (c) => JSON.parse((await deps.blobs.get(c.r2TraceKey))!) as { request: unknown }),
  );
}

describe('no sensitive consent (ADR-0043)', () => {
  it('never asks, reads, reflects, stores or graphs a sensitive facet', async () => {
    const { store } = engine.deps;
    const id = ids.none;
    for (const q of await store.listQuestions(id))
      expect(
        q.facetIds.filter((f) => AREA.has(f)),
        q.prompt,
      ).toEqual([]);
    for (const tr of await store.listTraitHistory(id)) expect(AREA.has(tr.facetId), tr.facetId).toBe(false);
    for (const i of await store.listInsights(id)) {
      expect(i.facetIds.filter((f) => AREA.has(f))).toEqual([]);
      expect(i.text).not.toBe(ROGUE_REFLECTION.insight);
    }
    expect((await store.listFacts(id)).map((f) => f.object)).not.toContain(ROGUE_REFLECTION.fact);
    for (const n of (await store.listKg(id)).nodes.filter((x) => x.type === 'Facet'))
      expect(AREA.has(String(n.props.facetId))).toBe(false);
    const hyp = await loadHypotheses(engine.deps, id);
    expect(hyp?.hypotheses.length).toBeGreaterThan(0);
    for (const h of hyp!.hypotheses) expect(h).not.toContain('church');
    const snap = await uiSnapshot(engine.deps, id);
    expect(snap.facets.filter((f) => AREA.has(f.id))).toEqual([]);
  });

  it('never shows a sensitive facet to the generator, the trait reader or the reflector', async () => {
    for (const tr of await traces(engine.deps, ids.none, 'pool.generate')) {
      const system = (tr.request as { messages: Array<{ role: string; content: string }> }).messages[0]!
        .content;
      expect(system.slice(system.indexOf('ONTOLOGY ('))).not.toContain('[sensitive: ');
    }
    for (const tr of await traces(engine.deps, ids.none, 'traits.read')) {
      const keys = Object.keys((tr.request as { questions: Record<string, unknown> }).questions);
      expect(keys.filter((k) => AREA.has(k.replace(/^t_/, '')))).toEqual([]);
    }
    for (const tr of await traces(engine.deps, ids.none, 'reflect')) {
      const system = (tr.request as { messages: Array<{ content: string }> }).messages[0]!.content;
      expect(system.slice(system.indexOf('ONTOLOGY facet IDs'))).not.toContain('[sensitive]');
    }
  });

  it('drops special-category facts from web search before they are stored', async () => {
    const m = (await engine.deps.store.getMimic(ids.none))!;
    const fact = (object: string): FactRecord => ({
      id: engine.deps.newId(),
      mimicId: m.id,
      predicate: 'hasInterest',
      object,
      source: 'search',
      sourceRef: null,
      sourceUrl: 'https://example.com',
      confidence: 0.7,
      userState: 'active',
      createdAt: engine.deps.clock(),
      userStateAt: null,
      seqUpTo: null,
    });
    await addFacts(engine.deps, m, [
      fact('Baptist church choir'),
      fact('Campaign volunteer for the Green Party'),
      fact('Trail running'),
    ]);
    const objects = (await engine.deps.store.listFacts(m.id)).map((f) => f.object);
    expect(objects).toContain('Trail running');
    expect(objects).not.toContain('Baptist church choir');
    expect(objects).not.toContain('Campaign volunteer for the Green Party');
  });
});

describe('with consent, only direct questions teach a sensitive facet (ADR-0043)', () => {
  it('asks consented sensitive questions', async () => {
    const byseq = await answered(ids.consented);
    expect([...byseq.values()].some((q) => q.facetIds.some((f) => AREA.has(f)))).toBe(true);
  });

  it('reads a sensitive trait only after a direct question about it', async () => {
    const byseq = await answered(ids.consented);
    const rows = (await engine.deps.store.listTraitHistory(ids.consented)).filter((r) => AREA.has(r.facetId));
    for (const r of rows) {
      const direct = directSeqs(byseq, new Set([r.facetId]));
      expect(
        [...direct].some((s) => s <= r.seqUpTo),
        `${r.facetId} read at ${r.seqUpTo}`,
      ).toBe(true);
    }
  });

  it("keeps the reflector's sensitive tags, statements and facts only when they cite a direct answer", async () => {
    const byseq = await answered(ids.consented);
    const religion = directSeqs(byseq, areaFacets('religion'));
    const insights = await engine.deps.store.listInsights(ids.consented);
    for (const i of insights) {
      for (const f of i.facetIds.filter((x) => AREA.has(x)))
        expect(
          i.evidenceSeqs.some((s) => directSeqs(byseq, new Set([f])).has(s)),
          i.text,
        ).toBe(true);
      if (i.text === ROGUE_REFLECTION.insight) expect(i.evidenceSeqs.some((s) => religion.has(s))).toBe(true);
    }
    for (const f of (await engine.deps.store.listFacts(ids.consented)).filter(
      (x) => x.object === ROGUE_REFLECTION.fact,
    )) {
      const cited = (f.sourceRef ?? '').replace('answers:', '').split(',').map(Number);
      expect(cited.some((s) => religion.has(s))).toBe(true);
    }
    // The fake reflector emitted the rogue insight at every reflection; most were dropped.
    const reflections = (await traces(engine.deps, ids.consented, 'reflect')).length;
    const kept = insights.filter((i) => i.text === ROGUE_REFLECTION.insight).length;
    expect(reflections).toBeGreaterThan(kept);
  });

  it('keeps a religious guess in a hypothesis only after a direct religion answer', async () => {
    const byseq = await answered(ids.consented);
    const religion = directSeqs(byseq, areaFacets('religion'));
    const hyp = (await loadHypotheses(engine.deps, ids.consented))!;
    if (hyp.hypotheses.some((h) => h.includes('church')))
      expect([...religion].some((s) => s <= hyp.seqUpTo)).toBe(true);
  });
});

describe('withdrawing a consent (ADR-0040, ADR-0043)', () => {
  it('asks nothing more about it and seals no later state with it', async () => {
    const { store, blobs } = engine.deps;
    const m = (await store.getMimic(ids.withdrawn))!;
    expect(m.scopeAt).not.toBeNull();
    const health = areaFacets('health');
    const qs = await store.listQuestions(ids.withdrawn);
    const healthSeqs = new Set(
      qs.filter((q) => q.seq !== null && q.facetIds.some((f) => health.has(f))).map((q) => q.seq!),
    );
    const later = qs.filter((q) => q.seq !== null && q.seq > withdrawnCutoff);
    expect(later.length).toBeGreaterThanOrEqual(10);
    for (const q of later)
      expect(
        q.facetIds.filter((f) => health.has(f)),
        q.prompt,
      ).toEqual([]);
    const preds = await store.listPredictions({ mimicId: ids.withdrawn, roles: ['primary'] });
    const laterIds = new Set(later.map((q) => q.id));
    let checked = 0;
    for (const p of preds.filter((x) => laterIds.has(x.questionId) && x.ok)) {
      const raw = await blobs.get(`states/${ids.withdrawn}/${p.stateHash}.json`);
      if (!raw) continue;
      const state = JSON.parse(raw) as {
        evidence: Array<{ seq: number }>;
        traits?: Array<{ facet: string }>;
        insights?: Array<{ facets?: string[] }>;
      };
      checked++;
      expect(state.evidence.filter((e) => healthSeqs.has(e.seq))).toEqual([]);
      expect((state.traits ?? []).filter((x) => health.has(x.facet))).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
    const snap = await uiSnapshot(engine.deps, ids.withdrawn);
    expect(snap.facets.filter((f) => health.has(f.id))).toEqual([]);
    for (const f of snap.facets) expect(f.supporting.filter((s) => healthSeqs.has(s))).toEqual([]);
  });

  it('replays every other state exactly and reports the withdrawn ones as rescoped', async () => {
    const r = await reproduceOnline(engine.deps, { seed: 's', name: 'leakage' }, 'hash');
    expect(r.rescoped).toBeGreaterThan(0);
    expect(r.stateHashMatchRate).toBe(1);
    expect(r.pass).toBe(true);
  }, 120_000);
});

describe('research export without research consent (ADR-0043)', () => {
  it('keeps everything for an internal --keep-identity export, then scrubs special categories for research', async () => {
    const { client } = engine;
    const count = async (sql: string, args: string[] = []) =>
      Number((await client.execute({ sql, args })).rows[0]!.n);
    const specialList = [...SPECIAL].map((f) => `'${f}'`).join(',');
    const touching = `select count(*) as n from questions q, json_each(q.facet_ids_json) j where q.mimic_id = ? and j.value in (${specialList})`;
    const moneyList = [...areaFacets('money')].map((f) => `'${f}'`).join(',');
    const money = `select count(*) as n from questions q, json_each(q.facet_ids_json) j where q.mimic_id = ? and j.value in (${moneyList})`;
    const before = {
      research: await count(touching, [ids.research]),
      consentedMoney: await count(money, [ids.consented]),
    };
    expect(before.research).toBeGreaterThan(0);
    expect(before.consentedMoney).toBeGreaterThan(0);

    await scrubExport(client, { keepIdentity: true });
    expect(await count(touching, [ids.research])).toBe(before.research);
    expect(await count(touching, [ids.consented])).toBeGreaterThan(0);

    await scrubExport(client, { keepIdentity: false });
    const people = (
      await client.execute('select id, consents_json, research_consents_json from mimics')
    ).rows.map((r) => ({
      id: String(r.id),
      consents: String(r.consents_json),
      research: String(r.research_consents_json),
    }));
    const consented = people.find((p) => p.consents.includes('sexuality') && p.research === '{}')!;
    const research = people.find((p) => p.research.includes('religion'))!;
    expect(consented).toBeDefined();
    expect(research).toBeDefined();
    // Without research consent: no question, trait, insight, graph node or fact on a special category survives.
    expect(await count(touching, [consented.id])).toBe(0);
    expect(
      await count(
        `select count(*) as n from trait_history where mimic_id = ? and facet_id in (${specialList})`,
        [consented.id],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*) as n from trait_estimates where mimic_id = ? and facet_id in (${specialList})`,
        [consented.id],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*) as n from insights i, json_each(i.facet_ids_json) j where i.mimic_id = ? and j.value in (${specialList})`,
        [consented.id],
      ),
    ).toBe(0);
    expect(
      await count(`select count(*) as n from insights where mimic_id = ? and text = ?`, [
        consented.id,
        ROGUE_REFLECTION.insight,
      ]),
    ).toBe(0);
    for (const f of (
      await client.execute({
        sql: 'select predicate, object from facts where mimic_id = ?',
        args: [consented.id],
      })
    ).rows)
      expect(specialAreaOfFact({ predicate: String(f.predicate), object: String(f.object) })).toBeNull();
    for (const n of (
      await client.execute({
        sql: "select props_json from kg_nodes where mimic_id = ? and type = 'Facet'",
        args: [consented.id],
      })
    ).rows)
      expect(
        SPECIAL.has(String((JSON.parse(String(n.props_json)) as { facetId?: string }).facetId ?? '')),
      ).toBe(false);
    // Money follows plain research consent; the person who consented to research use keeps everything.
    expect(await count(money, [consented.id])).toBe(before.consentedMoney);
    expect(await count(touching, [research.id])).toBe(before.research);
    // Sanity: the special areas in play here are the four special ones.
    expect(new Set([...AREA.values()].filter((a) => a !== 'money'))).toEqual(
      new Set<SpecialArea>(SPECIAL_AREAS),
    );
  });
});

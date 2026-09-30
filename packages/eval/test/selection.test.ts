import {
  DEFAULT_CONFIG,
  deleteMimic,
  hashJson,
  itemStatKey,
  type PersonState,
  parseHypothesisTag,
  populationScore,
  runStatsRefresh,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerNamedConfig } from '../src/configs';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript } from '../src/session';

let engine: LocalEngine;
let ids: string[] = [];
let configHash = '';
const PEOPLE = 10;

// ADR-0027's selector and gen.v2, as cfg.default.v6 has them; v7's balance and ramp are tested in balance.test.ts.
beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'voi-cohort' });
  configHash = await registerNamedConfig(engine.deps, 'v6');
  ids = [];
  for (let i = 0; i < PEOPLE; i++) {
    const script = SessionScript.parse({
      intake: { name: `Person ${i}`, location: 'Lisbon, PT', occupation: 'Nurse' },
      consentResearch: true,
      seed: `voi${i}`,
    });
    ids.push((await runSession(engine, script, { turns: 24, configHash })).mimicId);
  }
}, 180_000);

afterAll(() => engine.close());

describe('value-of-information selection (ADR-0027)', () => {
  it('is the default config and records the winning score’s components on every adaptive question', async () => {
    expect(DEFAULT_CONFIG.selector.type).toBe('voi');
    const { store } = engine.deps;
    for (const id of ids) {
      const adaptive = (await store.listQuestions(id)).filter((q) => q.kind === 'adaptive' && q.seq !== null);
      expect(adaptive.length).toBeGreaterThan(8);
      for (const q of adaptive) {
        expect(q.selection).toMatchObject({ selector: 'voi' });
        for (const k of ['info', 'gap', 'conflict', 'weakness', 'redundancy', 'burden', 'score'])
          expect(typeof q.selection![k], k).toBe('number');
      }
      // Anchors are fixed items: no selection.
      for (const q of (await store.listQuestions(id)).filter((x) => x.kind === 'anchor'))
        expect(q.selection ?? null).toBeNull();
    }
  });

  it('stores each hypothesis’s prediction of the chosen question, sealed and reproducible, and never scores it', async () => {
    const { store, blobs } = engine.deps;
    let rows = 0;
    for (const id of ids) {
      const hyps = await store.listPredictions({ mimicId: id, roles: ['hypothesis'] });
      const primaries = new Map(
        (await store.listPredictions({ mimicId: id, roles: ['primary'] })).map((p) => [p.questionId, p]),
      );
      const questions = new Map((await store.listQuestions(id)).map((q) => [q.id, q]));
      for (const h of hyps) {
        rows++;
        const q = questions.get(h.questionId)!;
        const primary = primaries.get(h.questionId)!;
        expect(parseHypothesisTag(h.hypothesis!)).toMatchObject({ index: expect.any(Number) });
        expect(h.evidenceSeqMax).toBe(primary.evidenceSeqMax);
        expect(h.evidenceSeqMax).toBeLessThan(q.seq!);
        expect(h.stateHash).not.toBe(primary.stateHash);
        const raw = await blobs.get(`states/${id}/${h.stateHash}.json`);
        expect(raw).not.toBeNull();
        const state = JSON.parse(raw!) as PersonState;
        const { meta, ...body } = state;
        expect(hashJson(body)).toBe(h.stateHash);
        expect(typeof state.hypothesis).toBe('string');
        expect(meta.builder).toMatch(/\+hyp$/);
        // The hypothesis rows are the same as the sealed primary's state plus the hypothesis text.
        expect(state.evidence.every((e) => e.seq < q.seq!)).toBe(true);
      }
      const scored = await store.listScoredPredictions(id, ['hypothesis']);
      expect(scored).toHaveLength(0);
      // One sealed primary per served non-repeat question, whatever the number of hypotheses.
      const served = [...questions.values()].filter((q) => q.seq !== null && q.kind !== 'repeat');
      expect(primaries.size).toBe(served.length);
    }
    expect(rows).toBeGreaterThan(0);
  });

  it('uses posterior hypothesis weights once answers have been given since the hypotheses were written', async () => {
    const { store } = engine.deps;
    let weighted = 0;
    for (const id of ids) {
      for (const q of await store.listQuestions(id)) {
        const w = q.selection?.hypothesisWeights as number[] | undefined;
        if (!w) continue;
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
        if (w.some((x) => Math.abs(x - 1 / w.length) > 0.01)) weighted++;
      }
    }
    expect(weighted).toBeGreaterThan(0);
  });

  it('annotates sealed states with latency hints (builder full.v2) and keeps the baseline context-only', async () => {
    const { store, blobs } = engine.deps;
    const id = ids[0]!;
    const primaries = await store.listPredictions({ mimicId: id, roles: ['primary', 'baseline'] });
    let v2 = 0;
    for (const p of primaries) {
      const state = JSON.parse((await blobs.get(`states/${id}/${p.stateHash}.json`))!) as PersonState;
      if (p.role === 'baseline') expect(state.meta.builder).toBe('context.v1');
      else if (state.evidence.length) {
        expect(state.meta.builder).toBe('full.v2');
        v2++;
      }
    }
    expect(v2).toBeGreaterThan(10);
  });

  it('refreshes aggregate item statistics over consented dev-split mimics and ranks candidates with them', async () => {
    const { store } = engine.deps;
    const n = await runStatsRefresh(engine.deps);
    expect(n).toBeGreaterThan(0);
    const stats = await store.listItemStats();
    const dev = (await store.listMimics({ consentResearch: true })).filter((m) => m.split === 'dev');
    expect(dev.length).toBeGreaterThanOrEqual(5);
    const gamble = stats.find((s) => s.key === itemStatKey.item('anchors.v1/risk_gamble'))!;
    expect(gamble.kind).toBe('item');
    expect(gamble.nPeople).toBe(dev.length);
    expect(gamble.answerEntropy).not.toBeNull();
    expect(gamble.baselineError).toBeGreaterThanOrEqual(0);
    expect(gamble.baselineError).toBeLessThanOrEqual(1);
    for (const s of stats) {
      expect(JSON.stringify(s)).not.toMatch(/Person \d/);
      for (const id of ids) expect(JSON.stringify(s)).not.toContain(id);
    }
    const byKey = new Map(stats.map((s) => [s.key, s]));
    const score = populationScore(
      { itemKey: 'anchors.v1/risk_gamble', facetIds: ['risk_tolerance'], domain: 'core', type: 'choice' },
      byKey,
      { minPeople: Math.min(5, dev.length) },
    );
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
    expect(score!).toBeLessThan(1);
    // No stored row is one person's numbers.
    for (const s of stats) expect(s.nPeople).toBeGreaterThanOrEqual(5);
    // A second refresh is idempotent on the same data.
    await runStatsRefresh(engine.deps);
    expect((await store.listItemStats()).length).toBe(stats.length);
    // The table is replaced, not upserted: a person who leaves takes their contribution with them, and a key
    // that no longer clears the threshold disappears rather than lingering.
    const gone = dev.slice(0, dev.length - 4);
    for (const m of gone) await deleteMimic(engine.deps, m.id);
    await runStatsRefresh(engine.deps);
    expect(await store.listItemStats()).toEqual([]);
    // Restore a cohort for the population check below.
    for (let i = 0; i < gone.length; i++) {
      const script = SessionScript.parse({
        intake: { name: `Person again ${i}`, location: 'Lisbon, PT', occupation: 'Nurse' },
        consentResearch: true,
        seed: `again${i}`,
      });
      await runSession(engine, script, { turns: 14, configHash });
    }
    await runStatsRefresh(engine.deps);
    expect((await store.listItemStats()).length).toBeGreaterThan(0);
    // A new selection with statistics available carries a population term.
    const script = SessionScript.parse({
      intake: { name: 'Person late', location: 'Lisbon, PT', occupation: 'Nurse' },
      consentResearch: true,
      seed: 'late',
    });
    const { mimicId } = await runSession(engine, script, { turns: 14, configHash });
    const adaptive = (await store.listQuestions(mimicId)).filter(
      (q) => q.kind === 'adaptive' && q.seq !== null,
    );
    expect(adaptive.length).toBeGreaterThan(0);
    for (const q of adaptive) expect(typeof q.selection!.population).toBe('number');
  }, 60_000);

  it('generates candidates with belief-driven targets (gen.v2) and the calls are logged', async () => {
    const calls = await engine.deps.store.listModelCalls({ mimicId: ids[0]!, limit: 10_000 });
    const purposes = new Set(calls.map((c) => c.purpose));
    expect(purposes.has('pool.generate')).toBe(true);
    expect(purposes.has('hypotheses')).toBe(true);
    expect(purposes.has('select.bald')).toBe(true);
    const pooled = (await engine.deps.store.listQuestions(ids[0]!)).filter(
      (q) => q.kind === 'adaptive' && q.provenance.promptVersion === 'gen.v2',
    );
    expect(pooled.length).toBeGreaterThan(0);
  });
});

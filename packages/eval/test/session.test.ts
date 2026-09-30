import {
  DEFAULT_CONFIG,
  enqueueMissingShadows,
  hashJson,
  jobKey,
  MimicJson,
  type PersonState,
} from '@mimic/core';
import { schema } from '@mimic/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript, type TurnLog } from '../src/session';

let engine: LocalEngine;
let mimicId: string;
let turns: TurnLog[];

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
  const script = SessionScript.parse({
    intake: { name: 'Sam Rivera', location: 'Austin, US', occupation: 'Software engineer' },
    consentResearch: true,
    answers: { 'anchors.v1/risk_gamble': 'b', 'free saturday': 'A quiet day at home' },
    whys: { 'anchors.v1/risk_gamble': 'I like upside.' },
  });
  ({ mimicId, turns } = await runSession(engine, script, { turns: 30 }));
}, 60_000);

afterAll(() => engine.close());

describe('scripted 30-turn session (offline fakes)', () => {
  it('runs 30 turns: anchors first, then adaptive with repeat probes', () => {
    expect(turns).toHaveLength(30);
    expect(turns.slice(0, 10).every((t) => t.kind === 'anchor')).toBe(true);
    expect(turns.slice(10).every((t) => t.kind === 'adaptive')).toBe(true);
    expect(turns.find((t) => t.itemKey === 'anchors.v1/risk_gamble')?.answer).toBe('b');
    expect(turns.find((t) => t.itemKey === 'anchors.v1/free_saturday')?.answerLabel).toBe(
      'A quiet day at home',
    );
  });

  it('seals every prediction: its state contains only answers with seq < t', async () => {
    const { store, blobs } = engine.deps;
    const questions = (await store.listQuestions(mimicId)).filter((q) => q.seq !== null);
    const preds = await store.listPredictions({ mimicId });
    let checked = 0;
    for (const q of questions) {
      for (const p of preds.filter((x) => x.questionId === q.id)) {
        expect(p.evidenceSeqMax).toBeLessThan(q.seq!);
        const raw = await blobs.get(`states/${mimicId}/${p.stateHash}.json`);
        expect(raw, `state blob for ${p.role}`).not.toBeNull();
        const state = JSON.parse(raw!) as PersonState;
        const { meta, ...body } = state;
        expect(hashJson(body)).toBe(p.stateHash);
        expect(meta.stateHash).toBe(p.stateHash);
        expect(state.evidence.every((e) => e.seq < q.seq!)).toBe(true);
        for (const i of state.insights ?? []) expect(i.evidence.every((s) => s < q.seq!)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('stores 1 primary, 1 context-only baseline and every configured shadow per scored question; none for repeats', async () => {
    const { store, blobs } = engine.deps;
    const questions = (await store.listQuestions(mimicId)).filter((q) => q.seq !== null);
    const repeats = questions.filter((q) => q.kind === 'repeat');
    expect(repeats.length).toBe(2);
    for (const q of questions) {
      const preds = await store.listPredictions({ questionId: q.id });
      if (q.kind === 'repeat') {
        expect(preds).toHaveLength(0);
        continue;
      }
      const primary = preds.filter((p) => p.role === 'primary');
      const baseline = preds.filter((p) => p.role === 'baseline');
      const shadows = preds.filter((p) => p.role === 'shadow');
      expect(primary).toHaveLength(1);
      expect(baseline).toHaveLength(1);
      // cfg.default.v6 (ADR-0041): the five LLMs on predict.v2 plus v5's reasoning-off Qwen as a control, each recording
      // its version (calibrated Jev is derived from the primary by the stored report, not a second Jev call).
      expect(shadows.map((s) => s.predictorId).sort()).toEqual([
        'llm:deepseek/deepseek-v4.1-flash@predict.v2',
        'llm:openai/gpt-6-luna@predict.v2',
        'llm:qwen/qwen3.8-flash@predict.v1-direct',
        'llm:qwen/qwen3.8-flash@predict.v2',
        'llm:xiaomi/mimo-v2.6-flash@predict.v2',
        'llm:z-ai/glm-5.3-flash@predict.v2',
      ]);
      for (const s of shadows) {
        expect(s.stateHash).toBe(primary[0]!.stateHash);
        expect(s.promptVersion).toBe(s.predictorId.split('@')[1]);
      }
      const base = JSON.parse(
        (await blobs.get(`states/${mimicId}/${baseline[0]!.stateHash}.json`))!,
      ) as PersonState;
      expect(base.evidence).toEqual([]);
      expect(base.meta.builder).toBe('context.v1');
      expect(primary[0]!.modelSnapshot).toMatch(/jev-1\.13/);
      expect(primary[0]!.configHash).toBeTruthy();
      expect(primary[0]!.promptVersion).toBe('jev-predict.v1');
    }
  });

  it('re-enqueues shadows whose enqueue was lost (cron repair), still on the sealed state', async () => {
    const { store } = engine.deps;
    const q = (await store.listQuestions(mimicId)).find((x) => x.kind === 'adaptive' && x.seq !== null)!;
    const lost = (await store.listPredictions({ questionId: q.id }))
      .filter((p) => p.role === 'shadow')
      .slice(0, 2);
    // Simulate a lost enqueue: no prediction, no score and no ledger row.
    for (const p of lost) {
      await engine.client.execute({ sql: 'delete from scores where prediction_id = ?', args: [p.id] });
      await engine.client.execute({ sql: 'delete from predictions where id = ?', args: [p.id] });
      const key = jobKey({ type: 'predict.shadow', mimicId, questionId: q.id, predictorId: p.predictorId });
      await engine.client.execute({ sql: 'delete from jobs where key = ?', args: [key] });
    }
    expect(await enqueueMissingShadows(engine.deps, mimicId, q.servedAt!)).toBe(0); // within the grace period
    expect(await enqueueMissingShadows(engine.deps, mimicId, Number.MAX_SAFE_INTEGER)).toBe(2);
    await engine.drain();
    const after = (await store.listPredictions({ questionId: q.id })).filter((p) => p.role === 'shadow');
    expect(after).toHaveLength(DEFAULT_CONFIG.predictor.shadows.length);
    const primary = (await store.listPredictions({ questionId: q.id, roles: ['primary'] }))[0]!;
    for (const p of after) expect(p.stateHash).toBe(primary.stateHash);
    expect(await enqueueMissingShadows(engine.deps, mimicId, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('scores every sealed prediction once the answer arrives, and appends fidelity', async () => {
    const { store } = engine.deps;
    const scored = await store.listScoredPredictions(mimicId, ['primary', 'baseline', 'shadow']);
    // Primary, baseline and every shadow, for each of the 28 scored questions.
    expect(scored.length).toBe(28 * (2 + DEFAULT_CONFIG.predictor.shadows.length));
    const fid = await store.listFidelity(mimicId);
    expect(fid).toHaveLength(30);
    expect(fid.at(-1)!.nRepeats).toBe(2);
    expect(fid.at(-1)!.nScored).toBe(28);
    expect(turns.at(-1)!.fidelity?.nScored).toBe(28);
  });

  it('writes every table with the same Drizzle schema', async () => {
    const { store } = engine.deps;
    const db = (store as unknown as { db: { get: (q: unknown) => Promise<{ n: number }> } }).db;
    const count = async (t: object) => (await db.get(sql`select count(*) as n from ${t}`)).n;
    const counts = {
      participants: await count(schema.participants),
      mimics: await count(schema.mimics),
      questions: await count(schema.questions),
      predictions: await count(schema.predictions),
      answers: await count(schema.answers),
      scores: await count(schema.scores),
      traitEstimates: await count(schema.traitEstimates),
      traitHistory: await count(schema.traitHistory),
      insights: await count(schema.insights),
      kgNodes: await count(schema.kgNodes),
      kgEdges: await count(schema.kgEdges),
      facts: await count(schema.facts),
      fidelity: await count(schema.fidelity),
      modelCalls: await count(schema.modelCalls),
      configs: await count(schema.configs),
      snapshots: await count(schema.snapshots),
      jobs: await count(schema.jobs),
      mimicFacets: await count(schema.mimicFacets),
      vectors: await count(schema.vectors),
    };
    for (const [table, n] of Object.entries(counts)) expect(n, table).toBeGreaterThan(0);
    expect(counts.answers).toBe(30);
  });

  it('keeps only cited insights and versions derived state', async () => {
    const { store } = engine.deps;
    const insights = await store.listInsights(mimicId);
    expect(insights.length).toBeGreaterThan(0);
    for (const i of insights) {
      expect(i.evidenceSeqs.length).toBeGreaterThan(0);
      expect(i.promptVersion).toBe('reflect.v2');
      expect(i.model).toContain('@fake');
    }
    const traits = await store.listTraits(mimicId);
    expect(traits.some((t) => t.method === 'jev')).toBe(true);
    expect(traits.some((t) => t.method === 'psychometric')).toBe(true);
    for (const t of traits) expect(t.configHash).toBeTruthy();
    expect((await store.listMimicFacets(mimicId)).map((f) => f.facet.id)).toContain('occ_prototype_first');
  });

  it('logs every model call with its purpose', async () => {
    const calls = await engine.deps.store.listModelCalls({ mimicId, limit: 10_000 });
    const purposes = new Set(calls.map((c) => c.purpose));
    for (const p of [
      'predict.primary',
      'predict.baseline',
      'predict.shadow',
      'pool.generate',
      'pool.gate',
      'traits.read',
      'reflect',
    ]) {
      expect(purposes.has(p), p).toBe(true);
    }
    expect(calls.every((c) => c.ok)).toBe(true);
  });

  it('writes a snapshot that validates against mimic/1', async () => {
    const snaps = await engine.deps.store.listSnapshots(mimicId);
    const doc = MimicJson.parse(JSON.parse((await engine.deps.blobs.get(snaps.at(-1)!.r2Key))!));
    expect(doc.seqUpTo).toBe(30);
    expect(doc.evidence).toHaveLength(30);
    expect(doc.evidence.find((e) => e.why)?.why).toBe('I like upside.');
  });
});

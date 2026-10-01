import {
  canonicalPredictorId,
  DEFAULT_CONFIG,
  type DecisionProvider,
  decisionChallenger,
  draftFromScenario,
  FLAG_KEYS,
  JEV_MODEL,
  labOverview,
  type PredictionRecord,
  predictPlayground,
  SPAN_MODEL,
  StaticFlags,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { storedRecords } from '../src/optimize/evaluate';
import { loadInstances } from '../src/optimize/instances';
import { runSession, SessionScript } from '../src/session';

// ADR-0054: rows are stored canonically (`decision:`), and a served prediction the `decisions-model` flag rerouted to
// span-01 is stored under span-01's predictor ID, so /lab and the eval reports never pool it with Jev's.
const JEV = canonicalPredictorId(DEFAULT_CONFIG.predictor.primary);
const SPAN = `decision:${SPAN_MODEL}@jev-predict.v2`;
const SERVED = ['primary', 'baseline', 'hypothesis'] as const;

const script = SessionScript.parse({
  intake: { name: 'Sam Rivera', location: 'Austin, US', occupation: 'Software engineer' },
  consentResearch: true,
  answers: { 'anchors.v1/risk_gamble': 'b' },
});

let engine: LocalEngine;
/** What the flag serves, and which models the provider fails, while each session runs. */
let mode: 'jev' | 'span-01' = 'jev';
const failing = new Set<string>();
const sessions: Record<'off' | 'on' | 'spanDown' | 'bothDown', string> = {
  off: '',
  on: '',
  spanDown: '',
  bothDown: '',
};

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'served-model' });
  const g = engine.deps.gateway.deps;
  const inner = g.decisions;
  g.decisions = {
    provider: inner.provider,
    decide: async (req) => {
      if (failing.has(req.model)) throw new Error(`HTTP 503 from openrouter.ai: ${req.model} unavailable`);
      return inner.decide(req);
    },
  } satisfies DecisionProvider;
  g.decisionRouter = decisionChallenger(new StaticFlags({ [FLAG_KEYS.decisionsModel]: () => mode }));

  sessions.off = (await runSession(engine, script, { turns: 12 })).mimicId;
  mode = 'span-01';
  sessions.on = (await runSession(engine, script, { turns: 12 })).mimicId;
  failing.add(SPAN_MODEL);
  sessions.spanDown = (await runSession(engine, script, { turns: 6 })).mimicId;
  // Both decision models down from the second question: the primary falls back to an LLM (PLAN §16).
  failing.delete(SPAN_MODEL);
  sessions.bothDown = (
    await runSession(engine, script, {
      turns: 4,
      onTurn: () => {
        failing.add(SPAN_MODEL);
        failing.add(JEV_MODEL);
      },
    })
  ).mimicId;
  failing.clear();
}, 240_000);

afterAll(() => engine?.close());

const rows = (mimicId: string, roles?: PredictionRecord['role'][]) =>
  engine.deps.store.listPredictions({ mimicId, ...(roles ? { roles } : {}) });

describe('rows are named canonically, after the model that answered (ADR-0054)', () => {
  it('flag off: every served row is Jev, as decision:, and nothing is written as jev:', async () => {
    const served = await rows(sessions.off, [...SERVED]);
    expect(served.length).toBeGreaterThan(20);
    for (const p of served) {
      expect(p.predictorId).toBe(JEV);
      expect(p.promptVersion).toBe('jev-predict.v2');
      expect(p.modelSnapshot.startsWith(JEV_MODEL)).toBe(true);
    }
    const shadows = await rows(sessions.off, ['shadow']);
    expect(shadows.length).toBeGreaterThan(0);
    for (const p of shadows) expect(DEFAULT_CONFIG.predictor.shadows).toContain(p.predictorId);
    // The raw table, not just what the Store reads back.
    const raw = await engine.client.execute(
      "SELECT COUNT(*) AS n FROM predictions WHERE predictor_id >= 'jev:' AND predictor_id < 'jev;'",
    );
    expect(Number(raw.rows[0]!.n)).toBe(0);
  });

  it('flag at span-01: primary, baseline and hypothesis rows carry span-01, with the config and prompt they had', async () => {
    const m = (await engine.deps.store.getMimic(sessions.on))!;
    const served = await rows(sessions.on, [...SERVED]);
    expect(served.length).toBeGreaterThan(20);
    expect(new Set(served.map((p) => p.role))).toEqual(new Set(SERVED));
    for (const p of served) {
      expect(p.predictorId).toBe(SPAN);
      expect(p.promptVersion).toBe('jev-predict.v2');
      expect(p.configHash).toBe(m.configHash);
      expect(p.modelSnapshot).toBe(`${SPAN_MODEL}-fake`);
      expect(p.fallback).toBe(false);
    }
    // Shadows name their own model and are never rerouted.
    const shadows = await rows(sessions.on, ['shadow']);
    expect(shadows.length).toBeGreaterThan(0);
    for (const p of shadows) expect(p.predictorId.startsWith('llm:')).toBe(true);
  });

  it('span-01 failing: Jev answers and the row keeps Jev’s ID', async () => {
    const served = await rows(sessions.spanDown, ['primary', 'baseline']);
    expect(served.length).toBeGreaterThan(5);
    for (const p of served) {
      expect(p.predictorId).toBe(JEV);
      expect(p.modelSnapshot).toBe(`${JEV_MODEL}-fake`);
    }
  });

  it('both failing: the primary is the LLM fallback, the failed baseline keeps the configured ID', async () => {
    const primaries = await rows(sessions.bothDown, ['primary']);
    const fallbacks = primaries.filter((p) => p.fallback);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const p of fallbacks) expect(p.predictorId.startsWith('llm:')).toBe(true);
    const failedBaselines = (await rows(sessions.bothDown, ['baseline'])).filter((p) => !p.ok);
    expect(failedBaselines.length).toBeGreaterThan(0);
    for (const p of failedBaselines) expect(p.predictorId).toBe(JEV);
  });

  it('the playground stores what answered too', async () => {
    mode = 'span-01';
    const draft = await draftFromScenario(
      engine.deps,
      sessions.off,
      'A friend invites you on a last-minute trip.',
    );
    const pred = await predictPlayground(engine.deps, sessions.off, { ...draft, rationale: false });
    const stored = (await rows(sessions.off)).filter((p) => p.questionId === pred.question.id);
    expect(stored.map((p) => [p.role, p.predictorId]).sort()).toEqual([
      ['baseline', SPAN],
      ['primary', SPAN],
    ]);
    mode = 'jev';
  });

  it('/lab and the stored report list Jev and span-01 apart', async () => {
    const lab = await labOverview(engine.deps, { includeAll: true, population: 'all' });
    const primaries = lab.predictors.filter((p) => p.role === 'primary').map((p) => p.predictorId);
    expect(primaries).toContain(JEV);
    expect(primaries).toContain(SPAN);
    expect(lab.predictors.every((p) => !p.predictorId.startsWith('jev:'))).toBe(true);

    const instances = await loadInstances(engine.deps, { k: 30, split: 'all', seed: 'served' });
    const candidates = new Set(storedRecords(instances).map((r) => r.candidate));
    expect(candidates).toContain(`${JEV}|primary`);
    expect(candidates).toContain(`${SPAN}|primary`);
  });
});

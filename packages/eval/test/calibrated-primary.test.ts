import {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_V6,
  type PredictionRecord,
  registerConfig,
  temperatureScale,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript, type TurnLog } from '../src/session';

// cfg.default.v7 (ADR-0048) calibrates the stored primary but must not change which questions are asked: selection
// scores candidates on Jev's raw scale. The same scripted person under v6 and v7 (same seed, offline fakes) should see
// the same questions, and v7's stored primary and baseline should be v6's rescaled at temperature 4.
const script = SessionScript.parse({
  intake: { name: 'Sam Rivera', location: 'Austin, US', occupation: 'Software engineer' },
  consentResearch: true,
  answers: { 'anchors.v1/risk_gamble': 'b' },
});

interface Run {
  engine: LocalEngine;
  mimicId: string;
  turns: TurnLog[];
}
let v6: Run;
let v7: Run;

async function run(configHash?: string, engine?: LocalEngine): Promise<Run> {
  const e =
    engine ?? (await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'calibrated-primary' }));
  const r = await runSession(e, script, { turns: 16, ...(configHash ? { configHash } : {}) });
  return { engine: e, ...r };
}

beforeAll(async () => {
  const e6 = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'calibrated-primary' });
  v6 = await run(await registerConfig(e6.deps, DEFAULT_CONFIG_V6, 'cfg.default.v6'), e6);
  v7 = await run();
}, 120_000);

afterAll(() => {
  v6?.engine.close();
  v7?.engine.close();
});

async function scored(r: Run, role: PredictionRecord['role']) {
  const questions = (await r.engine.deps.store.listQuestions(r.mimicId)).filter((q) => q.seq !== null);
  const preds = await r.engine.deps.store.listPredictions({ mimicId: r.mimicId });
  const bySeq = new Map<number, PredictionRecord>();
  for (const q of questions) {
    const p = preds.find((x) => x.questionId === q.id && x.role === role);
    if (p) bySeq.set(q.seq!, p);
  }
  return bySeq;
}

describe('calibrated primary (cfg.default.v7, ADR-0048)', () => {
  it('asks the same questions as v6', () => {
    expect(DEFAULT_CONFIG.predictor.primary).toBe('jev:typesafe/jev-1.13@jev-predict.v2');
    expect(v7.turns.map((t) => t.prompt)).toEqual(v6.turns.map((t) => t.prompt));
  });

  it('stores the primary and baseline rescaled at temperature 4, recorded as jev-predict.v2', async () => {
    for (const role of ['primary', 'baseline'] as const) {
      const [a, b] = [await scored(v6, role), await scored(v7, role)];
      expect(b.size).toBeGreaterThan(10);
      for (const [seq, p7] of b) {
        const p6 = a.get(seq)!;
        expect(p6.promptVersion).toBe('jev-predict.v1');
        expect(p7.predictorId).toBe('jev:typesafe/jev-1.13@jev-predict.v2');
        expect(p7.promptVersion).toBe('jev-predict.v2');
        const want = temperatureScale(p6.dist, 4);
        for (const k of Object.keys(want)) expect(p7.dist[k]).toBeCloseTo(want[k]!, 12);
      }
    }
  });

  it('keeps hypothesis rows on the raw scale, labelled with the uncalibrated twin', async () => {
    const preds = await v7.engine.deps.store.listPredictions({ mimicId: v7.mimicId, roles: ['hypothesis'] });
    for (const p of preds) {
      expect(p.predictorId).toBe('jev:typesafe/jev-1.13');
      expect(p.promptVersion).toBe('jev-predict.v1');
    }
    const raw = await v6.engine.deps.store.listPredictions({ mimicId: v6.mimicId, roles: ['hypothesis'] });
    expect(preds.map((p) => p.dist)).toEqual(raw.map((p) => p.dist));
  });
});

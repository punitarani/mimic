import {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_V6,
  type PipelineConfig,
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
// VOI with no hypotheses (k = 0): the information term is then the primary's own predictive entropy.
let v6Entropy: Run;
let v7Entropy: Run;

async function run(config: PipelineConfig, label: string): Promise<Run> {
  const engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'calibrated-primary' });
  const configHash = await registerConfig(engine.deps, config, label);
  return { engine, ...(await runSession(engine, script, { turns: 16, configHash })) };
}

const entropyOnly = (c: PipelineConfig): PipelineConfig =>
  c.selector.type === 'voi' ? { ...c, selector: { ...c.selector, k: 0 } } : c;

beforeAll(async () => {
  // One after another: engines in one process share module-level state (such as the item-stats cache).
  v6 = await run(DEFAULT_CONFIG_V6, 'cfg.default.v6');
  v7 = await run(DEFAULT_CONFIG, 'cfg.default.v7');
  v6Entropy = await run(entropyOnly(DEFAULT_CONFIG_V6), 'test.v6.entropy');
  v7Entropy = await run(entropyOnly(DEFAULT_CONFIG), 'test.v7.entropy');
}, 180_000);

afterAll(() => {
  for (const r of [v6, v7, v6Entropy, v7Entropy]) r?.engine.close();
});

/**
 * Every VOI score part and the hypothesis weights, per served question: selection reads the raw scale, so a
 * calibrated primary leaking into the information term, the weakness term or the posterior shows up here.
 */
async function expectSameSelection(a: Run, b: Run): Promise<number> {
  expect(b.turns.map((t) => t.prompt)).toEqual(a.turns.map((t) => t.prompt));
  const selections = async (r: Run) =>
    new Map(
      (await r.engine.deps.store.listQuestions(r.mimicId))
        .filter((q) => q.seq !== null && q.selection)
        .map((q) => [q.seq!, q.selection!]),
    );
  const [sa, sb] = [await selections(a), await selections(b)];
  expect(sb.size).toBeGreaterThan(3);
  let weights = 0;
  for (const [seq, s7] of sb) {
    const s6 = sa.get(seq)!;
    expect(Object.keys(s7).sort()).toEqual(Object.keys(s6).sort());
    for (const [k, v] of Object.entries(s7)) {
      if (typeof v === 'number') expect(v, `${k} at seq ${seq}`).toBeCloseTo(s6[k] as number, 6);
      else if (Array.isArray(v)) {
        weights++;
        for (const [i, w] of v.entries())
          expect(w, `${k}[${i}] at seq ${seq}`).toBeCloseTo((s6[k] as number[])[i]!, 3);
      } else expect(v).toEqual(s6[k]);
    }
  }
  return weights;
}

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
  it('asks the same questions as v6, scored the same way, with and without hypotheses', async () => {
    expect(DEFAULT_CONFIG.predictor.primary).toBe('jev:typesafe/jev-1.13@jev-predict.v2');
    // With hypotheses, the information term is their mutual information and the posterior reads stored rows.
    expect(await expectSameSelection(v6, v7)).toBeGreaterThan(0);
    // Without, it is the primary's own entropy.
    expect(await expectSameSelection(v6Entropy, v7Entropy)).toBe(0);
  });

  it('stores the primary, baseline and hypothesis rows rescaled at temperature 4, recorded as jev-predict.v2', async () => {
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
    // Hypothesis rows are the primary's own output too, labelled with it; the posterior reads them on the raw scale.
    const hyp = async (r: Run) =>
      r.engine.deps.store.listPredictions({ mimicId: r.mimicId, roles: ['hypothesis'] });
    const [h6, h7] = [await hyp(v6), await hyp(v7)];
    expect(h7.length).toBeGreaterThan(0);
    expect(h7.length).toBe(h6.length);
    h7.forEach((p7, i) => {
      expect(p7.predictorId).toBe('jev:typesafe/jev-1.13@jev-predict.v2');
      expect(p7.promptVersion).toBe('jev-predict.v2');
      const want = temperatureScale(h6[i]!.dist, 4);
      for (const k of Object.keys(want)) expect(p7.dist[k]).toBeCloseTo(want[k]!, 12);
    });
  });
});

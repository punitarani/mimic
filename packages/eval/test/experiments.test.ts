import { DEFAULT_CONFIG, ensureDefaultConfig, labOverview, registerConfig } from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript } from '../src/session';

let engine: LocalEngine;
let entropyHash: string;
let baldHash: string;
const EXPERIMENT = 'exp_e3';

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'e3' });
  const d = engine.deps;
  entropyHash = await ensureDefaultConfig(d);
  baldHash = await registerConfig(
    d,
    { ...DEFAULT_CONFIG, selector: { type: 'bald', k: 4, lambdaCoverage: 0.3 } },
    'cfg.bald.test',
  );
  await d.store.putExperiment({
    id: EXPERIMENT,
    name: 'E3 selector',
    status: 'active',
    arms: [
      { arm: 'entropy', configHash: entropyHash, weight: 1 },
      { arm: 'bald', configHash: baldHash, weight: 1 },
    ],
    createdAt: d.clock(),
  });
  for (let i = 0; i < 6; i++) {
    const script = SessionScript.parse({
      intake: { name: `Person ${i}`, location: 'Lisbon, PT', occupation: 'Nurse' },
      consentResearch: true,
      seed: `p${i}`,
    });
    await runSession(engine, script, { turns: 22 });
  }
}, 120_000);

afterAll(() => engine.close());

describe('experiments and BALD (M8)', () => {
  it('allocates new mimics to arms by hash(mimicId), each with its arm config', async () => {
    const mimics = await engine.deps.store.listMimics({});
    expect(mimics).toHaveLength(6);
    const byArm = new Map<string, number>();
    for (const m of mimics) {
      expect(m.experimentId).toBe(EXPERIMENT);
      expect(m.configHash).toBe(m.arm === 'bald' ? baldHash : entropyHash);
      byArm.set(m.arm!, (byArm.get(m.arm!) ?? 0) + 1);
    }
    expect(byArm.get('entropy')).toBeGreaterThan(0);
    expect(byArm.get('bald')).toBeGreaterThan(0);
  });

  it('runs BALD on refreshed persona hypotheses, logged apart from the sealed primary', async () => {
    const bald = (await engine.deps.store.listMimics({})).filter((m) => m.arm === 'bald');
    for (const m of bald) {
      expect(await engine.deps.kv.get(`hyp:${m.id}`)).toBeTruthy();
      const calls = await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 10_000 });
      const purposes = new Set(calls.map((c) => c.purpose));
      expect(purposes.has('hypotheses')).toBe(true);
      expect(purposes.has('select.bald')).toBe(true);
      // One sealed primary per scored question, never one per hypothesis.
      const primaries = await engine.deps.store.listPredictions({ mimicId: m.id, roles: ['primary'] });
      const questions = (await engine.deps.store.listQuestions(m.id)).filter(
        (q) => q.seq !== null && q.kind !== 'repeat',
      );
      expect(primaries).toHaveLength(questions.length);
    }
  });

  it('shows per-arm fidelity-vs-questions curves for the experiment in the lab', async () => {
    const o = await labOverview(engine.deps, { experimentId: EXPERIMENT });
    expect(o.armExperimentId).toBe(EXPERIMENT);
    expect(o.arms.map((a) => a.arm)).toEqual(['bald', 'entropy']);
    for (const a of o.arms) {
      expect(a.points.length).toBeGreaterThanOrEqual(20);
      expect(a.points[0]!.k).toBe(1);
      expect(a.fidelityAt20).not.toBeNull();
      expect(a.mimics).toBe(a.points[0]!.n);
    }
    const other = await labOverview(engine.deps, { experimentId: 'exp_other' });
    expect(other.arms).toEqual([]);
  });
});

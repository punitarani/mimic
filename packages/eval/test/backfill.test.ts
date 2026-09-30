import { EngineError, runBackfillMimic, runBackfillPredictor, runJob } from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript } from '../src/session';

// A model added after these sessions ran: not in their config, so no shadow job was ever enqueued for it.
const NEW = 'llm:acme/new-model';
let engine: LocalEngine;
let consented: string;
let private_: string;

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'backfill' });
  const script = (consentResearch: boolean) =>
    SessionScript.parse({
      intake: { name: 'Sam Rivera', location: 'Austin, US', occupation: 'Software engineer' },
      consentResearch,
    });
  consented = (await runSession(engine, script(true), { turns: 12 })).mimicId;
  private_ = (await runSession(engine, script(false), { turns: 12 })).mimicId;
}, 60_000);

afterAll(() => engine.close());

async function predictionsBy(mimicId: string, predictorId: string) {
  return (await engine.deps.store.listPredictions({ mimicId })).filter((p) => p.predictorId === predictorId);
}

describe('backfilling a new predictor (ADR-0024)', () => {
  it('predicts every served question of the consented mimics, on the sealed state the primary used', async () => {
    const { store } = engine.deps;
    await runJob(engine.deps, {
      type: 'backfill.predictor',
      runId: 'r1',
      predictorId: NEW,
      consentedOnly: true,
    });
    await engine.drain();

    const questions = (await store.listQuestions(consented)).filter(
      (q) => q.seq !== null && (q.kind === 'anchor' || q.kind === 'adaptive'),
    );
    expect(questions.length).toBeGreaterThanOrEqual(10);
    const added = await predictionsBy(consented, NEW);
    expect(added).toHaveLength(questions.length);
    for (const q of questions) {
      const preds = await store.listPredictions({ questionId: q.id });
      const primary = preds.find((p) => p.role === 'primary')!;
      const mine = preds.filter((p) => p.predictorId === NEW);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.role).toBe('shadow');
      expect(mine[0]!.stateHash).toBe(primary.stateHash);
      expect(mine[0]!.evidenceSeqMax).toBeLessThan(q.seq!);
    }
    // Answered questions are scored like any shadow.
    const scored = await store.listScoredPredictions(consented, ['shadow']);
    expect(scored.filter((s) => s.prediction.predictorId === NEW)).toHaveLength(questions.length);
    // consentedOnly: the private mimic is untouched.
    expect(await predictionsBy(private_, NEW)).toHaveLength(0);
  });

  it('is idempotent: running again finds nothing to do', async () => {
    const before = (await predictionsBy(consented, NEW)).length;
    expect(await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: NEW })).toBe(0);
    await runJob(engine.deps, {
      type: 'backfill.predictor',
      runId: 'r2',
      predictorId: NEW,
      consentedOnly: true,
    });
    await engine.drain();
    expect(await predictionsBy(consented, NEW)).toHaveLength(before);
  });

  it('covers every mimic without consentedOnly', async () => {
    expect(
      await runBackfillPredictor(engine.deps, { runId: 'r3', predictorId: NEW, consentedOnly: false }),
    ).toBe(2);
    await engine.drain();
    expect((await predictionsBy(private_, NEW)).length).toBeGreaterThanOrEqual(10);
  });

  it('never duplicates a predictor the question already has, such as the primary', async () => {
    const primary = (await engine.deps.store.listPredictions({ mimicId: consented, roles: ['primary'] }))[0]!;
    expect(
      await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: primary.predictorId }),
    ).toBe(0);
  });

  it('rejects a malformed predictor id as invalid (the worker drops it instead of retrying)', async () => {
    await expect(
      runBackfillPredictor(engine.deps, { runId: 'r4', predictorId: 'nope', consentedOnly: false }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});

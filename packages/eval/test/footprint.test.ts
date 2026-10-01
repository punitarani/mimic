import {
  createMimic,
  FOOTPRINT_PREDICTOR_ID,
  footprintMetaOf,
  parseText,
  proposeFromFootprint,
  serveNext,
  submitAnswer,
} from '@mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

let engine: LocalEngine;
afterEach(() => engine?.close());

const NOTES = `I ship the rough version first and fix what breaks; waiting a week for polish has never paid off for me.

When a side project stalls I come back to it on a quiet weekend rather than starting another one.

I rewrote our build tool in Rust last spring mostly because I wanted to learn it.`;

describe('footprint proposals: verify by asking (ADR-0059)', () => {
  it('pools implied questions, scores the footprint when they are served, and never stores a document as evidence', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'footprint' });
    const m = await createMimic(
      engine.deps,
      {
        name: 'Sam Reyes',
        location: 'Austin, US',
        occupation: 'Software engineer',
        attestSelf: true,
        consentSearch: false,
        consentResearch: true,
      },
      'p-sam',
    );
    await engine.drain();
    const docs = parseText(NOTES).docs;
    expect(docs).toHaveLength(3);
    const r = await proposeFromFootprint(engine.deps, m.id, { docs });
    // The fake proposes four items: two good, one on a sensitive facet, one citing nothing.
    expect(r).toMatchObject({ docs: 3, proposed: 4, pooled: 2 });
    expect(r.dropped).toEqual({ 'facet not allowed': 1, 'no citation': 1 });
    const pooled = (await engine.deps.store.listQuestions(m.id, ['pooled'], ['adaptive'])).filter(
      (q) => q.provenance.generator === 'footprint',
    );
    expect(pooled).toHaveLength(2);
    const meta = footprintMetaOf(pooled[0]!)!;
    expect(meta.answer).toBe('a');
    expect(meta.confidence).toBe(0.7);
    expect(meta.sources).toEqual(['text']);
    expect(meta.docIds.every((id) => docs.some((d) => d.id === id))).toBe(true);
    // Re-proposing the same documents pools nothing new.
    const again = await proposeFromFootprint(engine.deps, m.id, { docs });
    expect(again.pooled).toBe(0);
    expect(again.dropped.duplicate).toBe(2);
    const call = (await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 100 })).find(
      (c) => c.purpose === 'footprint.propose',
    )!;
    expect(call).toBeDefined();
    expect(await engine.deps.blobs.get(call.r2TraceKey)).not.toContain('Sam');

    // Answer the anchors, then the session reaches the pool; a served footprint question carries its own prediction.
    let footprintScored = 0;
    for (let i = 0; i < 24; i++) {
      const next = await serveNext(engine.deps, m.id);
      if (next.status !== 'question') break;
      await engine.drain((j) => j.type !== 'snapshot.write');
      const preds = await engine.deps.store.listPredictions({ mimicId: m.id });
      const fp = preds.filter(
        (p) => p.questionId === next.question.id && p.predictorId === FOOTPRINT_PREDICTOR_ID,
      );
      const q = (await engine.deps.store.getQuestion(next.question.id))!;
      if (q.provenance.generator === 'footprint') {
        expect(fp).toHaveLength(1);
        expect(fp[0]!.role).toBe('shadow');
        expect(fp[0]!.evidenceSeqMax).toBe(0);
        expect(fp[0]!.modelSnapshot).toBe('footprint.v1:text');
        footprintScored++;
      } else expect(fp).toHaveLength(0);
      await submitAnswer(engine.deps, m.id, {
        questionId: next.question.id,
        value: next.question.options[0]!.key,
        latencyMs: 900,
        idempotencyKey: `k-${m.id}-${i}`,
      });
      await engine.drain();
    }
    expect(footprintScored).toBeGreaterThan(0);
    // The footprint's predictions are scored like any shadow's, on the person's real answer.
    const scored = await engine.deps.store.listScoredPredictions(m.id, ['shadow']);
    const fpScores = scored.filter((s) => s.prediction.predictorId === FOOTPRINT_PREDICTOR_ID);
    expect(fpScores.length).toBe(footprintScored);
    for (const s of fpScores) expect(s.score.logLoss).toBeGreaterThan(0);
    // No document text reached a state, a trait or an insight: only answers did.
    const states = await engine.deps.blobs.list(`states/${m.id}/`);
    for (const key of states) expect(await engine.deps.blobs.get(key)).not.toContain('rough version first');
  }, 120_000);
});

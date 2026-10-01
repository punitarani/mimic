import { join } from 'node:path';
import { DEFAULT_CONFIG, type PipelineConfig, registerConfig } from '@mimic/core';
import type { MemoryBlobs } from '@mimic/db/local';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { replay, reproduceOnline } from '../src/replay';
import { runSession, SessionScript } from '../src/session';
import { importTwin } from '../src/twin';

let engine: LocalEngine;
afterEach(() => engine?.close());

/** cfg.default.v8 with a card state: six answers chosen by surprise (ADR-0056). An eval config, not a default. */
const CARD_CONFIG: PipelineConfig = {
  ...DEFAULT_CONFIG,
  stateBuilder: {
    ...DEFAULT_CONFIG.stateBuilder,
    strategy: 'card',
    evidencePolicy: 'surprise',
    maxEvidence: 6,
  },
};

const script = (name: string) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch: true,
    seed: name,
  });

describe('surprise-ranked evidence and the card state (ADR-0056)', () => {
  it('serves sealed card states online that replay rebuilds byte for byte', async () => {
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    const configHash = await registerConfig(engine.deps, CARD_CONFIG, 'cfg.eval.card');
    const { mimicId } = await runSession(engine, script('Card Person'), { turns: 20, configHash });
    const blobs = engine.deps.blobs as MemoryBlobs;
    const primaries = (await engine.deps.store.listPredictions({ mimicId, roles: ['primary'] })).filter(
      (p) => p.ok,
    );
    expect(primaries.length).toBeGreaterThan(12);
    let capped = 0;
    for (const p of primaries) {
      const state = JSON.parse((await blobs.get(`states/${mimicId}/${p.stateHash}.json`))!) as {
        evidence: Array<{ seq: number }>;
        traits?: unknown[];
        insights?: unknown[];
        meta: { builder: string; evidenceSeqMax: number };
      };
      // With no answer yet, the sealed state and the context-only one are the same object, so they share a blob.
      if (state.evidence.length) expect(state.meta.builder).toBe('card.v2.surprise');
      expect(state.insights).toBeUndefined();
      expect(state.evidence.length).toBeLessThanOrEqual(6);
      // Sealed: nothing at or after the question's own seq.
      const q = (await engine.deps.store.getQuestion(p.questionId))!;
      expect(state.evidence.every((e) => e.seq < q.seq!)).toBe(true);
      if (state.evidence.length === 6) capped++;
    }
    // Past six answers the cap binds, and the kept answers are no longer simply the latest ones.
    expect(capped).toBeGreaterThan(5);
    const last = primaries.at(-1)!;
    const lastState = JSON.parse((await blobs.get(`states/${mimicId}/${last.stateHash}.json`))!) as {
      evidence: Array<{ seq: number }>;
    };
    const lastQ = (await engine.deps.store.getQuestion(last.questionId))!;
    const latestSix = Array.from({ length: 6 }, (_, i) => lastQ.seq! - 6 + i);
    expect(lastState.evidence.map((e) => e.seq)).not.toEqual(latestSix);

    // The stored baseline scores that ranked the evidence are in the export, so the states rebuild exactly.
    const r = await reproduceOnline(engine.deps, { seed: 's', name: 'repro-card' }, 'hash');
    expect(r.checkable).toBeGreaterThan(10);
    expect(r.stateHashMatchRate).toBe(1);
    expect(r.pass).toBe(true);

    // Replay under each policy at the same cap runs on the same people; stored baselines mean nothing is annotated.
    for (const evidencePolicy of ['surprise', 'novelty', 'recent'] as const) {
      const rep = await replay(
        engine.deps,
        {
          name: `card ${evidencePolicy}`,
          predictor: 'decision:typesafe/jev-1.13',
          strategy: 'card',
          evidencePolicy,
          maxEvidence: 4,
          checkpoints: [8],
          split: 'all',
          targets: 'later',
          seed: 's',
        },
        'hash',
      );
      expect(rep.checkpoints[0]!.predictors[0]!.n).toBeGreaterThan(0);
      if (evidencePolicy === 'surprise') expect(rep.run.metrics?.surpriseAnnotated).toBe(0);
    }
  }, 120_000);

  it('gives imported answers a baseline surprise during replay, sealed by construction', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'twin-card' });
    await importTwin(engine.deps, {
      path: join(import.meta.dirname, '..', 'fixtures', 'twin2k500.sample.jsonl'),
    });
    const rep = await replay(
      engine.deps,
      {
        name: 'twin card',
        predictor: 'decision:typesafe/jev-1.13',
        strategy: 'card',
        evidencePolicy: 'surprise',
        maxEvidence: 3,
        budgetTokens: 600,
        checkpoints: [5],
        split: 'all',
        targets: 'heldout',
        seed: 's',
      },
      'hash',
    );
    expect(rep.checkpoints[0]!.people).toBe(6);
    // Every training answer of every person got a baseline prediction to rank by.
    let training = 0;
    for (const m of await engine.deps.store.listMimics({}))
      training += (await engine.deps.store.listQuestions(m.id)).filter(
        (q) => q.kind === 'adaptive' && !q.itemKey?.startsWith('twin2k/w4/'),
      ).length;
    expect(training).toBeGreaterThan(30);
    expect(rep.run.metrics?.surpriseAnnotated).toBe(training);
    expect(rep.checkpoints[0]!.predictors[0]!.n).toBe(30);
  }, 60_000);
});

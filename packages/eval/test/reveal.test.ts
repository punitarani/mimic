import { createMimic, serveNext, submitAnswer, uiSnapshot } from '@mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

let engine: LocalEngine;
afterEach(() => engine?.close());

async function start() {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
  const m = await createMimic(
    engine.deps,
    {
      name: 'Rowan Ellis',
      location: 'Lisbon, PT',
      occupation: 'Designer',
      attestSelf: true,
      consentSearch: false,
      consentResearch: true,
    },
    'p1',
  );
  await engine.drain();
  return m;
}

async function answer(mimicId: string, i: number, revealShown?: boolean) {
  const next = await serveNext(engine.deps, mimicId);
  if (next.status !== 'question') throw new Error(next.status);
  const q = next.question;
  const res = await submitAnswer(engine.deps, mimicId, {
    questionId: q.id,
    value: q.options[0]!.key,
    latencyMs: 900,
    idempotencyKey: `k-${mimicId}-${i}`,
    ...(revealShown === undefined ? {} : { revealShown }),
  });
  await engine.drain();
  return { q, res };
}

describe('reveal after the answer (session v2)', () => {
  it('returns the sealed primary distribution over every option', async () => {
    const m = await start();
    const { q, res } = await answer(m.id, 0);
    expect(res.reveal).not.toBeNull();
    const dist = res.reveal!.dist;
    expect(Object.keys(dist).sort()).toEqual(q.options.map((o) => o.key).sort());
    expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(dist[res.reveal!.optionKey]).toBe(res.reveal!.p);
  });

  it('neither returns nor records a reveal when the person turned guesses off', async () => {
    const m = await start();
    const shown = await answer(m.id, 0);
    const hidden = await answer(m.id, 1, false);
    expect(shown.res.reveal).not.toBeNull();
    expect(hidden.res.reveal).toBeNull();
    const byQ = new Map((await engine.deps.store.listAnswers(m.id)).map((a) => [a.questionId, a]));
    expect(byQ.get(shown.q.id)!.revealedPrediction).toBe(true);
    expect(byQ.get(hidden.q.id)!.revealedPrediction).toBe(false);
    // A retry with the same key replays what was actually shown.
    const retry = await submitAnswer(engine.deps, m.id, {
      questionId: hidden.q.id,
      value: hidden.q.options[0]!.key,
      latencyMs: 900,
      idempotencyKey: `k-${m.id}-1`,
      revealShown: false,
    });
    expect(retry.reveal).toBeNull();
  });

  it('exposes the anchor battery size and per-answer confidence bands in the snapshot', async () => {
    const m = await start();
    for (let i = 0; i < 3; i++) await answer(m.id, i);
    const s = await uiSnapshot(engine.deps, m.id);
    expect(s.progress.basics).toBe(10);
    expect(s.history.length).toBeGreaterThan(0);
    for (const h of s.history) {
      expect(h.ciLow).toBeLessThanOrEqual(h.fidelity);
      expect(h.ciHigh).toBeGreaterThanOrEqual(h.fidelity);
      expect(h.selfConsistency).toBeGreaterThan(0);
    }
  });
});

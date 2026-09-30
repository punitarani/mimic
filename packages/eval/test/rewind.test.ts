import {
  createMimic,
  deleteMimic,
  EngineError,
  exportMimic,
  hashJson,
  jobKey,
  loadHypotheses,
  ONTOLOGY_V1,
  type PersonState,
  type PublicQuestion,
  rewindLastAnswer,
  runHypotheses,
  runJob,
  serveNext,
  setScope,
  submitAnswer,
  submitFeedback,
  uiSnapshot,
  vectorId,
} from '@mimic/core';
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
  return m.id;
}

async function serve(mimicId: string): Promise<PublicQuestion> {
  const next = await serveNext(engine.deps, mimicId);
  if (next.status !== 'question') throw new Error(next.status);
  await engine.drain((j) => j.type !== 'snapshot.write');
  return next.question;
}

let keyN = 0;
async function answer(mimicId: string, q: PublicQuestion, value = q.options[0]!.key, drain = true) {
  const idempotencyKey = `k-${mimicId}-${q.seq}-${keyN++}`;
  const res = await submitAnswer(engine.deps, mimicId, {
    questionId: q.id,
    value,
    latencyMs: 900,
    idempotencyKey,
  });
  if (drain) await engine.drain((j) => j.type !== 'snapshot.write');
  return { res, idempotencyKey };
}

/** Answers `n` questions, serving each first. */
async function answerMany(mimicId: string, n: number) {
  for (let i = 0; i < n; i++) await answer(mimicId, await serve(mimicId));
}

async function expectConflict(p: Promise<unknown>, message?: RegExp) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EngineError);
  expect((e as EngineError).code).toBe('conflict');
  if (message) expect((e as EngineError).message).toMatch(message);
}

/** Every stored prediction is sealed: its state holds only answers before its question (PLAN §3.1). */
async function expectSealed(mimicId: string) {
  const { store, blobs } = engine.deps;
  const questions = await store.listQuestions(mimicId);
  const labelOf = new Map(
    (await store.listAnswers(mimicId)).map((a) => {
      const q = questions.find((x) => x.id === a.questionId)!;
      return [a.seq, q.options.find((o) => o.key === a.value)!.label];
    }),
  );
  for (const q of questions.filter((x) => x.seq !== null)) {
    for (const p of await store.listPredictions({ questionId: q.id })) {
      expect(p.evidenceSeqMax).toBeLessThan(q.seq!);
      const state = JSON.parse((await blobs.get(`states/${mimicId}/${p.stateHash}.json`))!) as PersonState;
      const { meta, ...body } = state;
      expect(hashJson(body)).toBe(p.stateHash);
      for (const e of state.evidence) {
        expect(e.seq).toBeLessThan(q.seq!);
        // Every answer in a live question's state is still the answer on record.
        expect(e.answer).toBe(labelOf.get(e.seq));
      }
    }
  }
}

describe('undo the latest answer (ADR-0036)', () => {
  it('takes back the answer, discards the prefetched question and rolls back what was learned', async () => {
    const id = await start();
    const { store, vectors } = engine.deps;
    await answerMany(id, 14);
    const q15 = await serve(id);
    const first = await answer(id, q15, q15.options[0]!.key);
    expect(first.res.reveal).not.toBeNull();
    // Answer 15 is the third reflection (every 5): traits, insights and fidelity at 15 exist.
    expect((await store.listTraitHistory(id)).some((t) => t.seqUpTo === 15)).toBe(true);
    expect((await store.listInsights(id)).some((i) => i.seqUpTo === 15)).toBe(true);
    // Reflection at 15 superseded an earlier insight; one superseded at 10 stays that way.
    const early = (await store.listInsights(id)).filter((i) => i.seqUpTo < 15);
    expect(early.length).toBeGreaterThanOrEqual(2);
    await store.updateInsightStatus(early[0]!.id, 'superseded', Date.now(), 15);
    await store.updateInsightStatus(early[1]!.id, 'superseded', Date.now(), 10);
    const at15 = new Set((await store.listInsights(id)).filter((i) => i.seqUpTo === 15).map((i) => i.id));
    expect((await store.listKg(id)).edges.some((e) => at15.has(e.sourceRef ?? ''))).toBe(true);
    const predsBefore = await store.listPredictions({ questionId: q15.id });
    const q16 = await serve(id); // prefetched while the reveal shows
    expect(q16.seq).toBe(16);

    const r = await rewindLastAnswer(engine.deps, id, { questionId: q15.id });
    expect(r.question).toEqual(q15);
    expect(r.progress.answered).toBe(14);
    expect(r.previous).toEqual({ value: q15.options[0]!.key, why: null });

    // The answer is gone from evidence and kept as a rewind.
    expect((await store.listAnswers(id)).map((a) => a.seq)).not.toContain(15);
    const [rw] = await store.listAnswerRewinds(id);
    expect(rw).toMatchObject({
      questionId: q15.id,
      seq: 15,
      value: q15.options[0]!.key,
      revealedPrediction: true,
    });
    // The question is served again with the same sealed predictions, now unscored.
    const back = (await store.getQuestion(q15.id))!;
    expect(back).toMatchObject({ status: 'served', seq: 15 });
    expect((await store.listPredictions({ questionId: q15.id })).map((p) => p.id)).toEqual(
      predsBefore.map((p) => p.id),
    );
    const scored = await store.listScoredPredictions(id, ['primary', 'baseline', 'shadow']);
    expect(scored.some((x) => x.question.id === q15.id)).toBe(false);
    // The prefetched question is discarded with its predictions; a fresh copy is back in the pool.
    const gone = (await store.getQuestion(q16.id))!;
    expect(gone).toMatchObject({ status: 'discarded', seq: null });
    expect(await store.listPredictions({ questionId: q16.id })).toEqual([]);
    const copy = (await store.listQuestions(id, ['pooled'])).find((q) => q.prompt === q16.prompt);
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(q16.id);
    // Derived state from 15 on is rolled back, and the estimates match the remaining history.
    expect((await store.listFidelity(id)).every((f) => f.seqUpTo < 15)).toBe(true);
    expect((await store.listTraitHistory(id)).every((t) => t.seqUpTo < 15)).toBe(true);
    const key = (t: { facetId: string; method: string }) => `${t.facetId}|${t.method}`;
    const sort = <T extends { facetId: string; method: string }>(ts: T[]) =>
      [...ts].sort((a, b) => key(a).localeCompare(key(b)));
    expect(sort(await store.listTraits(id))).toEqual(
      sort(await store.listTraitsAsOf(id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
    );
    const insightsAfter = await store.listInsights(id);
    expect(insightsAfter.every((i) => i.seqUpTo < 15)).toBe(true);
    expect(insightsAfter.find((i) => i.id === early[0]!.id)).toMatchObject({
      status: 'active',
      statusChangedAt: null,
    });
    expect(insightsAfter.find((i) => i.id === early[1]!.id)?.status).toBe('superseded');
    expect((await store.listKg(id)).edges.some((e) => at15.has(e.sourceRef ?? ''))).toBe(false);
    for (const f of await store.listFacts(id)) expect(f.sourceRef ?? '').not.toMatch(/answers:.*\b15\b/);
    expect(await vectors.getByIds([vectorId.qa(id, 15)])).toEqual([]);
    expect(await vectors.getByIds([vectorId.qa(id, 14)])).toHaveLength(1);
    // The mimic's own view and download drop it too.
    expect((await uiSnapshot(engine.deps, id)).progress.answered).toBe(14);
    expect((await exportMimic(engine.deps, id)).evidence.map((e) => e.seq)).not.toContain(15);

    // Next shows the same question again.
    const again = await serveNext(engine.deps, id);
    expect(again.status === 'question' && again.question).toEqual(q15);

    // Undo is single-step and can't be replayed.
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: q15.id }), /latest answer/);
    await expectConflict(
      submitAnswer(engine.deps, id, {
        questionId: q15.id,
        value: q15.options[0]!.key,
        latencyMs: 900,
        idempotencyKey: first.idempotencyKey,
      }),
      /undone/,
    );

    // Re-answer: scored against the same sealed predictions and learned again from scratch.
    const other = q15.options.at(-1)!.key;
    const second = await answer(id, q15, other);
    expect(second.res.seq).toBe(15);
    expect(second.res.fidelity).not.toBeNull();
    expect((await store.getAnswerForQuestion(q15.id))!.value).toBe(other);
    expect((await store.listTraitHistory(id)).some((t) => t.seqUpTo === 15)).toBe(true);
    expect((await store.listInsights(id)).some((i) => i.seqUpTo === 15)).toBe(true);
    expect((await store.listFidelity(id)).filter((f) => f.seqUpTo === 15)).toHaveLength(1);
    const reScored = (await store.listScoredPredictions(id, ['primary', 'baseline', 'shadow'])).filter(
      (x) => x.question.id === q15.id,
    );
    expect(reScored).toHaveLength(predsBefore.filter((p) => p.ok && p.role !== 'hypothesis').length);
    expect(new Set(reScored.map((x) => x.score.answerId)).size).toBe(1);

    // The next question is sealed on the new answer.
    const q16b = await serve(id);
    expect(q16b.seq).toBe(16);
    const primary = (await store.listPredictions({ questionId: q16b.id, roles: ['primary'] }))[0]!;
    const state = JSON.parse(
      (await engine.deps.blobs.get(`states/${id}/${primary.stateHash}.json`))!,
    ) as PersonState;
    const e15 = state.evidence.find((e) => e.seq === 15);
    if (e15) expect(e15.answer).toBe(q15.options.at(-1)!.label);
    await answer(id, q16b);
    await expectSealed(id);
    expect((await exportMimic(engine.deps, id)).evidence.find((e) => e.seq === 15)?.answer).toBe(other);
  }, 60_000);

  it('undoes an answer before the next question is served', async () => {
    const id = await start();
    await answerMany(id, 3);
    const q4 = await serve(id);
    await answer(id, q4);
    const r = await rewindLastAnswer(engine.deps, id, { questionId: q4.id });
    expect(r.progress.answered).toBe(3);
    expect(await engine.deps.store.listQuestions(id, ['discarded'])).toEqual([]);
    await answer(id, q4, q4.options[1]!.key);
    expect((await serve(id)).seq).toBe(5);
  }, 30_000);

  it('only undoes the latest answer', async () => {
    const id = await start();
    const q1 = await serve(id);
    await answer(id, q1);
    const q2 = await serve(id);
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: q2.id }), /latest answer/);
    await answer(id, q2);
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: q1.id }), /latest answer/);
    await rewindLastAnswer(engine.deps, id, { questionId: q2.id });
    // One step only: the answer before it stays.
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: q1.id }), /latest answer/);
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: 'nope' }));
  }, 30_000);

  function interleave(method: string, before: () => Promise<unknown>) {
    let fired = false;
    const store = engine.deps.store;
    return {
      ...engine.deps,
      store: new Proxy(store, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (prop !== method || fired || typeof v !== 'function') return v;
          return async (...args: unknown[]) => {
            fired = true;
            await before();
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }),
    };
  }

  /**
   * Deps whose guarded store (Store.guarded, ADR-0036) runs `undo` just ahead of its first write: the undo lands
   * after the work read its evidence and before it writes anything.
   */
  function undoBeforeGuardedWrite(undo: () => Promise<unknown>) {
    let fired = false;
    const store = engine.deps.store;
    return {
      ...engine.deps,
      store: new Proxy(store, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (prop !== 'guarded' || typeof v !== 'function') return v;
          return (mimicId: string, epoch: number) => {
            const g = (v as (m: string, e: number) => typeof store).call(target, mimicId, epoch);
            return new Proxy(g, {
              get(gt, gp, gr) {
                const gv = Reflect.get(gt, gp, gr);
                if (typeof gv !== 'function' || fired || !/^(insert|upsert|update|serve)/.test(String(gp)))
                  return typeof gv === 'function' ? gv.bind(gt) : gv;
                return async (...args: unknown[]) => {
                  fired = true;
                  await undo();
                  return (gv as (...a: unknown[]) => unknown).apply(gt, args);
                };
              },
            });
          };
        },
      }),
    };
  }

  it('makes a queued learn job for the undone answer a no-op', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 4);
    const q5 = await serve(id);
    await answer(id, q5, q5.options[0]!.key, false);
    const stale = engine.queue.drain();
    expect(stale.some((j) => j.type === 'learn.answer' && j.seq === 5 && j.answerId)).toBe(true);
    await rewindLastAnswer(engine.deps, id, { questionId: q5.id });
    for (const j of stale) await runJob(engine.deps, j);
    expect((await store.listTraitHistory(id)).every((t) => t.seqUpTo < 5)).toBe(true);
    expect((await store.listInsights(id)).every((i) => i.seqUpTo < 5)).toBe(true);
  }, 30_000);

  it('refuses every write of a learn job whose answer is undone while it runs, so the re-answer learns', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 4);
    const q5 = await serve(id);
    await answer(id, q5, q5.options[0]!.key, false);
    const [learn] = engine.queue.drain().filter((j) => j.type === 'learn.answer');
    // The undo lands after the job read the evidence and before it writes anything.
    const racing = undoBeforeGuardedWrite(() => rewindLastAnswer(engine.deps, id, { questionId: q5.id }));
    expect(await runJob(racing, learn!)).toBe('done');
    expect(await store.getJob(jobKey(learn!))).toMatchObject({
      status: 'done',
      lastError: expect.stringMatching(/changed/),
    });
    expect((await store.listTraitHistory(id)).every((t) => t.seqUpTo < 5)).toBe(true);
    expect((await store.listInsights(id)).every((i) => i.seqUpTo < 5)).toBe(true);
    expect(await engine.deps.vectors.getByIds([vectorId.qa(id, 5)])).toEqual([]);
    // Nothing stale blocks the re-answer's monotonic writes.
    await answer(id, q5, q5.options[1]!.key);
    const at5 = (await store.listTraitHistory(id)).filter((t) => t.seqUpTo === 5);
    expect(at5.length).toBeGreaterThan(0);
    expect((await store.listInsights(id)).some((i) => i.seqUpTo === 5)).toBe(true);
    const current = (await store.getAnswerForQuestion(q5.id))!;
    expect(current.value).toBe(q5.options[1]!.key);
  }, 30_000);

  it('retries a learn job that an undo of a later answer refused, since its own answer stands', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 3);
    const q4 = await serve(id);
    await answer(id, q4, q4.options[0]!.key, false);
    const [learn4] = engine.queue.drain().filter((j) => j.type === 'learn.answer');
    const next = await serveNext(engine.deps, id);
    if (next.status !== 'question') throw new Error(next.status);
    engine.queue.drain();
    await answer(id, next.question, next.question.options[0]!.key, false);
    engine.queue.drain();
    const racing = undoBeforeGuardedWrite(() =>
      rewindLastAnswer(engine.deps, id, { questionId: next.question.id }),
    );
    await expect(runJob(racing, learn4!)).rejects.toThrow(/retrying/);
    expect(await store.getJob(jobKey(learn4!))).toMatchObject({ status: 'failed' });
    expect(await runJob(engine.deps, learn4!)).toBe('done');
    expect((await store.listTraitHistory(id)).some((t) => t.seqUpTo === 4)).toBe(true);
  }, 30_000);

  it('discards a prefetch that commits inside the undo, and pools it again', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 11);
    const q12 = await serve(id);
    await answer(id, q12);
    let late: PublicQuestion | null = null;
    // The prefetch commits after the undo read the questions but before its batch.
    const racing = interleave('rewindAnswer', async () => {
      const r = await serveNext(engine.deps, id);
      if (r.status === 'question') late = r.question;
    });
    await rewindLastAnswer(racing, id, { questionId: q12.id });
    expect(late).not.toBeNull();
    expect(await store.getQuestion(late!.id)).toMatchObject({ status: 'discarded', seq: null });
    expect(await store.listPredictions({ questionId: late!.id })).toEqual([]);
    expect((await store.listQuestions(id, ['pooled'])).some((q) => q.prompt === late!.prompt)).toBe(true);
    expect((await serve(id)).id).toBe(q12.id);
  }, 30_000);

  it('builds the next question again when an undo lands while it is built, serving nothing stale', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 11);
    const q12 = await serve(id);
    await answer(id, q12);
    // The serve read the evidence with answer 12; the undo lands before it persists.
    const racing = undoBeforeGuardedWrite(() => rewindLastAnswer(engine.deps, id, { questionId: q12.id }));
    const r = await serveNext(racing, id);
    expect(r.status === 'question' && r.question).toEqual(q12);
    // The refused serve wrote nothing: no discarded question, no prediction outside a served question.
    expect(await store.listQuestions(id, ['discarded'])).toEqual([]);
    const served = new Set((await store.listQuestions(id)).filter((q) => q.seq !== null).map((q) => q.id));
    expect((await store.listPredictions({ mimicId: id })).every((p) => served.has(p.questionId))).toBe(true);
    await answer(id, q12, q12.options[1]!.key);
    expect((await serve(id)).seq).toBe(13);
    await expectSealed(id);
  }, 30_000);

  it('refuses an answer to the prefetched question that races the undo, and the session carries on', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 5);
    const q6 = await serve(id);
    await answer(id, q6);
    const q7 = await serve(id);
    // The answer read q7 as served; the undo discards it before the answer is recorded.
    const racing = interleave('recordAnswer', () => rewindLastAnswer(engine.deps, id, { questionId: q6.id }));
    await expectConflict(
      submitAnswer(racing, id, {
        questionId: q7.id,
        value: q7.options[0]!.key,
        latencyMs: 900,
        idempotencyKey: 'k-q7',
      }),
      /not being asked/,
    );
    expect(await store.getAnswerForQuestion(q7.id)).toBeNull();
    expect((await store.listAnswers(id)).map((a) => a.seq)).toEqual([1, 2, 3, 4, 5]);
    await answer(id, q6, q6.options[1]!.key);
    const next = await serve(id);
    expect(next.seq).toBe(7);
    await answer(id, next);
    expect((await store.listAnswers(id)).map((a) => a.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await expectSealed(id);
  }, 30_000);

  it('refuses an undo when the next answer lands between its checks and its batch', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 5);
    const q6 = await serve(id);
    await answer(id, q6);
    const q7 = await serve(id);
    const racing = interleave('rewindAnswer', () =>
      submitAnswer(engine.deps, id, {
        questionId: q7.id,
        value: q7.options[0]!.key,
        latencyMs: 900,
        idempotencyKey: 'k-7',
      }),
    );
    await expectConflict(rewindLastAnswer(racing, id, { questionId: q6.id }), /latest answer/);
    expect((await store.listAnswers(id)).map((a) => a.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await store.listAnswerRewinds(id)).toEqual([]);
    expect((await store.getMimic(id))!.evidenceEpoch).toBe(0);
    expect((await store.getQuestion(q6.id))!.status).toBe('answered');
  }, 30_000);

  it('refuses an undo when feedback lands between its checks and its batch', async () => {
    const id = await start();
    const q1 = await serve(id);
    await answer(id, q1);
    const racing = interleave('rewindAnswer', () =>
      submitFeedback(engine.deps, id, {
        question: {
          type: 'choice',
          prompt: 'Would you rather spend a free Saturday hiking or reading at home?',
          options: [
            { key: 'x1', label: 'Hiking in the hills' },
            { key: 'x2', label: 'Reading at home' },
          ],
        },
        answer: 'x1',
        idempotencyKey: 'fb-race',
      }),
    );
    await expectConflict(rewindLastAnswer(racing, id, { questionId: q1.id }), /latest answer/);
    expect(await engine.deps.store.getAnswerForQuestion(q1.id)).not.toBeNull();
  }, 30_000);

  it("keys the re-answer's snapshot and hypothesis jobs apart from the undone answer's", async () => {
    const id = await start();
    await answerMany(id, 4);
    const q5 = await serve(id);
    await answer(id, q5, q5.options[0]!.key, false);
    const before = engine.queue.drain();
    for (const j of before) await runJob(engine.deps, j);
    const snapA = engine.queue.pending.map((p) => p.job).find((j) => j.type === 'snapshot.write')!;
    expect(snapA).toMatchObject({ seqUpTo: 5, epoch: 0 });
    await runJob(engine.deps, snapA);
    engine.queue.drain();
    await rewindLastAnswer(engine.deps, id, { questionId: q5.id });
    await answer(id, q5, q5.options[1]!.key, false);
    for (const j of engine.queue.drain()) await runJob(engine.deps, j);
    const snapB = engine.queue.pending.map((p) => p.job).find((j) => j.type === 'snapshot.write')!;
    expect(snapB).toMatchObject({ seqUpTo: 5, epoch: 1 });
    expect(jobKey(snapB)).not.toBe(jobKey(snapA));
    expect(await runJob(engine.deps, snapB)).toBe('done');
    const doc = await exportMimic(engine.deps, id);
    expect(doc.evidence.find((e) => e.seq === 5)?.answer).toBe(q5.options[1]!.key);
  }, 30_000);

  it('takes back hypotheses drawn while an undo landed', async () => {
    const id = await start();
    await answerMany(id, 5);
    const q6 = await serve(id);
    await answer(id, q6);
    let fired = false;
    const kv = new Proxy(engine.deps.kv, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== 'put' || typeof v !== 'function') return v;
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await rewindLastAnswer(engine.deps, id, { questionId: q6.id });
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    await runHypotheses({ ...engine.deps, kv }, id, 6);
    expect(fired).toBe(true);
    expect((await loadHypotheses(engine.deps, id))?.seqUpTo ?? 0).toBeLessThan(6);
  }, 30_000);

  it("removes the undone reflection's facts even when they cite only earlier answers", async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 2);
    const q3 = await serve(id);
    await answer(id, q3);
    const fact = (fid: string, seqUpTo: number | null, sourceRef: string) => ({
      id: fid,
      mimicId: id,
      predicate: 'hasInterest',
      object: `Interest ${fid}`,
      source: 'reflection' as const,
      sourceRef,
      sourceUrl: null,
      confidence: 0.6,
      userState: 'active' as const,
      createdAt: Date.now(),
      userStateAt: null,
      seqUpTo,
    });
    await store.insertFacts([
      fact('f-at-3', 3, 'answers:1,2'),
      fact('f-at-2', 2, 'answers:1,2'),
      fact('f-legacy', null, 'answers:3'),
    ]);
    await rewindLastAnswer(engine.deps, id, { questionId: q3.id });
    const ids = (await store.listFacts(id)).map((f) => f.id);
    expect(ids).toContain('f-at-2');
    expect(ids).not.toContain('f-at-3');
    expect(ids).not.toContain('f-legacy');
  }, 30_000);

  it('never writes a score for an answer that is gone', async () => {
    const id = await start();
    const q1 = await serve(id);
    await answer(id, q1);
    const [p] = await engine.deps.store.listPredictions({ questionId: q1.id, roles: ['primary'] });
    const gone = {
      predictionId: `${p!.id}-x`,
      answerId: 'gone',
      top1: 1,
      itemAcc: 1,
      logLoss: 0,
      brier: 0,
      createdAt: 1,
    };
    await engine.deps.store.insertScores([gone]);
    const n = await engine.client.execute({
      sql: 'select count(*) as n from scores where answer_id = ?',
      args: ['gone'],
    });
    expect(Number(n.rows[0]!.n)).toBe(0);
  }, 30_000);

  it('removes a shadow that lands on a question discarded while it ran', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 2);
    const q3 = await serve(id);
    await answer(id, q3);
    const next = await serveNext(engine.deps, id);
    if (next.status !== 'question') throw new Error(next.status);
    const shadows = engine.queue.drain().filter((j) => j.type === 'predict.shadow');
    expect(shadows.length).toBeGreaterThan(0);
    // The undo commits after the shadow read the primary but before it inserts.
    const racing = interleave('insertShadow', () => rewindLastAnswer(engine.deps, id, { questionId: q3.id }));
    await runJob(racing, shadows[0]!);
    for (const j of shadows.slice(1)) await runJob(engine.deps, j);
    expect(await store.getQuestion(next.question.id)).toMatchObject({ status: 'discarded' });
    expect(await store.listPredictions({ questionId: next.question.id })).toEqual([]);
  }, 30_000);

  it('scores a shadow that lands between listing predictions and recording the answer', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 2);
    const next = await serveNext(engine.deps, id);
    if (next.status !== 'question') throw new Error(next.status);
    const q = next.question;
    const shadows = engine.queue.drain().filter((j) => j.type === 'predict.shadow');
    // Every shadow finishes after the answer listed predictions, and looks for the answer before it is recorded.
    const racing = interleave('recordAnswer', async () => {
      for (const j of shadows) await runJob(engine.deps, j);
    });
    await submitAnswer(racing, id, {
      questionId: q.id,
      value: q.options[0]!.key,
      latencyMs: 900,
      idempotencyKey: 'k-r',
    });
    const preds = (await store.listPredictions({ questionId: q.id })).filter(
      (p) => p.ok && p.role !== 'hypothesis',
    );
    const scored = (await store.listScoredPredictions(id, ['primary', 'baseline', 'shadow'])).filter(
      (r) => r.question.id === q.id,
    );
    expect(preds.length).toBe(2 + shadows.length);
    expect(scored).toHaveLength(preds.length);
  }, 30_000);

  it('drops a prefetched repeat probe instead of pooling it again', async () => {
    const id = await start();
    const { store } = engine.deps;
    let prev: PublicQuestion | null = null;
    for (let i = 0; i < 30; i++) {
      const q = await serve(id);
      const rec = (await store.getQuestion(q.id))!;
      if (rec.kind === 'repeat' && prev) {
        await rewindLastAnswer(engine.deps, id, { questionId: prev.id });
        expect((await store.getQuestion(q.id))!).toMatchObject({ status: 'discarded', seq: null });
        const pooledRepeats = await store.listQuestions(id, ['pooled']);
        expect(pooledRepeats.some((x) => x.kind === 'repeat')).toBe(false);
        // The repeat is scheduled again after the re-answer.
        await answer(id, prev);
        const after = (await store.getQuestion((await serve(id)).id))!;
        expect(after.seq).toBe(q.seq);
        return;
      }
      await answer(id, q);
      prev = q;
    }
    throw new Error('no repeat probe was served');
  }, 60_000);

  it('undoes a repeat answer', async () => {
    const id = await start();
    const { store } = engine.deps;
    for (let i = 0; i < 30; i++) {
      const q = await serve(id);
      await answer(id, q);
      if ((await store.getQuestion(q.id))!.kind !== 'repeat') continue;
      const fidBefore = (await store.listFidelity(id)).at(-1)!;
      expect(fidBefore.nRepeats).toBeGreaterThan(0);
      await rewindLastAnswer(engine.deps, id, { questionId: q.id });
      expect((await store.getQuestion(q.id))!.status).toBe('served');
      const { res } = await answer(id, q);
      expect(res.fidelity!.nRepeats).toBe(fidBefore.nRepeats);
      return;
    }
    throw new Error('no repeat probe was served');
  }, 60_000);

  it('refuses when the mimic was asked a playground question since', async () => {
    const id = await start();
    const q1 = await serve(id);
    await answer(id, q1);
    await engine.deps.store.insertQuestions([
      {
        ...(await engine.deps.store.getQuestion(q1.id))!,
        id: 'play-1',
        kind: 'playground',
        seq: 2,
        status: 'served',
      },
    ]);
    await expectConflict(
      rewindLastAnswer(engine.deps, id, { questionId: q1.id }),
      /asked or taught your mimic/,
    );
    expect(await engine.deps.store.getAnswerForQuestion(q1.id)).not.toBeNull();
  }, 30_000);

  it('refuses when the person taught their mimic something since (ADR-0032)', async () => {
    const id = await start();
    const q1 = await serve(id);
    await answer(id, q1);
    await submitFeedback(engine.deps, id, {
      question: {
        type: 'choice',
        prompt: 'Would you rather spend a free Saturday hiking or reading at home?',
        options: [
          { key: 'x1', label: 'Hiking in the hills' },
          { key: 'x2', label: 'Reading at home' },
        ],
      },
      answer: 'x2',
      idempotencyKey: 'fb-after-q1',
    });
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: q1.id }), /taught your mimic/);
    expect(await engine.deps.store.getAnswerForQuestion(q1.id)).not.toBeNull();
  }, 30_000);

  it('rolls back SOUL.md drafts that cover the undone answer (ADR-0033, ADR-0039)', async () => {
    const id = await start();
    const { store } = engine.deps;
    await answerMany(id, 2);
    const q3 = await serve(id);
    await answer(id, q3);
    const draft = (seqUpTo: number) => ({
      id: `pd-${seqUpTo}`,
      mimicId: id,
      seqUpTo,
      configHash: 'c',
      promptVersion: 'persona.v1',
      model: 'm',
      modelSnapshot: 'm',
      draft: { summary: `Up to ${seqUpTo}`, statements: [] },
      createdAt: Date.now() + seqUpTo,
    });
    await store.insertSoulDraft(draft(2));
    await store.insertSoulDraft(draft(3));
    await rewindLastAnswer(engine.deps, id, { questionId: q3.id });
    expect((await store.latestSoulDraft(id))?.seqUpTo).toBe(2);
  }, 30_000);

  it('refuses to undo an answer about a topic turned off since (ADR-0040)', async () => {
    const id = await start();
    const q = await serve(id);
    await answer(id, q);
    const stored = (await engine.deps.store.listQuestions(id)).find((x) => x.id === q.id)!;
    const category = ONTOLOGY_V1.find((f) => f.id === stored.facetIds[0])!.category;
    const m = (await engine.deps.store.getMimic(id))!;
    await setScope(engine.deps, id, {
      ...m.scope,
      categories: m.scope.categories.filter((c) => c !== category),
    });
    await expectConflict(rewindLastAnswer(engine.deps, id, { questionId: q.id }), /turned this topic off/);
    expect(await engine.deps.store.listAnswerRewinds(id)).toEqual([]);
  }, 30_000);

  it('hard delete removes rewinds too', async () => {
    const id = await start();
    const q1 = await serve(id);
    await answer(id, q1);
    await rewindLastAnswer(engine.deps, id, { questionId: q1.id });
    expect(await engine.deps.store.listAnswerRewinds(id)).toHaveLength(1);
    await deleteMimic(engine.deps, id);
    expect(await engine.deps.store.listAnswerRewinds(id)).toEqual([]);
  }, 30_000);
});

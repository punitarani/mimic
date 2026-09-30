import {
  buildState,
  createMimic,
  enqueueMissingShadows,
  exportMimic,
  type FeedbackInput,
  type Job,
  jobKey,
  listPlayground,
  loadConfig,
  loadMimicDataAt,
  predictPlayground,
  runJob,
  serveNext,
  stateOptions,
  submitAnswer,
  submitFeedback,
  uiSnapshot,
} from '@mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

let engine: LocalEngine;
afterEach(() => engine?.close());

async function session(turns: number) {
  const m = await createMimic(
    engine.deps,
    {
      name: 'Rowan Hale',
      location: 'Portland, US',
      occupation: 'Teacher',
      attestSelf: true,
      consentSearch: false,
      consentResearch: true,
    },
    'p-rowan',
  );
  await engine.drain();
  for (let i = 0; i < turns; i++) {
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    await engine.drain((j) => j.type !== 'snapshot.write');
    await submitAnswer(engine.deps, m.id, {
      questionId: next.question.id,
      value: next.question.options.at(-1)!.key,
      latencyMs: 900,
      idempotencyKey: `k-${m.id}-${i}`,
    });
    await engine.drain();
  }
  return m;
}

const ask = {
  type: 'choice' as const,
  prompt: 'Would you take a spontaneous day off?',
  options: [
    { key: 'a', label: 'Yes, today' },
    { key: 'b', label: 'No, I would wait' },
  ],
  rationale: false,
};

const teach = (key: string, answer = 'b'): FeedbackInput => ({
  question: {
    type: 'choice',
    prompt: `Would you rather cook at home or eat out tonight? (${key})`,
    options: [
      { key: 'a', label: 'Cook at home' },
      { key: 'b', label: 'Eat out' },
    ],
  },
  answer,
  idempotencyKey: `fb-${key}`,
});

/** Learnable answers, in the order they were recorded. */
async function learnOrder(mimicId: string) {
  const [qs, answers] = await Promise.all([
    engine.deps.store.listQuestions(mimicId),
    engine.deps.store.listAnswers(mimicId),
  ]);
  const kind = new Map(qs.map((q) => [q.id, q.kind]));
  return answers
    .filter((a) => kind.get(a.questionId) !== 'playground' && kind.get(a.questionId) !== 'repeat')
    .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
    .map((a) => a.seq);
}

describe('feedback while a session question is open (ADR-0032)', () => {
  it('takes the open question’s seq and moves it past, so answers stay in seq order', async () => {
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    const m = await session(4);
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    const open = next.question;
    await engine.drain((j) => j.type !== 'snapshot.write');

    const fb = await submitFeedback(engine.deps, m.id, teach('open'));
    expect(fb.question.seq).toBe(open.seq);
    const moved = (await engine.deps.store.getQuestion(open.id))!;
    expect(moved).toMatchObject({ status: 'served', seq: open.seq + 1 });
    expect((await engine.deps.store.getMimic(m.id))!.seqMax).toBe(open.seq + 1);
    // /next still returns the open question, at its new seq.
    const again = await serveNext(engine.deps, m.id);
    expect(again).toMatchObject({ status: 'question', question: { id: open.id, seq: open.seq + 1 } });
    await engine.drain();

    const res = await submitAnswer(engine.deps, m.id, {
      questionId: open.id,
      value: open.options[0]!.key,
      latencyMs: 500,
      idempotencyKey: `k-open-${m.id}`,
    });
    expect(res.seq).toBe(open.seq + 1);
    await engine.drain();
    const order = await learnOrder(m.id);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // Still sealed below its old seq, and replay rebuilds the same state at the new one.
    const primary = (
      await engine.deps.store.listPredictions({ questionId: open.id, roles: ['primary'] })
    )[0]!;
    expect(primary.evidenceSeqMax).toBeLessThan(open.seq);
    const cfg = await loadConfig(engine.deps, m.configHash);
    const mimic = (await engine.deps.store.getMimic(m.id))!;
    const asOf = await loadMimicDataAt(engine.deps, mimic, moved.stateAt!, moved.seq!);
    const rebuilt = buildState(asOf.data, stateOptions(cfg, moved.seq!, { forQuestions: [moved] }));
    expect(rebuilt.meta.stateHash).toBe(primary.stateHash);

    // The next question sees both answers, and the export has every answer.
    const after = await serveNext(engine.deps, m.id);
    if (after.status !== 'question') throw new Error(after.status);
    const p2 = (
      await engine.deps.store.listPredictions({ questionId: after.question.id, roles: ['primary'] })
    )[0]!;
    expect(p2.evidenceSeqMax).toBe(open.seq + 1);
    const doc = await exportMimic(engine.deps, m.id);
    expect(doc.evidence).toHaveLength((await engine.deps.store.listAnswers(m.id)).length);
  });

  it('records an answer that raced the move at the question’s new seq', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(2);
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    const store = engine.deps.store;
    const record = store.recordAnswer.bind(store);
    let injected = false;
    // The feedback lands after submitAnswer read the question and before it writes the answer.
    store.recordAnswer = async (args) => {
      if (!injected) {
        injected = true;
        await submitFeedback(engine.deps, m.id, teach('race'));
      }
      return record(args);
    };
    const res = await submitAnswer(engine.deps, m.id, {
      questionId: next.question.id,
      value: next.question.options[0]!.key,
      latencyMs: 500,
      idempotencyKey: `k-race-${m.id}`,
    });
    expect(injected).toBe(true);
    expect(res.seq).toBe(next.question.seq + 1);
    const a = await store.getAnswerForQuestion(next.question.id);
    expect(a?.seq).toBe(next.question.seq + 1);
    const seqs = (await store.listAnswers(m.id)).map((x) => x.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('feedback robustness (ADR-0032)', () => {
  it('refuses a reused key for a different answer, and replays the same request', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(1);
    const first = await submitFeedback(engine.deps, m.id, teach('same', 'a'));
    expect((await submitFeedback(engine.deps, m.id, teach('same', 'a'))).question.id).toBe(first.question.id);
    await expect(submitFeedback(engine.deps, m.id, teach('same', 'b'))).rejects.toThrow(
      'Idempotency key reused',
    );
  });

  it('maps yes/no by key in any order, and other keys by position', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(1);
    const yn = (options: Array<{ key: string; label: string }>, answer: string, k: string) =>
      submitFeedback(engine.deps, m.id, {
        question: { type: 'noul', prompt: `Would you swim in a cold lake? (${k})`, options },
        answer,
        idempotencyKey: `fb-yn-${k}`,
      });
    const reversed = await yn(
      [
        { key: 'no', label: 'No' },
        { key: 'yes', label: 'Yes' },
      ],
      'yes',
      'rev',
    );
    expect(reversed.answer.optionKey).toBe('yes');
    const lettered = await yn(
      [
        { key: 'a', label: 'Yes' },
        { key: 'b', label: 'No' },
      ],
      'b',
      'ab',
    );
    expect(lettered.answer.optionKey).toBe('no');
  });

  it('keeps feedback over budget without model calls or failed jobs', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(2);
    await engine.deps.store.updateMimic(m.id, { spendUsd: 1_000 });
    const before = (await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 10_000 })).length;
    const fb = await submitFeedback(engine.deps, m.id, teach('budget'));
    expect(fb.learns).toBe(false);
    await engine.drain();
    expect((await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 10_000 })).length).toBe(before);
    const doc = await exportMimic(engine.deps, m.id);
    expect(doc.evidence.find((e) => e.kind === 'feedback')?.seq).toBe(fb.question.seq);
  });

  it("keeps the budget's last 20% for the mimic page once the session has spent its share (ADR-0035)", async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(2);
    const { store } = engine.deps;
    const calls = async () => (await store.listModelCalls({ mimicId: m.id, limit: 10_000 })).length;
    // The standard $1 cap: the session stops at $0.80, the page runs to $1.
    await store.updateMimic(m.id, { spendUsd: 0.85 });
    expect((await serveNext(engine.deps, m.id)).status).toBe('budget');
    expect((await uiSnapshot(engine.deps, m.id)).mimic.budgetUsd).toBe(1);

    // Session background work stops before any call, and is not marked done, so a raised cap can run it again.
    const before = await calls();
    for (const q of await store.listQuestions(m.id, ['pooled']))
      await store.updateQuestionStatus(q.id, 'discarded');
    const served = (await store.listQuestions(m.id)).find((q) => q.kind === 'anchor' && q.seq !== null)!;
    const jobs: Job[] = [
      { type: 'pool.refill', mimicId: m.id, seq: 99 },
      { type: 'hypotheses.refresh', mimicId: m.id, seqUpTo: 99 },
      { type: 'predict.shadow', mimicId: m.id, questionId: served.id, predictorId: 'llm:test/new-shadow' },
    ];
    for (const job of jobs) {
      expect(await runJob(engine.deps, job)).toBe('skipped');
      expect((await store.getJob(jobKey(job)))?.lastError).toMatch(/^budget: /);
    }
    expect(await enqueueMissingShadows(engine.deps, m.id, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(await calls()).toBe(before);

    // The page still asks and teaches from the reserve.
    const asked = await predictPlayground(engine.deps, m.id, ask);
    expect(asked.guess).toBeDefined();
    expect((await submitFeedback(engine.deps, m.id, teach('reserve'))).learns).toBe(true);

    // Under the share again (as after a raised cap), the refused shadow runs.
    await store.updateMimic(m.id, { spendUsd: 0.1 });
    expect(await runJob(engine.deps, jobs[2]!)).toBe('done');

    await store.updateMimic(m.id, { spendUsd: 1 });
    await expect(predictPlayground(engine.deps, m.id, ask)).rejects.toMatchObject({ code: 'budget' });
    expect((await submitFeedback(engine.deps, m.id, teach('spent'))).learns).toBe(false);
  });

  it('holds the gateway and the engine to the same raised cap', async () => {
    engine = await openLocalEngine({
      db: ':memory:',
      providers: 'offline',
      spend: { budgetUsd: 2, sessionShare: 0.5 },
    });
    const m = await session(2);
    await engine.deps.store.updateMimic(m.id, { spendUsd: 0.85 });
    // $0.85 is under the $1 share of a $2 cap: the engine serves, and the gateway lets every serve call through.
    const next = await serveNext(engine.deps, m.id);
    expect(next.status).toBe('question');
    if (next.status !== 'question') return;
    const preds = await engine.deps.store.listPredictions({ questionId: next.question.id });
    expect(preds.find((p) => p.role === 'primary')?.ok).toBe(true);
    const shadow: Job = {
      type: 'predict.shadow',
      mimicId: m.id,
      questionId: next.question.id,
      predictorId: 'llm:test/new-shadow',
    };
    expect(await runJob(engine.deps, shadow)).toBe('done');
    // At the $1 share, session work stops; the page's calls would still go through up to $2.
    await engine.deps.store.updateMimic(m.id, { spendUsd: 1 });
    expect(await runJob(engine.deps, { ...shadow, predictorId: 'llm:test/other-shadow' })).toBe('skipped');
  });

  it('serves an asked question at the next free seq when feedback takes its seq, keeping its predictions', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(3);
    const store = engine.deps.store;
    const serve = store.serveQuestion.bind(store);
    let injected = false;
    store.serveQuestion = async (args) => {
      if (!injected) {
        injected = true;
        await submitFeedback(engine.deps, m.id, teach('pg'));
      }
      return serve(args);
    };
    const pred = await predictPlayground(engine.deps, m.id, {
      type: 'choice',
      prompt: 'Would you take a spontaneous day off?',
      options: [
        { key: 'a', label: 'Yes, today' },
        { key: 'b', label: 'No, I would wait' },
      ],
      rationale: false,
    });
    expect(injected).toBe(true);
    const qs = await store.listQuestions(m.id);
    const fb = qs.find((q) => q.kind === 'feedback')!;
    expect(pred.question.seq).toBe(fb.seq! + 1);
    // One Jev primary and baseline, no orphaned rows.
    expect(await store.listPredictions({ questionId: pred.question.id })).toHaveLength(2);
    expect(qs.filter((q) => q.kind === 'playground' && q.status !== 'served')).toEqual([]);
  });

  it('writes a new snapshot when an answer arrives below the latest one', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(2);
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    const asked = await predictPlayground(engine.deps, m.id, {
      type: 'choice',
      prompt: 'Would you rather walk or bike to work?',
      options: [
        { key: 'a', label: 'Walk' },
        { key: 'b', label: 'Bike' },
      ],
      rationale: false,
    });
    await submitAnswer(engine.deps, m.id, {
      questionId: asked.question.id,
      value: 'a',
      latencyMs: 0,
      idempotencyKey: `pg-snap-${m.id}`,
    });
    expect((await exportMimic(engine.deps, m.id)).seqUpTo).toBe(asked.question.seq);
    await submitAnswer(engine.deps, m.id, {
      questionId: next.question.id,
      value: next.question.options[0]!.key,
      latencyMs: 0,
      idempotencyKey: `k-snap-${m.id}`,
    });
    const doc = await exportMimic(engine.deps, m.id);
    expect(doc.evidence.map((e) => e.seq)).toContain(next.question.seq);
    expect(doc.evidence).toHaveLength((await engine.deps.store.listAnswers(m.id)).length);
    const hist = await listPlayground(engine.deps, m.id);
    expect(hist.checked).toBe(1);
  });
});

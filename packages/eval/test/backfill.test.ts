import {
  BACKFILL_MAX_DELAY_SECONDS,
  BACKFILL_MAX_JOBS,
  BACKFILL_PER_MINUTE,
  backfillLimit,
  type ChatRequest,
  EngineError,
  type Job,
  type LlmClient,
  MAX_JOB_ATTEMPTS,
  PENDING_WINDOW_MS,
  runBackfillMimic,
  runBackfillPredictor,
  runJob,
  runShadow,
  STALE_JOB_MS,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as cli from '../../../scripts/backfill.mjs';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript } from '../src/session';

// A model added after these sessions ran: not in their config, so no shadow job was ever enqueued for it.
const NEW = 'llm:acme/new-model';
const COST = 0.001;
let engine: LocalEngine;
let consented: string;
let private_: string;
/** Moves the engine's clock: backfills leave questions served in the last PENDING_WINDOW_MS to the live path. */
let offset = 0;
const later = (ms = PENDING_WINDOW_MS + 60_000) => {
  offset += ms;
};

/** The offline LLM, plus what a real provider does: charge per call, fail a call, time out, or answer garbage. */
const outages = new Set<string>();
function providerLike(inner: LlmClient): LlmClient {
  return {
    provider: inner.provider,
    async chat(req: ChatRequest) {
      if (outages.has(req.model))
        throw Object.assign(new Error('HTTP 429 from openrouter.ai'), { status: 429 });
      if (req.model === 'acme/slow')
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      const r = await inner.chat(req);
      const content = req.model === 'acme/garbage' ? 'I think they would pick the first one.' : r.content;
      return { ...r, content, usage: { ...r.usage, costUsd: COST } };
    },
  };
}

beforeAll(async () => {
  engine = await openLocalEngine({
    db: ':memory:',
    providers: 'offline',
    seed: 'backfill',
    clock: () => Date.now() + offset,
  });
  engine.deps.gateway.deps.llm = providerLike(engine.deps.gateway.deps.llm);
  const script = (consentResearch: boolean) =>
    SessionScript.parse({
      intake: { name: 'Sam Rivera', location: 'Austin, US', occupation: 'Software engineer' },
      consentResearch,
    });
  consented = (await runSession(engine, script(true), { turns: 12 })).mimicId;
  private_ = (await runSession(engine, script(false), { turns: 12 })).mimicId;
  later();
}, 60_000);

afterAll(() => engine.close());

async function predictionsBy(mimicId: string, predictorId: string) {
  return (await engine.deps.store.listPredictions({ mimicId })).filter((p) => p.predictorId === predictorId);
}

async function served(mimicId: string) {
  return (await engine.deps.store.listQuestions(mimicId)).filter(
    (q) => q.seq !== null && (q.kind === 'anchor' || q.kind === 'adaptive'),
  );
}

/** Runs every queued job once; a job that throws stays failed in the ledger, as between the queue's retries. */
async function drainQuietly() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await engine.drain();
  } finally {
    warn.mockRestore();
  }
}

/** What the CLI's dry run reports, from its own SQL on this database. */
async function cliMissing(predictor: string, o: { mimics?: string[]; retryFailed?: boolean } = {}) {
  const q = cli.missingQuery(
    { predictor, consented: false, mimics: o.mimics ?? [], retryFailed: o.retryFailed ?? false },
    engine.deps.clock(),
  );
  const rs = await engine.client.execute({ sql: q.sql, args: q.params });
  return rs.rows.reduce((s, r) => s + Number(r.missing), 0);
}

async function cliRow(q: { sql: string; params: string[] }) {
  return (await engine.client.execute({ sql: q.sql, args: q.params })).rows[0]!;
}

const backfillShadows = () => engine.queue.pending.filter((p) => p.job.type === 'backfill.shadow');

describe('backfilling a new predictor (ADR-0024, ADR-0035)', () => {
  it("shares the engine's pace, caps and windows with the CLI", () => {
    expect(cli.DEFAULT_RATE).toBe(BACKFILL_PER_MINUTE);
    expect(cli.MAX_JOBS).toBe(BACKFILL_MAX_JOBS);
    expect(cli.MAX_DELAY_SECONDS).toBe(BACKFILL_MAX_DELAY_SECONDS);
    expect(cli.PENDING_WINDOW_MS).toBe(PENDING_WINDOW_MS);
    expect(cli.MAX_ATTEMPTS).toBe(MAX_JOB_ATTEMPTS);
    expect(cli.STALE_JOB_MS).toBe(STALE_JOB_MS);
    for (const rate of [1, 7, 30, 600]) expect(cli.runLimit(rate)).toBe(backfillLimit(rate));
  });

  it('paces the consented mimics as one stream, then predicts each on the sealed state the primary used', async () => {
    const { store } = engine.deps;
    const questions = await served(consented);
    expect(questions.length).toBeGreaterThanOrEqual(10);
    expect(await cliMissing(NEW)).toBe(questions.length + (await served(private_)).length);
    await runJob(engine.deps, {
      type: 'backfill.predictor',
      runId: 'r1',
      predictorId: NEW,
      consentedOnly: true,
      perMinute: 12,
    });
    const queued = backfillShadows();
    expect(queued).toHaveLength(questions.length);
    expect(queued.map((p) => p.delaySeconds ?? 0)).toEqual(queued.map((_, i) => i * 5));
    const jobs = queued.map((p) => p.job as Extract<Job, { type: 'backfill.shadow' }>);
    expect(new Set(jobs.map((j) => j.mimicId))).toEqual(new Set([consented]));
    // Each is in the ledger as queued, due at its time, so the CLI and a re-run see it in flight.
    const first = (await store.getJob(`backfill.shadow:${consented}:${jobs[0]!.questionId}:${NEW}`))!;
    expect(first).toMatchObject({ status: 'queued', attempts: 0 });
    expect(Number((await cliRow(cli.inFlightQuery(NEW, engine.deps.clock()))).n)).toBe(questions.length);
    expect(await cliMissing(NEW, { mimics: [consented] })).toBe(0);
    expect((await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: NEW })).enqueued).toBe(0);

    await engine.drain();
    const added = await predictionsBy(consented, NEW);
    expect(added).toHaveLength(questions.length);
    for (const q of questions) {
      const preds = await store.listPredictions({ questionId: q.id });
      const primary = preds.find((p) => p.role === 'primary')!;
      const mine = preds.filter((p) => p.predictorId === NEW);
      expect(mine).toHaveLength(1);
      expect(mine[0]!).toMatchObject({ role: 'shadow', ok: true, stateHash: primary.stateHash });
      expect(mine[0]!.evidenceSeqMax).toBeLessThan(q.seq!);
    }
    // Answered questions are scored like any shadow.
    const scored = await store.listScoredPredictions(consented, ['shadow']);
    expect(scored.filter((s) => s.prediction.predictorId === NEW)).toHaveLength(questions.length);
    // consentedOnly: the private mimic is untouched.
    expect(await predictionsBy(private_, NEW)).toHaveLength(0);
    // Logged as backfill calls, not live shadows.
    const calls = await store.listModelCalls({ mimicId: consented });
    expect(calls.filter((c) => c.model === 'acme/new-model').map((c) => c.purpose)).toEqual(
      questions.map(() => 'predict.backfill'),
    );
    expect(Number((await cliRow(cli.inFlightQuery(NEW, engine.deps.clock()))).n)).toBe(0);
  });

  it('is idempotent: running again finds nothing to do', async () => {
    const before = (await predictionsBy(consented, NEW)).length;
    expect(await cliMissing(NEW, { mimics: [consented] })).toBe(0);
    expect(await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: NEW })).toEqual({
      enqueued: 0,
      capped: false,
    });
    await runJob(engine.deps, {
      type: 'backfill.predictor',
      runId: 'r2',
      predictorId: NEW,
      consentedOnly: true,
    });
    await engine.drain();
    expect(await predictionsBy(consented, NEW)).toHaveLength(before);
  });

  it('covers every mimic without consentedOnly, at the default pace', async () => {
    const r = await runBackfillPredictor(engine.deps, { predictorId: NEW, consentedOnly: false });
    expect(r).toMatchObject({ mimics: 2, capped: false });
    expect(r.enqueued).toBe((await served(private_)).length);
    expect(backfillShadows()[1]?.delaySeconds).toBe(60 / BACKFILL_PER_MINUTE);
    await engine.drain();
    expect((await predictionsBy(private_, NEW)).length).toBeGreaterThanOrEqual(10);
  });

  it('stops at the run limit and says so; the next run enqueues the rest', async () => {
    const OTHER = 'llm:acme/capped';
    // One a minute, 90 s before the delay horizon: two fit.
    const offsetSeconds = BACKFILL_MAX_DELAY_SECONDS - 90;
    expect(backfillLimit(1, offsetSeconds)).toBe(2);
    const r = await runBackfillMimic(engine.deps, {
      mimicId: private_,
      predictorId: OTHER,
      perMinute: 1,
      offsetSeconds,
    });
    expect(r).toEqual({ enqueued: 2, capped: true });
    await engine.drain();
    const next = await runBackfillMimic(engine.deps, { mimicId: private_, predictorId: OTHER });
    expect(next.enqueued).toBe((await served(private_)).length - 2);
    await engine.drain();
  });

  it('never duplicates a predictor the question already has, such as the primary', async () => {
    const primary = (await engine.deps.store.listPredictions({ mimicId: consented, roles: ['primary'] }))[0]!;
    expect(
      (await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: primary.predictorId }))
        .enqueued,
    ).toBe(0);
  });

  it('stores one shadow when two runs of it race', async () => {
    const [q] = await served(consented);
    const RACE = 'llm:acme/race';
    await Promise.all([
      runShadow(engine.deps, consented, q!.id, RACE, undefined, { backfill: true }),
      runShadow(engine.deps, consented, q!.id, RACE, undefined, { backfill: true }),
    ]);
    expect(await predictionsBy(consented, RACE)).toHaveLength(1);
  });

  it('rejects a malformed predictor id as invalid (the worker drops it instead of retrying)', async () => {
    await expect(
      runBackfillPredictor(engine.deps, { predictorId: 'nope', consentedOnly: false }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('leaves questions served in the last 15 minutes to the live shadows', async () => {
    const fresh = (
      await runSession(
        engine,
        SessionScript.parse({ intake: { name: 'Ada Park', location: 'Oslo, NO', occupation: 'Nurse' } }),
        { turns: 4 },
      )
    ).mimicId;
    const run = () => runBackfillMimic(engine.deps, { mimicId: fresh, predictorId: NEW });
    expect(await cliMissing(NEW, { mimics: [fresh] })).toBe(0);
    expect((await run()).enqueued).toBe(0);
    later();
    expect(await cliMissing(NEW, { mimics: [fresh] })).toBe(4);
    expect((await run()).enqueued).toBe(4);
    await engine.drain();
  });

  it('skips a mimic whose owner withdrew consent after a consented-only run was planned', async () => {
    const WITHDRAWN = 'llm:acme/withdrawn';
    await runBackfillPredictor(engine.deps, { predictorId: WITHDRAWN, consentedOnly: true });
    expect(backfillShadows().length).toBeGreaterThan(0);
    await engine.deps.store.updateMimic(consented, { consentResearch: false });
    try {
      await engine.drain();
      expect(await predictionsBy(consented, WITHDRAWN)).toHaveLength(0);
    } finally {
      await engine.deps.store.updateMimic(consented, { consentResearch: true });
    }
  });
});

describe('failed calls vs. the model failing (ADR-0035)', () => {
  const FLAKY = 'llm:acme/flaky';

  it('retries a failed call, stores it after the last attempt, and --retry-failed redoes it', async () => {
    const { store } = engine.deps;
    const questions = await served(consented);
    outages.add('acme/flaky');
    try {
      const { enqueued } = await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: FLAKY });
      expect(enqueued).toBe(questions.length);
      const jobs = backfillShadows().map((p) => p.job);
      await drainQuietly();
      // Attempt 1 threw: nothing stored, the job is being retried, so nothing re-enqueues it meanwhile.
      expect(await predictionsBy(consented, FLAKY)).toHaveLength(0);
      const key = `backfill.shadow:${consented}:${questions[0]!.id}:${FLAKY}`;
      expect(await store.getJob(key)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(await cliMissing(FLAKY, { mimics: [consented] })).toBe(0);
      expect((await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: FLAKY })).enqueued).toBe(
        0,
      );
      // The queue's remaining attempts; the last one stores the failed call.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (let a = 2; a <= MAX_JOB_ATTEMPTS; a++)
        for (const job of jobs) await runJob(engine.deps, job).catch(() => {});
      warn.mockRestore();
      expect(await store.getJob(key)).toMatchObject({ status: 'done', attempts: MAX_JOB_ATTEMPTS });
      const failed = await predictionsBy(consented, FLAKY);
      expect(failed).toHaveLength(questions.length);
      expect(failed.every((p) => !p.ok && p.errorKind === 'transport')).toBe(true);
      const stats = await cliRow(cli.statsQuery(FLAKY));
      expect(Number(stats.failed_calls)).toBe(questions.length);
      expect(Number(stats.redoable)).toBe(questions.length);
    } finally {
      outages.delete('acme/flaky');
    }
    // Stored, so not missing; with --retry-failed, redone and replaced once the provider is back.
    expect(await cliMissing(FLAKY, { mimics: [consented] })).toBe(0);
    expect(await cliMissing(FLAKY, { mimics: [consented], retryFailed: true })).toBe(questions.length);
    await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: FLAKY, retryFailed: true });
    await engine.drain();
    const preds = await predictionsBy(consented, FLAKY);
    expect(preds).toHaveLength(questions.length);
    expect(preds.every((p) => p.ok)).toBe(true);
  });

  it("stores unusable output and timeouts as the model's failures, and never redoes them", async () => {
    for (const model of ['garbage', 'slow']) {
      const id = `llm:acme/${model}`;
      await runBackfillMimic(engine.deps, { mimicId: consented, predictorId: id });
      await engine.drain();
      const preds = await predictionsBy(consented, id);
      expect(preds.length).toBeGreaterThan(0);
      const kind = model === 'garbage' ? 'output' : 'timeout';
      expect(preds.every((p) => !p.ok && p.errorKind === kind)).toBe(true);
      expect(await cliMissing(id, { mimics: [consented], retryFailed: true })).toBe(0);
      const r = await runBackfillMimic(engine.deps, {
        mimicId: consented,
        predictorId: id,
        retryFailed: true,
      });
      expect(r.enqueued).toBe(0);
    }
    const stats = await cliRow(cli.statsQuery('llm:acme/slow'));
    expect(Number(stats.timeouts)).toBeGreaterThan(0);
    expect(Number(stats.redoable)).toBe(0);
  });

  it("runs outside the mimic's budget, and --retry-failed replaces calls the budget refused", async () => {
    const { store, gateway } = engine.deps;
    const PRICED = 'llm:acme/priced';
    await gateway.deps.budget!.add(private_, 100);
    const spend = (await store.getMimic(private_))!.spendUsd;

    // A live shadow on an over-budget mimic is refused at once (not retried) and stored as a failed call.
    const [q1, q2] = await served(private_);
    for (const q of [q1!, q2!])
      await runJob(engine.deps, {
        type: 'predict.shadow',
        mimicId: private_,
        questionId: q.id,
        predictorId: PRICED,
      });
    const refused = await predictionsBy(private_, PRICED);
    expect(refused.map((p) => [p.ok, p.errorKind, p.error?.slice(0, 15)])).toEqual([
      [false, 'transport', 'Budget exceeded'],
      [false, 'transport', 'Budget exceeded'],
    ]);

    // Without --retry-failed they stand; with it, they are redone, alongside the rest, outside the budget.
    const all = (await served(private_)).length;
    expect(await cliMissing(PRICED, { mimics: [private_] })).toBe(all - 2);
    expect(await cliMissing(PRICED, { mimics: [private_], retryFailed: true })).toBe(all);
    const r = await runBackfillMimic(engine.deps, {
      mimicId: private_,
      predictorId: PRICED,
      retryFailed: true,
    });
    expect(r.enqueued).toBe(all);
    await engine.drain();
    const preds = await predictionsBy(private_, PRICED);
    expect(preds).toHaveLength(all);
    expect(preds.every((p) => p.ok && p.costUsd === COST)).toBe(true);
    expect(preds.map((p) => p.id)).not.toContain(refused[0]!.id);
    expect((await store.getMimic(private_))!.spendUsd).toBe(spend);
    expect(await cliMissing(PRICED, { mimics: [private_], retryFailed: true })).toBe(0);
  });

  it('gives up on a live shadow after its last attempt instead of re-enqueueing it from the cron', async () => {
    const LIVE = 'llm:acme/live-flaky';
    const [q] = await served(consented);
    outages.add('acme/live-flaky');
    try {
      const job: Job = { type: 'predict.shadow', mimicId: consented, questionId: q!.id, predictorId: LIVE };
      for (let a = 1; a <= MAX_JOB_ATTEMPTS; a++) await runJob(engine.deps, job).catch(() => {});
      const [stored] = await predictionsBy(consented, LIVE);
      expect(stored).toMatchObject({ ok: false, errorKind: 'transport' });
      expect(await engine.deps.store.getJob(`predict.shadow:${consented}:${q!.id}:${LIVE}`)).toMatchObject({
        status: 'done',
      });
    } finally {
      outages.delete('acme/live-flaky');
    }
  });
});

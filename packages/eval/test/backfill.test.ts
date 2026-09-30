import {
  BACKFILL_PER_MINUTE,
  type ChatRequest,
  EngineError,
  type Job,
  type LlmClient,
  PENDING_WINDOW_MS,
  runBackfillMimic,
  runBackfillPredictor,
  runJob,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PENDING_WINDOW_MS as CLI_PENDING_WINDOW_MS,
  DEFAULT_RATE,
  missingQuery,
  statsQuery,
} from '../../../scripts/backfill.mjs';
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
const later = () => {
  offset += PENDING_WINDOW_MS + 60_000;
};

/** The offline LLM, plus what a real provider does: charge per call, fail a call, or answer with garbage. */
const outages = new Set<string>();
function providerLike(inner: LlmClient): LlmClient {
  return {
    provider: inner.provider,
    async chat(req: ChatRequest) {
      if (outages.has(req.model))
        throw Object.assign(new Error('HTTP 429 from openrouter.ai'), { status: 429 });
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

/** Runs every queued job; jobs that throw stay failed in the ledger, as after the queue's last retry. */
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
  const q = missingQuery(
    { predictor, consented: false, mimics: o.mimics ?? [], retryFailed: o.retryFailed ?? false },
    engine.deps.clock(),
  );
  const rs = await engine.client.execute({ sql: q.sql, args: q.params });
  return rs.rows.reduce((s, r) => s + Number(r.missing), 0);
}

describe('backfilling a new predictor (ADR-0024, ADR-0027)', () => {
  it("shares the engine's pace and pending window with the CLI", () => {
    expect(DEFAULT_RATE).toBe(BACKFILL_PER_MINUTE);
    expect(CLI_PENDING_WINDOW_MS).toBe(PENDING_WINDOW_MS);
  });

  it('paces the predictions as one stream, 60 / perMinute seconds apart', async () => {
    expect(await cliMissing(NEW, { mimics: [consented] })).toBe((await served(consented)).length);
    await runJob(engine.deps, {
      type: 'backfill.predictor',
      runId: 'r1',
      predictorId: NEW,
      consentedOnly: true,
      perMinute: 12,
    });
    const queued = engine.queue.pending.filter((p) => p.job.type === 'backfill.shadow');
    expect(queued).toHaveLength((await served(consented)).length);
    expect(queued.map((p) => p.delaySeconds ?? 0)).toEqual(queued.map((_, i) => i * 5));
    expect(new Set(queued.map((p) => (p.job as Extract<Job, { type: 'backfill.shadow' }>).mimicId))).toEqual(
      new Set([consented]),
    );
  });

  it('predicts every served question of the consented mimics, on the sealed state the primary used', async () => {
    const { store } = engine.deps;
    await engine.drain();

    const questions = await served(consented);
    expect(questions.length).toBeGreaterThanOrEqual(10);
    const added = await predictionsBy(consented, NEW);
    expect(added).toHaveLength(questions.length);
    for (const q of questions) {
      const preds = await store.listPredictions({ questionId: q.id });
      const primary = preds.find((p) => p.role === 'primary')!;
      const mine = preds.filter((p) => p.predictorId === NEW);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.role).toBe('shadow');
      expect(mine[0]!.ok).toBe(true);
      expect(mine[0]!.stateHash).toBe(primary.stateHash);
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
  });

  it('is idempotent: running again finds nothing to do', async () => {
    const before = (await predictionsBy(consented, NEW)).length;
    expect(await cliMissing(NEW, { mimics: [consented] })).toBe(0);
    expect(
      await runBackfillMimic(engine.deps, { runId: 'r2', mimicId: consented, predictorId: NEW }),
    ).toEqual({
      enqueued: 0,
      deferred: 0,
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
    const r = await runBackfillPredictor(engine.deps, {
      runId: 'r3',
      predictorId: NEW,
      consentedOnly: false,
    });
    expect(r).toMatchObject({ mimics: 2, deferred: 0 });
    expect(r.enqueued).toBe((await served(private_)).length);
    expect(engine.queue.pending[1]?.delaySeconds).toBe(60 / BACKFILL_PER_MINUTE);
    await engine.drain();
    expect((await predictionsBy(private_, NEW)).length).toBeGreaterThanOrEqual(10);
  });

  it('never duplicates a predictor the question already has, such as the primary', async () => {
    const primary = (await engine.deps.store.listPredictions({ mimicId: consented, roles: ['primary'] }))[0]!;
    expect(
      (
        await runBackfillMimic(engine.deps, {
          runId: 'r4',
          mimicId: consented,
          predictorId: primary.predictorId,
        })
      ).enqueued,
    ).toBe(0);
  });

  it('rejects a malformed predictor id as invalid (the worker drops it instead of retrying)', async () => {
    await expect(
      runBackfillPredictor(engine.deps, { runId: 'r5', predictorId: 'nope', consentedOnly: false }),
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
    const run = () => runBackfillMimic(engine.deps, { runId: 'r6', mimicId: fresh, predictorId: NEW });
    expect(await cliMissing(NEW, { mimics: [fresh] })).toBe(0);
    expect((await run()).enqueued).toBe(0);
    later();
    expect(await cliMissing(NEW, { mimics: [fresh] })).toBe(4);
    expect((await run()).enqueued).toBe(4);
    await engine.drain();
  });
});

describe('failed calls vs. unusable output (ADR-0027)', () => {
  const FLAKY = 'llm:acme/flaky';
  const GARBAGE = 'llm:acme/garbage';

  it('retries a failed call instead of storing it as the model failing, then fills it in', async () => {
    outages.add('acme/flaky');
    const { enqueued } = await runBackfillMimic(engine.deps, {
      runId: 'f1',
      mimicId: consented,
      predictorId: FLAKY,
    });
    expect(enqueued).toBeGreaterThan(0);
    await drainQuietly();
    expect(await predictionsBy(consented, FLAKY)).toHaveLength(0);
    const [q] = await served(consented);
    const ledger = await engine.deps.store.getJob(`backfill.shadow:f1:${consented}:${q!.id}:${FLAKY}`);
    expect(ledger).toMatchObject({ status: 'failed', lastError: expect.stringContaining('HTTP 429') });
    // Still missing, so the next run picks it up once the provider recovers.
    expect(await cliMissing(FLAKY, { mimics: [consented] })).toBe(enqueued);
    outages.delete('acme/flaky');
    await runBackfillMimic(engine.deps, { runId: 'f2', mimicId: consented, predictorId: FLAKY });
    await engine.drain();
    const preds = await predictionsBy(consented, FLAKY);
    expect(preds).toHaveLength(enqueued);
    expect(preds.every((p) => p.ok)).toBe(true);
  });

  it('stores unusable output as the model failing, and never redoes it', async () => {
    await runBackfillMimic(engine.deps, { runId: 'g1', mimicId: consented, predictorId: GARBAGE });
    await engine.drain();
    const preds = await predictionsBy(consented, GARBAGE);
    expect(preds.length).toBeGreaterThan(0);
    expect(preds.every((p) => !p.ok && p.error === 'invalid JSON output')).toBe(true);
    expect(await cliMissing(GARBAGE, { mimics: [consented], retryFailed: true })).toBe(0);
    const r = await runBackfillMimic(engine.deps, {
      runId: 'g2',
      mimicId: consented,
      predictorId: GARBAGE,
      retryFailed: true,
    });
    expect(r.enqueued).toBe(0);
  });

  it("runs outside the mimic's budget, and --retry-failed replaces calls the budget refused", async () => {
    const { store, gateway } = engine.deps;
    const PRICED = 'llm:acme/priced';
    const m = (await store.getMimic(private_))!;
    await gateway.deps.budget!.add(private_, 100);
    const spend = (await store.getMimic(private_))!.spendUsd;
    expect(spend).toBeGreaterThan(m.spendUsd);

    // A live shadow on an over-budget mimic is refused: stored as a failed call (before ADR-0027, so were 429s).
    const [q1, q2] = await served(private_);
    for (const q of [q1!, q2!])
      await runJob(engine.deps, {
        type: 'predict.shadow',
        mimicId: private_,
        questionId: q.id,
        predictorId: PRICED,
      });
    const refused = await predictionsBy(private_, PRICED);
    expect(refused.map((p) => [p.ok, p.error?.slice(0, 15)])).toEqual([
      [false, 'Budget exceeded'],
      [false, 'Budget exceeded'],
    ]);

    // Without --retry-failed they stand; with it, they are redone, alongside the rest, outside the budget.
    const all = (await served(private_)).length;
    expect(await cliMissing(PRICED, { mimics: [private_] })).toBe(all - 2);
    expect(await cliMissing(PRICED, { mimics: [private_], retryFailed: true })).toBe(all);
    const r = await runBackfillMimic(engine.deps, {
      runId: 'b1',
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

  it("matches the CLI's report of how each predictor has done", async () => {
    const stats = async (predictor: string) => {
      const q = statsQuery(predictor);
      const rs = await engine.client.execute({ sql: q.sql, args: q.params });
      const r = rs.rows[0]!;
      return {
        n: Number(r.n),
        ok: Number(r.ok),
        unusable: Number(r.unusable),
        failedCalls: Number(r.failed_calls),
      };
    };
    const garbage = (await predictionsBy(consented, GARBAGE)).length;
    expect(await stats(GARBAGE)).toEqual({ n: garbage, ok: 0, unusable: garbage, failedCalls: 0 });
    const flaky = (await predictionsBy(consented, FLAKY)).length;
    expect(await stats(FLAKY)).toEqual({ n: flaky, ok: flaky, unusable: 0, failedCalls: 0 });
  });
});

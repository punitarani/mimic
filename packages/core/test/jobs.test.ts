import { describe, expect, it } from 'vitest';
import { Job, jobFromKey, jobKey } from '../src';

describe('job keys', () => {
  it('round-trips every job type through its dedupe key', () => {
    const jobs: Job[] = [
      { type: 'noop', id: 'x:y' },
      { type: 'identity.search', mimicId: 'M' },
      { type: 'identity.search', mimicId: 'M', attempt: 1790000000000 },
      { type: 'identity.enrich', mimicId: 'M', candidateId: 'C' },
      { type: 'pool.refill', mimicId: 'M', seq: 3 },
      { type: 'predict.shadow', mimicId: 'M', questionId: 'Q', predictorId: 'llm:openai/gpt-6-luna' },
      { type: 'learn.answer', mimicId: 'M', seq: 12 },
      { type: 'learn.answer', mimicId: 'M', seq: 12, answerId: 'A' },
      { type: 'hypotheses.refresh', mimicId: 'M', seqUpTo: 20 },
      { type: 'snapshot.write', mimicId: 'M', seqUpTo: 20 },
      { type: 'hypotheses.refresh', mimicId: 'M', seqUpTo: 20, epoch: 2 },
      { type: 'snapshot.write', mimicId: 'M', seqUpTo: 20, epoch: 0 },
      {
        type: 'backfill.predictor',
        runId: 'R',
        predictorId: 'llm:xiaomi/mimo-v2.6-pro',
        consentedOnly: true,
      },
      { type: 'backfill.predictor', runId: 'R', predictorId: 'jev:typesafe/jev-1.13', consentedOnly: false },
      // ADR-0054: decision IDs, and keys from before it (`jev:`) round-trip verbatim, so the ledger row still closes.
      {
        type: 'backfill.predictor',
        runId: 'R',
        predictorId: 'decision:typesafe/jev-1.13@jev-predict.v2',
        consentedOnly: false,
        perMinute: 30,
      },
      {
        type: 'predict.shadow',
        mimicId: 'M',
        questionId: 'Q',
        predictorId: 'decision:respan/span-01-20260925',
      },
      {
        type: 'backfill.shadow',
        mimicId: 'M',
        questionId: 'Q',
        predictorId: 'jev:typesafe/jev-1.13@jev-predict.v2',
      },
      {
        type: 'backfill.mimic',
        runId: 'R',
        mimicId: 'M',
        predictorId: 'decision:typesafe/jev-1.13',
        retryFailed: true,
      },
      { type: 'backfill.mimic', runId: 'R', mimicId: 'M', predictorId: 'llm:xiaomi/mimo-v2.6-pro' },
      { type: 'backfill.shadow', mimicId: 'M', questionId: 'Q', predictorId: 'llm:qwen/qwen3.8-flash:free' },
      {
        type: 'backfill.mimic',
        runId: 'R',
        mimicId: 'M',
        predictorId: 'llm:qwen/qwen3.8-flash@predict.v2',
        perMinute: 12,
        retryFailed: true,
        offsetSeconds: 90,
        consentedOnly: true,
      },
      { type: 'stats.refresh', bucket: '2026-09-30T10' },
    ];
    for (const j of jobs) expect(jobFromKey(jobKey(j))).toEqual(j);
    expect(jobFromKey('bogus:1')).toBeNull();
  });

  it('keeps backfill options in the key, so a job requeued from the ledger runs as asked', () => {
    const job: Job = {
      type: 'backfill.predictor',
      runId: 'R',
      predictorId: 'llm:qwen/qwen3.8-flash',
      consentedOnly: true,
      perMinute: 10,
      retryFailed: true,
    };
    expect(jobKey(job)).toBe('backfill.predictor:R:1:r10f:llm:qwen/qwen3.8-flash');
    expect(jobFromKey(jobKey(job))).toEqual(job);
    // Jobs from before the options existed keep their keys.
    const old: Job = {
      type: 'backfill.predictor',
      runId: 'R',
      predictorId: 'jev:typesafe/jev-1.13',
      consentedOnly: false,
    };
    expect(jobKey(old)).toBe('backfill.predictor:R:0:jev:typesafe/jev-1.13');
    expect(Job.safeParse({ ...job, perMinute: 0 }).success).toBe(false);
    expect(Job.safeParse({ ...job, perMinute: 2.5 }).success).toBe(false);
  });

  it('keys a backfilled prediction without its run, so runs dedupe; its flags fall back to the safe defaults', () => {
    const job: Job = {
      type: 'backfill.shadow',
      mimicId: 'M',
      questionId: 'Q',
      predictorId: 'llm:acme/m',
      retryFailed: true,
      allMimics: true,
    };
    expect(jobKey(job)).toBe('backfill.shadow:M:Q:llm:acme/m');
    expect(jobFromKey(jobKey(job))).toEqual({
      type: 'backfill.shadow',
      mimicId: 'M',
      questionId: 'Q',
      predictorId: 'llm:acme/m',
    });
  });
});

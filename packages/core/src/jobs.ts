import { z } from 'zod';

const BackfillOptions = z.object({
  /** Predictions per minute for this predictor (default BACKFILL_PER_MINUTE). */
  perMinute: z.number().positive().max(600).optional(),
  /** Also redo this predictor's shadows whose call failed (never ones where the model's output was unusable). */
  retryFailed: z.boolean().optional(),
});

export const Job = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noop'), id: z.string() }),
  z.object({ type: z.literal('identity.search'), mimicId: z.string() }),
  z.object({ type: z.literal('identity.enrich'), mimicId: z.string(), candidateId: z.string() }),
  z.object({ type: z.literal('pool.refill'), mimicId: z.string(), seq: z.number().int() }),
  z.object({
    type: z.literal('predict.shadow'),
    mimicId: z.string(),
    questionId: z.string(),
    predictorId: z.string(),
  }),
  z.object({ type: z.literal('learn.answer'), mimicId: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal('hypotheses.refresh'), mimicId: z.string(), seqUpTo: z.number().int() }),
  z.object({ type: z.literal('snapshot.write'), mimicId: z.string(), seqUpTo: z.number().int() }),
  /**
   * Backfill (ADR-0024, ADR-0027): enqueues a paced `backfill.shadow` for every (consented) mimic's missing
   * predictions. `runId` makes each run its own job. The optional fields aren't in the key, so a job requeued from
   * the ledger falls back to their conservative defaults.
   */
  z.object({
    type: z.literal('backfill.predictor'),
    runId: z.string(),
    predictorId: z.string(),
    consentedOnly: z.boolean(),
    ...BackfillOptions.shape,
  }),
  /** The same for one mimic, starting `offsetSeconds` from now (the CLI staggers several named mimics). */
  z.object({
    type: z.literal('backfill.mimic'),
    runId: z.string(),
    mimicId: z.string(),
    predictorId: z.string(),
    ...BackfillOptions.shape,
    offsetSeconds: z.number().int().min(0).optional(),
  }),
  /** One backfilled prediction, on the primary's sealed state (like `predict.shadow`, but outside the budget). */
  z.object({
    type: z.literal('backfill.shadow'),
    runId: z.string(),
    mimicId: z.string(),
    questionId: z.string(),
    predictorId: z.string(),
  }),
]);
export type Job = z.infer<typeof Job>;

/** Dedupe key: job type + its IDs + seq (PLAN §6.4). */
export function jobKey(job: Job): string {
  switch (job.type) {
    case 'noop':
      return `noop:${job.id}`;
    case 'identity.search':
      return `identity.search:${job.mimicId}`;
    case 'identity.enrich':
      return `identity.enrich:${job.mimicId}:${job.candidateId}`;
    case 'pool.refill':
      return `pool.refill:${job.mimicId}:${job.seq}`;
    case 'predict.shadow':
      return `predict.shadow:${job.mimicId}:${job.questionId}:${job.predictorId}`;
    case 'learn.answer':
      return `learn.answer:${job.mimicId}:${job.seq}`;
    case 'hypotheses.refresh':
      return `hypotheses.refresh:${job.mimicId}:${job.seqUpTo}`;
    case 'snapshot.write':
      return `snapshot.write:${job.mimicId}:${job.seqUpTo}`;
    // Predictor IDs contain ':', so they come last.
    case 'backfill.predictor':
      return `backfill.predictor:${job.runId}:${job.consentedOnly ? 1 : 0}:${job.predictorId}`;
    case 'backfill.mimic':
      return `backfill.mimic:${job.runId}:${job.mimicId}:${job.predictorId}`;
    case 'backfill.shadow':
      return `backfill.shadow:${job.runId}:${job.mimicId}:${job.questionId}:${job.predictorId}`;
  }
}

/** Inverse of jobKey, for re-enqueueing stale jobs from the ledger. Returns null for unknown shapes. */
export function jobFromKey(key: string): Job | null {
  const [type, ...parts] = key.split(':');
  let job: unknown = null;
  switch (type) {
    case 'noop':
      job = { type, id: parts.join(':') };
      break;
    case 'identity.search':
      job = { type, mimicId: parts[0] };
      break;
    case 'identity.enrich':
      job = { type, mimicId: parts[0], candidateId: parts[1] };
      break;
    case 'pool.refill':
    case 'learn.answer':
      job = { type, mimicId: parts[0], seq: Number(parts[1]) };
      break;
    case 'predict.shadow':
      job = { type, mimicId: parts[0], questionId: parts[1], predictorId: parts.slice(2).join(':') };
      break;
    case 'hypotheses.refresh':
    case 'snapshot.write':
      job = { type, mimicId: parts[0], seqUpTo: Number(parts[1]) };
      break;
    case 'backfill.predictor':
      job = { type, runId: parts[0], consentedOnly: parts[1] === '1', predictorId: parts.slice(2).join(':') };
      break;
    case 'backfill.mimic':
      job = { type, runId: parts[0], mimicId: parts[1], predictorId: parts.slice(2).join(':') };
      break;
    case 'backfill.shadow':
      job = {
        type,
        runId: parts[0],
        mimicId: parts[1],
        questionId: parts[2],
        predictorId: parts.slice(3).join(':'),
      };
      break;
  }
  const r = Job.safeParse(job);
  return r.success ? r.data : null;
}

export interface JobQueue {
  enqueue(job: Job, opts?: { delaySeconds?: number }): Promise<void>;
}

/** Collects jobs in memory; used by the CLI and tests to run jobs inline. */
export class MemoryQueue implements JobQueue {
  readonly pending: Array<{ job: Job; delaySeconds?: number }> = [];
  async enqueue(job: Job, opts?: { delaySeconds?: number }): Promise<void> {
    const item: { job: Job; delaySeconds?: number } = { job };
    if (opts?.delaySeconds !== undefined) item.delaySeconds = opts.delaySeconds;
    this.pending.push(item);
  }
  drain(): Job[] {
    return this.pending.splice(0).map((p) => p.job);
  }
}

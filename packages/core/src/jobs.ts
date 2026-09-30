import { z } from 'zod';

export const Job = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noop'), id: z.string() }),
  /** `attempt` is set when the person searches again with a link, so the retry is its own job. */
  z.object({ type: z.literal('identity.search'), mimicId: z.string(), attempt: z.number().int().optional() }),
  z.object({ type: z.literal('identity.enrich'), mimicId: z.string(), candidateId: z.string() }),
  z.object({ type: z.literal('pool.refill'), mimicId: z.string(), seq: z.number().int() }),
  z.object({
    type: z.literal('predict.shadow'),
    mimicId: z.string(),
    questionId: z.string(),
    predictorId: z.string(),
  }),
  /** `answerId` ties the job to one answer, so a re-answer after a rewind learns again (ADR-0036). */
  z.object({
    type: z.literal('learn.answer'),
    mimicId: z.string(),
    seq: z.number().int(),
    answerId: z.string().optional(),
  }),
  /** `epoch` (ADR-0036) keys a refresh or snapshot to the evidence it follows, so one queued before an undo never
   * stands in for the re-answer's. Absent on jobs queued before it. */
  z.object({
    type: z.literal('hypotheses.refresh'),
    mimicId: z.string(),
    seqUpTo: z.number().int(),
    epoch: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('snapshot.write'),
    mimicId: z.string(),
    seqUpTo: z.number().int(),
    epoch: z.number().int().optional(),
  }),
  /** Backfill (ADR-0024): fans out one `backfill.mimic` per mimic. `runId` makes each run its own job. */
  z.object({
    type: z.literal('backfill.predictor'),
    runId: z.string(),
    predictorId: z.string(),
    consentedOnly: z.boolean(),
  }),
  /** Enqueues `predict.shadow` for the mimic's served questions the predictor hasn't predicted yet. */
  z.object({
    type: z.literal('backfill.mimic'),
    runId: z.string(),
    mimicId: z.string(),
    predictorId: z.string(),
  }),
  /** Recomputes cross-person item statistics (ADR-0027); `bucket` (an hour) makes each run its own job. */
  z.object({ type: z.literal('stats.refresh'), bucket: z.string() }),
]);
export type Job = z.infer<typeof Job>;

/** Dedupe key: job type + its IDs + seq (PLAN §6.4). */
export function jobKey(job: Job): string {
  switch (job.type) {
    case 'noop':
      return `noop:${job.id}`;
    case 'identity.search':
      return `identity.search:${job.mimicId}${job.attempt === undefined ? '' : `:${job.attempt}`}`;
    case 'identity.enrich':
      return `identity.enrich:${job.mimicId}:${job.candidateId}`;
    case 'pool.refill':
      return `pool.refill:${job.mimicId}:${job.seq}`;
    case 'predict.shadow':
      return `predict.shadow:${job.mimicId}:${job.questionId}:${job.predictorId}`;
    case 'learn.answer':
      return `learn.answer:${job.mimicId}:${job.seq}${job.answerId ? `:${job.answerId}` : ''}`;
    case 'hypotheses.refresh':
    case 'snapshot.write':
      return `${job.type}:${job.mimicId}:${job.seqUpTo}${job.epoch !== undefined ? `:${job.epoch}` : ''}`;
    // Predictor IDs contain ':', so they come last.
    case 'backfill.predictor':
      return `backfill.predictor:${job.runId}:${job.consentedOnly ? 1 : 0}:${job.predictorId}`;
    case 'backfill.mimic':
      return `backfill.mimic:${job.runId}:${job.mimicId}:${job.predictorId}`;
    case 'stats.refresh':
      return `stats.refresh:${job.bucket}`;
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
      job =
        parts[1] === undefined
          ? { type, mimicId: parts[0] }
          : { type, mimicId: parts[0], attempt: Number(parts[1]) };
      break;
    case 'identity.enrich':
      job = { type, mimicId: parts[0], candidateId: parts[1] };
      break;
    case 'pool.refill':
      job = { type, mimicId: parts[0], seq: Number(parts[1]) };
      break;
    case 'learn.answer':
      job = { type, mimicId: parts[0], seq: Number(parts[1]), ...(parts[2] ? { answerId: parts[2] } : {}) };
      break;
    case 'predict.shadow':
      job = { type, mimicId: parts[0], questionId: parts[1], predictorId: parts.slice(2).join(':') };
      break;
    case 'hypotheses.refresh':
    case 'snapshot.write':
      job = {
        type,
        mimicId: parts[0],
        seqUpTo: Number(parts[1]),
        ...(parts[2] !== undefined ? { epoch: Number(parts[2]) } : {}),
      };
      break;
    case 'backfill.predictor':
      job = { type, runId: parts[0], consentedOnly: parts[1] === '1', predictorId: parts.slice(2).join(':') };
      break;
    case 'backfill.mimic':
      job = { type, runId: parts[0], mimicId: parts[1], predictorId: parts.slice(2).join(':') };
      break;
    case 'stats.refresh':
      job = { type, bucket: parts.join(':') };
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

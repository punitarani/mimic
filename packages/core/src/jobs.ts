import { z } from 'zod';

const BackfillOptions = z.object({
  /** Predictions per minute for this predictor (default BACKFILL_PER_MINUTE). */
  perMinute: z.number().int().min(1).max(600).optional(),
  /** Also redo this predictor's shadows whose call failed (never unusable output or timeouts: those are the model's). */
  retryFailed: z.boolean().optional(),
});

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
  /**
   * Backfill (ADR-0024, ADR-0037): enqueues a paced `backfill.shadow` for every (consented) mimic's missing
   * predictions. `runId` makes each run its own job; the options are part of the key, so a job requeued from the
   * ledger keeps them.
   */
  z.object({
    type: z.literal('backfill.predictor'),
    runId: z.string(),
    predictorId: z.string(),
    consentedOnly: z.boolean(),
    ...BackfillOptions.shape,
  }),
  /**
   * The same for one named mimic, starting `offsetSeconds` from now (the CLI staggers several). `consentedOnly`: its
   * predictions still check research consent when they run.
   */
  z.object({
    type: z.literal('backfill.mimic'),
    runId: z.string(),
    mimicId: z.string(),
    predictorId: z.string(),
    ...BackfillOptions.shape,
    offsetSeconds: z.number().int().min(0).optional(),
    consentedOnly: z.boolean().optional(),
  }),
  /**
   * One backfilled prediction on the primary's sealed state, like `predict.shadow` (and held to the same budget).
   * Keyed without a run, so the ledger dedupes it across runs. Consent is checked again when it runs, unless
   * `allMimics`; a job requeued from its key keeps neither flag (the conservative defaults).
   */
  z.object({
    type: z.literal('backfill.shadow'),
    mimicId: z.string(),
    questionId: z.string(),
    predictorId: z.string(),
    retryFailed: z.boolean().optional(),
    allMimics: z.boolean().optional(),
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
      return `backfill.predictor:${job.runId}:${job.consentedOnly ? 1 : 0}:${backfillToken(job)}${job.predictorId}`;
    case 'backfill.mimic':
      return `backfill.mimic:${job.runId}:${job.mimicId}${job.consentedOnly ? '!' : ''}:${backfillToken(job)}${job.predictorId}`;
    case 'backfill.shadow':
      return `backfill.shadow:${job.mimicId}:${job.questionId}:${job.predictorId}`;
    case 'stats.refresh':
      return `stats.refresh:${job.bucket}`;
  }
}

type BackfillTokenOpts = { perMinute?: number; retryFailed?: boolean; offsetSeconds?: number };

/**
 * A backfill job's options as one key segment, `r<perMinute>[f][+<offsetSeconds>]:` (for example `r12f:`), or ''
 * when none are set (the keys of jobs from before the options existed). Predictor IDs start with `llm:`, `decision:`
 * or (keys from before ADR-0054) `jev:`, none of which reads as an option segment.
 * backfill.mimic's `consentedOnly` rides on the mimic segment instead (`<mimicId>!`), since named mimics are rare.
 */
function backfillToken(o: BackfillTokenOpts): string {
  if (o.perMinute === undefined && !o.retryFailed && !o.offsetSeconds) return '';
  return `r${o.perMinute ?? ''}${o.retryFailed ? 'f' : ''}${o.offsetSeconds ? `+${o.offsetSeconds}` : ''}:`;
}

function fromBackfillToken(parts: string[]): [BackfillTokenOpts, string] {
  const m = parts[0]?.match(/^r(\d*)(f?)(?:\+(\d+))?$/);
  if (!m) return [{}, parts.join(':')];
  const opts: BackfillTokenOpts = {};
  if (m[1]) opts.perMinute = Number(m[1]);
  if (m[2]) opts.retryFailed = true;
  if (m[3]) opts.offsetSeconds = Number(m[3]);
  return [opts, parts.slice(1).join(':')];
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
    case 'backfill.predictor': {
      const [opts, predictorId] = fromBackfillToken(parts.slice(2));
      job = { type, runId: parts[0], consentedOnly: parts[1] === '1', ...opts, predictorId };
      break;
    }
    case 'backfill.mimic': {
      const [opts, predictorId] = fromBackfillToken(parts.slice(2));
      const consented = parts[1]?.endsWith('!');
      const mimicId = consented ? parts[1]!.slice(0, -1) : parts[1];
      job = {
        type,
        runId: parts[0],
        mimicId,
        ...(consented ? { consentedOnly: true } : {}),
        ...opts,
        predictorId,
      };
      break;
    }
    case 'backfill.shadow':
      job = { type, mimicId: parts[0], questionId: parts[1], predictorId: parts.slice(2).join(':') };
      break;
    case 'stats.refresh':
      job = { type, bucket: parts.join(':') };
      break;
  }
  const r = Job.safeParse(job);
  return r.success ? r.data : null;
}

export interface QueuedJob {
  job: Job;
  delaySeconds?: number;
}

export interface JobQueue {
  enqueue(job: Job, opts?: { delaySeconds?: number }): Promise<void>;
  /** Many jobs in few requests (Queues' sendBatch takes 100 at a time), each with its own delay. */
  enqueueBatch(items: readonly QueuedJob[]): Promise<void>;
}

/** Collects jobs in memory; used by the CLI and tests to run jobs inline. */
export class MemoryQueue implements JobQueue {
  readonly pending: QueuedJob[] = [];
  async enqueue(job: Job, opts?: { delaySeconds?: number }): Promise<void> {
    const item: QueuedJob = { job };
    if (opts?.delaySeconds !== undefined) item.delaySeconds = opts.delaySeconds;
    this.pending.push(item);
  }
  async enqueueBatch(items: readonly QueuedJob[]): Promise<void> {
    for (const i of items) await this.enqueue(i.job, i.delaySeconds === undefined ? undefined : i);
  }
  drain(): Job[] {
    return this.pending.splice(0).map((p) => p.job);
  }
}

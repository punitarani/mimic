import { makeProviders, type ProviderEnv } from '@mimic/adapters';
import {
  decisionChallenger,
  EMBEDDING_MODEL,
  type EngineDeps,
  Gateway,
  type Job,
  type JobQueue,
  parseSpendLimits,
  type QueuedJob,
  type SpendLimits,
  ulid,
} from '@mimic/core';
import { CfKv, R2Blobs, SqlVectors, StoreBudget, StoreCallLog, VectorizeVectors } from './bindings';
import { retryer } from './busy';
import { type FlagshipBinding, flaggedEnv, flagsFor, warnOnce } from './flags';
import { d1Db } from './index';
import { DrizzleStore } from './store';

export { flaggedEnv, flagHealth } from './flags';

/** Bindings shared by apps/web and apps/worker (PLAN §6.5). */
export interface MimicBindings extends ProviderEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  CACHE: KVNamespace;
  JOBS?: Queue<Job>;
  /** Identity jobs' own lane, so a person never waits behind question generation (ADR-0034). Optional. */
  IDENTITY_JOBS?: Queue<Job>;
  VEC?: VectorizeIndex;
  AI?: { run(model: string, input: { text: string[] }): Promise<unknown> };
  RL?: RateLimit;
  /**
   * Cloudflare Flagship: runtime flags and tunables (ADR-0051). Unbound (local tests, or a deploy token without
   * Flagship access), every flag reads its default, which is the behaviour from before the flag.
   */
  FLAGS?: FlagshipBinding;
  /** 'vectorize' (default when VEC is bound) | 'sql' (local dev; ADR-0003). */
  VECTOR_BACKEND?: string;
  /** '1' in local dev (.dev.vars): enables dev-only behavior such as the local D1 lock retry (ADR-0014). */
  DEV_MODE?: string;
  SESSION_SECRET?: string;
  ADMIN_EMAILS?: string;
  INVITE_CODES?: string;
  /**
   * Spend cap per mimic in USD on the standard budget (default 1; ADR-0035). A string, or a JSON number. The
   * `budget-usd` flag overrides it where Flagship is bound (ADR-0051); this var is the fallback.
   */
  BUDGET_USD?: string | number;
  /** Share of the cap the session may spend (0–1, default 0.8); the rest is kept for the mimic page. */
  BUDGET_SESSION_SHARE?: string | number;
}

/** Queues' sendBatch limit. */
const SEND_BATCH = 100;

export class CfQueue implements JobQueue {
  constructor(private readonly q: Queue<Job>) {}
  async enqueue(job: Job, opts?: { delaySeconds?: number }) {
    await this.q.send(job, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
  }
  async enqueueBatch(items: readonly QueuedJob[]) {
    for (let i = 0; i < items.length; i += SEND_BATCH) {
      await this.q.sendBatch(
        items
          .slice(i, i + SEND_BATCH)
          .map((x) => (x.delaySeconds ? { body: x.job, delaySeconds: x.delaySeconds } : { body: x.job })),
      );
    }
  }
}

/**
 * Job types a person waits on during sign-up. They get their own queue: Cloudflare Queues adds consumers only after
 * a batch finishes, so on a shared queue a 1–4 minute `pool.refill` batch held a 2-second search for its whole run.
 * Producers route by type alone, whatever their own settings say (ADR-0034).
 */
export const IDENTITY_JOB_TYPES: ReadonlySet<Job['type']> = new Set(['identity.search', 'identity.enrich']);

/** Identity queues: `mimic-identity` plus the environment suffix (wrangler.jsonc). */
export function isIdentityQueue(name: string): boolean {
  return /^mimic-identity(?:-|$)/.test(name);
}

/**
 * Whether the identity lane runs this job itself. Decided by the consumer, which is where enrichment runs and whose
 * ENRICH_PROVIDER counts: Parallel enrichment takes minutes and would hold the lane the way `pool.refill` held the
 * shared queue, so the consumer forwards it there.
 */
export function runsOnIdentityLane(job: Job, env: Pick<MimicBindings, 'ENRICH_PROVIDER'>): boolean {
  return (
    job.type === 'identity.search' || (job.type === 'identity.enrich' && env.ENRICH_PROVIDER !== 'parallel')
  );
}

/** Routes identity jobs to IDENTITY_JOBS when it is bound; everything else (and all jobs without it) to JOBS. */
export class RoutedQueue implements JobQueue {
  constructor(
    private readonly main: JobQueue,
    private readonly identity: JobQueue | null,
  ) {}
  private laneOf(job: Job): JobQueue {
    return this.identity && IDENTITY_JOB_TYPES.has(job.type) ? this.identity : this.main;
  }
  enqueue(job: Job, opts?: { delaySeconds?: number }) {
    return this.laneOf(job).enqueue(job, opts);
  }
  async enqueueBatch(items: readonly QueuedJob[]) {
    const lanes = new Map<JobQueue, QueuedJob[]>();
    for (const i of items) lanes.set(this.laneOf(i.job), [...(lanes.get(this.laneOf(i.job)) ?? []), i]);
    for (const [q, batch] of lanes) await q.enqueueBatch(batch);
  }
}

export function queueFor(env: MimicBindings): JobQueue {
  if (!env.JOBS) throw new Error('No job queue bound');
  return new RoutedQueue(new CfQueue(env.JOBS), env.IDENTITY_JOBS ? new CfQueue(env.IDENTITY_JOBS) : null);
}

/** Spend limits from the vars; an invalid value keeps its default and is logged once per isolate. */
export function spendLimitsFor(env: Pick<MimicBindings, 'BUDGET_USD' | 'BUDGET_SESSION_SHARE'>): SpendLimits {
  const { limits, problems } = parseSpendLimits(env);
  for (const p of problems) warnOnce(p);
  return limits;
}

export function engineDeps(env: MimicBindings, overrides: Partial<EngineDeps> = {}): EngineDeps {
  const local = env.DEV_MODE === '1';
  const db = d1Db(env.DB, { local });
  const store = new DrizzleStore(db);
  const retry = local ? retryer(true) : undefined;
  const blobs = new R2Blobs(env.BLOBS, retry);
  const providers = makeProviders(env, {
    embeddingModel: EMBEDDING_MODEL,
    ...(env.AI ? { ai: env.AI } : {}),
  });
  const clock = () => Date.now();
  // One object for both: the gateway's guard and the engine's checks always read the same caps.
  const spend = overrides.spend ?? spendLimitsFor(env);
  const gateway = new Gateway({
    ...providers,
    // Unbound FLAGS means no router at all: decision calls run exactly as asked.
    ...(env.FLAGS ? { decisionRouter: decisionChallenger(flagsFor(env)) } : {}),
    log: new StoreCallLog(store, blobs),
    budget: new StoreBudget(store, spend),
    clock,
    newId: () => ulid(),
  });
  const useVectorize = env.VEC && (env.VECTOR_BACKEND ?? 'vectorize') === 'vectorize';
  return {
    store,
    gateway,
    blobs,
    kv: new CfKv(env.CACHE, retry),
    vectors: useVectorize ? new VectorizeVectors(env.VEC!) : new SqlVectors(db),
    jobs: queueFor(env),
    clock,
    newId: () => ulid(),
    ...overrides,
    spend,
  };
}

/**
 * `engineDeps` over the flagged environment (ADR-0051): Flagship values over the provider and budget vars. Both apps
 * build their deps through this, once per request, queue batch or cron run, so a flag change applies without a
 * redeploy. Without FLAGS it is `engineDeps` itself.
 */
export async function runtimeEngineDeps(
  env: MimicBindings,
  overrides: Partial<EngineDeps> = {},
): Promise<EngineDeps> {
  return engineDeps(await flaggedEnv(env), overrides);
}

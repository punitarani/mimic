import { makeProviders, type ProviderEnv } from '@mimic/adapters';
import { EMBEDDING_MODEL, type EngineDeps, Gateway, type Job, type JobQueue, ulid } from '@mimic/core';
import { CfKv, R2Blobs, SqlVectors, StoreBudget, StoreCallLog, VectorizeVectors } from './bindings';
import { retryer } from './busy';
import { d1Db } from './index';
import { DrizzleStore } from './store';

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
  /** 'vectorize' (default when VEC is bound) | 'sql' (local dev; ADR-0003). */
  VECTOR_BACKEND?: string;
  /** '1' in local dev (.dev.vars): enables dev-only behavior such as the local D1 lock retry (ADR-0014). */
  DEV_MODE?: string;
  SESSION_SECRET?: string;
  ADMIN_EMAILS?: string;
  INVITE_CODES?: string;
}

export class CfQueue implements JobQueue {
  constructor(private readonly q: Queue<Job>) {}
  async enqueue(job: Job, opts?: { delaySeconds?: number }) {
    await this.q.send(job, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
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
  enqueue(job: Job, opts?: { delaySeconds?: number }) {
    const q = this.identity && IDENTITY_JOB_TYPES.has(job.type) ? this.identity : this.main;
    return q.enqueue(job, opts);
  }
}

export function queueFor(env: MimicBindings): JobQueue {
  if (!env.JOBS) throw new Error('No job queue bound');
  return new RoutedQueue(new CfQueue(env.JOBS), env.IDENTITY_JOBS ? new CfQueue(env.IDENTITY_JOBS) : null);
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
  const gateway = new Gateway({
    ...providers,
    log: new StoreCallLog(store, blobs),
    budget: new StoreBudget(store),
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
  };
}

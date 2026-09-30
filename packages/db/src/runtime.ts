import { makeProviders, type ProviderEnv } from '@mimic/adapters';
import {
  EMBEDDING_MODEL,
  type EngineDeps,
  Gateway,
  type Job,
  type JobQueue,
  parseSpendLimits,
  ulid,
} from '@mimic/core';
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
  /** Total spend cap per mimic in USD; unset keeps each config's `session.budgetUsd` (ADR-0034). */
  BUDGET_USD?: string;
  /** Share of the cap the session may spend (0–1, default 0.8); the rest is kept for the mimic page. */
  BUDGET_SESSION_SHARE?: string;
}

export class CfQueue implements JobQueue {
  constructor(private readonly q: Queue<Job>) {}
  async enqueue(job: Job, opts?: { delaySeconds?: number }) {
    await this.q.send(job, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
  }
}

export function queueFor(env: MimicBindings): JobQueue {
  if (!env.JOBS) throw new Error('No job queue bound');
  return new CfQueue(env.JOBS);
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
  const spend = parseSpendLimits(env);
  const gateway = new Gateway({
    ...providers,
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
    spend,
    ...overrides,
  };
}

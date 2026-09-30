import { makeProviders, type ProviderEnv } from '@mimic/adapters';
import { EMBEDDING_MODEL, type EngineDeps, Gateway, type Job, type JobQueue, ulid } from '@mimic/core';
import { CfKv, R2Blobs, SqlVectors, StoreBudget, StoreCallLog, VectorizeVectors } from './bindings';
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

export function queueFor(env: MimicBindings): JobQueue {
  if (!env.JOBS) throw new Error('No job queue bound');
  return new CfQueue(env.JOBS);
}

export function engineDeps(env: MimicBindings, overrides: Partial<EngineDeps> = {}): EngineDeps {
  const store = new DrizzleStore(d1Db(env.DB));
  const blobs = new R2Blobs(env.BLOBS);
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
    kv: new CfKv(env.CACHE),
    vectors: useVectorize ? new VectorizeVectors(env.VEC!) : new SqlVectors(d1Db(env.DB)),
    jobs: queueFor(env),
    clock,
    newId: () => ulid(),
    ...overrides,
  };
}

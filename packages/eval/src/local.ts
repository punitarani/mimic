import { join } from 'node:path';
import type { Client } from '@libsql/client';
import {
  FixtureEnricher,
  FixturePeopleSearch,
  HashEmbedder,
  makeProviders,
  type Providers,
} from '@mimic/adapters';
import {
  EMBEDDING_MODEL,
  type EngineDeps,
  Gateway,
  type Job,
  MemoryQueue,
  parseSpendLimits,
  runJob,
  type SpendLimits,
  seededRng,
  ulid,
} from '@mimic/core';
import { SqlVectors, StoreBudget, StoreCallLog } from '@mimic/db';
import { FsBlobs, MemoryBlobs, MemoryKv, openLocalDb } from '@mimic/db/local';
import { FakeDecisions, FakeLlm } from './fakes';

export interface LocalEngine {
  deps: EngineDeps;
  client: Client;
  providers: Providers;
  queue: MemoryQueue;
  close: () => void;
  /** Runs queued jobs inline until the queue is empty (delays are ignored). */
  drain: (filter?: (job: Job) => boolean) => Promise<number>;
}

export interface LocalOptions {
  /** SQLite path, or ':memory:'. */
  db: string;
  /** Directory standing in for R2; omitted → in memory. */
  blobsDir?: string;
  /** 'offline' uses deterministic fakes (zero spend); 'live' uses the real providers from the environment. */
  providers: 'offline' | 'live';
  clock?: () => number;
  /** Deterministic IDs (mimic IDs seed anchor order and selection), for reproducible offline tests. */
  seed?: string;
  /** Spend limits (ADR-0035); defaults to `BUDGET_*` from the environment for live runs, and none offline. */
  spend?: SpendLimits;
  /** One timeout for every decision vendor (`makeProviders`), for evals that compare them. */
  decisionTimeoutMs?: number;
}

/** Engine deps for Node: libSQL with the D1 schema and migrations, filesystem blobs, SQL vectors, inline queue. */
export async function openLocalEngine(opts: LocalOptions): Promise<LocalEngine> {
  const { db, store, client, close } = await openLocalDb(opts.db);
  const blobs = opts.blobsDir ? new FsBlobs(opts.blobsDir) : new MemoryBlobs();
  const clock = opts.clock ?? (() => Date.now());
  const providers: Providers =
    opts.providers === 'live'
      ? makeProviders(
          { ...process.env, EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER ?? 'openrouter' },
          {
            embeddingModel: EMBEDDING_MODEL,
            ...(opts.decisionTimeoutMs ? { decisionTimeoutMs: opts.decisionTimeoutMs } : {}),
          },
        )
      : {
          decisions: new FakeDecisions(),
          llm: new FakeLlm(),
          embedder: new HashEmbedder(),
          search: new FixturePeopleSearch(),
          enricher: new FixtureEnricher(),
        };
  const spend = opts.spend ?? (opts.providers === 'live' ? parseSpendLimits(process.env).limits : {});
  const gateway = new Gateway({
    ...providers,
    log: new StoreCallLog(store, blobs),
    budget: new StoreBudget(store, spend),
    clock,
    newId: () => ulid(),
  });
  const queue = new MemoryQueue();
  const newId = opts.seed ? seededIds(opts.seed) : () => ulid();
  const deps: EngineDeps = {
    store,
    gateway,
    blobs,
    kv: new MemoryKv(),
    vectors: new SqlVectors(db),
    jobs: queue,
    clock,
    newId,
    spend,
  };
  const drain = async (filter?: (job: Job) => boolean) => {
    let n = 0;
    for (let guard = 0; guard < 1000 && queue.pending.length; guard++) {
      const jobs = queue.drain();
      for (const job of jobs) {
        if (filter && !filter(job)) continue;
        try {
          await runJob(deps, job);
        } catch (e) {
          console.warn(`[job ${job.type}] ${(e as Error).message}`);
        }
        n++;
      }
    }
    return n;
  };
  return { deps, client, providers, queue, close, drain };
}

export function defaultDataPath(name: string): string {
  return join(process.cwd(), 'data', name);
}

function seededIds(seed: string): () => string {
  const rng = seededRng(seed);
  let t = Date.UTC(2026, 0, 1);
  return () => ulid(t++, rng);
}

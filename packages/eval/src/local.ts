import { join } from 'node:path';
import { HashEmbedder, makeProviders } from '@mimic/adapters';
import { EMBEDDING_MODEL, type EngineDeps, Gateway, type Job, MemoryQueue, runJob, ulid } from '@mimic/core';
import { SqlVectors, StoreBudget, StoreCallLog } from '@mimic/db';
import { FsBlobs, MemoryBlobs, MemoryKv, openLocalDb } from '@mimic/db/local';
import { FakeDecisions, FakeLlm } from './fakes';

export interface LocalEngine {
  deps: EngineDeps;
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
}

/** Engine deps for Node: libSQL with the D1 schema and migrations, filesystem blobs, SQL vectors, inline queue. */
export async function openLocalEngine(opts: LocalOptions): Promise<LocalEngine> {
  const { db, store, close } = await openLocalDb(opts.db);
  const blobs = opts.blobsDir ? new FsBlobs(opts.blobsDir) : new MemoryBlobs();
  const clock = opts.clock ?? (() => Date.now());
  const providers =
    opts.providers === 'live'
      ? makeProviders(
          { ...process.env, EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER ?? 'openrouter' },
          {
            embeddingModel: EMBEDDING_MODEL,
          },
        )
      : { decisions: new FakeDecisions(), llm: new FakeLlm(), embedder: new HashEmbedder() };
  const gateway = new Gateway({
    ...providers,
    log: new StoreCallLog(store, blobs),
    budget: new StoreBudget(store),
    clock,
    newId: () => ulid(),
  });
  const queue = new MemoryQueue();
  const deps: EngineDeps = {
    store,
    gateway,
    blobs,
    kv: new MemoryKv(),
    vectors: new SqlVectors(db),
    jobs: queue,
    clock,
    newId: () => ulid(),
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
  return { deps, queue, close, drain };
}

export function defaultDataPath(name: string): string {
  return join(process.cwd(), 'data', name);
}

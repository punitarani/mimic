import { type Job, MemoryQueue } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import { identityJobTypes, RoutedQueue } from '../src/runtime';

const search: Job = { type: 'identity.search', mimicId: 'M' };
const enrich: Job = { type: 'identity.enrich', mimicId: 'M', candidateId: 'C' };
const refill: Job = { type: 'pool.refill', mimicId: 'M', seq: 0 };

describe('job routing (ADR-0034)', () => {
  it('puts the jobs a person waits on in their own lane', async () => {
    const main = new MemoryQueue();
    const identity = new MemoryQueue();
    const q = new RoutedQueue(main, identity, identityJobTypes({}));
    for (const j of [search, enrich, refill]) await q.enqueue(j);
    expect(identity.drain()).toEqual([search, enrich]);
    expect(main.drain()).toEqual([refill]);
  });

  it('keeps minutes-long Parallel enrichment off the fast lane', async () => {
    const main = new MemoryQueue();
    const identity = new MemoryQueue();
    const q = new RoutedQueue(main, identity, identityJobTypes({ ENRICH_PROVIDER: 'parallel' }));
    for (const j of [search, enrich]) await q.enqueue(j);
    expect(identity.drain()).toEqual([search]);
    expect(main.drain()).toEqual([enrich]);
  });

  it('sends everything to the main queue when no identity queue is bound', async () => {
    const main = new MemoryQueue();
    const q = new RoutedQueue(main, null, identityJobTypes({}));
    for (const j of [search, enrich, refill]) await q.enqueue(j, { delaySeconds: 5 });
    expect(main.pending).toEqual([search, enrich, refill].map((job) => ({ job, delaySeconds: 5 })));
  });
});

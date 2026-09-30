import { type Job, MemoryQueue } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import { isIdentityQueue, RoutedQueue, runsOnIdentityLane } from '../src/runtime';

const search: Job = { type: 'identity.search', mimicId: 'M' };
const enrich: Job = { type: 'identity.enrich', mimicId: 'M', candidateId: 'C' };
const refill: Job = { type: 'pool.refill', mimicId: 'M', seq: 0 };

describe('job routing (ADR-0034)', () => {
  it('puts the jobs a person waits on in their own lane, by type alone', async () => {
    const main = new MemoryQueue();
    const identity = new MemoryQueue();
    const q = new RoutedQueue(main, identity);
    for (const j of [search, enrich, refill]) await q.enqueue(j);
    expect(identity.drain()).toEqual([search, enrich]);
    expect(main.drain()).toEqual([refill]);
  });

  it('splits a batch by lane, keeping each delay', async () => {
    const main = new MemoryQueue();
    const identity = new MemoryQueue();
    await new RoutedQueue(main, identity).enqueueBatch([
      { job: refill, delaySeconds: 2 },
      { job: search },
      { job: refill, delaySeconds: 4 },
    ]);
    expect(identity.pending).toEqual([{ job: search }]);
    expect(main.pending).toEqual([
      { job: refill, delaySeconds: 2 },
      { job: refill, delaySeconds: 4 },
    ]);
  });

  it("lets the consumer's enrichment setting decide what the lane runs itself", () => {
    expect(runsOnIdentityLane(search, {})).toBe(true);
    expect(runsOnIdentityLane(enrich, {})).toBe(true); // Exa, the default: under a second
    expect(runsOnIdentityLane(enrich, { ENRICH_PROVIDER: 'parallel' })).toBe(false); // minutes: forwarded
    expect(runsOnIdentityLane(search, { ENRICH_PROVIDER: 'parallel' })).toBe(true);
    expect(runsOnIdentityLane(refill, {})).toBe(false);
  });

  it('recognizes the identity queue in every environment', () => {
    for (const name of ['mimic-identity', 'mimic-identity-preview', 'mimic-identity-prod']) {
      expect(isIdentityQueue(name)).toBe(true);
    }
    for (const name of ['mimic-jobs', 'mimic-jobs-prod', 'mimic-identityx'])
      expect(isIdentityQueue(name)).toBe(false);
  });

  it('sends everything to the main queue when no identity queue is bound', async () => {
    const main = new MemoryQueue();
    const q = new RoutedQueue(main, null);
    for (const j of [search, enrich, refill]) await q.enqueue(j, { delaySeconds: 5 });
    expect(main.pending).toEqual([search, enrich, refill].map((job) => ({ job, delaySeconds: 5 })));
  });
});

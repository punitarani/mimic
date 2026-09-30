import { describe, expect, it } from 'vitest';
import { type Job, jobFromKey, jobKey } from '../src';

describe('job keys', () => {
  it('round-trips every job type through its dedupe key', () => {
    const jobs: Job[] = [
      { type: 'noop', id: 'x:y' },
      { type: 'identity.search', mimicId: 'M' },
      { type: 'identity.enrich', mimicId: 'M', candidateId: 'C' },
      { type: 'pool.refill', mimicId: 'M', seq: 3 },
      { type: 'predict.shadow', mimicId: 'M', questionId: 'Q', predictorId: 'llm:openai/gpt-6-luna' },
      { type: 'learn.answer', mimicId: 'M', seq: 12 },
      { type: 'hypotheses.refresh', mimicId: 'M', seqUpTo: 20 },
      { type: 'snapshot.write', mimicId: 'M', seqUpTo: 20 },
    ];
    for (const j of jobs) expect(jobFromKey(jobKey(j))).toEqual(j);
    expect(jobFromKey('bogus:1')).toBeNull();
  });
});

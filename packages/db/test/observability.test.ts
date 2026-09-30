import { BudgetExceededError, configHash, DEFAULT_CONFIG, Gateway, type MimicRecord } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import { StoreBudget, StoreCallLog } from '../src/bindings';
import { MemoryBlobs, openLocalDb } from '../src/local';

function mimic(id: string, cfg: string): MimicRecord {
  return {
    id,
    participantId: 'p1',
    displayName: 'Test Person',
    location: 'Somewhere',
    occupation: null,
    employer: null,
    links: [],
    status: 'learning',
    identityState: 'skipped',
    configHash: cfg,
    experimentId: null,
    arm: null,
    consentApp: true,
    consentSearch: false,
    consentResearch: false,
    split: 'dev',
    seqMax: 0,
    snapshotVersion: 0,
    spendUsd: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('model call logging and budget guard on the real schema', () => {
  it('writes model_calls rows + R2 traces, charges spend and blocks at the cap', async () => {
    const { store, close } = await openLocalDb(':memory:');
    const blobs = new MemoryBlobs();
    const hash = configHash(DEFAULT_CONFIG);
    await store.putConfig({ hash, json: JSON.stringify(DEFAULT_CONFIG), label: 'default', createdAt: 1 });
    await store.insertMimic(mimic('m1', hash));
    let n = 0;
    const g = new Gateway({
      decisions: {
        provider: 'fake',
        decide: async () => ({
          modelSnapshot: 'snap',
          answers: {},
          usage: { inputTokens: 100, outputTokens: 0, costUsd: 0.3 },
          latencyMs: 3,
          raw: { authorization: 'Bearer secret' },
        }),
      },
      llm: { provider: 'x', chat: () => Promise.reject(new Error('unused')) },
      log: new StoreCallLog(store, blobs),
      budget: new StoreBudget(store),
      clock: () => 1_790_000_000_000,
      newId: () => `call${++n}`,
    });
    const req = { model: 'typesafe/jev-1.13', state: {}, questions: {} };
    await g.decide({ purpose: 'test', mimicId: 'm1', configHash: hash }, req);
    await g.decide({ purpose: 'test', mimicId: 'm1', configHash: hash }, req);
    const calls = await store.listModelCalls({ mimicId: 'm1' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ purpose: 'test', costUsd: 0.3, ok: true, configHash: hash });
    const trace = JSON.parse((await blobs.get(calls[0]!.r2TraceKey))!);
    expect(trace.response.authorization).toBe('[redacted]');
    expect((await store.getMimic('m1'))!.spendUsd).toBeCloseTo(0.6);
    // $0.60 ≥ the $0.50 cap in cfg.default.v1
    await expect(g.decide({ purpose: 'test', mimicId: 'm1' }, req)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(await store.listModelCalls({ mimicId: 'm1' })).toHaveLength(2);
    close();
  });

  it("caps at BUDGET_USD instead of the config's budget when it is set (ADR-0034)", async () => {
    const { store, close } = await openLocalDb(':memory:');
    const hash = configHash(DEFAULT_CONFIG);
    await store.putConfig({ hash, json: JSON.stringify(DEFAULT_CONFIG), label: 'default', createdAt: 1 });
    await store.insertMimic({ ...mimic('m1', hash), spendUsd: 0.6 });
    expect(await new StoreBudget(store).get('m1')).toEqual({ spendUsd: 0.6, budgetUsd: 0.5 });
    expect(await new StoreBudget(store, { budgetUsd: 0.75 }).get('m1')).toEqual({
      spendUsd: 0.6,
      budgetUsd: 0.75,
    });
    close();
  });
});

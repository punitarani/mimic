import { FLAG_KEYS, JEV_MODEL, NO_FLAGS, SPAN_MODEL } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  type FlagshipBinding,
  FlagshipFlags,
  flaggedEnv,
  flagHealth,
  flagsFor,
  inviteRequired,
} from '../src/flags';
import { engineDeps, type MimicBindings, runtimeEngineDeps } from '../src/runtime';

/**
 * A Flagship binding over a map. A missing key returns the default, as Flagship does; the details methods report a
 * reason, and FLAG_NOT_FOUND or TYPE_MISMATCH the way Flagship does.
 */
function flagship(values: Record<string, unknown>, opts: { throws?: boolean } = {}): FlagshipBinding {
  const details = <T>(key: string, fallback: T) => {
    if (opts.throws) throw new Error('flagship unavailable');
    if (!Object.hasOwn(values, key))
      return { flagKey: key, value: fallback, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' };
    const v = values[key];
    return typeof v === typeof fallback
      ? { flagKey: key, value: v as T, reason: 'DEFAULT', variant: String(v) }
      : { flagKey: key, value: fallback, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' };
  };
  return {
    get: async (key: string, fallback?: unknown) => {
      if (opts.throws) throw new Error('flagship unavailable');
      return Object.hasOwn(values, key) ? values[key] : fallback;
    },
    getStringDetails: async (key: string, fallback: string) => details(key, fallback),
    getNumberDetails: async (key: string, fallback: number) => details(key, fallback),
    getBooleanDetails: async (key: string, fallback: boolean) => details(key, fallback),
  };
}

/** Enough of the bindings for engineDeps to build (nothing here is called). */
function env(extra: Partial<MimicBindings> = {}): MimicBindings {
  const queue = { send: async () => {}, sendBatch: async () => {} };
  return {
    DB: {} as D1Database,
    BLOBS: {} as R2Bucket,
    CACHE: {} as KVNamespace,
    JOBS: queue as unknown as Queue<never>,
    OPENROUTER_API_KEY: 'k',
    EXA_API_KEY: 'k',
    SEARCH_PROVIDER: 'exa',
    ENRICH_PROVIDER: 'exa',
    EMBEDDINGS_PROVIDER: 'workers-ai',
    AI: { run: async () => ({}) },
    ...extra,
  } as MimicBindings;
}

describe('Flagship flags (ADR-0051)', () => {
  it('reads and coerces values, and returns the default when a flag is missing or Flagship throws', async () => {
    const flags = new FlagshipFlags(flagship({ on: 'on', off: 'off', bool: true, n: '2', model: 'x/y' }));
    expect(await flags.boolean('on', false)).toBe(true);
    expect(await flags.boolean('off', true)).toBe(false);
    expect(await flags.boolean('bool', false)).toBe(true);
    expect(await flags.number('n', 1)).toBe(2);
    expect(await flags.string('model', 'd')).toBe('x/y');
    expect(await flags.boolean('missing', false)).toBe(false);
    const down = new FlagshipFlags(flagship({ on: true }, { throws: true }));
    expect(await down.boolean('on', false)).toBe(false);
    expect(flagsFor({})).toBe(NO_FLAGS);
  });

  it('use-invite-code: on unless the flag says off, for the whole environment (ADR-0053)', async () => {
    expect(await inviteRequired({})).toBe(true);
    expect(await inviteRequired({ FLAGS: flagship({}) })).toBe(true);
    expect(await inviteRequired({ FLAGS: flagship({ 'use-invite-code': true }) })).toBe(true);
    expect(await inviteRequired({ FLAGS: flagship({ 'use-invite-code': false }) })).toBe(false);
    // Made in the dashboard as a string flag, it reads the same.
    expect(await inviteRequired({ FLAGS: flagship({ 'use-invite-code': 'off' }) })).toBe(false);
    expect(await inviteRequired({ FLAGS: flagship({ 'use-invite-code': 'maybe' }) })).toBe(true);
    expect(await inviteRequired({ FLAGS: flagship({ 'use-invite-code': false }, { throws: true }) })).toBe(
      true,
    );
    const seen: unknown[] = [];
    const binding = flagship({ 'use-invite-code': false });
    await inviteRequired({
      FLAGS: {
        ...binding,
        get: async (k, d, ctx) => {
          seen.push(ctx);
          return binding.get(k, d, ctx);
        },
      },
    });
    expect(seen).toEqual([{ targetingKey: 'environment' }]);
  });

  it('without FLAGS the environment and deps are exactly today’s', async () => {
    const e = env({ BUDGET_USD: '2' });
    expect(await flaggedEnv(e)).toBe(e);
    const d = await runtimeEngineDeps(e);
    expect(d.gateway.deps.decisionRouter).toBeUndefined();
    expect(d.spend).toEqual({ budgetUsd: 2 });
    expect(engineDeps(env()).gateway.deps.decisionRouter).toBeUndefined();
  });

  it('flags matching the vars change nothing', async () => {
    const e = env({
      BUDGET_USD: '1',
      BUDGET_SESSION_SHARE: 0.8,
      FLAGS: flagship({ [FLAG_KEYS.budgetUsd]: 1, [FLAG_KEYS.budgetSessionShare]: '0.8' }),
    });
    const out = await flaggedEnv(e);
    expect(out.BUDGET_USD).toBe('1');
    expect(out.BUDGET_SESSION_SHARE).toBe(0.8);
  });

  it('provider and infrastructure choices are vars, whatever the app holds (ADR-0052)', async () => {
    const e = env({
      FLAGS: flagship({
        'search-provider': 'perplexity',
        'enrich-provider': 'parallel',
        'embeddings-provider': 'openrouter',
        'vector-backend': 'sql',
      }),
    });
    const out = await flaggedEnv(e);
    for (const k of ['SEARCH_PROVIDER', 'ENRICH_PROVIDER', 'EMBEDDINGS_PROVIDER', 'VECTOR_BACKEND'] as const)
      expect(out[k]).toBe(e[k]);
  });

  it('flags override the vars when valid, and leave them when not', async () => {
    const out = await flaggedEnv(
      env({ BUDGET_SESSION_SHARE: '0.5', FLAGS: flagship({ [FLAG_KEYS.budgetUsd]: '5' }) }),
    );
    expect(out.BUDGET_USD).toBe('5');
    // No budget-session-share flag in this app: the session share stays the var.
    expect(out.BUDGET_SESSION_SHARE).toBe('0.5');
    const share = await flaggedEnv(
      env({ BUDGET_SESSION_SHARE: '0.5', FLAGS: flagship({ [FLAG_KEYS.budgetSessionShare]: 0.9 }) }),
    );
    expect(share.BUDGET_SESSION_SHARE).toBe('0.9');
    const tooMuch = await flaggedEnv(
      env({ BUDGET_SESSION_SHARE: '0.5', FLAGS: flagship({ [FLAG_KEYS.budgetSessionShare]: 1.5 }) }),
    );
    expect(tooMuch.BUDGET_SESSION_SHARE).toBe('0.5');
    const bad = await flaggedEnv(env({ BUDGET_USD: '3', FLAGS: flagship({ [FLAG_KEYS.budgetUsd]: -1 }) }));
    expect(bad.BUDGET_USD).toBe('3');
    const d = await runtimeEngineDeps(env({ FLAGS: flagship({ [FLAG_KEYS.budgetUsd]: 4 }) }));
    expect(d.spend).toEqual({ budgetUsd: 4 });
  });

  it('evaluates the environment-wide flags with one fixed targeting key', async () => {
    const seen: unknown[] = [];
    const binding = flagship({ [FLAG_KEYS.budgetUsd]: 3 });
    const spy: FlagshipBinding = {
      ...binding,
      get: async (key, fallback, ctx) => {
        seen.push(ctx);
        return binding.get(key, fallback, ctx);
      },
    };
    await flaggedEnv(env({ FLAGS: spy }));
    expect(seen.length).toBeGreaterThan(0);
    for (const ctx of seen) expect(ctx).toEqual({ targetingKey: 'environment' });
  });

  it('with FLAGS bound, the router is live and Jev serves until decisions-model says span-01', async () => {
    const req = { model: JEV_MODEL, state: {}, questions: {} };
    const ctx = { purpose: 'predict.primary', mimicId: 'm' };
    const off = await runtimeEngineDeps(env({ FLAGS: flagship({ 'decisions-model': 'jev' }) }));
    expect(await off.gateway.deps.decisionRouter!(ctx, req)).toBeNull();
    const on = await runtimeEngineDeps(env({ FLAGS: flagship({ 'decisions-model': 'span-01' }) }));
    expect(await on.gateway.deps.decisionRouter!(ctx, req)).toBe(SPAN_MODEL);
  });

  it('flagHealth reports every registry flag as the binding resolves it', async () => {
    expect(await flagHealth({})).toEqual({ bound: false, ok: true, flags: {} });
    const all = {
      'decisions-model': 'jev',
      'budget-usd': 1,
      'budget-session-share': 0.8,
      'use-invite-code': true,
    };
    const good = await flagHealth({ FLAGS: flagship(all) });
    expect(good.ok).toBe(true);
    expect(Object.keys(good.flags).sort()).toEqual(Object.values(FLAG_KEYS).sort());
    expect(good.flags['decisions-model']).toEqual({ reason: 'DEFAULT', ok: true });
    // The endpoint is public: it says whether each flag evaluates, never what it serves.
    expect(JSON.stringify(good)).not.toMatch(/"value"|"jev"/);

    const { 'budget-usd': _, ...missing } = all;
    const bad = await flagHealth({
      FLAGS: flagship({ ...missing, 'decisions-model': 'not a model', 'budget-session-share': '1.5' }),
    });
    expect(bad.ok).toBe(false);
    expect(bad.flags['budget-usd']).toMatchObject({ errorCode: 'FLAG_NOT_FOUND', ok: false });
    expect(bad.flags['decisions-model']).toMatchObject({ ok: false });
    expect(bad.flags['budget-session-share']).toMatchObject({ errorCode: 'TYPE_MISMATCH', ok: false });
    expect((await flagHealth({ FLAGS: flagship(all, { throws: true }) })).ok).toBe(false);

    // A number flag made as a string in the dashboard: the runtime reads it (coerced), so health agrees.
    const asString = await flagHealth({ FLAGS: flagship({ ...all, 'budget-usd': '1' }) });
    expect(asString.flags['budget-usd']).toEqual({
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH',
      ok: true,
    });
    expect(asString.ok).toBe(true);
    expect(await new FlagshipFlags(flagship({ 'budget-usd': '1' })).number('budget-usd', 5)).toBe(1);
  });
});

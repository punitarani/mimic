import { FLAG_KEYS, JEV_MODEL, NO_FLAGS, SPAN_MODEL } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import { type FlagshipBinding, FlagshipFlags, flaggedEnv, flagsFor, providerValue } from '../src/flags';
import { engineDeps, type MimicBindings, runtimeEngineDeps } from '../src/runtime';

/** A Flagship binding over a map: a missing key returns the default, as Flagship does. */
function flagship(values: Record<string, unknown>, opts: { throws?: boolean } = {}): FlagshipBinding {
  return {
    get: async (key: string, fallback?: unknown) => {
      if (opts.throws) throw new Error('flagship unavailable');
      return Object.hasOwn(values, key) ? values[key] : fallback;
    },
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

describe('Flagship flags (ADR-0050)', () => {
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

  it('accepts dashboard labels for providers', () => {
    const embed = ['workers-ai', 'openrouter'];
    expect(providerValue('OpenRouter', embed)).toBe('openrouter');
    expect(providerValue('Cloudflare-Workers-AI', embed)).toBe('workers-ai');
    expect(providerValue('Workers AI', embed)).toBe('workers-ai');
    expect(providerValue('Exa', ['exa', 'none'])).toBe('exa');
    expect(providerValue('Off', ['exa', 'none'])).toBe('none');
    expect(providerValue('Cloudflare-Vectorize', embed)).toBeNull();
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
      FLAGS: flagship({
        [FLAG_KEYS.searchProvider]: 'Exa',
        [FLAG_KEYS.enrichProvider]: 'exa',
        [FLAG_KEYS.embeddingsProvider]: 'Workers-AI',
        [FLAG_KEYS.budgetUsd]: 1,
        [FLAG_KEYS.budgetSessionShare]: 0.8,
      }),
    });
    const out = await flaggedEnv(e);
    for (const k of ['SEARCH_PROVIDER', 'ENRICH_PROVIDER', 'EMBEDDINGS_PROVIDER', 'BUDGET_USD'] as const)
      expect(out[k]).toBe(e[k]);
    expect(out.BUDGET_SESSION_SHARE).toBeUndefined();
  });

  it('flags override the vars when valid, and leave them when not', async () => {
    const out = await flaggedEnv(
      env({
        FLAGS: flagship({
          [FLAG_KEYS.embeddingsProvider]: 'OpenRouter',
          [FLAG_KEYS.searchProvider]: 'Perplexity', // no PERPLEXITY_API_KEY deployed
          [FLAG_KEYS.enrichProvider]: 'Carrier pigeon',
          [FLAG_KEYS.budgetUsd]: '5',
          [FLAG_KEYS.budgetSessionShare]: 1.5,
        }),
      }),
    );
    expect(out.EMBEDDINGS_PROVIDER).toBe('openrouter');
    expect(out.SEARCH_PROVIDER).toBe('exa');
    expect(out.ENRICH_PROVIDER).toBe('exa');
    expect(out.BUDGET_USD).toBe('5');
    expect(out.BUDGET_SESSION_SHARE).toBeUndefined();
    const d = await runtimeEngineDeps(env({ FLAGS: flagship({ [FLAG_KEYS.budgetUsd]: 4 }) }));
    expect(d.spend).toEqual({ budgetUsd: 4 });
  });

  it('with FLAGS bound, the router is live and Jev serves until decisions-model says span-01', async () => {
    const req = { model: JEV_MODEL, state: {}, questions: {} };
    const ctx = { purpose: 'predict.primary', mimicId: 'm' };
    const off = await runtimeEngineDeps(env({ FLAGS: flagship({ 'decisions-model': 'jev' }) }));
    expect(await off.gateway.deps.decisionRouter!(ctx, req)).toBeNull();
    const on = await runtimeEngineDeps(env({ FLAGS: flagship({ 'decisions-model': 'span-01' }) }));
    expect(await on.gateway.deps.decisionRouter!(ctx, req)).toBe(SPAN_MODEL);
  });
});

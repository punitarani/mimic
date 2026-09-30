// Runtime settings (plain Worker vars, not secrets) and the provider keys they imply.
//
// Defaults are the `vars` in each env of wrangler.jsonc. A value set in the deploy environment (a GitHub secret
// synced from Doppler) overrides the default and is written into the generated deploy config, so switching a
// provider needs no code change. Only production-grade choices are allowed: fixtures and the hash embedder are
// for tests.
import { envBlock } from './lib.mjs';

/** A check for a numeric setting: returns what is wrong with the value, or null. */
const number = (describe, ok) => (value) => {
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) && ok(n) ? null : `must be ${describe}`;
};

/** Each setting's allowed values, or a check returning what is wrong with a value. */
export const SETTINGS = {
  VECTOR_BACKEND: ['vectorize', 'sql'],
  EMBEDDINGS_PROVIDER: ['workers-ai', 'openrouter'],
  SEARCH_PROVIDER: ['exa', 'perplexity', 'none'],
  ENRICH_PROVIDER: ['exa', 'parallel', 'none'],
  // Spend caps (ADR-0035): the total per mimic in USD, and the share of it the learning session may spend. Defaults
  // live in code; the ranges match `parseSpendLimits` in packages/core/src/config.ts (a test keeps them in step).
  BUDGET_USD: number('a number of US dollars above 0', (n) => n > 0),
  BUDGET_SESSION_SHARE: number('a number above 0 and at most 1', (n) => n > 0 && n <= 1),
};

function settingProblem(allowed, value) {
  if (typeof allowed === 'function') return allowed(value);
  return allowed.includes(value) ? null : `must be one of ${allowed.join(', ')}`;
}

/** The key each provider choice needs (packages/adapters/src/factory.ts). */
const PROVIDER_KEYS = {
  SEARCH_PROVIDER: { exa: 'EXA_API_KEY', perplexity: 'PERPLEXITY_API_KEY' },
  ENRICH_PROVIDER: { exa: 'EXA_API_KEY', parallel: 'PARALLEL_API_KEY' },
};

/**
 * This environment's settings: the config's vars, overridden by any non-empty value in `source`. Returns the vars
 * and a problem per value outside SETTINGS (named, never printed).
 */
export function resolveSettings(config, env, source) {
  const vars = { ...(envBlock(config, env).vars ?? {}) };
  const problems = [];
  for (const [name, allowed] of Object.entries(SETTINGS)) {
    const value = source[name]?.trim();
    if (value) vars[name] = value;
    const problem = vars[name] === undefined ? null : settingProblem(allowed, String(vars[name]));
    if (problem) problems.push(`${name} ${problem}`);
  }
  return { vars, problems };
}

/** The secrets the chosen providers need, beyond each Worker's `secrets.required`. */
export function providerSecrets(vars) {
  return Object.entries(PROVIDER_KEYS)
    .map(([name, keys]) => keys[vars[name]])
    .filter(Boolean);
}

/**
 * Every provider key that is set in `source`, chosen or not. They are pushed with the worker as well, so a provider
 * flag (ADR-0050) can switch to any provider whose key exists without a redeploy; they are never required.
 */
export function presentProviderSecrets(source) {
  const keys = new Set(Object.values(PROVIDER_KEYS).flatMap((k) => Object.values(k)));
  return [...keys].filter((k) => source[k]?.trim());
}

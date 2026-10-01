// Deploy-time settings (plain Worker vars, not secrets) and the provider keys they imply.
//
// Each environment's settings are the `vars` in its block of wrangler.jsonc, checked in. A value set in the deploy
// environment (a GitHub secret synced from Doppler) overrides one and is written into the generated deploy config;
// an override equal to the checked-in value is redundant, and preflight says so. Only production-grade choices are
// allowed: fixtures and the hash embedder are for tests.
//
// Runtime levers are Flagship flags instead (ADR-0052): the decision model and the spend caps change without a
// deploy. Provider choices stay here because each needs its key deployed with it, and the vector backend is
// infrastructure.
import { envBlock } from './lib.mjs';

/** Each setting's allowed values. */
export const SETTINGS = {
  VECTOR_BACKEND: ['vectorize', 'sql'],
  EMBEDDINGS_PROVIDER: ['workers-ai', 'openrouter'],
  SEARCH_PROVIDER: ['exa', 'perplexity', 'none'],
  ENRICH_PROVIDER: ['exa', 'parallel', 'none'],
};

/**
 * Names a deploy no longer reads, and where each value lives now. Set in the deploy environment, they are ignored,
 * and preflight says so.
 */
export const RETIRED = {
  BUDGET_USD: 'the budget-usd flag (ADR-0052)',
  BUDGET_SESSION_SHARE: 'the budget-session-share flag (ADR-0052)',
};

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
    if (vars[name] !== undefined && !allowed.includes(String(vars[name])))
      problems.push(`${name} must be one of ${allowed.join(', ')}`);
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
 * Deploy-environment values worth deleting (names only, never values): overrides equal to the checked-in setting, and
 * retired names. An override goes to every Worker (`resolveSettings`), so it is redundant only when each config that
 * sets the name sets it to the same value: deleting it must change neither Worker.
 */
export function redundantSettings(configs, env, source) {
  const blocks = configs.map((c) => envBlock(c, env).vars ?? {});
  const out = [];
  for (const name of Object.keys(SETTINGS)) {
    const value = source[name]?.trim();
    const set = blocks.filter((v) => v[name] !== undefined);
    if (value && set.length && set.every((v) => String(v[name]) === value))
      out.push(`${name} equals its value in wrangler.jsonc; delete it from Doppler`);
  }
  for (const [name, home] of Object.entries(RETIRED))
    if (source[name]?.trim())
      out.push(`${name} is no longer read (it lives in ${home}); delete it from Doppler`);
  return out;
}

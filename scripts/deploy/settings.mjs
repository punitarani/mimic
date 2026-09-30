// Runtime settings (plain Worker vars, not secrets) and the provider keys they imply.
//
// Defaults are the `vars` in each env of wrangler.jsonc. A value set in the deploy environment (a GitHub secret
// synced from Doppler) overrides the default and is written into the generated deploy config, so switching a
// provider needs no code change. Only production-grade choices are allowed: fixtures and the hash embedder are
// for tests.
import { envBlock } from './lib.mjs';

export const SETTINGS = {
  VECTOR_BACKEND: ['vectorize', 'sql'],
  EMBEDDINGS_PROVIDER: ['workers-ai', 'openrouter'],
  SEARCH_PROVIDER: ['exa', 'perplexity', 'none'],
  ENRICH_PROVIDER: ['exa', 'parallel', 'none'],
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
    if (vars[name] !== undefined && !allowed.includes(vars[name])) {
      problems.push(`${name} must be one of ${allowed.join(', ')}`);
    }
  }
  return { vars, problems };
}

/** The secrets the chosen providers need, beyond each Worker's `secrets.required`. */
export function providerSecrets(vars) {
  const keys = Object.entries(PROVIDER_KEYS)
    .map(([name, byChoice]) => byChoice[vars[name]])
    .filter(Boolean);
  return [...new Set(keys)]; // Exa search and Exa enrichment share one key
}

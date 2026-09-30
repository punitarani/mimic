// Cloudflare Flagship: one app per environment holding the runtime flags and tunables (ADR-0050): `mimic` for prod
// (created in the dashboard), `mimic-<env>` for any other environment.
//
// Each deploy finds or creates the app and creates any flag it lacks, at its default. It never updates an existing
// flag: after creation Flagship is the source of truth, so a toggle or a rollout set in the dashboard survives every
// deploy. The keys and defaults match packages/core/src/flags.ts and challenger.ts (a test keeps them in step).
//
// Flagship is optional. When the token can't use it, the deploy says so and ships without the FLAGS binding; every
// flag then reads its default in code, which is the behaviour from before the flags existed.
import { CloudflareError } from './lib.mjs';

/** The Flagship app of an environment. */
export const flagsAppName = (env) => (env === 'prod' ? 'mimic' : `mimic-${env}`);

const CHALLENGER_PURPOSES =
  'predict.primary,predict.baseline,select.bald,playground.predict,playground.baseline';

/**
 * The flags each environment gets, as Flagship create bodies. `vars` are the environment's resolved settings
 * (settings.mjs): the provider and budget flags start at the values those settings have, so creating them changes
 * nothing. Variation names are the values themselves. VECTOR_BACKEND stays a var: it picks where vectors live.
 */
export function flagCatalog(vars = {}) {
  const number = (name, fallback) => {
    const n = Number(String(vars[name] ?? '').trim() || Number.NaN);
    return Number.isFinite(n) ? n : fallback;
  };
  const choice = (key, name, fallback, description) => {
    const value = String(vars[name] ?? fallback);
    return {
      key,
      description,
      enabled: true,
      default_variation: value,
      variations: { [value]: value },
      rules: [],
    };
  };
  return [
    {
      key: 'decisions-model',
      description:
        'The model Jev decision calls for served predictions run on (ADR-0050): jev, or span-01 (pinned in code). Roll out by percentage on targetingKey (the mimic ID).',
      enabled: true,
      default_variation: 'jev',
      variations: { jev: 'jev', 'span-01': 'span-01' },
      rules: [],
    },
    {
      key: 'decisions-model-purposes',
      description:
        'Comma-separated call purposes a model other than Jev may serve. Gates, trait reads and identity stay on Jev by default.',
      enabled: true,
      default_variation: 'served',
      variations: { served: CHALLENGER_PURPOSES },
      rules: [],
    },
    {
      key: 'budget-usd',
      description: 'Spend cap per mimic in USD on the standard budget (ADR-0035). Over the BUDGET_USD var.',
      enabled: true,
      default_variation: 'standard',
      variations: { standard: number('BUDGET_USD', 1) },
      rules: [],
    },
    {
      key: 'budget-session-share',
      description:
        'Share of the cap the session may spend, above 0 and at most 1. Over BUDGET_SESSION_SHARE.',
      enabled: true,
      default_variation: 'standard',
      variations: { standard: number('BUDGET_SESSION_SHARE', 0.8) },
      rules: [],
    },
    choice(
      'search-provider',
      'SEARCH_PROVIDER',
      'exa',
      'People search: exa, perplexity or none. Over SEARCH_PROVIDER.',
    ),
    choice(
      'enrich-provider',
      'ENRICH_PROVIDER',
      'exa',
      'Enrichment: exa, parallel or none. Over ENRICH_PROVIDER.',
    ),
    choice(
      'embeddings-provider',
      'EMBEDDINGS_PROVIDER',
      'workers-ai',
      'Embeddings: workers-ai or openrouter (the same bge-base model). Over EMBEDDINGS_PROVIDER.',
    ),
  ];
}

const denied = (e) => e instanceof CloudflareError && (e.status === 401 || e.status === 403);

/**
 * Finds or creates the environment's Flagship app and its missing flags. Returns the app ID, or null when the token
 * can't use Flagship (the deploy then drops the binding). Any other failure is thrown: a half-made app is worth a
 * failed deploy rather than silent defaults.
 */
export async function ensureFlags(cf, env, vars = {}, log = console.log) {
  const name = flagsAppName(env);
  let apps;
  try {
    apps = (await cf.get('/flagship/apps')) ?? [];
  } catch (e) {
    if (!denied(e)) throw e;
    log(
      `  Flagship ${name}: skipped, the token can't use Flagship (add Account · Flagship · Edit); every flag reads its default`,
    );
    return null;
  }
  let app = apps.find((a) => a.name === name);
  const created = !app;
  if (!app) app = await cf.post('/flagship/apps', { name });
  log(`  Flagship ${name}: ${created ? 'created' : 'exists'}`);
  if (!app?.id) throw new Error(`Cloudflare returned no id for the Flagship app ${name}`);

  // One page (the maximum, 200) covers an app of a handful of flags; a flag it missed answers 409 below.
  const listed = (await cf.get(`/flagship/apps/${app.id}/flags?limit=200`)) ?? [];
  const have = new Set((Array.isArray(listed) ? listed : []).map((f) => f.key));
  for (const flag of flagCatalog(vars)) {
    if (have.has(flag.key)) {
      log(`  Flag ${flag.key}: exists (left as set)`);
      continue;
    }
    try {
      await cf.post(`/flagship/apps/${app.id}/flags`, flag);
      log(`  Flag ${flag.key}: created at its default`);
    } catch (e) {
      // Created by a concurrent deploy between the list and the create.
      if (!(e instanceof CloudflareError && e.status === 409)) throw e;
      log(`  Flag ${flag.key}: exists (left as set)`);
    }
  }
  return app.id;
}

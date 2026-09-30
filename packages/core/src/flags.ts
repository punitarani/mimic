import { DECISION_MODELS, DEFAULT_BUDGET_USD } from './config';

/**
 * Runtime feature flags and tunables (ADR-0050). The host evaluates them (Cloudflare Flagship in deployed envs,
 * `packages/db/src/flags.ts`); core sees only this interface, so it never imports Cloudflare. Every read names its
 * default, and a read that fails returns it: a missing flag, an unbound flag service or an outage all mean the
 * behaviour the code had before the flag existed.
 */
export type FlagContext = Record<string, string | number | boolean>;

export interface FlagReader {
  boolean(key: string, fallback: boolean, ctx?: FlagContext): Promise<boolean>;
  string(key: string, fallback: string, ctx?: FlagContext): Promise<string>;
  number(key: string, fallback: number, ctx?: FlagContext): Promise<number>;
}

const TRUE = new Set(['on', 'true', 'yes', 'enabled', '1']);
const FALSE = new Set(['off', 'false', 'no', 'disabled', '0']);

/**
 * A flag value read as the type the code wants. A boolean may be a boolean flag or a string one with "on"/"off"
 * variations, and a number a number or a numeric string; anything else is the default.
 */
export function coerceFlag<T extends string | number | boolean>(value: unknown, fallback: T): T {
  if (typeof value === typeof fallback) return value as T;
  if (typeof fallback === 'boolean') {
    const s = String(value).trim().toLowerCase();
    if ((typeof value === 'string' || typeof value === 'number') && TRUE.has(s)) return true as T;
    if ((typeof value === 'string' || typeof value === 'number') && FALSE.has(s)) return false as T;
    return fallback;
  }
  if (typeof fallback === 'number' && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return (Number.isFinite(n) ? n : fallback) as T;
  }
  if (typeof fallback === 'string' && (typeof value === 'number' || typeof value === 'boolean'))
    return String(value) as T;
  return fallback;
}

/** No flag service: every read returns its default. */
export const NO_FLAGS: FlagReader = {
  boolean: async (_k, fallback) => fallback,
  string: async (_k, fallback) => fallback,
  number: async (_k, fallback) => fallback,
};

type FlagValue = string | number | boolean;

/**
 * Flags from a fixed map, for tests and local overrides. A value may be a function of the evaluation context, to
 * stand in for targeting rules and percentage rollouts. Values are coerced like Flagship's (`coerceFlag`), and a
 * missing key returns the default.
 */
export class StaticFlags implements FlagReader {
  constructor(private readonly values: Record<string, FlagValue | ((ctx: FlagContext) => FlagValue)>) {}

  private read<T extends FlagValue>(key: string, fallback: T, ctx: FlagContext = {}): T {
    if (!Object.hasOwn(this.values, key)) return fallback;
    const v = this.values[key]!;
    return coerceFlag(typeof v === 'function' ? v(ctx) : v, fallback);
  }
  async boolean(key: string, fallback: boolean, ctx?: FlagContext) {
    return this.read(key, fallback, ctx);
  }
  async string(key: string, fallback: string, ctx?: FlagContext) {
    return this.read(key, fallback, ctx);
  }
  async number(key: string, fallback: number, ctx?: FlagContext) {
    return this.read(key, fallback, ctx);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The registry: every flag the code reads, defined once
// ---------------------------------------------------------------------------------------------------------------

/** The Worker vars a flag overrides (`flaggedEnv`); the var stays the fallback. */
export type FlaggedSetting = 'SEARCH_PROVIDER' | 'ENRICH_PROVIDER' | 'EMBEDDINGS_PROVIDER' | 'BUDGET_USD';

export interface FlagSpec {
  key: string;
  kind: 'string' | 'number';
  description: string;
  /**
   * What a read returns when the flag is missing or can't be read, which is the behaviour from before the flag. For
   * a flag over a setting, the setting's current value takes this place.
   */
  fallback: string | number;
  setting?: FlaggedSetting;
  /** The value the code uses for a raw flag value, or null when it can't use it (the read then falls back). */
  parse(raw: unknown): string | number | null;
  /** Variations a new flag is created with (`flags:check --create-missing`): name → value. */
  variations: Record<string, string | number>;
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/**
 * The model a `decisions-model` value names: a variant of DECISION_MODELS (case and spacing ignored, so a label such
 * as "Span-01" works), or an OpenRouter Decisions model ID. Null for anything else, which leaves Jev in place.
 */
export function decisionModelOf(value: string): string | null {
  const v = value.trim();
  const key = v.toLowerCase().replace(/[\s_]+/g, '-');
  if (Object.hasOwn(DECISION_MODELS, key)) return DECISION_MODELS[key]!;
  return MODEL_ID.test(v) ? v : null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^cloudflare/, '');

/**
 * A provider flag's value as the var spells it, accepting a dashboard label ("Exa", "Cloudflare-Workers-AI",
 * "OpenRouter") as well as the value itself; "off" means none. Null when it names no allowed provider.
 */
export function providerValue(value: string, allowed: readonly string[]): string | null {
  const n = norm(value);
  if (!n) return null;
  if ((n === 'off' || n === 'disabled') && allowed.includes('none')) return 'none';
  return allowed.find((v) => norm(v) === n) ?? null;
}

function provider(
  key: string,
  setting: FlaggedSetting,
  values: readonly string[],
  fallback: string,
  description: string,
): FlagSpec {
  return {
    key,
    kind: 'string',
    description,
    fallback,
    setting,
    parse: (raw) => (typeof raw === 'string' ? providerValue(raw, values) : null),
    variations: Object.fromEntries(values.map((v) => [v, v])),
  };
}

/** Every flag the code reads, keyed for use in code. `pnpm flags:check` holds the live Flagship app to this. */
export const FLAG_SPECS = {
  decisionsModel: {
    key: 'decisions-model',
    kind: 'string',
    description:
      'The model Jev decision calls for served predictions run on: jev (the default: unchanged), span-01, or an OpenRouter Decisions model ID (ADR-0050).',
    fallback: 'jev',
    parse: (raw) => (typeof raw === 'string' && decisionModelOf(raw) ? raw : null),
    variations: Object.fromEntries(Object.keys(DECISION_MODELS).map((v) => [v, v])),
  },
  budgetUsd: {
    key: 'budget-usd',
    kind: 'number',
    description: 'Spend cap per mimic in USD on the standard budget (ADR-0035). Over the BUDGET_USD var.',
    fallback: DEFAULT_BUDGET_USD,
    setting: 'BUDGET_USD',
    parse: (raw) => {
      const n =
        typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    variations: { standard: DEFAULT_BUDGET_USD },
  },
  searchProvider: provider(
    'search-provider',
    'SEARCH_PROVIDER',
    ['exa', 'perplexity', 'none'],
    'exa',
    'People search provider. Over the SEARCH_PROVIDER var.',
  ),
  enrichProvider: provider(
    'enrich-provider',
    'ENRICH_PROVIDER',
    ['exa', 'parallel', 'none'],
    'exa',
    'Enrichment provider. Over the ENRICH_PROVIDER var.',
  ),
  embeddingsProvider: provider(
    'embeddings-provider',
    'EMBEDDINGS_PROVIDER',
    ['workers-ai', 'openrouter'],
    'workers-ai',
    'Embeddings provider (the same bge-base model either way). Over the EMBEDDINGS_PROVIDER var.',
  ),
} as const satisfies Record<string, FlagSpec>;

/** Every flag in the registry, as plain specs. */
export const ALL_FLAGS: readonly FlagSpec[] = Object.values(FLAG_SPECS);

export const FLAG_KEYS = Object.fromEntries(
  Object.entries(FLAG_SPECS).map(([name, spec]) => [name, spec.key]),
) as { [K in keyof typeof FLAG_SPECS]: (typeof FLAG_SPECS)[K]['key'] };

// ---------------------------------------------------------------------------------------------------------------
// Checking a live app against the registry (`pnpm flags:check`)
// ---------------------------------------------------------------------------------------------------------------

/** A flag as the Flagship REST API lists it. */
export interface LiveFlag {
  key: string;
  enabled: boolean;
  default_variation: string;
  variations: Record<string, unknown>;
  rules?: Array<{ serve_variation?: string }>;
}

export interface FlagCheck {
  /** The app can't serve the code: a missing flag, or a value the code can't use. */
  problems: string[];
  /** Worth a look: a flag nothing reads, or a flag that overrides its setting. */
  warnings: string[];
}

const show = (v: unknown) => JSON.stringify(v);

/**
 * The live flags against the registry. Every variation must parse (a rule or a rollout can serve any of them), and
 * the default and every rule must name one that exists. `settings` are the environment's vars, so a flag that would
 * change a setting is called out.
 */
export function checkFlags(
  live: readonly LiveFlag[],
  settings: Partial<Record<FlaggedSetting, string>> = {},
  specs: readonly FlagSpec[] = ALL_FLAGS,
): FlagCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map(live.map((f) => [f.key, f]));
  for (const spec of specs) {
    const f = byKey.get(spec.key);
    if (!f) {
      problems.push(
        `${spec.key}: missing (create it as a ${spec.kind} flag with variations ${show(spec.variations)}; until then every read uses ${show(spec.fallback)}${spec.setting ? ` or ${spec.setting}` : ''})`,
      );
      continue;
    }
    for (const [name, value] of Object.entries(f.variations)) {
      if (spec.parse(value) === null)
        problems.push(`${spec.key}: variation "${name}" = ${show(value)} is not a value the code accepts`);
    }
    if (!Object.hasOwn(f.variations, f.default_variation))
      problems.push(`${spec.key}: default variation "${f.default_variation}" does not exist`);
    for (const r of f.rules ?? [])
      if (r.serve_variation !== undefined && !Object.hasOwn(f.variations, r.serve_variation))
        problems.push(`${spec.key}: a rule serves "${r.serve_variation}", which does not exist`);
    const served = spec.parse(f.variations[f.default_variation]);
    if (spec.setting && served !== null && settings[spec.setting] !== undefined) {
      const current = spec.parse(settings[spec.setting]);
      if (current !== null && current !== served)
        warnings.push(`${spec.key}: serves ${show(served)} over ${spec.setting}=${show(current)}`);
    }
    if (!f.enabled) warnings.push(`${spec.key}: disabled, so it always serves its default variation`);
    if (f.rules?.length) warnings.push(`${spec.key}: ${f.rules.length} targeting rule(s) active`);
  }
  const known = new Set(specs.map((s) => s.key));
  for (const f of live) if (!known.has(f.key)) warnings.push(`${f.key}: in the app, but no code reads it`);
  return { problems, warnings };
}

/** The Flagship create body for a missing flag, at its fallback (or the setting's value when it has one). */
export function flagCreateBody(spec: FlagSpec, settingValue?: string): LiveFlag & { description: string } {
  const seeded = settingValue !== undefined ? spec.parse(settingValue) : null;
  const value = seeded ?? spec.fallback;
  const variations: Record<string, string | number> = { ...spec.variations };
  let def = Object.entries(variations).find(([, v]) => v === value)?.[0];
  if (!def) {
    def = String(value);
    variations[def] = value;
  }
  return {
    key: spec.key,
    description: spec.description,
    enabled: true,
    default_variation: def,
    variations,
    rules: [],
  };
}

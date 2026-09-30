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

/**
 * Every flag the code reads, in the Flagship app `mimic` (prod; `mimic-preview` for preview). `scripts/deploy/flags.mjs`
 * creates any that are missing (a test keeps the two in step). `vector-backend` is deliberately not read: it picks
 * where vectors are stored, which is infrastructure, so it stays the VECTOR_BACKEND var.
 */
export const FLAG_KEYS = {
  /**
   * The model incumbent Jev decision calls run on (ADR-0050): `jev` (the default: unchanged), `span-01`, or an
   * OpenRouter Decisions model ID. A string flag, so a percentage rollout splits people between variants.
   */
  decisionsModel: 'decisions-model',
  /** Comma-separated call purposes a model other than Jev may serve. */
  decisionsModelPurposes: 'decisions-model-purposes',
  /** Spend cap per mimic in USD (over the BUDGET_USD var; ADR-0035). */
  budgetUsd: 'budget-usd',
  /** Share of the cap the session may spend (over BUDGET_SESSION_SHARE). */
  budgetSessionShare: 'budget-session-share',
  /** People search provider (over SEARCH_PROVIDER). */
  searchProvider: 'search-provider',
  /** Enrichment provider (over ENRICH_PROVIDER). */
  enrichProvider: 'enrich-provider',
  /** Embeddings provider (over EMBEDDINGS_PROVIDER). */
  embeddingsProvider: 'embeddings-provider',
} as const;

const TRUE = new Set(['on', 'true', 'yes', 'enabled', '1']);
const FALSE = new Set(['off', 'false', 'no', 'disabled', '0']);

/**
 * A flag value read as the type the code wants. A flag may be created as a boolean or as a string with "on"/"off"
 * variations, and a number as a number or a numeric string; anything else is the default.
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
 * Flags from a fixed map, for tests, the eval CLI and local overrides. A value may be a function of the evaluation
 * context, to stand in for targeting rules and percentage rollouts. Values are coerced like Flagship's (`coerceFlag`),
 * and a missing key returns the default.
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

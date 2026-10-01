import { DECISION_MODELS, DEFAULT_BUDGET_USD, DEFAULT_SESSION_SHARE, SpendEnv } from './config';

/**
 * Runtime feature flags and tunables (ADR-0051, ADR-0052). The host evaluates them (Cloudflare Flagship in deployed
 * envs, `packages/db/src/flags.ts`); core sees only this interface, so it never imports Cloudflare. Every read names
 * its default, and a read that fails returns it: a missing flag, an unbound flag service or an outage all mean the
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

/** The Worker vars a flag overrides (`flaggedEnv`); the var, where one is set (local dev), stays the fallback. */
export type FlaggedSetting = 'BUDGET_USD' | 'BUDGET_SESSION_SHARE';

export interface FlagSpec {
  key: string;
  kind: 'string' | 'number';
  description: string;
  /**
   * What a read returns when the flag is missing or can't be read, which is the behaviour from before the flag. For
   * a flag over a setting, the setting's value takes this place where one is set.
   */
  fallback: string | number;
  setting?: FlaggedSetting;
  /** The value the code uses for a raw flag value, or null when it can't use it (the read then falls back). */
  parse(raw: unknown): string | number | null;
  /** Variations a new flag is created with (`flags:check --create-missing`): name → value. */
  variations: Record<string, string | number>;
}

/**
 * The model a `decisions-model` value names: a variant of DECISION_MODELS (case and spacing ignored, so a label such
 * as "Span-01" works), or one of the pinned model IDs they map to. Null for anything else, which leaves Jev in place:
 * a model is served only once it is registered, pinned and reviewed in code, never from a dashboard edit alone.
 */
export function decisionModelOf(value: string): string | null {
  const v = value.trim();
  const key = v.toLowerCase().replace(/[\s_]+/g, '-');
  if (Object.hasOwn(DECISION_MODELS, key)) return DECISION_MODELS[key]!;
  return Object.values(DECISION_MODELS).includes(v) ? v : null;
}

/** A spend-limit flag's value: a number, or a numeric string, in the range its var takes (`SpendEnv`). */
function spendValue(k: keyof typeof SpendEnv.shape) {
  return (raw: unknown): number | null => {
    const n =
      typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && SpendEnv.shape[k].safeParse(n).success ? n : null;
  };
}

/**
 * Every flag the code reads, keyed for use in code. `pnpm flags:check` holds the live Flagship app to this.
 *
 * A flag is for a runtime lever (ADR-0052): something worth changing without a deploy (a rollout, a kill switch, a
 * spend cap), safe at its default, and needing nothing deployed beyond what every value already has. Provider
 * choices need their key deployed, and infrastructure is fixed per environment, so those stay Worker vars in
 * wrangler.jsonc; secrets stay secrets.
 */
export const FLAG_SPECS = {
  decisionsModel: {
    key: 'decisions-model',
    kind: 'string',
    description:
      'The model Jev decision calls for served predictions run on: jev (the default: unchanged) or span-01, each pinned in code (ADR-0051).',
    fallback: 'jev',
    parse: (raw) => (typeof raw === 'string' && decisionModelOf(raw) ? raw : null),
    variations: Object.fromEntries(Object.keys(DECISION_MODELS).map((v) => [v, v])),
  },
  budgetUsd: {
    key: 'budget-usd',
    kind: 'number',
    description: 'Spend cap per mimic in USD on the standard budget (ADR-0035).',
    fallback: DEFAULT_BUDGET_USD,
    setting: 'BUDGET_USD',
    parse: spendValue('BUDGET_USD'),
    variations: { standard: DEFAULT_BUDGET_USD },
  },
  budgetSessionShare: {
    key: 'budget-session-share',
    kind: 'number',
    description:
      'Share of the cap the learning session may spend, above 0 and at most 1; the rest is kept for the mimic page (ADR-0035).',
    fallback: DEFAULT_SESSION_SHARE,
    setting: 'BUDGET_SESSION_SHARE',
    parse: spendValue('BUDGET_SESSION_SHARE'),
    variations: { standard: DEFAULT_SESSION_SHARE },
  },
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
  /** Worth a look: a flag nothing reads, a disabled flag, or active targeting rules. */
  warnings: string[];
}

const show = (v: unknown) => JSON.stringify(v);

/**
 * The live flags against the registry. Every variation must parse (a rule or a rollout can serve any of them), and
 * the default and every rule must name one that exists. A flag is the source of truth for its value wherever
 * Flagship is bound (ADR-0052), so what it serves is not compared with anything else.
 */
export function checkFlags(live: readonly LiveFlag[], specs: readonly FlagSpec[] = ALL_FLAGS): FlagCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map(live.map((f) => [f.key, f]));
  for (const spec of specs) {
    const f = byKey.get(spec.key);
    if (!f) {
      problems.push(
        `${spec.key}: missing (create it as a ${spec.kind} flag with variations ${show(spec.variations)}; until then every read uses ${show(spec.fallback)})`,
      );
      continue;
    }
    // A variation the code can't use is a problem when it is served (the default, or a rule's), and a warning
    // otherwise: nothing serves it yet, but switching to it would fall back to the default.
    const served = new Set([f.default_variation, ...(f.rules ?? []).flatMap((r) => r.serve_variation ?? [])]);
    for (const [name, value] of Object.entries(f.variations)) {
      if (spec.parse(value) !== null) continue;
      const what = `${spec.key}: variation "${name}" = ${show(value)} is not a value the code accepts`;
      if (served.has(name)) problems.push(what);
      else warnings.push(`${what}; serving it would fall back to ${show(spec.fallback)}`);
    }
    if (!Object.hasOwn(f.variations, f.default_variation))
      problems.push(`${spec.key}: default variation "${f.default_variation}" does not exist`);
    for (const r of f.rules ?? [])
      if (r.serve_variation !== undefined && !Object.hasOwn(f.variations, r.serve_variation))
        problems.push(`${spec.key}: a rule serves "${r.serve_variation}", which does not exist`);
    if (!f.enabled) warnings.push(`${spec.key}: disabled, so it always serves its default variation`);
    if (f.rules?.length) warnings.push(`${spec.key}: ${f.rules.length} targeting rule(s) active`);
  }
  const known = new Set(specs.map((s) => s.key));
  for (const f of live) if (!known.has(f.key)) warnings.push(`${f.key}: in the app, but no code reads it`);
  return { problems, warnings };
}

/** The Flagship create body for a missing flag, serving its fallback. */
export function flagCreateBody(spec: FlagSpec): LiveFlag & { description: string } {
  const variations: Record<string, string | number> = { ...spec.variations };
  let def = Object.entries(variations).find(([, v]) => v === spec.fallback)?.[0];
  if (!def) {
    def = String(spec.fallback);
    variations[def] = spec.fallback;
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

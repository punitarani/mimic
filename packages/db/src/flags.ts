import {
  coerceFlag,
  DEFAULT_BUDGET_USD,
  DEFAULT_SESSION_SHARE,
  FLAG_KEYS,
  type FlagContext,
  type FlagReader,
  NO_FLAGS,
  parseSpendLimits,
} from '@mimic/core';

/** The part of the Flagship binding the app uses (workers-types `Flagship`). */
export type FlagshipBinding = Pick<Flagship, 'get'>;

/**
 * Flags from Cloudflare Flagship (ADR-0050). Values are read untyped and coerced (`coerceFlag`), so a flag made in the
 * dashboard as a string with "on"/"off" variations reads the same as a boolean one. Flagship returns the default for a
 * missing flag but may still throw on an unexpected failure; that is caught here, so a read always settles.
 */
export class FlagshipFlags implements FlagReader {
  constructor(private readonly binding: FlagshipBinding) {}

  private async read<T extends string | number | boolean>(
    key: string,
    fallback: T,
    ctx?: FlagContext,
  ): Promise<T> {
    try {
      return coerceFlag(await this.binding.get(key, fallback, ctx), fallback);
    } catch (e) {
      warnOnce(`flag ${key} could not be read; using its default (${e instanceof Error ? e.message : e})`);
      return fallback;
    }
  }
  boolean(key: string, fallback: boolean, ctx?: FlagContext) {
    return this.read(key, fallback, ctx);
  }
  string(key: string, fallback: string, ctx?: FlagContext) {
    return this.read(key, fallback, ctx);
  }
  number(key: string, fallback: number, ctx?: FlagContext) {
    return this.read(key, fallback, ctx);
  }
}

/** The environment's flags: Flagship when the FLAGS binding exists, else every default. */
export function flagsFor(env: { FLAGS?: FlagshipBinding }): FlagReader {
  return env.FLAGS ? new FlagshipFlags(env.FLAGS) : NO_FLAGS;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** The vars the flags override (ADR-0050). Secrets and infrastructure (VECTOR_BACKEND, DEV_MODE, …) are not here. */
export interface FlaggedVars {
  SEARCH_PROVIDER?: string;
  ENRICH_PROVIDER?: string;
  EMBEDDINGS_PROVIDER?: string;
  BUDGET_USD?: string | number;
  BUDGET_SESSION_SHARE?: string | number;
  EXA_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  PARALLEL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI?: unknown;
  FLAGS?: FlagshipBinding;
}

type ProviderVar = 'SEARCH_PROVIDER' | 'ENRICH_PROVIDER' | 'EMBEDDINGS_PROVIDER';

/** What a provider needs in the environment before a flag may pick it at runtime. */
const NEEDS: Record<string, (env: FlaggedVars) => boolean> = {
  exa: (e) => !!e.EXA_API_KEY,
  perplexity: (e) => !!e.PERPLEXITY_API_KEY,
  parallel: (e) => !!e.PARALLEL_API_KEY,
  'workers-ai': (e) => !!e.AI,
  openrouter: (e) => !!e.OPENROUTER_API_KEY,
  none: () => true,
};

/** Each provider flag, its var and the values the adapters accept (scripts/deploy/settings.mjs). */
const PROVIDER_FLAGS: Array<{ key: string; name: ProviderVar; values: string[] }> = [
  { key: FLAG_KEYS.searchProvider, name: 'SEARCH_PROVIDER', values: ['exa', 'perplexity', 'none'] },
  { key: FLAG_KEYS.enrichProvider, name: 'ENRICH_PROVIDER', values: ['exa', 'parallel', 'none'] },
  { key: FLAG_KEYS.embeddingsProvider, name: 'EMBEDDINGS_PROVIDER', values: ['workers-ai', 'openrouter'] },
];

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

/**
 * The environment with each flag's value over its var (ADR-0050). A flag overrides only when it differs from the var
 * and passes the same checks the deploy applies to the var (an allowed provider whose key is deployed; a budget in
 * range); otherwise the var stands and the reason is logged once. Without FLAGS the environment is returned as is.
 */
export async function flaggedEnv<E extends FlaggedVars>(env: E): Promise<E> {
  if (!env.FLAGS) return env;
  const flags = flagsFor(env);
  const out: E = { ...env };

  await Promise.all(
    PROVIDER_FLAGS.map(async ({ key, name, values }) => {
      const current = env[name] ?? '';
      const raw = await flags.string(key, current);
      if (raw === current) return;
      const value = providerValue(raw, values);
      if (!value) return warnOnce(`flag ${key} is "${raw}", not one of ${values.join(', ')}; using ${name}`);
      if (value === current) return;
      if (!NEEDS[value]?.(env))
        return warnOnce(`flag ${key} picks ${value}, whose key or binding isn't deployed; using ${name}`);
      out[name] = value;
    }),
  );

  const budgets = [
    { key: FLAG_KEYS.budgetUsd, name: 'BUDGET_USD', fallback: DEFAULT_BUDGET_USD },
    { key: FLAG_KEYS.budgetSessionShare, name: 'BUDGET_SESSION_SHARE', fallback: DEFAULT_SESSION_SHARE },
  ] as const;
  const fromVars = parseSpendLimits(env).limits;
  await Promise.all(
    budgets.map(async ({ key, name, fallback }) => {
      const current = (name === 'BUDGET_USD' ? fromVars.budgetUsd : fromVars.sessionShare) ?? fallback;
      const value = await flags.number(key, current);
      if (value === current) return;
      if (parseSpendLimits({ [name]: value }).problems.length)
        return warnOnce(`flag ${key} is out of range (${value}); using ${name}`);
      out[name] = String(value);
    }),
  );
  return out;
}

import {
  ALL_FLAGS,
  coerceFlag,
  type FlagContext,
  type FlaggedSetting,
  type FlagReader,
  type FlagSpec,
  NO_FLAGS,
} from '@mimic/core';

/** The part of the Flagship binding the app uses (workers-types `Flagship`). */
export type FlagshipBinding = Pick<Flagship, 'get' | 'getStringDetails' | 'getNumberDetails'>;

/**
 * Flags from Cloudflare Flagship (ADR-0050). Values are read untyped and coerced (`coerceFlag`), so a flag made in the
 * dashboard as a string reads the same as a typed one. Flagship returns the default for a missing flag but may still
 * throw on an unexpected failure; that is caught here, so a read always settles.
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

/** The vars the flags override (ADR-0050), and what a provider needs deployed before a flag may pick it. */
export type FlaggedVars = Partial<Record<FlaggedSetting, string | number>> & {
  EXA_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  PARALLEL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI?: unknown;
  FLAGS?: FlagshipBinding;
};

const NEEDS: Record<string, (env: FlaggedVars) => boolean> = {
  exa: (e) => !!e.EXA_API_KEY,
  perplexity: (e) => !!e.PERPLEXITY_API_KEY,
  parallel: (e) => !!e.PARALLEL_API_KEY,
  'workers-ai': (e) => !!e.AI,
  openrouter: (e) => !!e.OPENROUTER_API_KEY,
};

const SETTING_SPECS: FlagSpec[] = ALL_FLAGS.filter((s) => s.setting);

/**
 * The environment with each flag's value over its var (ADR-0050). A flag overrides only when its value parses, differs
 * from the var, and (for a provider) names one whose key or binding is deployed; otherwise the var stands and the
 * reason is logged once. Without FLAGS the environment is returned as is.
 */
export async function flaggedEnv<E extends FlaggedVars>(env: E): Promise<E> {
  if (!env.FLAGS) return env;
  const flags = flagsFor(env);
  const out: E = { ...env };
  await Promise.all(
    SETTING_SPECS.map(async (spec) => {
      const name = spec.setting!;
      const raw = env[name];
      const current = raw === undefined ? null : spec.parse(spec.kind === 'number' ? raw : String(raw));
      const fallback = current ?? spec.fallback;
      const read =
        spec.kind === 'number'
          ? await flags.number(spec.key, Number(fallback))
          : await flags.string(spec.key, String(fallback));
      const value = spec.parse(read);
      if (value === null)
        return warnOnce(
          `flag ${spec.key} is ${JSON.stringify(read)}, which the code can't use; using ${name}`,
        );
      if (value === fallback) return;
      if (typeof value === 'string' && NEEDS[value] && !NEEDS[value](env))
        return warnOnce(
          `flag ${spec.key} picks ${value}, whose key or binding isn't deployed; using ${name}`,
        );
      out[name] = typeof value === 'number' ? String(value) : value;
    }),
  );
  return out;
}

/** One flag as the Worker's binding resolves it, for `/api/health` (ADR-0050). */
export interface FlagHealth {
  value: unknown;
  reason?: string;
  errorCode?: string;
  /** False when the binding errored or served a value the code can't use. */
  ok: boolean;
}

/**
 * Every registry flag evaluated through the binding, with Flagship's reason and error code, so the post-deploy smoke
 * test proves the deployed Worker can read each flag. `bound: false` when there is no FLAGS binding (local dev).
 */
export async function flagHealth(env: {
  FLAGS?: FlagshipBinding;
}): Promise<{ bound: boolean; ok: boolean; flags: Record<string, FlagHealth> }> {
  const binding = env.FLAGS;
  if (!binding) return { bound: false, ok: true, flags: {} };
  const flags: Record<string, FlagHealth> = {};
  await Promise.all(
    ALL_FLAGS.map(async (spec) => {
      const ctx = { targetingKey: 'health' };
      try {
        const d =
          spec.kind === 'number'
            ? await binding.getNumberDetails(spec.key, Number(spec.fallback), ctx)
            : await binding.getStringDetails(spec.key, String(spec.fallback), ctx);
        flags[spec.key] = {
          value: d.value,
          ...(d.reason ? { reason: d.reason } : {}),
          ...(d.errorCode ? { errorCode: d.errorCode } : {}),
          ok: !d.errorCode && d.reason !== 'ERROR' && spec.parse(d.value) !== null,
        };
      } catch (e) {
        flags[spec.key] = { value: null, errorCode: e instanceof Error ? e.message : String(e), ok: false };
      }
    }),
  );
  return { bound: true, ok: Object.values(flags).every((f) => f.ok), flags };
}

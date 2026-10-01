import {
  ALL_FLAGS,
  coerceFlag,
  FLAG_SPECS,
  type FlagContext,
  type FlaggedSetting,
  type FlagReader,
  type FlagSpec,
  NO_FLAGS,
} from '@mimic/core';

/** The part of the Flagship binding the app uses (workers-types `Flagship`). */
export type FlagshipBinding = Pick<
  Flagship,
  'get' | 'getStringDetails' | 'getNumberDetails' | 'getBooleanDetails'
>;

/**
 * Flags from Cloudflare Flagship (ADR-0051). Values are read untyped and coerced (`coerceFlag`), so a flag made in the
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
      // Once per flag: the error text varies, so it is logged but not part of the key.
      warnOnce(
        `flag ${key} unreadable`,
        `flag ${key} could not be read; using its default (${e instanceof Error ? e.message : e})`,
      );
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

/**
 * Whether creating a mimic needs an invite code (`use-invite-code`, ADR-0053). The flag holds for the whole
 * environment, like the spend caps; unbound or unreadable, it is on, as before the flag.
 */
export async function inviteRequired(env: { FLAGS?: FlagshipBinding }): Promise<boolean> {
  const spec = FLAG_SPECS.useInviteCode;
  return flagsFor(env).boolean(spec.key, spec.fallback, { targetingKey: 'environment' });
}

const warned = new Set<string>();
/** Logs `message` once per isolate for each `key` (the message itself when no key is given). */
export function warnOnce(key: string, message: string = key): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The vars the flags override (ADR-0051, ADR-0052), as Worker vars come: strings or JSON numbers. */
export type FlaggedVars = Partial<Record<FlaggedSetting, string | number>> & { FLAGS?: FlagshipBinding };

const SETTING_SPECS: FlagSpec[] = ALL_FLAGS.filter((s) => s.setting);

/**
 * The environment with each flag's value over its var (ADR-0051). Where FLAGS is bound (prod) the flag is the source
 * of truth (ADR-0052): deploys set no such var, so a failed read falls back to the code default. A flag overrides when
 * its value parses and differs; otherwise the var stands and the reason is logged once. Without FLAGS (preview, local
 * dev) the environment, `.dev.vars` included, is returned as is.
 */
export async function flaggedEnv<E extends FlaggedVars>(env: E): Promise<E> {
  if (!env.FLAGS) return env;
  const flags = flagsFor(env);
  const out: E = { ...env };
  // These flags hold for the whole environment, not a person: a fixed targeting key makes every request, batch and
  // cron run evaluate them alike (without one, Flagship buckets a percentage rule at random on each read).
  const ctx = { targetingKey: 'environment' };
  await Promise.all(
    SETTING_SPECS.map(async (spec) => {
      const name = spec.setting!;
      const raw = env[name];
      const current = raw === undefined ? null : spec.parse(spec.kind === 'number' ? raw : String(raw));
      const fallback = current ?? spec.fallback;
      const read =
        spec.kind === 'number'
          ? await flags.number(spec.key, Number(fallback), ctx)
          : await flags.string(spec.key, String(fallback), ctx);
      const value = spec.parse(read);
      if (value === null)
        return warnOnce(
          `flag ${spec.key} is ${JSON.stringify(read)}, which the code can't use; using ${name}`,
        );
      if (value === fallback) return;
      out[name] = typeof value === 'string' ? value : String(value);
    }),
  );
  return out;
}

/**
 * One flag as the Worker's binding resolves it, for `/api/health` (ADR-0051). No value: the endpoint is public, and
 * whether each flag evaluates is all the smoke test needs.
 */
export interface FlagHealth {
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
            : spec.kind === 'boolean'
              ? await binding.getBooleanDetails(spec.key, spec.fallback === true, ctx)
              : await binding.getStringDetails(spec.key, String(spec.fallback), ctx);
        // Runtime reads are untyped and coerced (FlagshipFlags), so a flag made with another type (a number flag
        // made as a string, say) still works there: judge it by that read, and keep the error code visible.
        const mismatch = d.errorCode === 'TYPE_MISMATCH';
        const value = mismatch
          ? coerceFlag(await binding.get(spec.key, spec.fallback, ctx), spec.fallback)
          : d.value;
        flags[spec.key] = {
          ...(d.reason ? { reason: d.reason } : {}),
          ...(d.errorCode ? { errorCode: d.errorCode } : {}),
          ok: (mismatch || (!d.errorCode && d.reason !== 'ERROR')) && spec.parse(value) !== null,
        };
      } catch (e) {
        flags[spec.key] = { errorCode: e instanceof Error ? e.name : 'Error', ok: false };
      }
    }),
  );
  return { bound: true, ok: Object.values(flags).every((f) => f.ok), flags };
}

/**
 * `pnpm flags:check` (ADR-0050): holds a live Flagship app to the flag registry (`FLAG_SPECS`, packages/core).
 *
 * 1. Defined: every flag the code reads exists, and every variation, default and rule serves a value the code
 *    accepts (`checkFlags`). A missing flag can be created at its default with `--create-missing` (needs Flagship
 *    Edit on the app).
 * 2. Accessible: each flag evaluates through Flagship's evaluate API, as the Worker binding would, to a value the
 *    code accepts.
 *
 * Problems exit 1; warnings (a flag nothing reads, a flag serving something other than its setting) don't. Run it
 * through `scripts/deploy/flags.mjs`, which finds the app ID and the settings for an environment. Node only.
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ALL_FLAGS,
  checkFlags,
  type FlaggedSetting,
  type FlagSpec,
  flagCreateBody,
  type LiveFlag,
} from '@mimic/core';
import { z } from 'zod';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const Envelope = z.object({
  success: z.boolean().optional(),
  errors: z
    .array(z.object({ message: z.string().optional(), code: z.number().optional() }).passthrough())
    .optional(),
  result: z.unknown().optional(),
  result_info: z.object({ cursor: z.string().nullable().optional() }).passthrough().optional(),
});

const Flag = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    default_variation: z.string(),
    variations: z.record(z.string(), z.unknown()),
    rules: z.array(z.object({ serve_variation: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const Evaluation = z
  .object({ flagKey: z.string().optional(), value: z.unknown(), reason: z.string().optional() })
  .passthrough();

export class FlagshipApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FlagshipApiError';
  }
}

/** The Flagship REST API for one app: list, create and evaluate. */
export function flagshipApi(opts: { accountId: string; token: string; appId: string; fetch?: FetchLike }) {
  const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/flagship/apps/${opts.appId}`;
  async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => ({}));
    const env = Envelope.safeParse(json);
    if (!res.ok || (env.success && env.data.success === false)) {
      const detail = env.success ? (env.data.errors ?? []).map((e) => e.message).join('; ') : '';
      throw new FlagshipApiError(
        res.status,
        `${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return { json, env: env.success ? env.data : null };
  }
  return {
    async listFlags(): Promise<LiveFlag[]> {
      const out: LiveFlag[] = [];
      let cursor: string | null | undefined = '';
      for (let page = 0; page < 50 && cursor !== null && cursor !== undefined; page++) {
        const q = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
        const { env } = await call('GET', `/flags?${q}`);
        out.push(...z.array(Flag).parse(env?.result ?? []));
        cursor = env?.result_info?.cursor ?? null;
      }
      return out;
    },
    async createFlag(body: LiveFlag & { description: string }): Promise<void> {
      await call('POST', '/flags', body);
    },
    /** The flag as Flagship evaluates it for a context (the same evaluation the binding makes). */
    async evaluate(key: string, targetingKey: string): Promise<z.infer<typeof Evaluation>> {
      const q = new URLSearchParams({ flagKey: key, targetingKey });
      const { json, env } = await call('GET', `/evaluate?${q}`);
      // Documented as a bare object; accepted inside the usual envelope too.
      return Evaluation.parse(env?.result ?? json);
    },
  };
}

export interface FlagsReport {
  problems: string[];
  warnings: string[];
  created: string[];
  evaluated: Record<string, { value: unknown; reason?: string | undefined }>;
}

const denied = (e: unknown) => e instanceof FlagshipApiError && (e.status === 401 || e.status === 403);

/** The whole check against one app. `settings` are the environment's resolved vars (scripts/deploy/settings.mjs). */
export async function runFlagsCheck(opts: {
  api: ReturnType<typeof flagshipApi>;
  appId: string;
  settings?: Partial<Record<FlaggedSetting, string>>;
  createMissing?: boolean;
  specs?: readonly FlagSpec[];
}): Promise<FlagsReport> {
  const specs = opts.specs ?? ALL_FLAGS;
  const settings = opts.settings ?? {};
  const report: FlagsReport = { problems: [], warnings: [], created: [], evaluated: {} };
  let live: LiveFlag[];
  try {
    live = await opts.api.listFlags();
  } catch (e) {
    report.problems.push(
      denied(e)
        ? `the token can't read Flagship app ${opts.appId} (give it Flagship App · Read on that app, or check CLOUDFLARE_ACCOUNT_ID)`
        : `listing the flags of app ${opts.appId} failed: ${(e as Error).message}`,
    );
    return report;
  }
  if (opts.createMissing) {
    const have = new Set(live.map((f) => f.key));
    for (const spec of specs.filter((s) => !have.has(s.key))) {
      try {
        await opts.api.createFlag(flagCreateBody(spec, spec.setting ? settings[spec.setting] : undefined));
        report.created.push(spec.key);
      } catch (e) {
        report.warnings.push(
          denied(e)
            ? `${spec.key}: can't create it (the token needs Flagship App · Edit); create it in the dashboard`
            : `${spec.key}: create failed: ${(e as Error).message}`,
        );
      }
    }
    if (report.created.length) live = await opts.api.listFlags();
  }
  const check = checkFlags(live, settings, specs);
  report.problems.push(...check.problems);
  report.warnings.push(...check.warnings);

  const present = new Set(live.map((f) => f.key));
  for (const spec of specs.filter((s) => present.has(s.key))) {
    try {
      const r = await opts.api.evaluate(spec.key, 'flags-check');
      report.evaluated[spec.key] = { value: r.value, reason: r.reason };
      if (spec.parse(r.value) === null)
        report.problems.push(
          `${spec.key}: evaluates to ${JSON.stringify(r.value)}, which the code can't use`,
        );
    } catch (e) {
      report.problems.push(
        denied(e)
          ? `${spec.key}: the token can't evaluate flags (give it Flagship App · Evaluate on app ${opts.appId})`
          : `${spec.key}: evaluation failed: ${(e as Error).message}`,
      );
    }
  }
  return report;
}

export function renderReport(appId: string, r: FlagsReport, specs: readonly FlagSpec[] = ALL_FLAGS): string {
  const lines = [`Flagship app ${appId}: ${specs.length} flags in the registry`];
  for (const spec of specs) {
    const e = r.evaluated[spec.key];
    const bad = r.problems.some((p) => p.startsWith(`${spec.key}:`));
    // ✓ only for a flag that is defined and evaluated cleanly; ? for one the check never reached.
    const mark = bad ? '✗' : e ? '✓' : '?';
    lines.push(
      `  ${mark} ${spec.key}${e ? ` = ${JSON.stringify(e.value)}${e.reason ? ` (${e.reason})` : ''}` : ''}`,
    );
  }
  for (const c of r.created) lines.push(`  + created ${c} at its default`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  for (const p of r.problems) lines.push(`  problem: ${p}`);
  lines.push(
    r.problems.length
      ? `✗ ${r.problems.length} problem(s)`
      : '✓ every flag is defined and evaluates to a value the code accepts',
  );
  return lines.join('\n');
}

/** The CLI (`packages/db/src/flags-check.cli.ts`): exit code 1 on problems. */
export async function flagsCheckCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      settings: { type: 'string', default: '{}' },
      'create-missing': { type: 'boolean', default: false },
      optional: { type: 'boolean', default: false },
    },
  });
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!values.app) throw new Error('--app is required');
  if (!token || !accountId) {
    const msg = 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed to check the flags';
    if (values.optional) {
      console.log(`::notice::${msg}; skipped`);
      return 0;
    }
    throw new Error(msg);
  }
  const settings = z.record(z.string(), z.string()).parse(JSON.parse(values.settings));
  const report = await runFlagsCheck({
    api: flagshipApi({ accountId, token, appId: values.app }),
    appId: values.app,
    settings,
    createMissing: values['create-missing'],
  });
  const text = renderReport(values.app, report);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### Feature flags\n\n\`\`\`\n${text}\n\`\`\`\n`);
  return report.problems.length ? 1 : 0;
}

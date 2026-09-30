import { ALL_FLAGS, type LiveFlag } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import { flagsCheckCli, flagshipApi, renderReport, runFlagsCheck } from '../src/flags-check';

const APP = 'c4598f95-4f82-48c0-a8c5-62588cc2b598';

/** The five flags as the `mimic` app holds them. */
const good = (): LiveFlag[] => [
  {
    key: 'budget-session-share',
    enabled: true,
    default_variation: '80',
    variations: { '75': 0.75, '80': 0.8 },
    rules: [],
  },
  { key: 'budget-usd', enabled: true, default_variation: '1', variations: { '1': 1 }, rules: [] },
  {
    key: 'decisions-model',
    enabled: true,
    default_variation: 'jev',
    variations: { jev: 'jev', 'span-01': 'span-01' },
    rules: [],
  },
  {
    key: 'embeddings-provider',
    enabled: true,
    default_variation: 'Workers AI',
    variations: { 'Workers AI': 'workers-ai', OpenRouter: 'openrouter' },
    rules: [],
  },
  { key: 'enrich-provider', enabled: true, default_variation: 'Exa', variations: { Exa: 'exa' }, rules: [] },
  { key: 'search-provider', enabled: true, default_variation: 'Exa', variations: { Exa: 'exa' }, rules: [] },
];

/**
 * The Flagship REST API over an in-memory app: list (two pages, with a cursor), create (409 on a duplicate) and
 * evaluate (the default variation, as a bare object like the docs show). `deny` answers 403 to paths it prefixes.
 */
function fakeApi(
  flags: LiveFlag[],
  opts: { deny?: string[]; denyPost?: boolean; enveloped?: boolean; endCursor?: string | null } = {},
) {
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(`/client/v4/accounts/acct/flagship/apps/${APP}`, '');
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}${u.search}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (opts.deny?.some((d) => path.startsWith(d)) || (opts.denyPost && method === 'POST'))
      return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    if (path === '/flags' && method === 'GET') {
      const sorted = [...flags].sort((a, b) => a.key.localeCompare(b.key));
      const second = u.searchParams.get('cursor') === 'p2';
      const page = second ? sorted.slice(3) : sorted.slice(0, 3);
      return reply(200, {
        success: true,
        errors: [],
        result: page,
        result_info: { cursor: second || sorted.length <= 3 ? (opts.endCursor ?? null) : 'p2' },
      });
    }
    if (path === '/flags' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as LiveFlag;
      if (flags.some((f) => f.key === body.key))
        return reply(409, { success: false, errors: [{ message: 'exists' }] });
      flags.push(body);
      return reply(200, { success: true, result: body });
    }
    if (path === '/evaluate') {
      const f = flags.find((x) => x.key === u.searchParams.get('flagKey'));
      if (!f) return reply(404, { success: false, errors: [{ message: 'flag not found' }] });
      const body = {
        flagKey: f.key,
        reason: 'DEFAULT',
        variant: f.default_variation,
        value: f.variations[f.default_variation],
      };
      return reply(200, opts.enveloped ? { success: true, result: body } : body);
    }
    return reply(404, {});
  };
  return { api: flagshipApi({ accountId: 'acct', token: 't', appId: APP, fetch }), calls, flags };
}

describe('flags:check (ADR-0051)', () => {
  it('passes a well-formed app, across pages, and evaluates every flag', async () => {
    const { api, calls } = fakeApi(good());
    const r = await runFlagsCheck({ api, appId: APP, settings: { EMBEDDINGS_PROVIDER: 'workers-ai' } });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.evaluated['decisions-model']).toEqual({ value: 'jev', reason: 'DEFAULT' });
    expect(calls.filter((c) => c.startsWith('GET /flags'))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('GET /evaluate'))).toHaveLength(ALL_FLAGS.length);
    expect(renderReport(APP, r)).toContain('✓ every flag is defined');
  });

  it('stops at an empty end cursor instead of starting over from the first page', async () => {
    const { api, calls } = fakeApi(good(), { endCursor: '' });
    expect((await api.listFlags()).map((f) => f.key)).toEqual(
      good()
        .map((f) => f.key)
        .sort(),
    );
    expect(calls.filter((c) => c.startsWith('GET /flags'))).toHaveLength(2);
  });

  it('accepts an evaluation inside the usual envelope too', async () => {
    const { api } = fakeApi(good(), { enveloped: true });
    expect((await runFlagsCheck({ api, appId: APP })).problems).toEqual([]);
  });

  it('fails on a missing flag or a value the code cannot use, and warns about the rest', async () => {
    const flags = good().filter((f) => f.key !== 'budget-usd');
    flags.find((f) => f.key === 'decisions-model')!.default_variation = 'gpt';
    flags.find((f) => f.key === 'decisions-model')!.variations.gpt = 'gpt';
    flags.push({
      key: 'vector-backend',
      enabled: true,
      default_variation: 'v',
      variations: { v: 'Cloudflare-Vectorize' },
      rules: [],
    });
    const { api } = fakeApi(flags);
    const r = await runFlagsCheck({ api, appId: APP, settings: { EMBEDDINGS_PROVIDER: 'openrouter' } });
    expect(r.problems).toEqual([
      'decisions-model: variation "gpt" = "gpt" is not a value the code accepts',
      expect.stringMatching(/^budget-usd: missing/),
      'decisions-model: evaluates to "gpt", which the code can\'t use',
    ]);
    expect(r.warnings).toEqual([
      'embeddings-provider: serves "workers-ai" over EMBEDDINGS_PROVIDER="openrouter"',
      'vector-backend: in the app, but no code reads it',
    ]);
    expect(renderReport(APP, r)).toMatch(/✗ 3 problem\(s\)$/);
  });

  it('names the permission a token lacks', async () => {
    const list = await runFlagsCheck({ api: fakeApi(good(), { deny: ['/flags'] }).api, appId: APP });
    expect(list.problems).toEqual([expect.stringContaining('Flagship App · Read')]);
    // Nothing was reached, so no flag is marked as passing.
    expect(renderReport(APP, list)).not.toContain('✓');
    expect(renderReport(APP, list)).toContain('? decisions-model');
    const evalDenied = await runFlagsCheck({ api: fakeApi(good(), { deny: ['/evaluate'] }).api, appId: APP });
    expect(evalDenied.problems).toHaveLength(ALL_FLAGS.length);
    expect(evalDenied.problems[0]).toContain('Flagship App · Evaluate');
  });

  it('--create-missing creates a missing flag at its setting, or warns when the token cannot', async () => {
    const { api, flags } = fakeApi(good().filter((f) => f.key !== 'search-provider'));
    const r = await runFlagsCheck({
      api,
      appId: APP,
      createMissing: true,
      settings: { SEARCH_PROVIDER: 'perplexity' },
    });
    expect(r.created).toEqual(['search-provider']);
    expect(r.problems).toEqual([]);
    expect(flags.find((f) => f.key === 'search-provider')).toMatchObject({
      default_variation: 'perplexity',
      enabled: true,
    });

    // A read-and-evaluate token can't create: a warning naming the permission, and the missing flag stays a problem.
    const readOnly = fakeApi(
      good().filter((f) => f.key !== 'search-provider'),
      { denyPost: true },
    );
    const blocked = await runFlagsCheck({ api: readOnly.api, appId: APP, createMissing: true });
    expect(blocked.created).toEqual([]);
    expect(blocked.warnings).toEqual([expect.stringContaining('Flagship App · Edit')]);
    expect(blocked.problems).toEqual([expect.stringMatching(/^search-provider: missing/)]);
  });

  it('the CLI skips without credentials only when told the check is optional', async () => {
    await expect(flagsCheckCli(['--app', APP], {})).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(await flagsCheckCli(['--app', APP, '--optional'], {})).toBe(0);
    await expect(
      flagsCheckCli([], { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }),
    ).rejects.toThrow(/--app/);
  });
});

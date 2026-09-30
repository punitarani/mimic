// node --test scripts/deploy/*.test.mjs (part of `pnpm test`). No network: Cloudflare is an in-memory fake that
// speaks the same paths and bodies as the real API, driven through the real client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accessApp, adminEmails, ensureAccess, LAB_PATHS } from './access.mjs';
import {
  cloudflare,
  parseJsonc,
  readConfig,
  requiredSecrets,
  secretPayload,
  WEB_CONFIG,
  WORKER_CONFIG,
  withSecretsFile,
} from './lib.mjs';
import { checkNames, customDomain, requiredNames, verifyToken, workerSecrets } from './preflight.mjs';
import { deployConfig, ensureResources, resourceSpec } from './resources.mjs';
import { resolveSettings } from './settings.mjs';
import { smoke } from './smoke.mjs';

const web = readConfig(WEB_CONFIG);
const worker = readConfig(WORKER_CONFIG);
const quiet = () => {};

/** An in-memory Cloudflare account behind a fetch. Records every call. */
function fakeCloudflare({ zeroTrust = true } = {}) {
  const state = { d1: [], kv: [], r2: [], queues: [], indexes: new Map(), apps: [], policies: new Map() };
  const calls = [];
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const reply = (status, result, extra = {}) =>
    new Response(
      JSON.stringify({
        success: status < 400,
        errors: status < 400 ? [] : [{ code: status, message: 'x' }],
        result,
        ...extra,
      }),
      {
        status,
      },
    );
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname.replace('/client/v4/accounts/acc', '').replace('/client/v4', '');
    calls.push(`${method} ${path}`);
    const r2 = path.match(/^\/r2\/buckets\/(.+)$/);
    const meta = path.match(/^\/vectorize\/v2\/indexes\/([^/]+)\/metadata_index\/(list|create)$/);
    const index = path.match(/^\/vectorize\/v2\/indexes\/([^/]+)$/);
    const app = path.match(/^\/access\/apps\/([^/]+)$/);
    const policies = path.match(/^\/access\/apps\/([^/]+)\/policies$/);
    const policy = path.match(/^\/access\/apps\/([^/]+)\/policies\/([^/]+)$/);
    if (path === '/tokens/verify') return reply(200, { status: 'active' });
    if (path === '/d1/database' && method === 'GET')
      return reply(
        200,
        state.d1.filter((d) => d.name.includes(u.searchParams.get('name') ?? '')),
      );
    if (path === '/d1/database' && method === 'POST') {
      const db = { uuid: id('d1'), name: body.name };
      state.d1.push(db);
      return reply(200, db);
    }
    if (path === '/storage/kv/namespaces' && method === 'GET')
      return reply(200, state.kv, { result_info: { total_pages: 1 } });
    if (path === '/storage/kv/namespaces' && method === 'POST') {
      const ns = { id: id('kv'), title: body.title };
      state.kv.push(ns);
      return reply(200, ns);
    }
    if (r2) {
      return state.r2.includes(r2[1]) ? reply(200, { name: r2[1] }) : reply(404, null);
    }
    if (path === '/r2/buckets' && method === 'POST') {
      state.r2.push(body.name);
      return reply(200, { name: body.name });
    }
    if (path === '/queues' && method === 'GET')
      return reply(
        200,
        state.queues.filter((q) => q.queue_name === u.searchParams.get('name')),
      );
    if (path === '/queues' && method === 'POST') {
      state.queues.push({ queue_id: id('q'), queue_name: body.queue_name });
      return reply(200, state.queues.at(-1));
    }
    if (meta) {
      const idx = state.indexes.get(meta[1]);
      if (meta[2] === 'list')
        return reply(200, {
          metadataIndexes: idx.metadata.map((p) => ({ propertyName: p, indexType: 'string' })),
        });
      idx.metadata.push(body.propertyName);
      return reply(200, {});
    }
    if (index) {
      const idx = state.indexes.get(index[1]);
      return idx ? reply(200, { name: index[1], config: idx.config }) : reply(404, null);
    }
    if (path === '/vectorize/v2/indexes' && method === 'POST') {
      state.indexes.set(body.name, { config: body.config, metadata: [] });
      return reply(200, { name: body.name });
    }
    if (path.startsWith('/access/') && !zeroTrust) return reply(403, null);
    if (path === '/access/apps' && method === 'GET')
      return reply(200, state.apps, { result_info: { total_pages: 1 } });
    if (path === '/access/apps' && method === 'POST') {
      const app = { id: id('app'), ...body };
      state.apps.push(app);
      state.policies.set(app.id, []);
      return reply(200, app);
    }
    if (app && method === 'PUT') {
      const found = state.apps.find((a) => a.id === app[1]);
      Object.assign(found, body);
      return reply(200, found);
    }
    if (policies) {
      if (method === 'GET') return reply(200, state.policies.get(policies[1]));
      const p = { id: id('pol'), ...body };
      state.policies.get(policies[1]).push(p);
      return reply(200, p);
    }
    if (policy && method === 'PUT') {
      const p = state.policies.get(policy[1]).find((x) => x.id === policy[2]);
      Object.assign(p, body);
      return reply(200, p);
    }
    return reply(404, null);
  };
  return { cf: cloudflare({ token: 't', accountId: 'acc', fetchImpl }), state, calls };
}

describe('config', () => {
  it('parses wrangler.jsonc comments without touching strings', () => {
    const o = parseJsonc('// top\n{ "a": "https://x.y/*z*/", /* block */ "b": [1, 2] // tail\n}');
    assert.deepEqual(o, { a: 'https://x.y/*z*/', b: [1, 2] });
  });

  it('lists the secrets each Worker needs, per environment', () => {
    const web3 = ['OPENROUTER_API_KEY', 'SESSION_SECRET', 'INVITE_CODES'];
    assert.deepEqual(requiredSecrets(web, 'prod'), [...web3, 'ADMIN_EMAILS']);
    // Preview has no Access in front of workers.dev, so no admins: its lab stays closed.
    assert.deepEqual(requiredSecrets(web, 'preview'), web3);
    for (const env of ['preview', 'prod']) {
      assert.deepEqual(requiredSecrets(worker, env), ['OPENROUTER_API_KEY']);
      // The default providers (exa search, parallel enrichment) add their keys.
      assert.deepEqual(workerSecrets(worker, env, {}), [
        'OPENROUTER_API_KEY',
        'EXA_API_KEY',
        'PARALLEL_API_KEY',
      ]);
    }
  });

  it('lets the deploy environment choose providers, and asks only for their keys', () => {
    const src = {
      SEARCH_PROVIDER: 'perplexity',
      ENRICH_PROVIDER: 'none',
      EMBEDDINGS_PROVIDER: ' openrouter ',
    };
    const { vars, problems } = resolveSettings(worker, 'prod', src);
    assert.deepEqual(problems, []);
    assert.equal(vars.EMBEDDINGS_PROVIDER, 'openrouter');
    assert.equal(vars.VECTOR_BACKEND, 'vectorize', 'unset settings keep the config default');
    assert.deepEqual(workerSecrets(worker, 'prod', src), ['OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY']);
    assert.deepEqual(workerSecrets(worker, 'prod', { SEARCH_PROVIDER: 'none', ENRICH_PROVIDER: 'none' }), [
      'OPENROUTER_API_KEY',
    ]);
  });

  it('refuses test-only or unknown settings', () => {
    const { problems } = resolveSettings(worker, 'prod', {
      SEARCH_PROVIDER: 'fixture',
      EMBEDDINGS_PROVIDER: 'hash',
    });
    assert.deepEqual(problems, [
      'EMBEDDINGS_PROVIDER must be one of workers-ai, openrouter',
      'SEARCH_PROVIDER must be one of exa, perplexity, none',
    ]);
  });

  it('serves prod only on the custom domain, with workers.dev and preview URLs off', () => {
    assert.equal(customDomain(web, 'prod'), 'mimic.punitarani.com');
    for (const c of [web, worker]) {
      assert.equal(c.env.prod.workers_dev, false);
      assert.equal(c.env.prod.preview_urls, false);
    }
  });

  it('names every missing secret without printing values', async () => {
    assert.throws(
      () => secretPayload({ A: 'secret-a', B: ' ' }, ['A', 'B', 'C']),
      /missing worker secrets: B, C/,
    );
    const payload = secretPayload({ A: 'secret-a' }, ['A']);
    const seen = await withSecretsFile(payload, async (file) => {
      const { readFileSync, statSync } = await import('node:fs');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      return [file, JSON.parse(readFileSync(file, 'utf8'))];
    });
    assert.deepEqual(seen[1], { A: 'secret-a' });
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(seen[0]), false);
  });
});

describe('resources', () => {
  it('reads the names from the worker config', () => {
    assert.deepEqual(resourceSpec(worker, 'prod'), {
      d1: 'mimic-prod',
      kv: 'mimic-cache-prod',
      r2: 'mimic-blobs-prod',
      queues: ['mimic-jobs-prod', 'mimic-jobs-prod-dlq'],
      vectorize: 'mimic-qa-prod',
    });
  });

  it('creates everything on an empty account, and nothing on a second run', async () => {
    const { cf, state, calls } = fakeCloudflare();
    const spec = resourceSpec(worker, 'prod');
    const first = await ensureResources(cf, spec, quiet);
    assert.equal(state.d1.length, 1);
    assert.equal(state.kv.length, 1);
    assert.deepEqual(state.r2, ['mimic-blobs-prod']);
    assert.deepEqual(
      state.queues.map((q) => q.queue_name),
      ['mimic-jobs-prod', 'mimic-jobs-prod-dlq'],
    );
    assert.deepEqual(state.indexes.get('mimic-qa-prod'), {
      config: { dimensions: 768, metric: 'cosine' },
      metadata: ['mimicId', 'kind'],
    });
    const posts = calls.filter((c) => c.startsWith('POST')).length;
    const second = await ensureResources(cf, spec, quiet);
    assert.deepEqual(second, first);
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, posts, 'a second run creates nothing');
  });

  it('refuses a Vectorize index of the wrong shape', async () => {
    const { cf, state } = fakeCloudflare();
    state.indexes.set('mimic-qa-prod', { config: { dimensions: 1536, metric: 'cosine' }, metadata: [] });
    await assert.rejects(ensureResources(cf, resourceSpec(worker, 'prod'), quiet), /1536-d cosine/);
  });

  it('fills the IDs into one environment of a copy of the config', () => {
    const out = deployConfig(worker, 'prod', { d1Id: 'D1', kvId: 'KV' });
    assert.equal(out.env.prod.d1_databases[0].database_id, 'D1');
    assert.equal(out.env.prod.kv_namespaces[0].id, 'KV');
    assert.equal(out.env.preview.d1_databases[0].database_id, 'REPLACE_ME_PREVIEW_D1_ID');
    assert.equal(worker.env.prod.d1_databases[0].database_id, 'REPLACE_ME_PROD_D1_ID', 'original untouched');
    const withVars = deployConfig(worker, 'prod', { d1Id: 'D1', kvId: 'KV' }, { SEARCH_PROVIDER: 'none' });
    assert.deepEqual(withVars.env.prod.vars, { SEARCH_PROVIDER: 'none' });
    assert.equal(withVars.env.preview.vars.SEARCH_PROVIDER, 'exa');
  });
});

describe('access', () => {
  it('protects every lab path on the public host', () => {
    const app = accessApp('mimic.punitarani.com');
    assert.deepEqual(
      app.destinations.map((d) => d.uri),
      LAB_PATHS.map((p) => `mimic.punitarani.com/${p}`),
    );
    assert.ok(LAB_PATHS.includes('lab/*') && LAB_PATHS.includes('api/lab/*'));
  });

  it('creates the app and its policy once, then updates them in place', async () => {
    const { cf, state } = fakeCloudflare();
    await ensureAccess(cf, { host: 'mimic.punitarani.com', emails: ['a@x.com'] }, quiet);
    await ensureAccess(cf, { host: 'mimic.punitarani.com', emails: ['a@x.com', 'b@x.com'] }, quiet);
    assert.equal(state.apps.length, 1);
    const policies = state.policies.get(state.apps[0].id);
    assert.equal(policies.length, 1);
    assert.deepEqual(policies[0].include, [{ email: { email: 'a@x.com' } }, { email: { email: 'b@x.com' } }]);
    assert.equal(policies[0].decision, 'allow');
  });

  it('explains what to set up when Zero Trust is off', async () => {
    const { cf } = fakeCloudflare({ zeroTrust: false });
    await assert.rejects(ensureAccess(cf, { host: 'h', emails: ['a@x.com'] }, quiet), /Turn on Zero Trust/);
  });

  it('parses ADMIN_EMAILS strictly', () => {
    assert.deepEqual(adminEmails(' A@x.com, b@y.io '), ['a@x.com', 'b@y.io']);
    assert.throws(() => adminEmails(''), /empty/);
    assert.throws(() => adminEmails('not-an-email'), /invalid/);
  });
});

describe('preflight', () => {
  const full = {
    CLOUDFLARE_API_TOKEN: 't',
    CLOUDFLARE_ACCOUNT_ID: 'a',
    OPENROUTER_API_KEY: 'k',
    EXA_API_KEY: 'k',
    PARALLEL_API_KEY: 'k',
    SESSION_SECRET: 's',
    INVITE_CODES: 'c',
    ADMIN_EMAILS: 'me@x.com',
    APP_URL: 'https://mimic.punitarani.com',
  };

  it('passes with every name and a matching APP_URL', () => {
    assert.deepEqual(checkNames(full, web, worker, 'prod'), { problems: [], warnings: [] });
    assert.equal(requiredNames(web, worker, 'prod', full).length, 9);
    // Without exa search, EXA_API_KEY isn't needed.
    const noSearch = { ...full, SEARCH_PROVIDER: 'none', EXA_API_KEY: '' };
    assert.deepEqual(checkNames(noSearch, web, worker, 'prod'), { problems: [], warnings: [] });
  });

  it('names what is missing, mismatched or local-only', () => {
    const { problems, warnings } = checkNames(
      {
        ...full,
        SESSION_SECRET: 'sk-live-do-not-print',
        EXA_API_KEY: '',
        APP_URL: 'https://mimic.example.com',
        DEV_MODE: '1',
      },
      web,
      worker,
      'prod',
    );
    assert.deepEqual(problems, [
      'EXA_API_KEY is missing or empty (a GitHub secret synced from Doppler)',
      "APP_URL must be https://mimic.punitarani.com (the web app's custom domain in wrangler.jsonc)",
    ]);
    assert.equal(warnings.length, 1);
    assert.ok(
      !JSON.stringify({ problems, warnings }).includes('sk-live-do-not-print'),
      'never prints a value',
    );
  });

  it('accepts an active Cloudflare token', async () => {
    const { cf } = fakeCloudflare();
    await verifyToken(cf);
  });
});

describe('smoke', () => {
  const site =
    (labStatus, labLocation = 'https://team.cloudflareaccess.com/cdn-cgi/access/login') =>
    async (url) => {
      const path = new URL(url).pathname;
      if (path === '/') return new Response('<h1>Build your mimic</h1>', { status: 200 });
      if (path === '/api/health') return Response.json({ ok: true });
      return new Response(null, { status: labStatus, headers: { location: labLocation } });
    };

  it('passes when the page renders, health is ok and the lab redirects to Access', async () => {
    await smoke('https://mimic.punitarani.com', { fetchImpl: site(302), attempts: 1, log: quiet });
  });

  it('fails when the lab answers without Access', async () => {
    await assert.rejects(
      smoke('https://mimic.punitarani.com', { fetchImpl: site(200), attempts: 2, delayMs: 1, log: quiet }),
      /the lab is public/,
    );
  });

  it('retries while a new custom domain comes up', async () => {
    let calls = 0;
    const flaky = async (url, init) =>
      ++calls <= 3 ? new Response('', { status: 522 }) : site(302)(url, init);
    await smoke('https://mimic.punitarani.com', { fetchImpl: flaky, attempts: 3, delayMs: 1, log: quiet });
  });
});

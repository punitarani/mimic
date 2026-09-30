// Shared helpers for the deploy scripts. Dependency-free (Node 22): they run in CI before and after `pnpm install`.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEB_CONFIG = join(ROOT, 'apps/web/wrangler.jsonc');
export const WORKER_CONFIG = join(ROOT, 'apps/worker/wrangler.jsonc');
/** The generated config each deploy runs against: the checked-in one with real resource IDs (gitignored). */
export const DEPLOY_CONFIG_NAME = 'wrangler.deploy.jsonc';
export const ENVS = ['preview', 'prod'];

/** JSON with // and /* *\/ comments (wrangler.jsonc) → object. Strings are left intact. */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out);
}

export function readConfig(path) {
  return parseJsonc(readFileSync(path, 'utf8'));
}

/** The named environment block of a wrangler config (preview | prod). */
export function envBlock(config, env) {
  if (!ENVS.includes(env))
    throw new Error(`unknown environment ${JSON.stringify(env)}; use ${ENVS.join(' | ')}`);
  const block = config.env?.[env];
  if (!block) throw new Error(`wrangler config has no env.${env}`);
  return block;
}

const KEY = /^[A-Z0-9_]+$/;

/** `secrets.required` of an environment: the names the Worker needs, validated. */
export function requiredSecrets(config, env) {
  const keys = envBlock(config, env).secrets?.required;
  if (!Array.isArray(keys) || keys.length === 0)
    throw new Error(`env.${env}.secrets.required is missing or empty`);
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== 'string' || !KEY.test(k)) throw new Error(`invalid secret name ${JSON.stringify(k)}`);
    if (seen.has(k)) throw new Error(`duplicate secret name ${k}`);
    seen.add(k);
  }
  return keys;
}

/** Names that are missing or empty in `source`. */
export function missingNames(source, names) {
  return names.filter((k) => typeof source[k] !== 'string' || source[k].trim() === '');
}

/** The secret values for `keys` from the environment (Doppler), or an error naming every missing one. */
export function secretPayload(source, keys) {
  const missing = missingNames(source, keys);
  if (missing.length) {
    throw new Error(
      `missing worker secrets: ${missing.join(', ')}\nrun under \`doppler run --\` with the mimic project's config`,
    );
  }
  return Object.fromEntries(keys.map((k) => [k, source[k]]));
}

/**
 * Runs `fn(path)` with the secrets written to a 0600 file in a fresh 0700 temp dir, removed afterwards. Values are
 * never printed; only names.
 */
export async function withSecretsFile(payload, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mimic-secrets-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs a command, inheriting stdio; rejects on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args[0] ?? ''} exited ${code}`))));
  });
}

export function step(title) {
  console.log(`\n▸ ${title}`);
}

export function parseArgs(argv) {
  const i = argv.indexOf('--env');
  const env = i >= 0 ? argv[i + 1] : 'prod';
  if (!ENVS.includes(env)) {
    console.error(`✗ --env must be one of ${ENVS.join(', ')} (got ${env})`);
    process.exit(2);
  }
  return { env };
}

// ---------------------------------------------------------------------------------------------------------------
// Cloudflare API
// ---------------------------------------------------------------------------------------------------------------

export class CloudflareError extends Error {
  constructor(method, path, status, errors) {
    super(
      `${method} ${path} → ${status}: ${errors.map((e) => `${e.code} ${e.message}`).join('; ') || 'no detail'}`,
    );
    this.status = status;
    this.codes = errors.map((e) => e.code);
  }
}

/** A minimal Cloudflare v4 API client. Paths are relative to /accounts/{accountId}. */
export function cloudflare({ token, accountId, fetchImpl = fetch }) {
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  const base = 'https://api.cloudflare.com/client/v4';
  async function call(method, path, body, { account = true } = {}) {
    const url = `${base}${account ? `/accounts/${accountId}` : ''}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false)
      throw new CloudflareError(method, path, res.status, json.errors ?? []);
    return json;
  }
  return {
    accountId,
    get: (path, opts) => call('GET', path, undefined, opts).then((j) => j.result),
    post: (path, body) => call('POST', path, body).then((j) => j.result),
    put: (path, body) => call('PUT', path, body).then((j) => j.result),
    /** GET that returns null on 404 (the resource doesn't exist). */
    async find(path) {
      try {
        return (await call('GET', path)).result;
      } catch (e) {
        if (e instanceof CloudflareError && e.status === 404) return null;
        throw e;
      }
    },
    /** All pages of a list endpoint (per_page 100). */
    async list(path, params = {}) {
      const out = [];
      for (let page = 1; page < 100; page++) {
        const q = new URLSearchParams({ ...params, page: String(page), per_page: '100' });
        const j = await call('GET', `${path}?${q}`);
        const items = Array.isArray(j.result) ? j.result : [];
        out.push(...items);
        const total = j.result_info?.total_pages;
        if (items.length < 100 || (total !== undefined && page >= total)) break;
      }
      return out;
    },
  };
}

export function cloudflareFromEnv(source = process.env) {
  return cloudflare({ token: source.CLOUDFLARE_API_TOKEN, accountId: source.CLOUDFLARE_ACCOUNT_ID });
}

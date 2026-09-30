#!/usr/bin/env node
// Everything a deploy reads, checked before anything is touched: each name is present (values are never printed),
// settings are valid and their providers' keys are set, APP_URL matches the custom domain the web app deploys to,
// ADMIN_EMAILS parses, and the Cloudflare token is active. A gap fails here in seconds, with its name, instead of
// halfway through a rollout.
import { adminEmails } from './access.mjs';
import {
  CloudflareError,
  cloudflareFromEnv,
  envBlock,
  missingNames,
  parseArgs,
  readConfig,
  requiredSecrets,
  WEB_CONFIG,
  WORKER_CONFIG,
} from './lib.mjs';
import { providerSecrets, resolveSettings } from './settings.mjs';

/** Local-dev-only names: harmless (only the names a deploy needs are pushed) but a sign of a mixed-up config. */
export const DEV_ONLY = ['DEV_MODE', 'EGRESS_RELAY'];

/** The web app's public hostname in this environment (a custom-domain route), or null. */
export function customDomain(webConfig, env) {
  const route = (envBlock(webConfig, env).routes ?? []).find((r) => r.custom_domain);
  return route ? route.pattern : null;
}

/**
 * The web app's public origin, which its link previews are built against (ADR-0031): the custom domain, else the
 * workers.dev URL on the account's subdomain. Without `cf` (a dry run has no credentials) that second case is null.
 */
export async function siteUrl(webConfig, env, cf = null) {
  const domain = customDomain(webConfig, env);
  if (domain) return `https://${domain}`;
  if (!cf) return null;
  const { subdomain } = await cf.get('/workers/subdomain');
  return `https://${envBlock(webConfig, env).name}.${subdomain}.workers.dev`;
}

/** The worker's secrets: its `secrets.required` plus the keys of the providers `source` selects. */
export function workerSecrets(workerConfig, env, source) {
  const extra = providerSecrets(resolveSettings(workerConfig, env, source).vars);
  return [...new Set([...requiredSecrets(workerConfig, env), ...extra])];
}

/** The names a deploy of `env` reads from `source`. */
export function requiredNames(webConfig, workerConfig, env, source) {
  const names = new Set(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  for (const k of requiredSecrets(webConfig, env)) names.add(k);
  for (const k of workerSecrets(workerConfig, env, source)) names.add(k);
  if (customDomain(webConfig, env)) {
    names.add('APP_URL');
    names.add('ADMIN_EMAILS');
  }
  return [...names];
}

/** Checks that need no network. Returns a list of problems (empty = fine) and warnings. */
export function checkNames(source, webConfig, workerConfig, env) {
  const problems = [
    ...new Set([
      ...resolveSettings(workerConfig, env, source).problems,
      ...resolveSettings(webConfig, env, source).problems,
    ]),
    ...missingNames(source, requiredNames(webConfig, workerConfig, env, source)).map(
      (k) => `${k} is missing or empty (a GitHub secret synced from Doppler)`,
    ),
  ];
  const warnings = DEV_ONLY.filter((k) => source[k]).map(
    (k) => `${k} is set; it is for local dev only and is ignored`,
  );
  const domain = customDomain(webConfig, env);
  if (domain && source.APP_URL) {
    let url;
    try {
      url = new URL(source.APP_URL);
    } catch {
      problems.push('APP_URL is not a URL');
    }
    if (
      url &&
      (url.protocol !== 'https:' || url.host !== domain || (url.pathname !== '/' && url.pathname !== ''))
    ) {
      problems.push(`APP_URL must be https://${domain} (the web app's custom domain in wrangler.jsonc)`);
    }
  }
  if (source.ADMIN_EMAILS) {
    try {
      adminEmails(source.ADMIN_EMAILS);
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { problems, warnings };
}

/** The Cloudflare token works: account-owned tokens verify under the account, user tokens under /user. */
export async function verifyToken(cf) {
  for (const [path, opts, kind] of [
    ['/tokens/verify', {}, 'account'],
    ['/user/tokens/verify', { account: false }, 'user'],
  ]) {
    try {
      const r = await cf.get(path, opts);
      if (r?.status === 'active') return kind;
    } catch {
      /* try the other kind */
    }
  }
  throw new Error('CLOUDFLARE_API_TOKEN is not an active token for CLOUDFLARE_ACCOUNT_ID');
}

/** One read-only probe per account permission the deploy uses (docs/DEPLOY.md, step 2). */
export const ACCOUNT_PERMISSIONS = [
  { permission: 'Workers Scripts', path: '/workers/scripts' },
  { permission: 'D1', path: '/d1/database?per_page=1' },
  { permission: 'Workers KV Storage', path: '/storage/kv/namespaces?per_page=1' },
  { permission: 'Workers R2 Storage', path: '/r2/buckets?per_page=1' },
  { permission: 'Queues', path: '/queues?per_page=1' },
  { permission: 'Vectorize', path: '/vectorize/v2/indexes' },
];

const denied = (e) => e instanceof CloudflareError && (e.status === 401 || e.status === 403);

/**
 * What the token can't do, found before anything is touched: every account permission, Access (when there's a
 * custom domain) and the custom domain's zone. A token that verifies can still lack a permission, or belong to
 * another account than CLOUDFLARE_ACCOUNT_ID; each gap is named with the permission to add.
 */
export async function checkPermissions(cf, { domain = null } = {}) {
  const problems = [];
  let deniedCount = 0;
  for (const { permission, path } of ACCOUNT_PERMISSIONS) {
    try {
      await cf.get(path);
    } catch (e) {
      if (denied(e)) deniedCount++;
      problems.push(
        denied(e)
          ? `the token can't use ${permission} on CLOUDFLARE_ACCOUNT_ID (add Account · ${permission} · Edit)`
          : `${permission}: ${e.message}`,
      );
    }
  }
  if (deniedCount === ACCOUNT_PERMISSIONS.length) {
    return [
      "the token can't use anything on CLOUDFLARE_ACCOUNT_ID: check that it is the token's account " +
        '(dashboard → Workers & Pages → Account ID), and that the token has the account permissions in docs/DEPLOY.md',
    ];
  }
  if (domain) {
    try {
      await cf.get('/access/apps?per_page=1');
    } catch (e) {
      problems.push(
        denied(e)
          ? "the token can't manage Access: add Account · Access: Apps and Policies · Edit, and turn on Zero Trust " +
              'for the account once (it picks a team name)'
          : `Access: ${e.message}`,
      );
    }
    const zone = domain.split('.').slice(-2).join('.');
    let zones = [];
    try {
      zones = (await cf.get(`/zones?name=${encodeURIComponent(zone)}`, { account: false })) ?? [];
    } catch (e) {
      if (!denied(e)) problems.push(`zone ${zone}: ${e.message}`);
    }
    if (!zones.some((z) => z.name === zone)) {
      problems.push(
        `the token can't see the zone ${zone}, which serves ${domain}: add Zone · Workers Routes · Edit for ` +
          `${zone} (the zone must be on this account)`,
      );
    }
  }
  return problems;
}

export async function preflight(env, source = process.env) {
  const web = readConfig(WEB_CONFIG);
  const worker = readConfig(WORKER_CONFIG);
  const { problems, warnings } = checkNames(source, web, worker, env);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (problems.length) throw new Error(`preflight failed:\n  - ${problems.join('\n  - ')}`);
  const cf = cloudflareFromEnv(source);
  const kind = await verifyToken(cf);
  console.log(`  ${requiredNames(web, worker, env, source).length} names present; ${kind} token active`);
  const gaps = await checkPermissions(cf, { domain: customDomain(web, env) });
  if (gaps.length) throw new Error(`preflight failed: Cloudflare API token\n  - ${gaps.join('\n  - ')}`);
  console.log('  token can use every resource, Access and the zone');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  preflight(parseArgs(process.argv.slice(2)).env).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Everything a deploy reads, checked before anything is touched: each name is present (values are never printed),
// APP_URL matches the custom domain the web app deploys to, ADMIN_EMAILS parses, and the Cloudflare token is
// active. A gap fails here in seconds, with its name, instead of halfway through a rollout.
import { adminEmails } from './access.mjs';
import {
  cloudflareFromEnv,
  envBlock,
  missingNames,
  parseArgs,
  readConfig,
  requiredSecrets,
  WEB_CONFIG,
  WORKER_CONFIG,
} from './lib.mjs';

/** Local-dev-only names: harmless in Doppler (only required secrets are synced) but a sign of a mixed-up config. */
export const DEV_ONLY = ['DEV_MODE', 'EGRESS_RELAY'];

/** The web app's public hostname in this environment (a custom-domain route), or null. */
export function customDomain(webConfig, env) {
  const route = (envBlock(webConfig, env).routes ?? []).find((r) => r.custom_domain);
  return route ? route.pattern : null;
}

/** The names a deploy of `env` reads from the environment. */
export function requiredNames(webConfig, workerConfig, env) {
  const names = new Set(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  for (const k of requiredSecrets(webConfig, env)) names.add(k);
  for (const k of requiredSecrets(workerConfig, env)) names.add(k);
  if (customDomain(webConfig, env)) {
    names.add('APP_URL');
    names.add('ADMIN_EMAILS');
  }
  return [...names];
}

/** Checks that need no network. Returns a list of problems (empty = fine) and warnings. */
export function checkNames(source, webConfig, workerConfig, env) {
  const problems = missingNames(source, requiredNames(webConfig, workerConfig, env)).map(
    (k) => `${k} is missing or empty in Doppler`,
  );
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
  for (const [path, opts] of [
    ['/tokens/verify', {}],
    ['/user/tokens/verify', { account: false }],
  ]) {
    try {
      const r = await cf.get(path, opts);
      if (r?.status === 'active') return;
    } catch {
      /* try the other kind */
    }
  }
  throw new Error('CLOUDFLARE_API_TOKEN is not an active token for CLOUDFLARE_ACCOUNT_ID');
}

export async function preflight(env, source = process.env) {
  const web = readConfig(WEB_CONFIG);
  const worker = readConfig(WORKER_CONFIG);
  const { problems, warnings } = checkNames(source, web, worker, env);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (problems.length) throw new Error(`preflight failed:\n  - ${problems.join('\n  - ')}`);
  await verifyToken(cloudflareFromEnv(source));
  console.log(`  ${requiredNames(web, worker, env).length} names present; Cloudflare token active`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  preflight(parseArgs(process.argv.slice(2)).env).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

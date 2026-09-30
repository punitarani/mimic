#!/usr/bin/env node
// `pnpm deploy:dry-run [--env prod]` (CI): build both Workers exactly as a deploy would and have wrangler validate
// the config and bundle, without credentials or touching Cloudflare. It catches a broken OpenNext build, a
// wrangler config error or an oversized bundle on the PR, rather than in CD.
import { join } from 'node:path';
import { parseArgs, ROOT, readConfig, run, step, WEB_CONFIG } from './lib.mjs';
import { siteUrl } from './preflight.mjs';

const { env } = parseArgs(process.argv.slice(2));
const dryRun = (dir) =>
  run('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--env', env], { cwd: join(ROOT, dir) });

try {
  step(`Worker (${env}, dry run)`);
  await dryRun('apps/worker');
  step('Web app: OpenNext build');
  // As a deploy would, against the custom domain when there is one (a workers.dev origin needs credentials).
  const site = await siteUrl(readConfig(WEB_CONFIG), env);
  await run('pnpm', ['exec', 'opennextjs-cloudflare', 'build'], {
    cwd: join(ROOT, 'apps/web'),
    env: { ...process.env, ...(site ? { SITE_URL: site } : {}) },
  });
  step(`Web app (${env}, dry run)`);
  await dryRun('apps/web');
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}

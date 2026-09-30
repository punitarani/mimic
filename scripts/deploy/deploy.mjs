#!/usr/bin/env node
// `pnpm deploy:prod` (and CD): the whole deploy, in order, from environment variables (GitHub secrets synced from
// Doppler in CD; `doppler run --` locally).
//
//   1. preflight      every name present, APP_URL matches the custom domain, Cloudflare token active
//   2. resources      find-or-create D1, KV, R2, queues, Vectorize; write wrangler.deploy.jsonc with real IDs
//                     and the settings (settings.mjs)
//   3. migrations     D1 migrations, before any code that expects them
//   4. worker         queue consumer + cron, deployed with its secrets (--secrets-file)
//   5. web            OpenNext build against the environment's origin (link previews), then deployed with its
//                     secrets and custom domain
//   6. access         Cloudflare Access in front of /lab and /api/lab (custom-domain environments)
//   7. smoke          the landing page, its link preview, /api/health and the lab's Access gate
//
// Secrets go up with the code (`--secrets-file`), which also works on a first deploy: wrangler refuses to create a
// Worker whose `secrets.required` are unset, and `wrangler secret bulk` needs the Worker to exist already.
//
// Run locally with `doppler run -- pnpm deploy:prod`.
import { join } from 'node:path';
import { adminEmails, ensureAccess } from './access.mjs';
import {
  cloudflareFromEnv,
  parseArgs,
  ROOT,
  readConfig,
  requiredSecrets,
  run,
  secretPayload,
  step,
  WEB_CONFIG,
  WORKER_CONFIG,
  withSecretsFile,
} from './lib.mjs';
import { customDomain, preflight, siteUrl, workerSecrets } from './preflight.mjs';
import { prepareConfigs } from './resources.mjs';
import { presentProviderSecrets } from './settings.mjs';
import { smoke } from './smoke.mjs';

async function deploy(env) {
  const source = process.env;
  const web = readConfig(WEB_CONFIG);
  const worker = readConfig(WORKER_CONFIG);
  const webDir = join(ROOT, 'apps/web');
  const workerDir = join(ROOT, 'apps/worker');

  step(`Preflight (${env})`);
  await preflight(env, source);

  step('Cloudflare resources');
  const cf = cloudflareFromEnv(source);
  const { worker: workerDeploy, web: webDeploy } = await prepareConfigs(cf, env, source);

  step('D1 migrations');
  await run(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--remote',
      '--env',
      env,
      '--config',
      workerDeploy,
    ],
    {
      cwd: workerDir,
    },
  );

  step('Worker (queue consumer + cron)');
  // Plus any other provider key that is set, so a provider flag can pick it at runtime (ADR-0051).
  const workerSecretValues = secretPayload(source, [
    ...new Set([...workerSecrets(worker, env, source), ...presentProviderSecrets(source)]),
  ]);
  console.log(`  with secrets: ${Object.keys(workerSecretValues).join(', ')}`);
  await withSecretsFile(workerSecretValues, (file) =>
    run(
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--env', env, '--config', workerDeploy, '--secrets-file', file],
      {
        cwd: workerDir,
      },
    ),
  );

  step('Web app (OpenNext)');
  const webSecrets = secretPayload(source, requiredSecrets(web, env));
  const site = await siteUrl(web, env, cf);
  console.log(`  for ${site}`);
  await run('pnpm', ['exec', 'opennextjs-cloudflare', 'build'], {
    cwd: webDir,
    env: { ...process.env, SITE_URL: site },
  });
  console.log(`  with secrets: ${Object.keys(webSecrets).join(', ')}`);
  await withSecretsFile(webSecrets, (file) =>
    run(
      'pnpm',
      [
        'exec',
        'opennextjs-cloudflare',
        'deploy',
        '--env',
        env,
        '--config',
        webDeploy,
        '--',
        '--secrets-file',
        file,
      ],
      { cwd: webDir },
    ),
  );

  const domain = customDomain(web, env);
  if (!domain) {
    console.log(`\nDeployed ${env} (no custom domain: Access and the smoke test are skipped).`);
    return;
  }

  step('Cloudflare Access for the lab');
  await ensureAccess(cf, { host: domain, emails: adminEmails(source.ADMIN_EMAILS) });

  step(`Smoke test ${source.APP_URL}`);
  await smoke(source.APP_URL);
  console.log(`\nDeployed ${env} to ${source.APP_URL}`);
}

deploy(parseArgs(process.argv.slice(2)).env).catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});

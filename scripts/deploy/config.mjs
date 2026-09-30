#!/usr/bin/env node
// `pnpm deploy:config --env prod`: write apps/*/wrangler.deploy.jsonc (real resource IDs) without deploying.
// The eval CLI's remote commands (`export --env prod`, `report --to prod`) run wrangler against it. Needs
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, e.g. `doppler run -- pnpm deploy:config --env prod`.
import { cloudflareFromEnv, parseArgs, step } from './lib.mjs';
import { prepareConfigs } from './resources.mjs';

const { env } = parseArgs(process.argv.slice(2));
step(`Cloudflare resources (${env})`);
Promise.resolve()
  .then(() => prepareConfigs(cloudflareFromEnv(process.env), env))
  .then((paths) => console.log(`  wrote ${paths.worker}\n  wrote ${paths.web}`))
  .catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  });

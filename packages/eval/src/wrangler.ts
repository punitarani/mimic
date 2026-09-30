import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where wrangler runs for the eval CLI: the worker app, whose config binds every resource. */
export const WORKER_DIR = join(ROOT, 'apps/worker');

/**
 * Wrangler flags for a deployed environment. The checked-in config has placeholder resource IDs; the real ones are
 * in the generated wrangler.deploy.jsonc (scripts/deploy, ADR-0022).
 */
export function remoteFlags(env: 'preview' | 'prod'): string[] {
  const config = join(WORKER_DIR, 'wrangler.deploy.jsonc');
  if (!existsSync(config))
    throw new Error(`No ${config}; run \`doppler run -- pnpm deploy:config --env ${env}\` first`);
  return ['--remote', '--env', env, '--config', config];
}

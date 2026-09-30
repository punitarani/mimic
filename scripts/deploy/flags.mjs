#!/usr/bin/env node
// `pnpm flags:check [--env prod] [--optional] [--create-missing]` (ADR-0050): holds the environment's Flagship app to
// the flag registry in packages/core. It checks that every flag the code reads is defined with values the code
// accepts, and that each one evaluates. It runs in CI (the Flags job), in deploy preflight, and by hand.
//
// This wrapper finds what the check needs from the checked-in config: the app the Workers bind as FLAGS, and the
// environment's resolved settings (so a flag that overrides one is called out). The check itself is TypeScript
// (packages/db/src/flags-check.ts), so it uses the registry's own parsers. The app ID is pinned in both
// wrangler.jsonc files, since the token needs no permission to find it; an environment that binds no app has
// nothing to check.
import { join } from 'node:path';
import { envBlock, parseArgs, ROOT, readConfig, run, WEB_CONFIG, WORKER_CONFIG } from './lib.mjs';
import { resolveSettings } from './settings.mjs';

/** The Flagship app an environment's Worker binds as FLAGS, or null. */
export function flagsAppId(config, env) {
  const bindings = envBlock(config, env).flagship ?? [];
  return bindings.find((b) => b.binding === 'FLAGS')?.app_id ?? null;
}

/** The app both Workers bind in `env` (they must agree), or null when neither binds one. */
export function environmentFlagsApp(env, web = readConfig(WEB_CONFIG), worker = readConfig(WORKER_CONFIG)) {
  const a = flagsAppId(worker, env);
  const b = flagsAppId(web, env);
  if (a !== b)
    throw new Error(`env.${env}: the worker binds Flagship app ${a} and the web app ${b}; bind the same one`);
  return a;
}

/** The checker's command line for an environment, or null when it binds no app. */
export function flagsCheckArgs(env, source, { optional = false, createMissing = false } = {}) {
  const worker = readConfig(WORKER_CONFIG);
  const app = environmentFlagsApp(env, readConfig(WEB_CONFIG), worker);
  if (!app) return null;
  const { vars } = resolveSettings(worker, env, source);
  return [
    'exec',
    'tsx',
    join(ROOT, 'packages/db/src/flags-check.cli.ts'),
    '--app',
    app,
    '--settings',
    JSON.stringify(vars),
    ...(optional ? ['--optional'] : []),
    ...(createMissing ? ['--create-missing'] : []),
  ];
}

/** Runs the check for `env`; throws when it finds a problem. */
export async function checkFlags(env, source = process.env, opts = {}) {
  const args = flagsCheckArgs(env, source, opts);
  if (!args) {
    console.log(`  env.${env} binds no Flagship app: every flag reads its code default`);
    return;
  }
  await run('pnpm', args, { cwd: ROOT });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  checkFlags(parseArgs(argv).env, process.env, {
    optional: argv.includes('--optional'),
    createMissing: argv.includes('--create-missing'),
  }).catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}

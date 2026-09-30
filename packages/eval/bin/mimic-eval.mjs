#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so the workspace packages need no build step.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync('npx', ['tsx', join(here, '..', 'src', 'cli.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);

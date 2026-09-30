#!/usr/bin/env node
// `pnpm dev`: egress relay + worker (wrangler dev) + web (next dev), sharing local D1/R2/KV/Queues state.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const app of ['apps/web', 'apps/worker']) {
  const vars = join(root, app, '.dev.vars');
  if (!existsSync(vars)) {
    copyFileSync(join(root, app, '.dev.vars.example'), vars);
    console.log(`[dev] created ${app}/.dev.vars from the example`);
  }
}

const env = { ...process.env, NODE_USE_ENV_PROXY: '1', FORCE_COLOR: '1' };
const colors = { relay: 35, worker: 33, web: 36, migrate: 32 };
const children = [];

function run(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd: join(root, cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colors[name]}m[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) out.write(`${prefix + line}\n`);
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const migrate = run('migrate', 'pnpm', ['db:migrate:local'], '.');
migrate.on('exit', (code) => {
  if (code !== 0) {
    console.error('[dev] migrations failed');
    shutdown(code ?? 1);
    return;
  }
  run('relay', 'node', ['scripts/egress-relay.mjs'], '.');
  run(
    'worker',
    'pnpm',
    ['exec', 'wrangler', 'dev', '--port', '8787', '--persist-to', '../../.wrangler/state'],
    'apps/worker',
  );
  run('web', 'pnpm', ['exec', 'next', 'dev', '--port', '3000'], 'apps/web');
  console.log('[dev] web http://localhost:3000 · worker http://localhost:8787 · relay http://127.0.0.1:8790');
});

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { schema } from '@mimic/db';
import { sql } from 'drizzle-orm';
import { calibrateGates } from './gates';
import { openLocalEngine } from './local';
import { runSession, SessionScript } from './session';

const USAGE = `mimic-eval <command> [options]

Commands
  session   Run a scripted session end to end against a local SQLite database (PLAN §14 M2)
            --script <file.json>   scripted answers (see packages/eval/scripts/example.json)
            --db <path>            SQLite path (default data/session.sqlite)
            --blobs <dir>          directory standing in for R2 (default data/blobs)
            --turns <n>            number of questions (default 30)
            --live                 use real providers (costs money); default is offline fakes
            --simulate <persona>   LLM-simulated user for unscripted questions (smoke tests only; never report
                                   metrics from simulated users)
  gates     Calibrate the Jev quality-gate thresholds on a hand-labeled set (live Jev calls, < $0.01)
            --labeled <file.json>  default packages/eval/data/gates.labeled.v1.json
`;

async function gates(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { labeled: { type: 'string', default: 'packages/eval/data/gates.labeled.v1.json' } },
  });
  const engine = await openLocalEngine({ db: ':memory:', providers: 'live' });
  const rows = await calibrateGates(engine.deps.gateway, resolve(values.labeled));
  console.table(
    rows.map((r) => ({
      gate: r.gate,
      auc: r.auc.toFixed(3),
      threshold: r.threshold,
      'balanced acc': r.balancedAccuracy.toFixed(3),
      'bad / ok': `${r.positives} / ${r.negatives}`,
    })),
  );
  engine.close();
}

async function session(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      script: { type: 'string' },
      db: { type: 'string', default: 'data/session.sqlite' },
      blobs: { type: 'string', default: 'data/blobs' },
      turns: { type: 'string', default: '30' },
      live: { type: 'boolean', default: false },
      simulate: { type: 'string' },
    },
  });
  if (!values.script) throw new Error('--script is required');
  const script = SessionScript.parse(JSON.parse(readFileSync(resolve(values.script), 'utf8')));
  if (values.simulate) {
    console.warn('⚠ Simulated user: smoke test only. Never report metrics from LLM-simulated users.');
  }
  const engine = await openLocalEngine({
    db: resolve(values.db),
    blobsDir: resolve(values.blobs),
    providers: values.live ? 'live' : 'offline',
  });
  console.log(`providers: ${values.live ? 'live' : 'offline fakes (zero spend; outputs are arbitrary)'}`);
  const { mimicId, turns } = await runSession(engine, script, {
    turns: Number(values.turns),
    ...(values.simulate ? { simulatePersona: values.simulate } : {}),
    onTurn: (t) => {
      const guess = t.reveal
        ? `${t.reveal.match ? '✓' : '✗'} guessed "${t.reveal.label}" (${Math.round(t.reveal.p * 100)}%)`
        : '—';
      const fid = t.fidelity ? `fidelity ${t.fidelity.fidelity.toFixed(2)} [${t.fidelity.state}]` : '';
      console.log(
        `#${String(t.seq).padStart(2)} ${t.kind.padEnd(8)} ${t.prompt.slice(0, 60).padEnd(60)} → ${t.answerLabel.slice(0, 28).padEnd(28)} ${guess} ${fid}`,
      );
    },
  });
  const db = (engine.deps.store as unknown as { db: { get: (q: unknown) => Promise<{ n: number }> } }).db;
  console.log(`\nmimic ${mimicId}: ${turns.length} turns written to ${values.db}`);
  for (const [name, table] of Object.entries(schema)) {
    if (typeof table !== 'object' || !table || !('getSQL' in table)) continue;
    const { n } = await db.get(sql`select count(*) as n from ${table}`);
    console.log(`  ${name.padEnd(20)} ${n}`);
  }
  const spend = (await engine.deps.store.getMimic(mimicId))!.spendUsd;
  console.log(`  spend                $${spend.toFixed(4)}`);
  engine.close();
}

async function main() {
  const args = process.argv.slice(2).filter((a: string, i: number) => !(i === 0 && a === '--'));
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'session':
      return session(rest);
    case 'gates':
      return gates(rest);
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

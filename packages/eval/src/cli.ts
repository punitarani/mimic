#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type EvalRunRecord, type PipelineConfig, VOI_SELECTOR } from '@mimic/core';
import { schema } from '@mimic/db';
import { sql } from 'drizzle-orm';
import { NAMED_CONFIGS, registerNamedConfig } from './configs';
import { datasetHash, exportData } from './export';
import { calibrateGates, sampleDrafts } from './gates';
import { openLocalEngine } from './local';
import { diagnoseCmd, evaluateCmd, optimizeCmd } from './optimize/commands';
import { replay, reproduceOnline } from './replay';
import { publishReport, renderReport, writeReport } from './report';
import { simulateSelection } from './select';
import { runSession, SessionScript } from './session';
import { importTwin } from './twin';

const USAGE = `mimic-eval <command> [options]

Commands
  session   Run a scripted session end to end against a local SQLite database (PLAN §14 M2)
            --script <file.json>   scripted answers (see packages/eval/scripts/example.json)
            --db <path>            SQLite path (default data/session.sqlite)
            --blobs <dir>          directory standing in for R2 (default data/blobs)
            --turns <n>            number of questions (default 30)
            --config <name>        default | v3 | m10-candidate (default: default)
            --live                 use real providers (costs money); default is offline fakes
            --simulate <persona>   LLM-simulated user for unscripted questions (smoke tests only; never report
                                   metrics from simulated users)
  drafts    Sample raw generator drafts, before any gate, for hand labelling (live LLM calls, about $0.01)
            [--config m10-candidate] [--batches 6] [--per-batch 10] [--occupation Nurse] [--out <file.json>]
  gates     Calibrate the Jev quality-gate thresholds on a hand-labelled set (live Jev calls, < $0.05)
            [--labeled packages/eval/labeled/gates.v3.json] [--version gates.v3] [--out <file.json>]
  export    D1 → SQLite (same schema); consented mimics only; names, locations, links, URLs dropped, IDs replaced
            --env local|preview|prod   --out <file.sqlite>   [--keep-identity]  (internal reproduction check only)
  replay    Offline replay (PLAN §12.3)
            --data <file.sqlite> --predictor jev:typesafe/jev-1.13 --state full|raw|structured|summary
            --checkpoints 10,20,30 --split dev|test|all [--targets later|heldout] [--limit N] [--offline]
            --mode online   rebuild each online primary's state and re-predict (needs --keep-identity export)
  select    Pool-restricted selection simulation (biased; iteration only)
            --data <file.sqlite> --selector random|coverage|entropy|bald|voi[,…] --budget 5,10,20 [--split dev]
            [--limit N] [--no-population]   several selectors run on the same people and report side by side
  import    import twin2k500 --path <twin2k500.jsonl> --out <file.sqlite> [--limit N]
  report    --data <file.sqlite> --run <id> [--to local|preview|prod]   writes report.{json,md}; --to publishes to /lab
  evaluate  Score prediction prompts on sealed instances (docs/OPTIMIZATION.md §5)
            --data <a.sqlite>[,<b.sqlite>] --from stored        stored online predictions, calibration fits; no calls
            --data … --predictor <id>[,<id>] [--candidate <cand.json>[,…]] [--repeat] [--max-usd 2]
            [--split dev|test|all] [--k 30] [--limit N] [--max-targets 40] [--publish local|preview|prod]
  diagnose  Failure analysis of a stored predictor by the reflection model (one call)
            --data … --predictor <id> [--role primary|shadow] [--cases 40] [--reflection-model <id>]
  optimize  GEPA-style reflective prompt optimization (docs/OPTIMIZATION.md §6); resumable with --run-dir
            --data … --predictor jev:typesafe/jev-1.13 | llm:<model> [--candidate <seed.json>] [--components a,b]
            [--max-metric-calls 400] [--max-usd 2] [--minibatch 8] [--val-size 60] [--holdout-size 80]
            [--max-iterations 30] [--reflection-model anthropic/claude-sonnet-5.5] [--no-noise] [--run-dir <dir>]
            [--k 30] [--publish local|preview|prod] [--offline]

Every eval command records its run in the data file's eval_runs table and writes data/reports/<run>/.
`;

async function gates(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      labeled: { type: 'string', default: 'packages/eval/labeled/gates.v3.json' },
      version: { type: 'string', default: 'gates.v3' },
      out: { type: 'string' },
    },
  });
  const engine = await openLocalEngine({ db: ':memory:', providers: 'live' });
  const { gates: rows, rows: items } = await calibrateGates(
    engine.deps.gateway,
    resolve(values.labeled),
    values.version,
  );
  console.table(
    rows.map((r) => ({
      gate: r.gate,
      auc: r.auc.toFixed(3),
      'best threshold': r.threshold,
      'balanced acc': r.balancedAccuracy.toFixed(3),
      current: r.current ?? '',
      'balanced acc (current)': r.currentBalancedAccuracy?.toFixed(3) ?? '',
      'bad / ok': `${r.positives} / ${r.negatives}`,
    })),
  );
  if (values.out) {
    writeFileSync(
      resolve(values.out),
      `${JSON.stringify({ version: values.version, gates: rows, items }, null, 2)}\n`,
    );
    console.log(`wrote ${values.out}`);
  }
  engine.close();
}

async function drafts(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'm10-candidate' },
      batches: { type: 'string', default: '6' },
      'per-batch': { type: 'string', default: '10' },
      occupation: { type: 'string', default: 'Nurse' },
      out: { type: 'string' },
    },
  });
  const named = NAMED_CONFIGS[values.config];
  if (!named) throw new Error(`Unknown config "${values.config}"`);
  const engine = await openLocalEngine({ db: ':memory:', providers: 'live' });
  const rows = await sampleDrafts(engine.deps.gateway, named.config, {
    batches: Number(values.batches),
    perBatch: Number(values['per-batch']),
    occupation: values.occupation,
  });
  const body = `${JSON.stringify({ config: values.config, drafts: rows }, null, 2)}\n`;
  if (values.out) writeFileSync(resolve(values.out), body);
  else process.stdout.write(body);
  console.error(`${rows.length} drafts from ${named.config.generator.promptVersion}`);
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
      config: { type: 'string', default: 'default' },
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
  const configHash = await registerNamedConfig(engine.deps, values.config);
  console.log(`config: ${values.config} (${configHash.slice(0, 12)})`);
  const { mimicId, turns } = await runSession(engine, script, {
    turns: Number(values.turns),
    configHash,
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

const list = (v: string) =>
  v
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);

async function replayCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      predictor: { type: 'string', default: 'jev:typesafe/jev-1.13' },
      state: { type: 'string', default: 'full' },
      checkpoints: { type: 'string', default: '10,20,30' },
      split: { type: 'string', default: 'dev' },
      targets: { type: 'string', default: 'later' },
      limit: { type: 'string' },
      mode: { type: 'string', default: 'checkpoint' },
      seed: { type: 'string', default: 'replay' },
      name: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const data = resolve(values.data);
  const engine = await openLocalEngine({ db: data, providers: values.offline ? 'offline' : 'live' });
  const hash = await datasetHash(engine.client);
  const limit = values.limit ? Number(values.limit) : undefined;
  let run: EvalRunRecord;
  if (values.mode === 'online') {
    const r = await reproduceOnline(
      engine.deps,
      {
        seed: values.seed,
        name: values.name ?? 'reproduce online',
        ...(limit ? { limitPeople: limit } : {}),
      },
      hash,
    );
    run = r.run;
  } else {
    const r = await replay(
      engine.deps,
      {
        name: values.name ?? `replay ${values.predictor} ${values.state}`,
        predictor: values.predictor,
        strategy: values.state as 'full' | 'raw' | 'structured' | 'summary',
        checkpoints: list(values.checkpoints),
        split: values.split as 'dev' | 'test' | 'all',
        targets: values.targets as 'later' | 'heldout',
        seed: values.seed,
        ...(limit ? { limitPeople: limit } : {}),
      },
      hash,
    );
    run = r.run;
  }
  const files = writeReport(run);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
  engine.close();
}

async function selectCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      selector: { type: 'string', default: 'entropy' },
      budget: { type: 'string', default: '5,10,20' },
      split: { type: 'string', default: 'dev' },
      limit: { type: 'string' },
      seed: { type: 'string', default: 'select' },
      offline: { type: 'boolean', default: false },
      'no-population': { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const data = resolve(values.data);
  const engine = await openLocalEngine({ db: data, providers: values.offline ? 'offline' : 'live' });
  const selectors: Record<string, PipelineConfig['selector']> = {
    random: { type: 'random' },
    coverage: { type: 'coverage' },
    entropy: { type: 'entropy', lambdaCoverage: 0.3, muRedundancy: 0.5 },
    bald: { type: 'bald', k: 4, lambdaCoverage: 0.3 },
    voi: VOI_SELECTOR,
  };
  const chosen = values.selector.split(',').map((s) => s.trim());
  for (const s of chosen) if (!selectors[s]) throw new Error(`unknown selector ${s}`);
  const { run } = await simulateSelection(
    engine.deps,
    {
      name: `select ${chosen.join(' vs ')}`,
      selectors: chosen.map((label) => ({ label, selector: selectors[label]! })),
      budgets: list(values.budget),
      split: values.split as 'dev' | 'test' | 'all',
      seed: values.seed,
      population: !values['no-population'],
      ...(values.limit ? { limitPeople: Number(values.limit) } : {}),
    },
    await datasetHash(engine.client),
  );
  const files = writeReport(run);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
  engine.close();
}

async function exportCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: 'string', default: 'local' },
      out: { type: 'string' },
      'keep-identity': { type: 'boolean', default: false },
    },
  });
  const out = values.out ?? `data/export-${values.env}-${new Date().toISOString().slice(0, 10)}.sqlite`;
  const r = await exportData({
    env: values.env as 'local' | 'preview' | 'prod',
    out,
    keepIdentity: values['keep-identity'],
  });
  console.log(
    `exported ${r.mimics} consented mimics (${r.dropped} without research consent dropped) → ${r.path}`,
  );
  if (r.withheld)
    console.log(
      `withheld by scope and research consent: ${r.withheld.questions} questions, ${r.withheld.traits} trait rows, ${r.withheld.insights} insights, ${r.withheld.facts} facts`,
    );
  console.log(`dataset hash ${r.datasetHash}`);
  if (values['keep-identity'])
    console.warn(
      '⚠ --keep-identity: contains names, locations and special-category answers (politics, religion, sexuality, health) without research consent for them. Internal use only; never share.',
    );
}

async function importCmd(argv: string[]) {
  const [dataset, ...rest] = argv;
  if (dataset !== 'twin2k500')
    throw new Error('usage: import twin2k500 --path <file.jsonl> --out <file.sqlite>');
  const { values } = parseArgs({
    args: rest,
    options: {
      path: { type: 'string' },
      out: { type: 'string', default: 'data/twin2k500.sqlite' },
      limit: { type: 'string' },
    },
  });
  if (!values.path) throw new Error('--path is required');
  const engine = await openLocalEngine({ db: resolve(values.out), providers: 'offline' });
  const r = await importTwin(engine.deps, {
    path: resolve(values.path),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
  });
  console.log(`imported ${r.people} people, ${r.items} typed items → ${values.out}`);
  engine.close();
}

async function reportCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { data: { type: 'string' }, run: { type: 'string' }, to: { type: 'string' } },
  });
  if (!values.data || !values.run) throw new Error('--data and --run are required');
  const engine = await openLocalEngine({ db: resolve(values.data), providers: 'offline' });
  const run = (await engine.deps.store.listEvalRuns()).find((r) => r.id === values.run);
  engine.close();
  if (!run) throw new Error(`run ${values.run} not found in ${values.data}`);
  const files = writeReport(run);
  console.log(`wrote ${files.md}`);
  if (values.to) {
    const key = publishReport(run, files, values.to as 'local' | 'preview' | 'prod');
    console.log(`published to ${values.to}: eval_runs row + R2 ${key} (visible in /lab)`);
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a: string, i: number) => !(i === 0 && a === '--'));
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'session':
      return session(rest);
    case 'gates':
      return gates(rest);
    case 'drafts':
      return drafts(rest);
    case 'export':
      return exportCmd(rest);
    case 'replay':
      return replayCmd(rest);
    case 'select':
      return selectCmd(rest);
    case 'import':
      return importCmd(rest);
    case 'report':
      return reportCmd(rest);
    case 'evaluate':
      return evaluateCmd(rest);
    case 'diagnose':
      return diagnoseCmd(rest);
    case 'optimize':
      return optimizeCmd(rest);
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

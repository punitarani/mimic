#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Category,
  EVIDENCE_POLICIES,
  type EvalRunRecord,
  type EvidencePolicy,
  footprintTokens,
  type PipelineConfig,
  proposeFromFootprint,
  STATE_STRATEGIES,
  type StateStrategy,
  VOI_SELECTOR,
  VOI_SELECTOR_V8,
} from '@mimic/core';
import { schema } from '@mimic/db';
import { sql } from 'drizzle-orm';
import { armsRun } from './arms';
import { benchmarkCmd } from './benchmark';
import { runCohort } from './cohort';
import { NAMED_CONFIGS, registerNamedConfig } from './configs';
import { ensembleRun } from './ensemble';
import { evidenceCmd } from './evidence';
import { datasetHash, exportData } from './export';
import { parseFootprintDir } from './footprint';
import { calibrateGates, sampleDrafts } from './gates';
import { openLocalEngine } from './local';
import { diagnoseCmd, evaluateCmd, loadData, loadOptsOf, optimizeCmd, recordRun } from './optimize/commands';
import { probeReadout } from './probes';
import { replay, reproduceOnline } from './replay';
import { publishReport, renderReport, writeReport } from './report';
import { POPULATIONS, type Population, rubricRun } from './rubric';
import { simulateSelection } from './select';
import { runSession, SessionScript } from './session';
import { buildPopulation } from './synthesize';
import { TRANSFER_VIEWS, type TransferView, transfer } from './transfer';
import { importTwin } from './twin';

const USAGE = `mimic-eval <command> [options]

Commands
  session   Run a scripted session end to end against a local SQLite database (PLAN §14 M2)
            --script <file.json>   scripted answers (see packages/eval/scripts/example.json)
            --db <path>            SQLite path (default data/session.sqlite)
            --blobs <dir>          directory standing in for R2 (default data/blobs)
            --turns <n>            number of questions (default 30)
            --config <name>        default | v3 | v6 | m10-candidate (default: default)
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
            --data <file.sqlite> --predictor decision:typesafe/jev-1.13 --state full|raw|structured|summary|card
            --checkpoints 10,20,30 --split dev|test|all [--targets later|heldout] [--limit N] [--offline]
            [--evidence mixed|recent|similar|surprise|novelty|fill] [--max-evidence N] [--budget <tokens>]
                            which answers a state keeps once over budget or cap (ADR-0056)
            [--views full,raw,structured,summary]   also predict from each of these views of the same evidence and
                            pool them log-linearly at equal weight: the evidence-view ensemble (ADR-0058)
            [--rows]   also write every scored prediction to rows.json beside the report, for paired comparisons
            [--per-target [--embed]]   one state per target with that question as the retrieval target, ranked
                            lexically or by embeddings, as production ranks against its candidates; one call each
            [--max-targets N]   at most N targets per person, the same ones at every checkpoint
            --mode online   rebuild each online primary's state and re-predict (needs --keep-identity export)
  footprint   Parse the person's own exports into clean documents (ADR-0061; no model calls): tweets.js (X archive),
            Profile/Positions/Education/Skills/Shares.csv (LinkedIn), posts.csv and comments.csv (Reddit),
            github.json ({ user, repos }), and *.txt or *.md notes; reports what the hygiene rules dropped
            --dir <folder> [--out docs.json]
            [--propose --db data/session.sqlite --mimic <id> [--live]]   pool the questions the documents imply
  population  A calibrated synthetic population from the consented cohort (ADR-0059; no model calls): a Gaussian copula
            over facet means, answers to the cohort's stable items drawn from each agent's nearest real exemplars, realism
            metrics (dispersion, caricature, structure, coverage, re-identification, sensitive leakage), and Concordia and
            Smallville renderings; writes population.json next to the report
            --data <file.sqlite> [--agents 100] [--k 5] [--kappa 10] [--min-people 5] [--split dev]
            [--population real|all] [--seed population]
  probes    E7's readout (ADR-0062, docs/PROBE.md; no model calls): what the stored predictions on served probes
            say the mimic learned, per distance tier and slot against the context-only baseline, shared-item
            residual and individuation, repeat consistency, and PROBE_RULE's verdict
            --data <file.sqlite> [--population real|all] [--seed probes] [--summary <file>]
            [--publish local|preview|prod]
  ensemble  Prequential ensembles of the stored primary and shadows (ADR-0058; no model calls): equal-weight pools,
            Hedge/BMA weights learned from each person's earlier questions, and a hindsight oracle, paired against
            the primary with bootstrap intervals
            --data <a.sqlite>[,<b.sqlite>] [--etas 0.5,1,2] [--with-baseline] [--split all] [--limit N]
  transfer  Transfer loss (ADR-0057): a reader that knows nothing about Mimic predicts later answers from one exported
            view alone (SOUL.md core or full, mimic.json, the card, or the identity-only context), against the full
            in-context state; per view: accuracy, log loss, lift, tokens, cost
            --data <file.sqlite> [--readers llm:deepseek/deepseek-v4.1-flash[,decision:typesafe/jev-1.13]]
            [--views context,state,card,soul-core,soul-full,mimic-json] [--checkpoints 10,20] [--split dev]
            [--targets later|heldout] [--draft] [--card-max 12] [--card-policy surprise] [--limit N]
            [--max-targets N] [--offline]
  select    Pool-restricted selection simulation (biased; iteration only)
            --data <file.sqlite> --selector random|coverage|entropy|bald|voi|voi-v8[,…] --budget 5,10,20
            [--split dev] [--limit N] [--no-population]   several selectors run on the same people, side by side
            [--series]   accuracy on the rest after every pick, and questions to sustain 75%
            [--categories psychology,values,life]   as if only these categories were selected
  rubric    What the question loop served, by population and config: concreteness, category shares, groups,
            sensitive coverage and ordering (ADR-0044; no model calls)
            --data <file.sqlite> [--arm] [--population real,scripted,twin2k]
  arms      An experiment's arms on the E3 metrics, with 95% bootstrap intervals and each arm against the control
            (ADR-0045): fidelity at 20, questions to sustain fidelity 0.75. Real people only unless --population all
            --data <file.sqlite> [--experiment <id>] [--population real|all] [--seed arms]
  cohort    A scripted cohort through an experiment preset, every persona in every arm (ADR-0045; tests the machinery,
            never a result). Sets the preset up and starts it in this database only
            --preset e3b [--people 8] [--turns 32] [--db data/cohort.sqlite] [--blobs data/blobs] [--live]
  import    import twin2k500 --path <twin2k500.jsonl> --out <file.sqlite> [--limit N]
  report    --data <file.sqlite> --run <id> [--to local|preview|prod]   writes report.{json,md}; --to publishes to /lab
  evaluate  Score prediction prompts on sealed instances (docs/OPTIMIZATION.md §5)
            --data <a.sqlite>[,<b.sqlite>] --from stored        stored online predictions, calibration fits; no calls
            --data … --predictor <id>[,<id>] [--candidate <cand.json>[,…]] [--repeat] [--max-usd 2]
            [--split dev|test|all] [--k 30] [--limit N] [--max-targets 40] [--since <date>]   people who joined then
            or later (ADR-0065's rule reads new people)   [--publish local|preview|prod]
  diagnose  Failure analysis of stored predictions by the reflection model (one call per person)
            --data … [--role primary|baseline|shadow] [--predictor <id>, required for shadow] [--cases 30]
            [--people 3] [--reflection-model <id>]
  benchmark Jev vs span-01 on the same sealed instances (ADR-0051, docs/CHALLENGER.md): quality, latency p50/p95,
            cost per request, error rate, and the enable/keep verdict; writes benchmark.{md,csv,json}
            --data <a.sqlite>[,<b.sqlite>] [--split test] [--seed benchmark] [--limit N] [--max-targets 40]
            [--incumbent decision:typesafe/jev-1.13@jev-predict.v2] [--challenger <id>] [--max-usd 1] [--offline]
            [--summary <file>]   also appends the Markdown there (GitHub's step summary)
  evidence  E6 (docs/EVIDENCE.md): what the mimic learns from. Jev and an LLM each predict the same sealed questions
            from one view of the state (context, full, answers, derived, relevant); lift over context, against full,
            dose and response, individuation, reproduction checks and EVIDENCE_RULE's verdict
            --data <a.sqlite>[,<b.sqlite>] [--split all] [--k 10,30,100] [--max-targets 20] [--limit N]
            [--jev <id>] [--llm <id>|none] [--views a,b] [--llm-views a,b] [--llm-people 40] [--llm-k 30]
            [--max-usd 4] [--concurrency 8] [--probes-only] [--publish local|preview|prod] [--summary <file>]
            [--offline]
  optimize  GEPA-style reflective prompt optimization (docs/OPTIMIZATION.md §6); resumable with --run-dir
            --data … --predictor decision:typesafe/jev-1.13 | llm:<model> [--candidate <seed.json>] [--components a,b]
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

function parseStrategy(v: string): StateStrategy {
  if (!(STATE_STRATEGIES as readonly string[]).includes(v))
    throw new Error(`unknown state strategy ${v}; one of ${STATE_STRATEGIES.join(', ')}`);
  return v as StateStrategy;
}

function parsePolicy(v: string): EvidencePolicy {
  if (!(EVIDENCE_POLICIES as readonly string[]).includes(v))
    throw new Error(`unknown evidence policy ${v}; one of ${EVIDENCE_POLICIES.join(', ')}`);
  return v as EvidencePolicy;
}

async function replayCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      predictor: { type: 'string', default: 'decision:typesafe/jev-1.13' },
      state: { type: 'string', default: 'full' },
      evidence: { type: 'string' },
      'max-evidence': { type: 'string' },
      budget: { type: 'string' },
      views: { type: 'string' },
      rows: { type: 'boolean', default: false },
      'per-target': { type: 'boolean', default: false },
      embed: { type: 'boolean', default: false },
      'max-targets': { type: 'string' },
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
  if (values.embed && !values['per-target']) throw new Error('--embed needs --per-target');
  const data = resolve(values.data);
  const engine = await openLocalEngine({ db: data, providers: values.offline ? 'offline' : 'live' });
  const hash = await datasetHash(engine.client);
  const limit = values.limit ? Number(values.limit) : undefined;
  let run: EvalRunRecord;
  let rows: unknown[] | undefined;
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
        strategy: parseStrategy(values.state),
        ...(values.evidence ? { evidencePolicy: parsePolicy(values.evidence) } : {}),
        ...(values['max-evidence'] ? { maxEvidence: Number(values['max-evidence']) } : {}),
        ...(values.budget ? { budgetTokens: Number(values.budget) } : {}),
        ...(values.views ? { views: values.views.split(',').map((v) => parseStrategy(v.trim())) } : {}),
        ...(values['per-target'] ? { perTarget: true } : {}),
        ...(values.embed ? { embed: true } : {}),
        ...(values['max-targets'] ? { maxTargets: Number(values['max-targets']) } : {}),
        checkpoints: list(values.checkpoints),
        split: values.split as 'dev' | 'test' | 'all',
        targets: values.targets as 'later' | 'heldout',
        seed: values.seed,
        ...(limit ? { limitPeople: limit } : {}),
      },
      hash,
    );
    run = r.run;
    rows = r.rows;
  }
  const files = writeReport(run);
  // Every scored row beside the report, so two runs can be compared pairwise by question.
  if (values.rows && rows) writeFileSync(resolve(files.md, '..', 'rows.json'), `${JSON.stringify(rows)}\n`);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
  engine.close();
  if (run.status === 'failed') {
    console.error(`Every prediction failed; first error: ${String(run.metrics?.firstError)}`);
    process.exitCode = 1;
  }
}

async function footprintCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      out: { type: 'string' },
      propose: { type: 'boolean', default: false },
      db: { type: 'string', default: 'data/session.sqlite' },
      mimic: { type: 'string' },
      live: { type: 'boolean', default: false },
    },
  });
  if (!values.dir) throw new Error('--dir is required');
  const { docs, reports } = parseFootprintDir(resolve(values.dir));
  for (const r of reports)
    console.log(
      `${r.file.padEnd(28)} ${String(r.docs).padStart(4)} docs · dropped: empty ${r.dropped.empty}, not own ${r.dropped.notOwn}, sensitive ${r.dropped.sensitive}, duplicate ${r.dropped.duplicate}`,
    );
  console.log(`${docs.length} documents, about ${footprintTokens(docs)} tokens`);
  if (values.out) {
    writeFileSync(resolve(values.out), `${JSON.stringify(docs, null, 2)}\n`);
    console.log(`wrote ${values.out}`);
  }
  if (values.propose) {
    if (!values.mimic) throw new Error('--mimic is required with --propose');
    const engine = await openLocalEngine({
      db: resolve(values.db),
      providers: values.live ? 'live' : 'offline',
    });
    const r = await proposeFromFootprint(engine.deps, values.mimic, { docs });
    console.log(
      `read ${r.docs} documents (${r.tokens} tokens): ${r.proposed} proposed, ${r.pooled} pooled; dropped ${JSON.stringify(r.dropped)}`,
    );
    engine.close();
  }
}

async function populationCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      agents: { type: 'string', default: '100' },
      k: { type: 'string', default: '5' },
      kappa: { type: 'string', default: '10' },
      'min-people': { type: 'string', default: '5' },
      split: { type: 'string', default: 'dev' },
      population: { type: 'string', default: 'real' },
      seed: { type: 'string', default: 'population' },
      name: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  if (values.population !== 'real' && values.population !== 'all')
    throw new Error('--population must be real or all');
  const engine = await openLocalEngine({ db: resolve(values.data), providers: 'offline' });
  const { run, doc } = await buildPopulation(
    engine.deps,
    {
      name: values.name ?? `population ${values.agents} agents`,
      split: values.split as 'dev' | 'test' | 'all',
      population: values.population,
      agents: Number(values.agents),
      k: Number(values.k),
      kappa: Number(values.kappa),
      minPeople: Number(values['min-people']),
      seed: values.seed,
    },
    await datasetHash(engine.client),
  );
  const files = writeReport(run);
  const out = resolve(files.md, '..', 'population.json');
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}\npopulation → ${out}`);
  engine.close();
}

async function probesCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      population: { type: 'string', default: 'real' },
      seed: { type: 'string', default: 'probes' },
      name: { type: 'string' },
      summary: { type: 'string' },
      publish: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  if (values.population !== 'real' && values.population !== 'all')
    throw new Error('--population must be real or all');
  const data = resolve(values.data);
  const engine = await openLocalEngine({ db: data, providers: 'offline' });
  const hash = await datasetHash(engine.client);
  let run: Awaited<ReturnType<typeof probeReadout>>['run'];
  try {
    ({ run } = await probeReadout(
      engine.deps,
      { name: values.name ?? 'E7 probes', population: values.population, seed: values.seed },
      hash,
    ));
  } finally {
    engine.close();
  }
  if (values.population === 'all')
    console.warn('⚠ Includes scripted or imported people: a check of the machinery, not a result.');
  const md = await recordRun(run, { instances: [], datasetHash: hash, files: [data] }, values);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${md}`);
}

async function ensembleCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      etas: { type: 'string', default: '0.5,1,2' },
      'with-baseline': { type: 'boolean', default: false },
      split: { type: 'string', default: 'all' },
      limit: { type: 'string' },
      seed: { type: 'string', default: 'ensemble' },
      name: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const loaded = await loadData(values.data, loadOptsOf({ ...values, k: '30' }));
  const etas = values.etas
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
  const { run } = ensembleRun(
    loaded.instances,
    {
      name: values.name ?? 'ensemble of stored predictions',
      etas,
      withBaseline: values['with-baseline'],
      seed: values.seed,
    },
    loaded.datasetHash,
    Date.now(),
  );
  const files = writeReport(run);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
}

async function transferCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      readers: { type: 'string', default: 'llm:deepseek/deepseek-v4.1-flash' },
      views: { type: 'string', default: TRANSFER_VIEWS.join(',') },
      checkpoints: { type: 'string', default: '10,20' },
      split: { type: 'string', default: 'dev' },
      targets: { type: 'string', default: 'later' },
      draft: { type: 'boolean', default: false },
      'card-max': { type: 'string', default: '12' },
      'card-policy': { type: 'string', default: 'surprise' },
      limit: { type: 'string' },
      'max-targets': { type: 'string' },
      seed: { type: 'string', default: 'transfer' },
      name: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const engine = await openLocalEngine({
    db: resolve(values.data),
    providers: values.offline ? 'offline' : 'live',
  });
  const views = values.views.split(',').map((v) => v.trim());
  for (const v of views)
    if (!(TRANSFER_VIEWS as readonly string[]).includes(v))
      throw new Error(`unknown view ${v}; one of ${TRANSFER_VIEWS.join(', ')}`);
  const { run } = await transfer(
    engine.deps,
    {
      name: values.name ?? `transfer ${views.join(',')}`,
      readers: values.readers.split(',').map((r) => r.trim()),
      views: views as TransferView[],
      checkpoints: list(values.checkpoints),
      split: values.split as 'dev' | 'test' | 'all',
      targets: values.targets as 'later' | 'heldout',
      draft: values.draft,
      cardMaxEvidence: Number(values['card-max']),
      cardPolicy: parsePolicy(values['card-policy']),
      seed: values.seed,
      ...(values.limit ? { limitPeople: Number(values.limit) } : {}),
      ...(values['max-targets'] ? { maxTargets: Number(values['max-targets']) } : {}),
    },
    await datasetHash(engine.client),
  );
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
      series: { type: 'boolean', default: false },
      categories: { type: 'string' },
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
    'voi-v8': VOI_SELECTOR_V8,
  };
  const categories = values.categories
    ? values.categories.split(',').map((c) => Category.parse(c.trim()))
    : undefined;
  const chosen = values.selector.split(',').map((s) => s.trim());
  for (const s of chosen) if (!selectors[s]) throw new Error(`unknown selector ${s}`);
  const { run } = await simulateSelection(
    engine.deps,
    {
      name: `select ${chosen.join(' vs ')}${categories ? ` (${categories.join(', ')})` : ''}`,
      selectors: chosen.map((label) => ({ label, selector: selectors[label]! })),
      budgets: list(values.budget),
      split: values.split as 'dev' | 'test' | 'all',
      seed: values.seed,
      population: !values['no-population'],
      series: values.series,
      ...(categories ? { categories } : {}),
      ...(values.limit ? { limitPeople: Number(values.limit) } : {}),
    },
    await datasetHash(engine.client),
  );
  const files = writeReport(run);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
  engine.close();
}

async function rubricCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      arm: { type: 'boolean', default: false },
      population: { type: 'string' },
      name: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const engine = await openLocalEngine({ db: resolve(values.data), providers: 'offline' });
  const population = values.population?.split(',').map((p) => {
    const x = p.trim();
    if (!(POPULATIONS as readonly string[]).includes(x))
      throw new Error(`unknown population ${x} (${POPULATIONS.join(', ')})`);
    return x as Population;
  });
  const { run } = await rubricRun(
    engine.deps,
    {
      name: values.name ?? 'rubric',
      byArm: values.arm,
      ...(population ? { population } : {}),
    },
    await datasetHash(engine.client),
  );
  const files = writeReport(run);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
  engine.close();
}

async function armsCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      experiment: { type: 'string' },
      population: { type: 'string', default: 'real' },
      seed: { type: 'string' },
      name: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  if (values.population !== 'real' && values.population !== 'all')
    throw new Error('--population is real or all');
  const engine = await openLocalEngine({ db: resolve(values.data), providers: 'offline' });
  const { run, people } = await armsRun(
    engine.deps,
    {
      name: values.name ?? 'arms',
      population: values.population,
      ...(values.experiment ? { experimentId: values.experiment } : {}),
      ...(values.seed ? { seed: values.seed } : {}),
    },
    await datasetHash(engine.client),
  );
  if (values.population === 'all' && people.some((p) => p.population !== 'real'))
    console.warn('⚠ Includes scripted or imported people: a check of the machinery, not a result.');
  const files = writeReport(run);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}`);
  engine.close();
}

async function cohortCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      preset: { type: 'string', default: 'e3b' },
      people: { type: 'string', default: '8' },
      turns: { type: 'string', default: '32' },
      db: { type: 'string', default: 'data/cohort.sqlite' },
      blobs: { type: 'string', default: 'data/blobs' },
      live: { type: 'boolean', default: false },
    },
  });
  const engine = await openLocalEngine({
    db: resolve(values.db),
    blobsDir: resolve(values.blobs),
    providers: values.live ? 'live' : 'offline',
  });
  console.warn(
    '⚠ Scripted answers: this checks which arm asks what and when. Its fidelity is never a result.',
  );
  console.log(`providers: ${values.live ? 'live' : 'offline fakes (zero spend; outputs are arbitrary)'}`);
  const { experimentId, mimics } = await runCohort(engine, {
    preset: values.preset,
    people: Number(values.people),
    turns: Number(values.turns),
    onSession: (x) => console.log(`${x.arm.padEnd(8)} ${x.persona.padEnd(24)} ${x.mimicId}`),
  });
  console.log(`\nexperiment ${experimentId}: ${mimics.length} sessions written to ${values.db}`);
  console.log(
    `next: pnpm eval -- rubric --data ${values.db} --arm; pnpm eval -- arms --data ${values.db} --population all`,
  );
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
    case 'rubric':
      return rubricCmd(rest);
    case 'arms':
      return armsCmd(rest);
    case 'cohort':
      return cohortCmd(rest);
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
    case 'transfer':
      return transferCmd(rest);
    case 'probes':
      return probesCmd(rest);
    case 'ensemble':
      return ensembleCmd(rest);
    case 'population':
      return populationCmd(rest);
    case 'footprint':
      return footprintCmd(rest);
    case 'import':
      return importCmd(rest);
    case 'report':
      return reportCmd(rest);
    case 'evaluate':
      return evaluateCmd(rest);
    case 'diagnose':
      return diagnoseCmd(rest);
    case 'benchmark':
      return benchmarkCmd(rest);
    case 'evidence':
      return evidenceCmd(rest);
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

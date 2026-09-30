import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  COMPONENT_IDS,
  type ComponentId,
  type EvalRunRecord,
  parsePredictorId,
  seededRng,
  shuffle,
  ulid,
} from '@mimic/core';
import { datasetHash } from '../export';
import { openLocalEngine } from '../local';
import { publishReport, renderReport, writeReport } from '../report';
import {
  BudgetStop,
  breakdown,
  type Candidate,
  CandidateInput,
  calibrationFits,
  type EvalRecord,
  evaluateCandidate,
  groupBy,
  Meter,
  noiseSd,
  pairedComparisons,
  pairedDelta,
  resolveCandidate,
  selfConsistencyOf,
  storedRecords,
} from './evaluate';
import { DEFAULT_COMPONENTS, type OptimizeSpec, optimize, variantSnippet } from './gepa';
import { type EvalInstance, loadInstances, personLabel } from './instances';
import { DIAGNOSE_PROMPT_VERSION, diagnose, REFLECT_PROMPT_VERSION } from './reflect';

/** Offline reflection model for optimization runs: strong, and cheap at the ~10–40 calls a run makes (ADR-0028). */
export const DEFAULT_REFLECTION_MODEL = 'anthropic/claude-sonnet-5.5';

type Env = 'local' | 'preview' | 'prod';

export type { Env };

interface Loaded {
  instances: EvalInstance[];
  datasetHash: string;
  files: string[];
}

/** Loads instances from one or more data files (a prod export, a Twin-2K-500 import, …). */
async function loadData(
  data: string,
  opts: { split: 'dev' | 'test' | 'all'; k: number; limitPeople?: number; maxTargets?: number; seed: string },
): Promise<Loaded> {
  const files = data
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => resolve(f));
  if (!files.length) throw new Error('--data is required');
  const instances: EvalInstance[] = [];
  const hashes: string[] = [];
  for (const f of files) {
    const engine = await openLocalEngine({ db: f, providers: 'offline' });
    try {
      hashes.push(await datasetHash(engine.client));
      const loadOpts: Parameters<typeof loadInstances>[1] = { k: opts.k, split: opts.split, seed: opts.seed };
      if (opts.limitPeople) loadOpts.limitPeople = opts.limitPeople;
      if (opts.maxTargets) loadOpts.maxTargetsPerPerson = opts.maxTargets;
      instances.push(...(await loadInstances(engine.deps, loadOpts)));
    } finally {
      engine.close();
    }
  }
  const combined =
    hashes.length === 1 ? hashes[0]! : createHash('sha256').update(hashes.join('\n')).digest('hex');
  return { instances, datasetHash: combined, files };
}

/**
 * Records the run in the first data file's eval_runs, writes data/reports/<id>/, optionally appends the Markdown to a
 * summary file (GitHub's step summary), and optionally publishes to /lab. Reports hold aggregates and prompt text
 * only, never a person's questions or answers.
 */
async function recordRun(
  run: EvalRunRecord,
  loaded: Loaded,
  opts: { publish?: string | undefined; summary?: string | undefined },
): Promise<string> {
  const engine = await openLocalEngine({ db: loaded.files[0]!, providers: 'offline' });
  try {
    await engine.deps.store.putEvalRun(run);
  } finally {
    engine.close();
  }
  const files = writeReport(run);
  if (opts.summary) appendFileSync(opts.summary, `${renderReport(run)}\n\n`);
  if (opts.publish) {
    if (!['local', 'preview', 'prod'].includes(opts.publish))
      throw new Error('--publish must be local, preview or prod');
    console.log(
      `published to ${opts.publish}: ${publishReport(run, files, opts.publish as Env)} (visible in /lab)`,
    );
  }
  return files.md;
}

/** A positive number option (workflow inputs arrive as strings). */
function positive(name: string, v: string | undefined, integer = true): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n)))
    throw new Error(`--${name} must be a positive ${integer ? 'integer' : 'number'}`);
  return n;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function candidatesFrom(values: {
  candidate?: string | undefined;
  predictor?: string | undefined;
}): Candidate[] {
  const out: Candidate[] = [];
  for (const id of list(values.predictor)) {
    parsePredictorId(id);
    out.push(resolveCandidate({ predictor: id, label: id }));
  }
  for (const f of list(values.candidate))
    out.push(resolveCandidate(CandidateInput.parse(JSON.parse(readFileSync(resolve(f), 'utf8')))));
  return out;
}

const COMMON = {
  data: { type: 'string' },
  split: { type: 'string', default: 'dev' },
  k: { type: 'string', default: '30' },
  limit: { type: 'string' },
  'max-targets': { type: 'string', default: '40' },
  seed: { type: 'string', default: 'optimize' },
  name: { type: 'string' },
  offline: { type: 'boolean', default: false },
  publish: { type: 'string' },
  summary: { type: 'string' },
  out: { type: 'string' },
} as const;

function loadOptsOf(v: {
  split?: string;
  k?: string;
  limit?: string;
  'max-targets'?: string;
  seed?: string;
}) {
  if (!['dev', 'test', 'all'].includes(v.split ?? 'dev')) throw new Error('--split must be dev, test or all');
  const o: Parameters<typeof loadData>[1] = {
    split: (v.split ?? 'dev') as 'dev' | 'test' | 'all',
    k: positive('k', v.k ?? '30'),
    seed: v.seed ?? 'optimize',
    maxTargets: positive('max-targets', v['max-targets'] ?? '40'),
  };
  if (v.limit) o.limitPeople = positive('limit', v.limit);
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------------------------------------------

export async function evaluateCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON,
      from: { type: 'string' },
      predictor: { type: 'string' },
      candidate: { type: 'string' },
      split: { type: 'string' },
      repeat: { type: 'boolean', default: false },
      'max-usd': { type: 'string', default: '2' },
      concurrency: { type: 'string', default: '8' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const stored = values.from === 'stored';
  // The stored report compares dev (fit) with test (check), so it reads every split unless told otherwise; a live
  // evaluation defaults to dev people.
  const split = values.split ?? (stored ? 'all' : 'dev');
  const loaded = await loadData(values.data, loadOptsOf({ ...values, split }));
  console.log(
    `${loaded.instances.length} instances from ${new Set(loaded.instances.map((i) => i.mimicId)).size} people`,
  );
  const people = new Set(loaded.instances.map((i) => i.mimicId)).size;
  let run: EvalRunRecord;
  if (stored) {
    const recs = storedRecords(loaded.instances);
    const groups = groupBy(recs, (r) => r.candidate);
    const predictors = [...groups.entries()]
      .sort(([a], [b]) => roleOrder(a) - roleOrder(b) || a.localeCompare(b))
      .map(([key, rs]) => ({ predictor: key.split('|')[0]!, role: key.split('|')[1]!, ...breakdown(rs) }));
    run = {
      id: ulid(),
      name: values.name ?? 'evaluate stored predictions',
      spec: {
        kind: 'evaluate',
        mode: 'stored',
        data: loaded.files.length,
        split,
        seed: values.seed,
      },
      datasetHash: loaded.datasetHash,
      status: 'done',
      metrics: {
        people,
        instances: loaded.instances.length,
        withWhy: loaded.instances.filter((i) => i.why).length,
        revealed: loaded.instances.filter((i) => i.revealed).length,
        predictors,
        selfConsistency: selfConsistencyOf(loaded.instances),
        fits: calibrationFits(loaded.instances),
        paired: pairedComparisons(recs),
      },
      r2ReportKey: null,
      createdAt: Date.now(),
    };
  } else {
    const cands = candidatesFrom(values);
    if (!cands.length) throw new Error('give --predictor and/or --candidate (or --from stored)');
    const runDir = resolve(values.out ?? `data/evaluate/${ulid()}`);
    mkdirSync(runDir, { recursive: true });
    const engine = await openLocalEngine({
      db: join(runDir, 'calls.sqlite'),
      blobsDir: join(runDir, 'traces'),
      providers: values.offline ? 'offline' : 'live',
    });
    const meter = new Meter(positive('max-usd', values['max-usd'], false));
    const results: Array<{ c: Candidate; recs: EvalRecord[] }> = [];
    const concurrency = positive('concurrency', values.concurrency);
    let stopReason: string | null = null;
    try {
      const cache = new Map<string, EvalRecord>();
      for (const c of cands) {
        let recs: EvalRecord[];
        try {
          recs = await evaluateCandidate(c, loaded.instances, {
            gateway: engine.deps.gateway,
            meter,
            concurrency,
            cache,
          });
        } catch (e) {
          if (!(e instanceof BudgetStop)) throw e;
          // The spend cap stops new work; report what was paid for (a partial candidate included) instead of
          // discarding it. A partial candidate is compared on the instances it covers.
          const partial = loaded.instances
            .map((i) => cache.get(`${c.hash}|${i.id}`))
            .filter((r): r is EvalRecord => !!r);
          stopReason = `${e.message}; ${c.label} scored on ${partial.length} of ${loaded.instances.length} instances${cands.at(-1) === c ? '' : ', later candidates not at all'}`;
          console.warn(`stopped: ${stopReason}`);
          if (partial.length) results.push({ c, recs: partial });
          if (!results.length) throw e;
          break;
        }
        results.push({ c, recs });
        console.log(
          `${c.label}: log loss ${breakdown(recs).all.logLoss.toFixed(4)} ($${meter.usd.toFixed(4)} so far)`,
        );
      }
      let noise: number | null = null;
      if (values.repeat && !stopReason) {
        try {
          const again = await evaluateCandidate(cands[0]!, loaded.instances, {
            gateway: engine.deps.gateway,
            meter,
            concurrency,
            fresh: true,
          });
          noise = noiseSd(results[0]!.recs, again);
        } catch (e) {
          if (!(e instanceof BudgetStop)) throw e;
          stopReason = `${e.message}; the repeat pass was not completed`;
          console.warn(`stopped: ${stopReason}`);
        }
      }
      writeFileSync(
        join(runDir, 'records.jsonl'),
        `${results.flatMap((r) => r.recs.map((x) => JSON.stringify({ ...x, raw: undefined }))).join('\n')}\n`,
      );
      run = {
        id: ulid(),
        name: values.name ?? `evaluate ${cands.map((c) => c.label).join(' vs ')}`,
        spec: { kind: 'evaluate', mode: 'live', split, k: values.k, seed: values.seed, stopReason },
        datasetHash: loaded.datasetHash,
        status: 'done',
        metrics: {
          people,
          instances: loaded.instances.length,
          costUsd: meter.usd,
          noiseSd: noise,
          stopReason,
          candidates: results.map(({ c, recs }, i) => ({
            label: c.label,
            hash: c.hash,
            ...breakdown(recs),
            vsFirst: i ? pairedDelta(results[0]!.recs, recs, 'value', `vs:${i}`) : null,
            modelSnapshots: [...new Set(recs.map((r) => r.modelSnapshot))].sort(),
          })),
        },
        r2ReportKey: null,
        createdAt: Date.now(),
      };
    } finally {
      engine.close();
    }
    console.log(`records → ${join(runDir, 'records.jsonl')} (local only: contains answers)`);
  }
  const md = await recordRun(run, loaded, { publish: values.publish, summary: values.summary });
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${md}`);
}

function roleOrder(key: string): number {
  return { primary: 0, baseline: 1, shadow: 2 }[key.split('|')[1] ?? ''] ?? 3;
}

// ---------------------------------------------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------------------------------------------

export async function diagnoseCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON,
      predictor: { type: 'string', default: 'jev:typesafe/jev-1.13' },
      role: { type: 'string', default: 'primary' },
      cases: { type: 'string', default: '30' },
      people: { type: 'string', default: '3' },
      'reflection-model': { type: 'string', default: DEFAULT_REFLECTION_MODEL },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const loaded = await loadData(values.data, loadOptsOf(values));
  const byId = new Map(loaded.instances.map((i) => [i.id, i]));
  const recs = storedRecords(loaded.instances).filter(
    (r) =>
      r.candidate ===
      `${values.predictor}|${values.role === 'primary' || values.role === 'baseline' ? values.role : 'shadow'}`,
  );
  if (!recs.length)
    throw new Error(`no stored ${values.role} predictions from ${values.predictor} in ${values.split}`);
  // One call per person (invariant 8: no prompt mixes people), for the people with the most predictions, each on
  // mostly their costliest misses plus a sample of the rest, so the analysis also sees what works.
  const n = positive('cases', values.cases);
  const maxPeople = positive('people', values.people);
  const byPerson = new Map<string, EvalRecord[]>();
  for (const r of recs) {
    const list = byPerson.get(r.mimicId);
    if (list) list.push(r);
    else byPerson.set(r.mimicId, [r]);
  }
  const people = [...byPerson.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, maxPeople);
  const out = resolve(values.out ?? `data/diagnose/${ulid()}.md`);
  mkdirSync(dirname(out), { recursive: true });
  // The calls are logged next to the report (invariant 5), like evaluate and optimize do in their run directories.
  const engine = await openLocalEngine({
    db: join(dirname(out), 'calls.sqlite'),
    blobsDir: join(dirname(out), 'traces'),
    providers: values.offline ? 'offline' : 'live',
  });
  const sections: string[] = [];
  let total = 0;
  try {
    for (const [mimicId, rs] of people) {
      const worst = [...rs].sort((x, y) => x.value - y.value).slice(0, Math.ceil(n * 0.7));
      const rest = shuffle(
        rs.filter((r) => !worst.includes(r)),
        seededRng(`${values.seed}:${mimicId}`),
      ).slice(0, n - worst.length);
      const { markdown, costUsd } = await diagnose(
        engine.deps.gateway,
        values['reflection-model'],
        values.predictor,
        byId,
        [...worst, ...rest],
      );
      total += costUsd;
      sections.push(
        `## ${personLabel(mimicId)} (${rs.length} predictions, ${worst.length + rest.length} cases)\n\n${markdown}`,
      );
    }
  } finally {
    engine.close();
  }
  const body = `# Diagnosis: ${values.predictor} (${values.role}, ${values.split})\n\n${recs.length} stored predictions from ${byPerson.size} people; ${people.length} analysed one person per call by ${values['reflection-model']} (prompt ${DIAGNOSE_PROMPT_VERSION}, $${total.toFixed(4)}).\n\n${sections.join('\n\n')}\n`;
  writeFileSync(out, body);
  console.log(`${body}\n→ ${out} (local only: it describes people's answers)`);
}

// ---------------------------------------------------------------------------------------------------------------
// optimize
// ---------------------------------------------------------------------------------------------------------------

export async function optimizeCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON,
      split: { type: 'string', default: 'all' },
      predictor: { type: 'string', default: 'jev:typesafe/jev-1.13' },
      candidate: { type: 'string' },
      components: { type: 'string' },
      'reflection-model': { type: 'string', default: DEFAULT_REFLECTION_MODEL },
      'max-metric-calls': { type: 'string', default: '400' },
      'max-usd': { type: 'string', default: '2' },
      minibatch: { type: 'string', default: '8' },
      'val-size': { type: 'string', default: '60' },
      'holdout-size': { type: 'string', default: '80' },
      'max-iterations': { type: 'string', default: '30' },
      'max-minutes': { type: 'string' },
      'no-noise': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '8' },
      'run-dir': { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  if (values.split !== 'all')
    throw new Error('optimize reads every split: dev people train and validate, test people are the holdout');
  const seedInput: CandidateInput = values.candidate
    ? CandidateInput.parse(JSON.parse(readFileSync(resolve(values.candidate), 'utf8')))
    : { predictor: values.predictor, label: `seed ${values.predictor}` };
  const seed = resolveCandidate(seedInput);
  const components = (
    values.components ? list(values.components) : DEFAULT_COMPONENTS[seed.kind]
  ) as ComponentId[];
  for (const c of components) if (!COMPONENT_IDS.includes(c)) throw new Error(`unknown component ${c}`);
  const loaded = await loadData(values.data, loadOptsOf(values));
  const spec: OptimizeSpec = {
    name: values.name ?? `optimize ${seed.kind === 'jev' ? 'Jev templates' : 'LLM prompt'} (${seed.model})`,
    seed: seedInput,
    components,
    reflectionModel: values['reflection-model'],
    maxMetricCalls: positive('max-metric-calls', values['max-metric-calls']),
    maxUsd: positive('max-usd', values['max-usd'], false),
    minibatch: positive('minibatch', values.minibatch),
    valSize: positive('val-size', values['val-size']),
    holdoutSize: positive('holdout-size', values['holdout-size']),
    maxIterations: positive('max-iterations', values['max-iterations']),
    noise: !values['no-noise'],
    concurrency: positive('concurrency', values.concurrency),
    rngSeed: values.seed,
  };
  const runDir = resolve(values['run-dir'] ?? `data/optimize/${ulid()}`);
  mkdirSync(runDir, { recursive: true });
  const engine = await openLocalEngine({
    db: join(runDir, 'calls.sqlite'),
    blobsDir: join(runDir, 'traces'),
    providers: values.offline ? 'offline' : 'live',
  });
  // Wall clock for this invocation (not saved with the run): the loop stops cleanly in time to write its report.
  const maxMinutes = values['max-minutes'] ? positive('max-minutes', values['max-minutes'], false) : null;
  const deadline = maxMinutes === null ? undefined : Date.now() + maxMinutes * 60_000;
  let result: Awaited<ReturnType<typeof optimize>>;
  try {
    result = await optimize(
      { gateway: engine.deps.gateway, runDir, log: (l) => console.log(l), ...(deadline ? { deadline } : {}) },
      spec,
      loaded.instances,
    );
  } finally {
    engine.close();
  }
  const r = result;
  const outcomes: Record<string, number> = {};
  for (const h of r.state.history) outcomes[h.outcome] = (outcomes[h.outcome] ?? 0) + 1;
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: {
      kind: 'optimize',
      ...spec,
      seed: spec.rngSeed,
      seedCandidate: spec.seed,
      reflectPrompt: REFLECT_PROMPT_VERSION,
      data: loaded.files.length,
    },
    datasetHash: loaded.datasetHash,
    status: 'done',
    metrics: {
      verdict: r.verdict,
      improved: r.improved,
      suggestedVersion: r.suggestedVersion,
      stopReason: r.state.stopReason,
      split: {
        by: r.state.split.by,
        train: r.state.split.train.length,
        val: r.state.split.val.length,
        holdout: r.state.split.holdout.length,
      },
      noise: r.state.noise,
      spend: r.state.meter,
      iterations: r.state.iteration,
      outcomes,
      poolSize: r.state.pool.length,
      val: r.val,
      holdout: r.holdout,
      best: {
        label: r.best.candidate.label,
        hash: r.best.candidate.hash,
        components: r.bestInput.components,
        harness: r.bestInput.harness,
      },
      pool: r.state.pool.map((p) => ({
        label: p.candidate.label,
        parent: p.parent,
        valMean: p.valMean,
        failures: p.valFailures,
      })),
    },
    r2ReportKey: null,
    createdAt: Date.now(),
  };
  writeFileSync(join(runDir, 'best.candidate.json'), `${JSON.stringify(r.bestInput, null, 2)}\n`);
  const snippet = variantSnippet(r, run.id);
  if (snippet) writeFileSync(join(runDir, 'variant.snippet.txt'), `${snippet}\n`);
  const md = await recordRun(run, loaded, { publish: values.publish, summary: values.summary });
  writeFileSync(join(runDir, 'report.md'), `${renderReport(run)}\n`);
  console.log(`\n${renderReport(run)}\n\nrun ${run.id} → ${md}; run dir ${runDir}`);
  if (snippet)
    console.log(`\nRegister the winner in packages/core/src/components.ts (PREDICT_PROMPTS):\n${snippet}`);
}

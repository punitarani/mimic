import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  canonicalPredictorId,
  DEFAULT_CONFIG,
  JEV_MODEL,
  parsePredictorId,
  quantile,
  SPAN_MODEL,
  servedPredictorId,
  ulid,
} from '@mimic/core';
import { openLocalEngine } from './local';
import { loadData, loadOptsOf, positive } from './optimize/commands';
import {
  BudgetStop,
  type Candidate,
  type EvalRecord,
  evaluateCandidate,
  groupBy,
  jevRequests,
  Meter,
  metricsOf,
  type PairedDelta,
  pairedDelta,
  resolveCandidate,
} from './optimize/evaluate';
import type { EvalInstance } from './optimize/instances';

/**
 * Jev versus span-01 on the same sealed instances (ADR-0051, docs/CHALLENGER.md). Both run through the same predictor
 * code, prompt and calibration, with no flag and no fallback, so each model's own quality, latency, cost and errors
 * are measured. The verdict applies DECISION_RULE.
 */

/**
 * The production primary, and the same predictor on span-01: exactly what `decisions-model: span-01` serves, under
 * the ID its served rows are stored with (ADR-0054).
 */
export const INCUMBENT = canonicalPredictorId(DEFAULT_CONFIG.predictor.primary);
export const CHALLENGER = challengerOf(INCUMBENT);

export function challengerOf(incumbent: string, model: string = SPAN_MODEL): string {
  const spec = parsePredictorId(incumbent);
  if (spec.kind !== 'decision' || spec.model !== JEV_MODEL)
    throw new Error(`${incumbent} is not a Jev predictor`);
  return servedPredictorId(incumbent, model);
}

/**
 * Enable span-01 only if it beats Jev on quality without an unacceptable regression elsewhere:
 * - quality: log loss lower, with the upper end of the paired bootstrap interval of (span-01 − Jev) below 0, and
 *   item accuracy no more than `maxAccuracyDrop` lower;
 * - errors: error rate at most `maxErrorRateIncrease` above Jev's (each error is a fallback to Jev, so it costs both
 *   calls' latency);
 * - latency: p50 and p95 per request at most `maxLatencyRatio` × Jev's;
 * - cost: per request at most `maxCostRatio` × Jev's;
 * - enough data: at least `minPredictions` paired predictions from `minPeople` people.
 */
export const DECISION_RULE = {
  maxAccuracyDrop: 0.01,
  maxErrorRateIncrease: 0.01,
  maxLatencyRatio: 1.5,
  maxCostRatio: 1.5,
  minPredictions: 200,
  minPeople: 5,
} as const;

export interface BenchmarkRow {
  role: 'incumbent' | 'challenger';
  predictorId: string;
  modelSnapshots: string[];
  predictions: number;
  requests: number;
  /** Requests that got an answer: latency is measured over these, and cost per request divides by them. */
  answeredRequests: number;
  errors: number;
  errorRate: number;
  logLoss: number;
  itemAcc: number;
  top1: number;
  brier: number;
  ece: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  costUsd: number;
  costPerRequestUsd: number;
  /**
   * Quality per question type. span-01 answers yes/no questions directly and choice and score questions one option
   * at a time (ADR-0051), so the types can differ a lot.
   */
  byType: Record<string, { predictions: number; errors: number; logLoss: number; itemAcc: number }>;
}

/** One Decisions request: the instances that shared a state (as production batches them). */
export function requestsOf(c: Candidate, instances: EvalInstance[]): string[][] {
  return (c.kind === 'decision' ? jevRequests(c, instances) : instances.map((i) => [i])).map((g) =>
    g.map((i) => i.id),
  );
}

export function summarize(
  role: BenchmarkRow['role'],
  predictorId: string,
  recs: EvalRecord[],
  requests: string[][],
): BenchmarkRow {
  const m = metricsOf(recs);
  const byId = new Map(recs.map((r) => [r.instanceId, r]));
  const reqs = requests.map((ids) => ids.map((id) => byId.get(id)).filter((r): r is EvalRecord => !!r));
  // A request that never answered (transport failure or timeout) has no latency; it counts as an error instead.
  const answered = reqs.filter((g) => g.length && g[0]!.latencyMs > 0);
  const latencies = answered.map((g) => g[0]!.latencyMs);
  const costUsd = recs.reduce((a, r) => a + r.costUsd, 0);
  const n = reqs.filter((g) => g.length).length;
  const paid = answered.length;
  return {
    role,
    predictorId,
    modelSnapshots: [...new Set(recs.filter((r) => r.ok).map((r) => r.modelSnapshot))].sort(),
    predictions: recs.length,
    requests: n,
    answeredRequests: paid,
    errors: m.failures,
    errorRate: recs.length ? m.failures / recs.length : 0,
    logLoss: m.logLoss,
    itemAcc: m.itemAcc,
    top1: m.top1,
    brier: m.brier,
    ece: m.ece,
    p50LatencyMs: latencies.length ? quantile(latencies, 0.5) : 0,
    p95LatencyMs: latencies.length ? quantile(latencies, 0.95) : 0,
    costUsd,
    costPerRequestUsd: paid ? costUsd / paid : 0,
    byType: Object.fromEntries(
      [...groupBy(recs, (r) => r.type).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, rs]) => {
          const t = metricsOf(rs);
          return [type, { predictions: t.n, errors: t.failures, logLoss: t.logLoss, itemAcc: t.itemAcc }];
        }),
    ),
  };
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Verdict {
  enable: boolean;
  checks: Check[];
  logLoss: PairedDelta;
  itemAcc: PairedDelta;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : a > 0 ? Number.POSITIVE_INFINITY : 1);
/** Latency and cost compare only when both answered: a model that never answered has neither. */
const bothAnswered = (a: BenchmarkRow, b: BenchmarkRow) => a.answeredRequests > 0 && b.answeredRequests > 0;

export function decide(
  inc: BenchmarkRow,
  chal: BenchmarkRow,
  incRecs: EvalRecord[],
  chalRecs: EvalRecord[],
  rule = DECISION_RULE,
): Verdict {
  const logLoss = pairedDelta(incRecs, chalRecs, 'logLoss', 'benchmark');
  const itemAcc = pairedDelta(incRecs, chalRecs, 'itemAcc', 'benchmark');
  const people = new Set(chalRecs.map((r) => r.mimicId)).size;
  const f = (x: number, d = 4) => x.toFixed(d);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const checks: Check[] = [
    {
      name: 'enough data',
      pass: logLoss.n >= rule.minPredictions && people >= rule.minPeople,
      detail: `${logLoss.n} paired predictions from ${people} people (needs ${rule.minPredictions} from ${rule.minPeople})`,
    },
    {
      name: 'better log loss',
      pass: logLoss.ciHigh < 0,
      detail: `Δ ${f(logLoss.mean)} [${f(logLoss.ciLow)}, ${f(logLoss.ciHigh)}] (span-01 − Jev; the interval must be below 0)`,
    },
    {
      name: 'accuracy held',
      pass: itemAcc.mean >= -rule.maxAccuracyDrop,
      detail: `Δ ${pct(itemAcc.mean)} item accuracy (no worse than −${pct(rule.maxAccuracyDrop)})`,
    },
    {
      name: 'error rate',
      pass: chal.errorRate <= inc.errorRate + rule.maxErrorRateIncrease,
      detail: `${pct(chal.errorRate)} vs ${pct(inc.errorRate)} (at most +${pct(rule.maxErrorRateIncrease)})`,
    },
    {
      name: 'latency',
      pass:
        bothAnswered(inc, chal) &&
        ratio(chal.p50LatencyMs, inc.p50LatencyMs) <= rule.maxLatencyRatio &&
        ratio(chal.p95LatencyMs, inc.p95LatencyMs) <= rule.maxLatencyRatio,
      detail: `p50 ${Math.round(chal.p50LatencyMs)} vs ${Math.round(inc.p50LatencyMs)} ms, p95 ${Math.round(chal.p95LatencyMs)} vs ${Math.round(inc.p95LatencyMs)} ms (at most ${rule.maxLatencyRatio}×)`,
    },
    {
      name: 'cost',
      pass:
        bothAnswered(inc, chal) && ratio(chal.costPerRequestUsd, inc.costPerRequestUsd) <= rule.maxCostRatio,
      detail: `$${chal.costPerRequestUsd.toFixed(6)} vs $${inc.costPerRequestUsd.toFixed(6)} per request (at most ${rule.maxCostRatio}×; per answered request)`,
    },
  ];
  return { enable: checks.every((c) => c.pass), checks, logLoss, itemAcc };
}

const COLUMNS: Array<[string, (r: BenchmarkRow) => string]> = [
  ['role', (r) => r.role],
  ['predictor', (r) => r.predictorId],
  ['model_snapshots', (r) => r.modelSnapshots.join(' ') || '-'],
  ['predictions', (r) => String(r.predictions)],
  ['requests', (r) => String(r.requests)],
  ['answered_requests', (r) => String(r.answeredRequests)],
  ['log_loss', (r) => r.logLoss.toFixed(4)],
  ['item_acc', (r) => r.itemAcc.toFixed(4)],
  ['top1', (r) => r.top1.toFixed(4)],
  ['brier', (r) => r.brier.toFixed(4)],
  ['ece', (r) => r.ece.toFixed(4)],
  ['p50_latency_ms', (r) => String(Math.round(r.p50LatencyMs))],
  ['p95_latency_ms', (r) => String(Math.round(r.p95LatencyMs))],
  ['cost_per_request_usd', (r) => r.costPerRequestUsd.toFixed(8)],
  ['cost_total_usd', (r) => r.costUsd.toFixed(6)],
  ['errors', (r) => String(r.errors)],
  ['error_rate', (r) => r.errorRate.toFixed(4)],
];

export function renderCsv(rows: BenchmarkRow[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return `${[COLUMNS.map(([h]) => h), ...rows.map((r) => COLUMNS.map(([, f]) => esc(f(r))))].map((l) => l.join(',')).join('\n')}\n`;
}

export interface BenchmarkMeta {
  runId: string;
  data: string[];
  datasetHash: string;
  split: string;
  seed: string;
  people: number;
  instances: number;
  stopReason: string | null;
  offline: boolean;
}

export function renderMarkdown(meta: BenchmarkMeta, rows: BenchmarkRow[], v: Verdict): string {
  const [inc, chal] = rows as [BenchmarkRow, BenchmarkRow];
  const row = (label: string, f: (r: BenchmarkRow) => string) => `| ${label} | ${f(inc)} | ${f(chal)} |`;
  return [
    `# Jev vs span-01 benchmark (${meta.runId})`,
    '',
    ...(meta.offline
      ? ['> Offline run with fake providers: checks the harness only. These numbers mean nothing.', '']
      : []),
    `Dataset \`${meta.datasetHash.slice(0, 16)}\` (${meta.data.join(', ')}), split \`${meta.split}\`, seed \`${meta.seed}\`: ${meta.instances} predictions from ${meta.people} people.`,
    '',
    ...(meta.stopReason ? [`**Stopped early:** ${meta.stopReason}`, ''] : []),
    '| Metric | Jev (incumbent) | span-01 (challenger) |',
    '| --- | --- | --- |',
    row('Predictor', (r) => `\`${r.predictorId}\``),
    row('Model snapshot', (r) => r.modelSnapshots.join(', ') || '(none answered)'),
    row('Log loss (lower is better)', (r) => r.logLoss.toFixed(4)),
    row('Item accuracy', (r) => r.itemAcc.toFixed(4)),
    row('Top-1 accuracy', (r) => r.top1.toFixed(4)),
    row('Brier', (r) => r.brier.toFixed(4)),
    row('ECE', (r) => r.ece.toFixed(4)),
    row(
      'Latency p50 / p95 per request',
      (r) => `${Math.round(r.p50LatencyMs)} / ${Math.round(r.p95LatencyMs)} ms`,
    ),
    row('Cost per request', (r) => `$${r.costPerRequestUsd.toFixed(6)}`),
    row('Total cost', (r) => `$${r.costUsd.toFixed(6)}`),
    row('Errors', (r) => `${r.errors} of ${r.predictions} (${(r.errorRate * 100).toFixed(1)}%)`),
    row('Requests (answered)', (r) => `${r.requests} (${r.answeredRequests})`),
    '',
    '## By question type',
    '',
    '| Type | Predictions | Log loss: Jev | Log loss: span-01 | Item accuracy: Jev | Item accuracy: span-01 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...[...new Set([...Object.keys(inc.byType), ...Object.keys(chal.byType)])].sort().map((type) => {
      const a = inc.byType[type];
      const b = chal.byType[type];
      const f = (x: number | undefined) => (x === undefined ? '-' : x.toFixed(4));
      return `| ${type} | ${a?.predictions ?? b?.predictions ?? 0} | ${f(a?.logLoss)} | ${f(b?.logLoss)} | ${f(a?.itemAcc)} | ${f(b?.itemAcc)} |`;
    }),
    '',
    'span-01 takes only yes/no questions: it answers a choice or score question as one yes/no per option, normalized',
    '(ADR-0051).',
    '',
    `## Verdict: ${v.enable ? 'enable span-01' : 'keep Jev'}`,
    '',
    '| Check | Pass | Detail |',
    '| --- | --- | --- |',
    ...v.checks.map((c) => `| ${c.name} | ${c.pass ? 'yes' : 'no'} | ${c.detail} |`),
    '',
    'Failed predictions count as uniform in log loss and accuracy. Latency is per Decisions request (questions that',
    'share a state go in one request, as in production), over requests that answered. The interval is a seeded',
    'paired bootstrap (5th–95th percentile). The rule is DECISION_RULE in packages/eval/src/benchmark.ts.',
    '',
  ].join('\n');
}

export async function benchmarkCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      incumbent: { type: 'string', default: INCUMBENT },
      challenger: { type: 'string' },
      split: { type: 'string', default: 'test' },
      k: { type: 'string', default: '30' },
      limit: { type: 'string' },
      'max-targets': { type: 'string', default: '40' },
      seed: { type: 'string', default: 'benchmark' },
      'max-usd': { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '4' },
      offline: { type: 'boolean', default: false },
      out: { type: 'string' },
      summary: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data is required');
  const incumbent = canonicalPredictorId(values.incumbent);
  const challenger = canonicalPredictorId(values.challenger ?? challengerOf(incumbent));
  const loaded = await loadData(values.data, loadOptsOf(values));
  const people = new Set(loaded.instances.map((i) => i.mimicId)).size;
  if (!loaded.instances.length) throw new Error(`no instances in ${values.data} (split ${values.split})`);
  console.log(
    `${loaded.instances.length} predictions from ${people} people; dataset ${loaded.datasetHash.slice(0, 16)}`,
  );

  const runId = ulid();
  const runDir = resolve(values.out ?? `data/benchmark/${runId}`);
  mkdirSync(runDir, { recursive: true });
  const engine = await openLocalEngine({
    db: join(runDir, 'calls.sqlite'),
    blobsDir: join(runDir, 'traces'),
    providers: values.offline ? 'offline' : 'live',
  });
  const meter = new Meter(positive('max-usd', values['max-usd'], false));
  const cands = [
    {
      role: 'incumbent' as const,
      c: resolveCandidate({ predictor: incumbent, label: incumbent }),
    },
    { role: 'challenger' as const, c: resolveCandidate({ predictor: challenger, label: challenger }) },
  ];
  const results: Array<{ role: BenchmarkRow['role']; c: Candidate; recs: EvalRecord[] }> = [];
  let stopReason: string | null = null;
  try {
    for (const { role, c } of cands) {
      const cache = new Map<string, EvalRecord>();
      try {
        const recs = await evaluateCandidate(c, loaded.instances, {
          gateway: engine.deps.gateway,
          meter,
          concurrency: positive('concurrency', values.concurrency),
          purpose: `eval.benchmark.${role}`,
          cache,
        });
        results.push({ role, c, recs });
      } catch (e) {
        if (!(e instanceof BudgetStop)) throw e;
        // Keep what was paid for; the comparison then covers the instances both predictors reached.
        stopReason = e.message;
        const partial = loaded.instances
          .map((i) => cache.get(`${c.hash}|${i.id}`))
          .filter((r): r is EvalRecord => !!r);
        results.push({ role, c, recs: partial });
        break;
      }
      console.log(`${role} ${c.label}: done ($${meter.usd.toFixed(4)} so far)`);
    }
  } finally {
    engine.close();
  }
  if (results.length < 2) throw new Error(`stopped before the challenger ran: ${stopReason}`);
  const rows = results.map(({ role, c, recs }) =>
    summarize(role, c.label, recs, requestsOf(c, loaded.instances)),
  );
  const verdict = decide(rows[0]!, rows[1]!, results[0]!.recs, results[1]!.recs);
  const meta: BenchmarkMeta = {
    runId,
    data: loaded.files,
    datasetHash: loaded.datasetHash,
    split: values.split,
    seed: values.seed,
    people,
    instances: loaded.instances.length,
    stopReason,
    offline: values.offline,
  };
  const md = renderMarkdown(meta, rows, verdict);
  writeFileSync(join(runDir, 'benchmark.md'), md);
  // GitHub's step summary (the Benchmark workflow): aggregates only, never a person's questions or answers.
  if (values.summary) appendFileSync(values.summary, `${md}\n`);
  writeFileSync(join(runDir, 'benchmark.csv'), renderCsv(rows));
  writeFileSync(join(runDir, 'benchmark.json'), `${JSON.stringify({ meta, rows, verdict }, null, 2)}\n`);
  writeFileSync(
    join(runDir, 'records.jsonl'),
    `${results.flatMap((r) => r.recs.map((x) => JSON.stringify({ role: r.role, ...x, raw: undefined }))).join('\n')}\n`,
  );
  console.log(`\n${md}`);
  console.log(`wrote ${runDir}/benchmark.{md,csv,json} and records.jsonl`);
}

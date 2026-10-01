import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalRunRecord, PredictorMetrics } from '@mimic/core';
import { type ArmsReport, renderArms } from './arms';
import { renderEnsemble } from './ensemble';
import { type EvidenceReport, renderEvidence } from './evidence';
import { MIN_INTERVAL_PEOPLE, VIEW_RULE } from './optimize/evaluate';
import { type ProbeReport, renderProbes } from './probes';
import { type RubricGroup, renderRubric } from './rubric';
import { renderPopulation } from './synthesize';
import { renderTransfer } from './transfer';
import { remoteFlags, WORKER_DIR } from './wrangler';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');
const f3 = (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : '—');
const COUNTS = new Set(['n', 'checkable', 'legacy', 'truncated', 'rescoped']);

function predictorTable(ps: PredictorMetrics[]): string {
  const rows = ps.map(
    (p) =>
      `| \`${p.predictorId}\` | ${p.role} | ${p.n} | ${pct(p.accuracy)} | ${pct(p.top1)} | ${f3(p.logLoss)} | ${f3(p.brier)} | ${f3(p.ece)} | ${p.lift === null ? '—' : (p.lift * 100).toFixed(1)} | ${pct(p.failureRate)} | $${(p.usdPer1k).toFixed(3)} | ${Math.round(p.p50LatencyMs)} ms |`,
  );
  return [
    '| Predictor | Role | n | Accuracy | Top-1 | Log loss | Brier | ECE | Lift | Failed | $/1k | p50 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Markdown report for an eval run (PLAN §12.3: records dataset hash, config, model snapshots and seed). */
export function renderReport(run: EvalRunRecord): string {
  const m = (run.metrics ?? {}) as Record<string, unknown>;
  const spec = run.spec as Record<string, unknown>;
  const lines = [
    `# ${run.name}`,
    '',
    `- Run: \`${run.id}\` · ${new Date(run.createdAt).toISOString()}`,
    `- Kind: ${String(spec.kind)} · dataset \`${run.datasetHash.slice(0, 16)}\` · seed \`${String(spec.seed ?? '')}\``,
    `- Spec: \`${JSON.stringify(spec)}\``,
  ];
  if (Array.isArray(m.modelSnapshots))
    lines.push(`- Model snapshots: ${(m.modelSnapshots as string[]).map((s) => `\`${s}\``).join(', ')}`);
  lines.push('');
  if (spec.kind === 'replay') {
    lines.push(
      `People: ${String(m.people)} · cost per person: $${Number(m.costPerPersonUsd ?? 0).toFixed(4)}`,
      '',
    );
    for (const c of (m.checkpoints as Array<Record<string, unknown>>) ?? []) {
      const across = c.acrossPeople as Record<string, unknown>;
      lines.push(
        `## After ${String(c.k)} answers (${String(c.people)} people)`,
        '',
        `Fidelity (accuracy ÷ self-consistency): ${pct(c.fidelity)} · across-person correlation: ${f3(across.meanCorrelation)} over ${String(across.items)} items · dispersion ratio: ${f3(across.meanDispersionRatio)}`,
        '',
        predictorTable(c.predictors as PredictorMetrics[]),
        '',
      );
    }
  } else if (spec.kind === 'reproduce') {
    lines.push(
      '## Online reproduction',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      ...[
        'n',
        'checkable',
        'legacy',
        'truncated',
        'rescoped',
        'stateHashMatchRate',
        'snapshotMatchRate',
        'argmaxAgreement',
        'meanTvd',
        'p95Tvd',
        'onlineAccuracy',
        'replayAccuracy',
        'meanAbsItemAccDelta',
        'pass',
      ].map((k) => `| ${k} | ${typeof m[k] === 'number' && !COUNTS.has(k) ? f3(m[k]) : String(m[k])} |`),
      '',
    );
  } else if (spec.kind === 'evaluate') {
    lines.push(...renderEvaluate(m));
  } else if (spec.kind === 'optimize') {
    lines.push(...renderOptimize(m));
  } else if (spec.kind === 'rubric') {
    lines.push(...renderRubric((m.groups as RubricGroup[]) ?? []));
  } else if (spec.kind === 'arms') {
    if (m.report) lines.push(...renderArms(m.report as ArmsReport));
  } else if (spec.kind === 'transfer') {
    lines.push(...renderTransfer(m));
  } else if (spec.kind === 'ensemble') {
    lines.push(...renderEnsemble(m));
  } else if (spec.kind === 'population') {
    lines.push(...renderPopulation(m));
  } else if (spec.kind === 'evidence') {
    if (m.report) lines.push(...renderEvidence(m.report as EvidenceReport));
  } else if (spec.kind === 'probes') {
    if (m.report) lines.push(...renderProbes(m.report as ProbeReport));
  } else if (spec.kind === 'select') {
    lines.push(
      '## Pool-restricted selection (biased; iteration only)',
      '',
      '| Selector | Budget | People | Accuracy on the rest |',
      '| --- | --- | --- | --- |',
      ...((m.results as Array<Record<string, unknown>>) ?? []).map(
        (r) =>
          `| ${String(r.selector ?? (spec.selector as { type?: string } | undefined)?.type ?? '')} | ${String(r.budget)} | ${String(r.people)} | ${pct(r.accuracy)} |`,
      ),
      '',
    );
    if (Array.isArray(m.sustained)) lines.push(...renderSeries(m));
  }
  return lines.join('\n');
}

/** `select --series` (ADR-0044): questions to sustained accuracy on the rest, and accuracy after every pick. */
function renderSeries(m: Record<string, unknown>): string[] {
  const sustained = m.sustained as Array<{
    selector: string;
    people: number;
    reached: number;
    meanQuestions: number | null;
  }>;
  const series = (m.series as Array<{ selector: string; k: number; accuracy: number | null }>) ?? [];
  const selectors = sustained.map((x) => x.selector);
  const ks = [...new Set(series.map((p) => p.k))].sort((a, b) => a - b);
  const at = (sel: string, k: number) => series.find((p) => p.selector === sel && p.k === k)?.accuracy;
  return [
    `### Questions to sustain ${pct(m.target)} accuracy on the rest`,
    '',
    '| Selector | People | Reached | Mean questions (people who reached it) |',
    '| --- | --- | --- | --- |',
    ...sustained.map(
      (x) =>
        `| ${x.selector} | ${x.people} | ${x.reached} | ${x.meanQuestions === null ? '—' : x.meanQuestions.toFixed(1)} |`,
    ),
    '',
    '### Accuracy on the rest after each pick',
    '',
    `| Picks | ${selectors.join(' | ')} |`,
    `| --- | ${selectors.map(() => '---').join(' | ')} |`,
    ...ks.map((k) => `| ${k} | ${selectors.map((s) => pct(at(s, k))).join(' | ')} |`),
    '',
  ];
}

export function writeReport(run: EvalRunRecord, dir = 'data/reports'): { json: string; md: string } {
  const base = resolve(dir, run.id);
  mkdirSync(base, { recursive: true });
  const json = join(base, 'report.json');
  const md = join(base, 'report.md');
  writeFileSync(json, `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(md, `${renderReport(run)}\n`);
  return { json, md };
}

const BUCKET: Record<string, string> = {
  local: 'mimic-blobs',
  preview: 'mimic-blobs-preview',
  prod: 'mimic-blobs-prod',
};

function wrangler(args: string[], env: 'local' | 'preview' | 'prod'): void {
  const where = env === 'local' ? ['--local', '--persist-to', '../../.wrangler/state'] : remoteFlags(env);
  const r = spawnSync('pnpm', ['exec', 'wrangler', ...args, ...where], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
  });
  if (r.status !== 0)
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${r.stderr || r.stdout}`);
}

const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** D1 caps a statement at about 100 KB; the full report is the R2 Markdown, so the row keeps a compact copy. */
export const METRICS_ROW_LIMIT = 60_000;

/**
 * Metrics small enough for one D1 statement: per-person breakdowns go first (they grow with the cohort), then
 * everything but top-level scalars. /lab renders the R2 report whenever there is one.
 */
export function compactMetrics(metrics: unknown): unknown {
  if (JSON.stringify(metrics ?? null).length <= METRICS_ROW_LIMIT) return metrics;
  const noPeople = JSON.parse(JSON.stringify(metrics), (k, v) => (k === 'byPerson' ? undefined : v));
  if (JSON.stringify(noPeople).length <= METRICS_ROW_LIMIT)
    return { ...noPeople, compacted: 'per-person rows in the R2 report' };
  const scalars = Object.fromEntries(
    Object.entries((metrics ?? {}) as Record<string, unknown>).filter(
      ([, v]) => v === null || typeof v !== 'object',
    ),
  );
  return { ...scalars, compacted: 'see the R2 report' };
}

/** `mimic-eval report --to <env>`: uploads report.{json,md} to R2 and the eval_runs row to D1, so /lab shows it. */
export function publishReport(
  run: EvalRunRecord,
  files: { json: string; md: string },
  env: 'local' | 'preview' | 'prod',
) {
  const key = `evals/${run.id}/report`;
  wrangler(
    [
      'r2',
      'object',
      'put',
      `${BUCKET[env]}/${key}.json`,
      '--file',
      files.json,
      '--content-type',
      'application/json',
    ],
    env,
  );
  wrangler(
    [
      'r2',
      'object',
      'put',
      `${BUCKET[env]}/${key}.md`,
      '--file',
      files.md,
      '--content-type',
      'text/markdown',
    ],
    env,
  );
  const sql = `INSERT OR REPLACE INTO eval_runs (id, name, spec_json, dataset_hash, status, metrics_json, r2_report_key, created_at) VALUES (${[
    run.id,
    run.name,
    JSON.stringify(run.spec),
    run.datasetHash,
    run.status,
    JSON.stringify(compactMetrics(run.metrics)),
    `${key}.md`,
  ]
    .map(q)
    .join(', ')}, ${run.createdAt});`;
  const dir = resolve(ROOT, 'data', 'reports', run.id);
  mkdirSync(dir, { recursive: true });
  const sqlFile = join(dir, 'eval_run.sql');
  writeFileSync(sqlFile, sql);
  wrangler(['d1', 'execute', 'DB', '--file', sqlFile], env);
  return `${key}.md`;
}

// ---------------------------------------------------------------------------------------------------------------
// evaluate and optimize (docs/OPTIMIZATION.md). Aggregates and prompt text only: safe to publish to /lab.
// ---------------------------------------------------------------------------------------------------------------

type M = Record<string, unknown>;
const f4 = (x: unknown) => (typeof x === 'number' ? x.toFixed(4) : '—');
const signed = (x: unknown, d = 1, scale = 100) =>
  typeof x === 'number' ? `${x >= 0 ? '+' : ''}${(x * scale).toFixed(d)}` : '—';

function metricsHeader(first: string): string[] {
  return [
    `| ${first} | n | Log loss | Accuracy | Top-1 | Brier | ECE | Lift | Failed | $ | p50 |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
}

function metricsRow(label: string, x: M): string {
  return `| ${label} | ${String(x.n)} | ${f4(x.logLoss)} | ${pct(x.itemAcc)} | ${pct(x.top1)} | ${f3(x.brier)} | ${f3(x.ece)} | ${signed(x.lift)} | ${String(x.failures)} | $${Number(x.costUsd ?? 0).toFixed(4)} | ${Math.round(Number(x.p50LatencyMs ?? 0))} ms |`;
}

function breakdownTable(first: string, rows: Array<[string, M]>): string[] {
  return [...metricsHeader(first), ...rows.map(([l, x]) => metricsRow(l, x))];
}

function renderEvaluate(m: M): string[] {
  const out: string[] = [
    `People: ${String(m.people)} · instances: ${String(m.instances)}${m.withWhy !== undefined ? ` · with a reason: ${String(m.withWhy)} · reveal shown: ${String(m.revealed)}` : ''}${typeof m.costUsd === 'number' ? ` · spend $${m.costUsd.toFixed(4)}` : ''}${typeof m.noiseSd === 'number' ? ` · noise SD per question ${m.noiseSd.toFixed(4)}` : ''}`,
    '',
    'Lift is item accuracy minus the stored profile-only baseline on the same questions, in points. Failed predictions count as uniform.',
    '',
  ];
  const preds = (m.predictors ?? m.candidates) as Array<M> | undefined;
  if (!preds?.length) return out;
  out.push(
    '## All instances',
    '',
    ...breakdownTable(
      m.predictors ? 'Predictor (role)' : 'Candidate',
      preds.map((p) => [
        m.predictors ? `\`${String(p.predictor)}\` (${String(p.role)})` : String(p.label),
        p.all as M,
      ]),
    ),
    '',
  );
  if (preds.some((p) => p.role === 'hypothesis'))
    out.push(
      "`hypothesis` rows are the primary's predictions under each of selection's persona hypotheses (PLAN §9.5), several",
      'per question. They feed question selection and are not a predictor to compare.',
      '',
    );
  for (const [title, key] of [
    ['By split', 'bySplit'],
    ['By question type', 'byType'],
    ['By person', 'byPerson'],
  ] as const) {
    out.push(`## ${title}`, '');
    const rows: Array<[string, M]> = [];
    for (const p of preds) {
      const label = m.predictors ? `\`${String(p.predictor)}\` (${String(p.role)})` : String(p.label);
      for (const [k, v] of Object.entries((p[key] as M) ?? {})) rows.push([`${label} · ${k}`, v as M]);
    }
    out.push(...breakdownTable('Predictor · group', rows), '');
  }
  if (m.candidates) {
    const c = m.candidates as Array<M>;
    const deltas = c.filter((x) => x.vsFirst);
    if (deltas.length) {
      out.push(
        `## Paired against ${String(c[0]!.label)}`,
        '',
        '| Candidate | n | Δ score (nats/question) | 90% CI |',
        '| --- | --- | --- | --- |',
        ...deltas.map((x) => {
          const d = x.vsFirst as M;
          return `| ${String(x.label)} | ${String(d.n)} | ${signed(d.mean, 4, 1)} | ${f4(d.ciLow)} to ${f4(d.ciHigh)} |`;
        }),
        '',
      );
    }
  }
  const sc = m.selfConsistency as Record<string, { n: number; c: number }> | undefined;
  if (sc && Object.keys(sc).length) {
    out.push(
      '## Self-consistency (repeat probes, smoothed toward 0.8)',
      '',
      '| Person | Repeat pairs | Self-consistency |',
      '| --- | --- | --- |',
      ...Object.entries(sc).map(([k, v]) => `| ${k} | ${v.n} | ${pct(v.c)} |`),
      '',
    );
  }
  const paired = m.paired as Array<M> | undefined;
  if (paired?.length) {
    const ci = (d: M, scale: number, digits: number) =>
      `${signed(d.mean, digits, scale)} (${signed(d.ciLow, digits, scale)} to ${signed(d.ciHigh, digits, scale)})`;
    out.push(
      '## Paired comparisons (same model, same questions)',
      '',
      'Each change on the questions both predictors answered, with a 90% CI. A CI that spans 0 is noise at this size.',
      '',
      '| Model | From → to | n | Δ log loss | Δ item accuracy (points) | Failed |',
      '| --- | --- | --- | --- | --- | --- |',
      ...paired.map(
        (x) =>
          `| \`${String(x.model)}\` | \`${String(x.from)}\` → \`${String(x.to)}\` | ${String(x.n)} | ${ci(x.logLoss as M, 1, 4)} | ${ci(x.itemAcc as M, 100, 1)} | ${String(x.failedFrom)} → ${String(x.failedTo)} |`,
      ),
      '',
    );
  }
  const byPerson = (d: M, scale: number, digits: number) =>
    Number(d.people) < MIN_INTERVAL_PEOPLE
      ? `${signed(d.mean, digits, scale)} [—]`
      : `${signed(d.mean, digits, scale)} [${signed(d.ciLow, digits, scale)}, ${signed(d.ciHigh, digits, scale)}]`;
  const vs = m.againstPrimary as Array<M> | undefined;
  if (vs?.length) {
    out.push(
      '## Against the primary (any model, intervals over people)',
      '',
      "Each predictor minus the primary that served the same questions. A view shadow gets ADR-0065's verdict: it",
      `passes with higher accuracy and log loss no worse than +${VIEW_RULE.maxLogLossWorse} on at least ${VIEW_RULE.minPeople} people;`,
      `read it on people who joined after E6 (\`--since\`). Under ${MIN_INTERVAL_PEOPLE} people an interval is only their spread, so none is shown.`,
      '',
      '| Primary | Predictor (role) | View | People | n | Δ log loss [90% CI] | Δ item accuracy, points [90% CI] | Better / worse (log loss) | Verdict |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...vs.map((x) => {
        const ll = x.logLoss as M;
        return `| \`${String(x.primary)}\` | \`${String(x.predictor)}\` (${String(x.role)}) | ${x.view ? String(x.view) : '—'} | ${String(ll.people)} | ${String(ll.n)} | ${byPerson(ll, 1, 3)} | ${byPerson(x.itemAcc as M, 100, 1)} | ${String(ll.better)} / ${String(ll.worse)} | ${x.verdict ? String(x.verdict) : '—'} |`;
      }),
      '',
    );
  }
  const res = m.residual as M | undefined;
  if (res && Number(res.instances) > 0) {
    const im = res.itemMean as M;
    out.push(
      '## Residual: against the item mean (RESEARCH §1.2)',
      '',
      `On ${String(res.items)} items asked of at least ${String(Number(res.minOthers) + 1)} people (${String(res.instances)} questions, ${String(res.people)} people), the population's answers, leaving the person's own out, score log loss ${f4(im.logLoss)} and item accuracy ${pct(im.itemAcc)}. A negative Δ log loss is skill beyond the population.`,
      '',
      'The last column pools each predictor with the item mean, the weight fitted on dev people, and scores test people.',
      '',
      '| Predictor (role) | n | Δ log loss [90% CI] | Δ item accuracy, points [90% CI] | Better / worse (log loss) | Pooled, test: Δ log loss vs item mean [90% CI] |',
      '| --- | --- | --- | --- | --- | --- |',
      ...(res.rows as Array<M>).map((x) => {
        const ll = x.logLoss as M;
        const pooled = x.pooled as M | null;
        const p = pooled ? `${byPerson(pooled.logLoss as M, 1, 3)} (w = ${f3(pooled.w)})` : '—';
        return `| \`${String(x.predictor)}\` (${String(x.role)}) | ${String(ll.n)} | ${byPerson(ll, 1, 3)} | ${byPerson(x.itemAcc as M, 100, 1)} | ${String(ll.better)} / ${String(ll.worse)} | ${p} |`;
      }),
      '',
    );
  }
  const audit = m.probabilities as Array<M> | undefined;
  if (audit?.length) {
    out.push(
      '## Probability audit (RESEARCH §2.5)',
      '',
      'Distinct top probabilities per predictor (to 0.001). A predictor that says a few values most of the time is binned',
      'by them, so judge it on log loss rather than calibration error.',
      '',
      '| Predictor (role) | n | Distinct values | Most common | Its share |',
      '| --- | --- | --- | --- | --- |',
      ...audit.map((x) => {
        const [id, role] = String(x.candidate).split('|');
        return `| \`${id}\` (${role}) | ${String(x.n)} | ${String(x.distinct)} | ${f3(x.mode)} | ${pct(x.modeShare)} |`;
      }),
      '',
    );
  }
  const fits = m.fits as Array<M> | undefined;
  if (fits?.length) {
    out.push(
      '## Post-hoc calibration and pooling (fit on dev, checked on test)',
      '',
      'Log loss before → after. With few people the dev column is in-sample; only the test column is evidence.',
      'A temperature keeps the top pick, but score questions are scored by expected index, so accuracy can move.',
      '',
      '| Predictor | Method | Fitted | Dev n | Dev | Test n | Test | Test ECE | Test accuracy |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...fits.map(
        (x) =>
          `| \`${String(x.predictor)}\` | ${String(x.method)} | ${f3(x.param)} | ${String(x.nFit)} | ${f4(x.fitBefore)} → ${f4(x.fitAfter)} | ${String(x.nTest)} | ${x.testBefore === null ? '—' : `${f4(x.testBefore)} → ${f4(x.testAfter)}`} | ${x.testEceBefore === null ? '—' : `${f3(x.testEceBefore)} → ${f3(x.testEceAfter)}`} | ${typeof x.testAccBefore === 'number' ? `${pct(x.testAccBefore)} → ${pct(x.testAccAfter)}` : '—'} |`,
      ),
      '',
    );
  }
  return out;
}

function renderOptimize(m: M): string[] {
  const val = m.val as M;
  const holdout = m.holdout as M | null;
  const split = m.split as M;
  const noise = m.noise as M | null;
  const spend = m.spend as M;
  const best = m.best as M;
  const out: string[] = [
    `**Verdict.** ${String(m.verdict)}`,
    '',
    `- Stopped: ${String(m.stopReason)}`,
    `- Iterations: ${String(m.iterations)} (${Object.entries((m.outcomes as M) ?? {})
      .map(([k, v]) => `${String(v)} ${k}`)
      .join(', ')}); candidates in the pool: ${String(m.poolSize)}`,
    `- Instances: ${String(split.train)} train, ${String(split.val)} val, ${String(split.holdout)} holdout (split by ${String(split.by)})`,
    `- Noise floor: per-question SD ${noise ? f4(noise.sd) : '—'}; minibatch margin ${noise ? f4(noise.minibatchMargin) : '—'}; val margin ${noise ? f4(noise.valMargin) : '—'}`,
    `- Spend: $${Number(spend.usd ?? 0).toFixed(4)} (reflection $${Number(spend.reflectionUsd ?? 0).toFixed(4)} over ${String(spend.reflections)} calls); ${String(spend.predictions)} predictions`,
    '',
    '## Validation (dev)',
    '',
    ...breakdownTable('Candidate', [
      ['seed', (val.seed as M) ?? {}],
      [`best: ${String(best.label)}`, (val.best as M) ?? {}],
    ]),
    '',
  ];
  const d = val.delta as M;
  const dl = val.logLossDelta as M;
  out.push(
    `Paired Δ score (best − seed): ${signed(d.mean, 4, 1)} nats per question, 90% CI ${f4(d.ciLow)} to ${f4(d.ciHigh)}, n = ${String(d.n)}; Δ log loss ${signed(dl.mean, 4, 1)}.`,
    '',
  );
  const byPerson = val.byPerson as Record<string, M> | undefined;
  if (byPerson && Object.keys(byPerson).length) {
    out.push(
      '| Person (val) | n | Δ score | 90% CI |',
      '| --- | --- | --- | --- |',
      ...Object.entries(byPerson).map(
        ([k, v]) => `| ${k} | ${String(v.n)} | ${signed(v.mean, 4, 1)} | ${f4(v.ciLow)} to ${f4(v.ciHigh)} |`,
      ),
      '',
    );
  }
  if (holdout) {
    const hd = holdout.delta as M;
    const ad = holdout.accuracyDelta as M | undefined;
    out.push(
      '## Holdout (test-split people, evaluated once after selection)',
      '',
      ...breakdownTable('Candidate', [
        ['seed', holdout.seed as M],
        ['best', holdout.best as M],
      ]),
      '',
      `Paired Δ score: ${signed(hd.mean, 4, 1)} nats per question, 90% CI ${f4(hd.ciLow)} to ${f4(hd.ciHigh)}, n = ${String(hd.n)}.`,
      ...(ad
        ? [
            `Paired Δ item accuracy: ${signed(ad.mean)} points, 90% CI ${signed(ad.ciLow)} to ${signed(ad.ciHigh)}.`,
          ]
        : []),
      '',
    );
  }
  const comps = best.components as Record<string, string> | undefined;
  if (comps && Object.keys(comps).length) {
    out.push('## Best candidate: changed components', '');
    for (const [k, v] of Object.entries(comps)) out.push(`### ${k}`, '', '```', v, '```', '');
  }
  if (m.suggestedVersion)
    out.push(
      `Register it as \`${String(m.suggestedVersion)}\` in \`packages/core/src/components.ts\` (the run directory has the snippet), then run it as a shadow with \`pnpm backfill\` (ADR-0028).`,
      '',
    );
  return out;
}

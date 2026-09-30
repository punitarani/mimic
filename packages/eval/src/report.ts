import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalRunRecord, PredictorMetrics } from '@mimic/core';
import { remoteFlags, WORKER_DIR } from './wrangler';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');
const f3 = (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : '—');
const COUNTS = new Set(['n', 'checkable', 'legacy', 'truncated']);

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
  } else if (spec.kind === 'select') {
    lines.push(
      '## Pool-restricted selection (biased; iteration only)',
      '',
      '| Budget | People | Accuracy on the rest |',
      '| --- | --- | --- |',
      ...((m.results as Array<Record<string, unknown>>) ?? []).map(
        (r) => `| ${String(r.budget)} | ${String(r.people)} | ${pct(r.accuracy)} |`,
      ),
      '',
    );
  }
  return lines.join('\n');
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
    JSON.stringify(run.metrics),
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
  const fits = m.fits as Array<M> | undefined;
  if (fits?.length) {
    out.push(
      '## Post-hoc calibration and pooling (fit on dev, checked on test)',
      '',
      'Log loss before → after. With few people the dev column is in-sample; only the test column is evidence.',
      '',
      '| Predictor | Method | Fitted | Dev n | Dev | Test n | Test | Test ECE |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...fits.map(
        (x) =>
          `| \`${String(x.predictor)}\` | ${String(x.method)} | ${f3(x.param)} | ${String(x.nFit)} | ${f4(x.fitBefore)} → ${f4(x.fitAfter)} | ${String(x.nTest)} | ${x.testBefore === null ? '—' : `${f4(x.testBefore)} → ${f4(x.testAfter)}`} | ${x.testEceBefore === null ? '—' : `${f3(x.testEceBefore)} → ${f3(x.testEceAfter)}`} |`,
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
    out.push(
      '## Holdout (test-split people, evaluated once after selection)',
      '',
      ...breakdownTable('Candidate', [
        ['seed', holdout.seed as M],
        ['best', holdout.best as M],
      ]),
      '',
      `Paired Δ score: ${signed(hd.mean, 4, 1)} nats per question, 90% CI ${f4(hd.ciLow)} to ${f4(hd.ciHigh)}, n = ${String(hd.n)}.`,
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
      `Register it as \`${String(m.suggestedVersion)}\` in \`packages/core/src/components.ts\` (the run directory has the snippet), then run it as a shadow with \`pnpm backfill\` (ADR-0027).`,
      '',
    );
  return out;
}

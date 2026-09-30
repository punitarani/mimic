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

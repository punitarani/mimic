#!/usr/bin/env node
// `pnpm backfill --predictor <id>[,<id>...] [--env local|preview|prod] [--consented] [--mimic <id>]...
//                [--rate <per-minute>] [--retry-failed] [--yes]`
//
// Adds predictors (usually new shadow models) to questions that were served before they existed (ADR-0024). Each
// prediction runs on the sealed state blob the primary used, like a live shadow, so it is sealed (PLAN §3.1), logged
// through the gateway (as `predict.backfill`, outside the mimic's session budget), and scored against the answer.
//
// A dry run by default: checks the model, reports how this predictor has done so far (failures split into unusable
// output, which is the model's, and failed calls, which aren't), counts the missing predictions per mimic, and
// estimates cost and duration from what this predictor has cost so far (never a hardcoded price). `--yes` enqueues
// one job per predictor (or per named mimic); the worker spaces the predictions `--rate` a minute (ADR-0027) so they
// see the load a live shadow sees. Re-running is safe and shows what's left: the count falls to 0 as the queue drains.
//
//   --retry-failed  also redo this predictor's failed calls (timeouts, rate limits, provider errors, the budget
//                   guard), which were stored as failures before ADR-0027. Unusable output is kept: it is the model's.
//
//   local           the `pnpm dev` worker (POST /__jobs) and the local D1
//   preview, prod   the Cloudflare Queues and D1 HTTP APIs; needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
//                   (`doppler run -- pnpm backfill ...`)
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { cloudflareFromEnv, envBlock, ROOT, readConfig, WORKER_CONFIG } from './deploy/lib.mjs';

const ENVS = ['local', 'preview', 'prod'];
/** `llm:<vendor>/<model>` or `jev:<vendor>/<model>`. Strict, since the local path inlines it into SQL. */
export const PREDICTOR_ID = /^(llm|jev):[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const MIMIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LOCAL_WORKER = 'http://127.0.0.1:8787';
/** BACKFILL_PER_MINUTE in packages/core/src/engine/jobs.ts. */
export const DEFAULT_RATE = 30;
/** PENDING_WINDOW_MS in packages/core/src/engine/lab.ts: newer questions are left to the live shadows. */
export const PENDING_WINDOW_MS = 15 * 60 * 1000;

export function parseBackfillArgs(argv) {
  const out = {
    predictors: [],
    env: 'local',
    consented: false,
    mimics: [],
    rate: DEFAULT_RATE,
    retryFailed: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Repeatable, or comma- or space-separated (as the Actions workflow passes a list).
    if (a === '--predictor') out.predictors.push(...(argv[++i] ?? '').split(/[\s,]+/).filter(Boolean));
    else if (a === '--env') out.env = argv[++i];
    else if (a === '--mimic') out.mimics.push(argv[++i]);
    else if (a === '--rate') out.rate = Number(argv[++i]);
    else if (a === '--consented') out.consented = true;
    else if (a === '--retry-failed') out.retryFailed = true;
    else if (a === '--yes') out.yes = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.predictors.length || !out.predictors.every((p) => PREDICTOR_ID.test(p)))
    throw new Error('--predictor must look like llm:<vendor>/<model> or jev:<vendor>/<model>');
  out.predictors = [...new Set(out.predictors)];
  if (!ENVS.includes(out.env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
  for (const m of out.mimics) if (!MIMIC_ID.test(m ?? '')) throw new Error(`--mimic ${m} is not a mimic ID`);
  out.mimics = [...new Set(out.mimics)];
  if (!(out.rate > 0 && out.rate <= 600))
    throw new Error('--rate must be a number of predictions a minute, 1–600');
  return out;
}

// Mirrors isOutputFailure / isFailedCall in packages/core (predictors.ts, engine/jobs.ts): a failed prediction whose
// output was unusable is the model's failure and stands; any other failed shadow is a failed call, which may be redone.
const OUTPUT_FAILURE = `COALESCE(p.error IN ('invalid JSON output', 'output does not cover every option')
  OR p.error LIKE 'output cut off at max_tokens%' OR p.error LIKE 'missing answer for %', 0)`;
const FAILED_CALL = `(p.role = 'shadow' AND p.ok = 0 AND NOT ${OUTPUT_FAILURE})`;

/**
 * Served anchor and adaptive questions with a primary (so a sealed state) and no prediction from this predictor (a
 * failed call counts as none with `retryFailed`), per mimic. Questions served in the last PENDING_WINDOW_MS are left
 * to the live path. The same rule as `missingPredictions` in packages/core/src/engine/jobs.ts.
 */
export function missingQuery({ predictor, consented, mimics, retryFailed }, now = Date.now()) {
  const params = [predictor, now - PENDING_WINDOW_MS, ...mimics];
  const sql = [
    'SELECT q.mimic_id AS mimic, COUNT(*) AS missing FROM questions q JOIN mimics m ON m.id = q.mimic_id',
    "WHERE q.seq IS NOT NULL AND q.served_at IS NOT NULL AND q.served_at < ?2 AND q.kind IN ('anchor', 'adaptive')",
    "AND EXISTS (SELECT 1 FROM predictions p WHERE p.question_id = q.id AND p.role = 'primary')",
    'AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.question_id = q.id AND p.predictor_id = ?1',
    retryFailed ? `AND NOT ${FAILED_CALL})` : ')',
    consented ? 'AND m.consent_research = 1' : '',
    mimics.length ? `AND q.mimic_id IN (${mimics.map((_, i) => `?${i + 3}`).join(', ')})` : '',
    'GROUP BY q.mimic_id ORDER BY q.mimic_id',
  ]
    .filter(Boolean)
    .join(' ');
  return { sql, params };
}

/**
 * How this predictor has done so far, in this environment: predictions, the two kinds of failure, and what the
 * charged ones cost (provider usage.cost). Unusable outputs are charged too, so they count toward the estimate.
 */
export function statsQuery(predictor) {
  return {
    sql: [
      'SELECT COUNT(*) AS n, COALESCE(SUM(p.ok), 0) AS ok,',
      `COALESCE(SUM(CASE WHEN p.ok = 0 AND ${OUTPUT_FAILURE} THEN 1 ELSE 0 END), 0) AS unusable,`,
      `COALESCE(SUM(CASE WHEN ${FAILED_CALL} THEN 1 ELSE 0 END), 0) AS failed_calls,`,
      `SUM(CASE WHEN p.ok = 1 OR ${OUTPUT_FAILURE} THEN 1 ELSE 0 END) AS charged,`,
      `AVG(CASE WHEN p.ok = 1 OR ${OUTPUT_FAILURE} THEN p.cost_usd END) AS avg_cost`,
      'FROM predictions p WHERE p.predictor_id = ?1',
    ].join(' '),
    params: [predictor],
  };
}

/** The most common failure messages (truncated, since HTTP errors carry response bodies). */
export function errorsQuery(predictor) {
  return {
    sql: [
      "SELECT substr(COALESCE(p.error, '(none)'), 1, 60) AS error, COUNT(*) AS n,",
      `MAX(CASE WHEN ${OUTPUT_FAILURE} THEN 1 ELSE 0 END) AS unusable`,
      'FROM predictions p WHERE p.predictor_id = ?1 AND p.ok = 0 GROUP BY 1 ORDER BY n DESC LIMIT 4',
    ].join(' '),
    params: [predictor],
  };
}

/** For `wrangler d1 execute --command`, which takes no parameters. Only validated IDs and numbers reach here. */
export function inlineParams(sql, params) {
  return sql.replace(/\?(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1];
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return `'${String(v).replaceAll("'", "''")}'`;
  });
}

/**
 * The jobs to publish for one predictor. With no named mimics, one job that paces every (consented) mimic as one
 * stream. With named mimics, one job each for those with something missing, staggered so they form one stream too.
 */
export function backfillJobs({ predictor, consented, mimics, rate, retryFailed }, rows, runId) {
  const opts = { perMinute: rate, ...(retryFailed ? { retryFailed: true } : {}) };
  if (!mimics.length)
    return [{ type: 'backfill.predictor', runId, predictorId: predictor, consentedOnly: consented, ...opts }];
  const jobs = [];
  let before = 0;
  for (const r of rows) {
    const offsetSeconds = Math.round((before * 60) / rate);
    jobs.push({
      type: 'backfill.mimic',
      runId,
      mimicId: r.mimic,
      predictorId: predictor,
      ...opts,
      offsetSeconds,
    });
    before += Number(r.missing);
  }
  return jobs;
}

/** An LLM shadow must exist on OpenRouter and support structured outputs (predict.v1 is a JSON-schema call). */
export async function checkModel(predictor, fetchImpl = fetch) {
  const [kind, model] = [
    predictor.slice(0, predictor.indexOf(':')),
    predictor.slice(predictor.indexOf(':') + 1),
  ];
  if (kind !== 'llm') return `${model} (Jev decisions API)`;
  const res = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenRouter model list: ${res.status}`);
  const found = ((await res.json()).data ?? []).find((m) => m.id === model);
  if (!found) throw new Error(`${model} is not an OpenRouter model (check the slug)`);
  const params = found.supported_parameters ?? [];
  if (!params.includes('structured_outputs') && !params.includes('response_format'))
    throw new Error(`${model} doesn't support structured outputs, which predict.v1 needs`);
  return `${found.name ?? model} on OpenRouter (structured outputs)`;
}

// ---------------------------------------------------------------------------------------------------------------
// Where the data lives: the local D1 and `pnpm dev` worker, or a deployed environment through Cloudflare's APIs.
// ---------------------------------------------------------------------------------------------------------------

function capture(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed:\n${err || out}`)),
    );
  });
}

export function localTarget({ fetchImpl = fetch, exec = capture } = {}) {
  return {
    name: 'local',
    async query({ sql, params }) {
      const out = await exec(
        'pnpm',
        [
          'exec',
          'wrangler',
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          '../../.wrangler/state',
          '--json',
          '--command',
          inlineParams(sql, params),
        ],
        join(ROOT, 'apps/worker'),
      );
      return JSON.parse(out)[0]?.results ?? [];
    },
    async publish(job) {
      let res;
      try {
        res = await fetchImpl(`${LOCAL_WORKER}/__jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(job),
        });
      } catch {
        throw new Error(`the local worker isn't running on ${LOCAL_WORKER}: start \`pnpm dev\` first`);
      }
      if (!res.ok) throw new Error(`local worker refused the job: ${res.status} ${await res.text()}`);
    },
  };
}

export function remoteTarget(env, cf, workerConfig = readConfig(WORKER_CONFIG)) {
  const e = envBlock(workerConfig, env);
  const dbName = e.d1_databases?.[0]?.database_name;
  const queueName = e.queues?.producers?.[0]?.queue;
  let dbId;
  let queueId;
  return {
    name: env,
    async query({ sql, params }) {
      if (!dbId) {
        const dbs = (await cf.get(`/d1/database?name=${encodeURIComponent(dbName)}`)) ?? [];
        dbId = dbs.find((d) => d.name === dbName)?.uuid;
        if (!dbId) throw new Error(`no D1 database ${dbName}: deploy ${env} first`);
      }
      const r = await cf.post(`/d1/database/${dbId}/query`, { sql, params });
      return r?.[0]?.results ?? [];
    },
    async publish(job) {
      if (!queueId) {
        const qs = (await cf.get(`/queues?name=${encodeURIComponent(queueName)}`)) ?? [];
        queueId = qs.find((q) => q.queue_name === queueName)?.queue_id;
        if (!queueId) throw new Error(`no queue ${queueName}: deploy ${env} first`);
      }
      await cf.post(`/queues/${queueId}/messages`, { body: job });
    },
  };
}

const usd = (x) => (x === 0 ? '$0' : `$${x < 0.01 ? x.toPrecision(2) : x.toFixed(2)}`);
const pct = (x, n) => `${((100 * x) / (n || 1)).toFixed(1)}%`;
const duration = (minutes) =>
  minutes < 1
    ? 'under a minute'
    : minutes < 90
      ? `about ${Math.ceil(minutes)} min`
      : `about ${(minutes / 60).toFixed(1)} h`;

/** Plans (and with --yes enqueues) each predictor in turn. Every model is checked before anything is enqueued. */
export async function backfill(opts, target, { fetchImpl = fetch, log = console.log, runId, now } = {}) {
  const scope = opts.mimics.length
    ? `${opts.mimics.length} named mimic(s)${opts.consented ? ', consented only' : ''}`
    : opts.consented
      ? 'consented mimics only'
      : 'every mimic';
  const models = [];
  for (const predictor of opts.predictors) models.push(await checkModel(predictor, fetchImpl));

  const id = runId ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let missing = 0;
  let enqueued = 0;
  for (const [i, predictor] of opts.predictors.entries()) {
    const one = { ...opts, predictor };
    log(`Backfill ${predictor} on ${target.name} (${scope})`);
    log(`  model: ${models[i]}`);

    const [stats] = await target.query(statsQuery(predictor));
    const n = Number(stats?.n ?? 0);
    if (n) {
      const failed = n - Number(stats.ok);
      log(`  so far: ${n} prediction(s), ${failed} failed (${pct(failed, n)})`);
      if (failed) {
        log(`    unusable output (the model's; kept): ${stats.unusable}`);
        log(
          `    failed calls (not the model's): ${stats.failed_calls}${Number(stats.failed_calls) > 0 && !opts.retryFailed ? ', redo with --retry-failed' : ''}`,
        );
        for (const e of await target.query(errorsQuery(predictor)))
          log(`      ${String(e.n).padStart(5)} × ${e.error}`);
      }
    }

    const rows = await target.query(missingQuery(one, now));
    const count = rows.reduce((s, r) => s + Number(r.missing), 0);
    missing += count;
    const what = opts.retryFailed ? 'missing or failed call(s)' : 'missing';
    log(`  ${what}: ${count} prediction(s) across ${rows.length} mimic(s), served over 15 min ago`);
    if (Number(stats?.charged) > 0) {
      const avg = Number(stats.avg_cost);
      const estimate = count ? `, so about ${usd(avg * count)} for these` : '';
      log(`  cost: ${usd(avg)} per prediction over ${stats.charged} so far${estimate}`);
    } else {
      log(
        '  cost: no predictions from this model yet, so no estimate (it is charged per call, from usage.cost)',
      );
    }
    if (!count) {
      log('  nothing to backfill');
      continue;
    }
    log(`  pace: ${opts.rate} a minute, ${duration(count / opts.rate)}`);
    if (opts.yes) {
      const jobs = backfillJobs(one, rows, id);
      for (const job of jobs) await target.publish(job);
      enqueued += jobs.length;
      log(`  enqueued ${jobs.length} ${jobs[0].type} job(s) (run ${id})`);
    }
  }
  if (missing && !opts.yes) log('Dry run: nothing enqueued. Re-run with --yes to enqueue.');
  if (enqueued) log('Re-run without --yes to watch the counts fall to 0.');
  return { missing, enqueued };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseBackfillArgs(process.argv.slice(2));
    const target =
      opts.env === 'local' ? localTarget() : remoteTarget(opts.env, cloudflareFromEnv(process.env));
    await backfill(opts, target);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
// `pnpm backfill --predictor <id>[,<id>...] [--env local|preview|prod] [--consented] [--mimic <id>]... [--yes]`
//
// Adds predictors (usually new shadow models) to questions that were served before they existed (ADR-0024). Each
// prediction runs on the sealed state blob the primary used, through the same `predict.shadow` job as a live shadow,
// so it is sealed (PLAN §3.1), logged through the gateway, and scored against the answer.
//
// A dry run by default: checks the model, counts the missing predictions per mimic, and estimates cost from what
// this predictor has cost so far (never a hardcoded price). `--yes` enqueues one job per predictor; the worker fans it out per
// mimic. Re-running is safe and shows what's left: the count falls to 0 as the queue drains.
//
//   local           the `pnpm dev` worker (POST /__jobs) and the local D1
//   preview, prod   the Cloudflare Queues and D1 HTTP APIs; needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
//                   (`doppler run -- pnpm backfill ...`)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudflareFromEnv, envBlock, ROOT, readConfig, WORKER_CONFIG } from './deploy/lib.mjs';

const ENVS = ['local', 'preview', 'prod'];
/**
 * `llm:<vendor>/<model>` or `jev:<vendor>/<model>`, optionally `@<promptVersion>` for a registered prediction prompt
 * variant (ADR-0027; the worker rejects an unregistered one). Strict, since the local path inlines it into SQL.
 */
export const PREDICTOR_ID =
  /^(llm|jev):[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*(@[a-z0-9][a-z0-9._-]*)?$/i;
const MIMIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LOCAL_WORKER = 'http://127.0.0.1:8787';

export function parseBackfillArgs(argv) {
  const out = { predictors: [], env: 'local', consented: false, mimics: [], yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Repeatable, or comma- or space-separated (as the Actions workflow passes a list).
    if (a === '--predictor') out.predictors.push(...(argv[++i] ?? '').split(/[\s,]+/).filter(Boolean));
    else if (a === '--env') out.env = argv[++i];
    else if (a === '--mimic') out.mimics.push(argv[++i]);
    else if (a === '--consented') out.consented = true;
    else if (a === '--yes') out.yes = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.predictors.length || !out.predictors.every((p) => PREDICTOR_ID.test(p)))
    throw new Error(
      '--predictor must look like llm:<vendor>/<model> or jev:<vendor>/<model>, optionally @<promptVersion>',
    );
  out.predictors = [...new Set(out.predictors)];
  if (!ENVS.includes(out.env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
  for (const m of out.mimics) if (!MIMIC_ID.test(m ?? '')) throw new Error(`--mimic ${m} is not a mimic ID`);
  return out;
}

/**
 * Served anchor and adaptive questions with a primary (so a sealed state) and no prediction from this predictor, per
 * mimic. The same rule as `enqueueMissingPredictions` in packages/core/src/engine/jobs.ts.
 */
export function missingQuery({ predictor, consented, mimics }) {
  const params = [predictor, ...mimics];
  const sql = [
    'SELECT q.mimic_id AS mimic, COUNT(*) AS missing FROM questions q JOIN mimics m ON m.id = q.mimic_id',
    "WHERE q.seq IS NOT NULL AND q.served_at IS NOT NULL AND q.kind IN ('anchor', 'adaptive')",
    "AND EXISTS (SELECT 1 FROM predictions p WHERE p.question_id = q.id AND p.role = 'primary')",
    'AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.question_id = q.id AND p.predictor_id = ?1)',
    consented ? 'AND m.consent_research = 1' : '',
    mimics.length ? `AND q.mimic_id IN (${mimics.map((_, i) => `?${i + 2}`).join(', ')})` : '',
    'GROUP BY q.mimic_id ORDER BY q.mimic_id',
  ]
    .filter(Boolean)
    .join(' ');
  return { sql, params };
}

/** What this predictor has cost per prediction so far (from provider usage.cost), if it has run at all. */
export function costQuery(predictor) {
  return {
    sql: 'SELECT COUNT(*) AS n, AVG(cost_usd) AS avg FROM predictions WHERE predictor_id = ?1 AND ok = 1',
    params: [predictor],
  };
}

/** For `wrangler d1 execute --command`, which takes no parameters. Only validated IDs reach here. */
export function inlineParams(sql, params) {
  return sql.replace(/\?(\d+)/g, (_, n) => `'${String(params[Number(n) - 1]).replaceAll("'", "''")}'`);
}

/** The jobs to publish: one per named mimic, or one that fans out over every (consented) mimic. */
export function backfillJobs({ predictor, consented, mimics }, runId) {
  if (mimics.length)
    return mimics.map((mimicId) => ({ type: 'backfill.mimic', runId, mimicId, predictorId: predictor }));
  return [{ type: 'backfill.predictor', runId, predictorId: predictor, consentedOnly: consented }];
}

const INCUMBENT = { llm: 'predict.v1', jev: 'jev-predict.v1' };

/**
 * A `@<version>` must be a registered prompt variant of the right kind, and not the incumbent (which would store a
 * second ID for the same predictor). The registry in packages/core/src/components.ts is mirrored to
 * docs/prompts/variants/ (checked by a test), which this dependency-free script can read. Throws, or returns a label.
 */
export function checkPromptVersion(predictor, root = ROOT) {
  const kind = predictor.slice(0, predictor.indexOf(':'));
  const at = predictor.lastIndexOf('@');
  if (at < 0) return null;
  const version = predictor.slice(at + 1);
  const bare = predictor.slice(0, at);
  if (version === INCUMBENT[kind]) throw new Error(`${predictor} names the incumbent prompt; use ${bare}`);
  let doc;
  try {
    doc = readFileSync(join(root, 'docs/prompts/variants', `${version}.md`), 'utf8');
  } catch {
    throw new Error(
      `${version} is not a registered prompt variant (packages/core/src/components.ts); merge it first`,
    );
  }
  if (!doc.includes(`Predictor kind: \`${kind}\``))
    throw new Error(`${version} is not a ${kind} prompt variant`);
  return version;
}

/** An LLM shadow must exist on OpenRouter and support structured outputs (predict.v1 is a JSON-schema call). */
export async function checkModel(predictor, fetchImpl = fetch) {
  const version = checkPromptVersion(predictor);
  // A prompt variant (`@<promptVersion>`) runs on the same model, so check the bare model.
  const [kind, model] = [
    predictor.slice(0, predictor.indexOf(':')),
    predictor.slice(predictor.indexOf(':') + 1).replace(/@[^@]*$/, ''),
  ];
  const suffix = version ? `, prompt ${version}` : '';
  if (kind !== 'llm') return `${model} (Jev decisions API${suffix})`;
  const res = await fetchImpl('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter model list: ${res.status}`);
  const found = ((await res.json()).data ?? []).find((m) => m.id === model);
  if (!found) throw new Error(`${model} is not an OpenRouter model (check the slug)`);
  const params = found.supported_parameters ?? [];
  if (!params.includes('structured_outputs') && !params.includes('response_format'))
    throw new Error(`${model} doesn't support structured outputs, which predict.v1 needs`);
  return `${found.name ?? model} on OpenRouter (structured outputs${suffix})`;
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

/** Plans (and with --yes enqueues) each predictor in turn. Every model is checked before anything is enqueued. */
export async function backfill(opts, target, { fetchImpl = fetch, log = console.log, runId } = {}) {
  const scope = opts.mimics.length
    ? `${opts.mimics.length} named mimic(s)`
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
    const rows = await target.query(missingQuery(one));
    const n = rows.reduce((s, r) => s + Number(r.missing), 0);
    missing += n;
    log(`  missing: ${n} prediction(s) across ${rows.length} mimic(s)`);
    const [cost] = await target.query(costQuery(predictor));
    if (cost && Number(cost.n) > 0) {
      const avg = Number(cost.avg);
      const estimate = n ? `, so about ${usd(avg * n)} for these` : '';
      log(`  cost: ${usd(avg)} per prediction over ${cost.n} so far${estimate}`);
    } else {
      log(
        '  cost: no predictions from this model yet, so no estimate (it is charged per call, from usage.cost)',
      );
    }
    if (!n) {
      log('  nothing to backfill');
    } else if (opts.yes) {
      const jobs = backfillJobs(one, id);
      for (const job of jobs) await target.publish(job);
      enqueued += jobs.length;
      log(`  enqueued ${jobs.length} ${jobs[0].type} job(s) (run ${id}); the worker fans out per mimic`);
    }
  }
  if (missing && !opts.yes) log('Dry run: nothing enqueued. Re-run with --yes to enqueue.');
  if (enqueued) log('Re-run without --yes to watch the missing counts fall to 0.');
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

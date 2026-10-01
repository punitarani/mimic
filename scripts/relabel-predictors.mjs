#!/usr/bin/env node
// `pnpm relabel:predictors [--env local|preview|prod] [--batch <rows>] [--reverse] [--yes]`
//
// Relabels stored predictor IDs for ADR-0052. Run it after the deploy that ships ADR-0052 has finished (CD green):
// until then the old code still writes `jev:` and can't read `decision:`.
//
//   1. Shadows stored under both spellings for one question (only when old and new code stored the same shadow at
//      once) keep the better row, by migration 0006's rule (a success over a failure, then the earliest), and lose
//      the other with its score: the unique shadow index would refuse the rewrite otherwise.
//   2. `jev:<model>[@<version>]` becomes `decision:<model>[@<version>]` on every prediction row. The kind was renamed;
//      nothing else about the row changes.
//   3. Served rows (primary, baseline, hypothesis) that the `decisions-model` flag rerouted to a challenger (ADR-0051)
//      but that were stored under Jev's ID take the challenger's ID, keeping the prompt version: what new code stores.
//      They are found by their model snapshot, so only challengers pinned in DECISION_MODELS are relabelled; any other
//      snapshot on a Jev row is listed, not changed.
//
// A dry run by default: it counts what each step would change. `--yes` applies, `--batch` rows per statement. It is
// safe to re-run, and a dry run afterwards should count 0 everywhere.
//
//   --reverse  `decision:` back to `jev:` (step 2 inverted, after step 1), for a code rollback: run it once the rollback
//              deploy has finished, and again if the dry run still counts rows. Step 3 is kept: the old code reads
//              `jev:respan/span-01-…@…` as it is, a span-01 prediction, which is what it was.
//
// Left as they are: configs (hashed: they keep `jev:`, read as `decision:`), job keys (the ledger: a job keeps its key,
// and runs as `decision:`), eval reports and model_calls (records of what ran).
//
//   local           the `pnpm dev` D1 (wrangler d1 execute --local)
//   preview, prod   the Cloudflare D1 HTTP API; needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
//                   (`doppler run -- pnpm relabel:predictors --env prod`, or Actions → Relabel predictors)
import { localTarget, remoteTarget } from './backfill.mjs';
import { cloudflareFromEnv } from './deploy/lib.mjs';
import { DECISION_MODELS, DECISION_PREFIX, JEV_MODEL, LEGACY_DECISION_PREFIX } from './predictor-ids.mjs';

const ENVS = ['local', 'preview', 'prod'];
export const DEFAULT_BATCH = 500;
export const MAX_BATCH = 5000;
/** The roles a served call stores, so the roles the flag can reroute (CHALLENGER_PURPOSES in packages/core). */
export const SERVED_ROLES = ['primary', 'baseline', 'hypothesis'];
/** MAX_JOB_ATTEMPTS in packages/core: a failed job with this many attempts is not retried. */
const MAX_ATTEMPTS = 5;

export function parseRelabelArgs(argv) {
  const out = { env: 'local', batch: DEFAULT_BATCH, reverse: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a === '--reverse') out.reverse = true;
    else if (a === '--yes') out.yes = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!ENVS.includes(out.env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
  if (!(Number.isInteger(out.batch) && out.batch >= 1 && out.batch <= MAX_BATCH))
    throw new Error(`--batch must be a whole number of rows, 1–${MAX_BATCH}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// SQL. Only constants and validated integers are inlined; model IDs are bound as string parameters (the D1 HTTP API
// takes only strings).
// ---------------------------------------------------------------------------------------------------------------

/** `col` starts with the constant `prefix`. */
const startsWith = (col, prefix) => `substr(${col}, 1, ${prefix.length}) = '${prefix}'`;
const legacy = (col) => startsWith(col, LEGACY_DECISION_PREFIX);
const canonical = (col) => startsWith(col, DECISION_PREFIX);
/** The same ID under the other spelling of the decision kind. */
const twin = (col) =>
  `CASE WHEN ${legacy(col)} THEN '${DECISION_PREFIX}' || substr(${col}, ${LEGACY_DECISION_PREFIX.length + 1})` +
  ` ELSE '${LEGACY_DECISION_PREFIX}' || substr(${col}, ${DECISION_PREFIX.length + 1}) END`;

/** The prefix a direction rewrites from and to. */
export function direction(reverse) {
  return reverse
    ? { from: DECISION_PREFIX, to: LEGACY_DECISION_PREFIX }
    : { from: LEGACY_DECISION_PREFIX, to: DECISION_PREFIX };
}

/** Step 2's rows by role, and the newest (a row newer than the deploy means old code was still writing). */
export function countQuery(reverse) {
  const { from } = direction(reverse);
  return {
    sql: [
      'SELECT role, COUNT(*) AS n, MAX(created_at) AS newest FROM predictions',
      `WHERE ${startsWith('predictor_id', from)} GROUP BY role ORDER BY role`,
    ].join(' '),
    params: [],
  };
}

/**
 * Step 1: of each shadow stored under both spellings for one question, the worse row (migration 0006's rule: a
 * success over a failure, then the earliest, then the smallest ID). The unique shadow index allows one row per
 * spelling, so a pair is all there can be.
 */
const TWIN_LOSERS = [
  'SELECT p.id FROM predictions p JOIN predictions o',
  "ON o.role = 'shadow' AND o.question_id = p.question_id AND o.id <> p.id",
  `AND o.predictor_id = ${twin('p.predictor_id')}`,
  `WHERE p.role = 'shadow' AND (${legacy('p.predictor_id')} OR ${canonical('p.predictor_id')})`,
  'AND (o.ok > p.ok OR (o.ok = p.ok AND (o.created_at < p.created_at OR (o.created_at = p.created_at AND o.id < p.id))))',
].join(' ');

export function twinCountQuery() {
  return {
    sql: [
      `SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM scores WHERE prediction_id IN (${TWIN_LOSERS})) AS scores`,
      `FROM (${TWIN_LOSERS})`,
    ].join(' '),
    params: [],
  };
}

/** Scores first: a re-run after a failure between the two finds the same losers. */
export function twinDeleteQueries() {
  return [
    { sql: `DELETE FROM scores WHERE prediction_id IN (${TWIN_LOSERS})`, params: [] },
    { sql: `DELETE FROM predictions WHERE id IN (${TWIN_LOSERS})`, params: [] },
  ];
}

/** Step 2, one batch. */
export function rewriteQuery(reverse, batch) {
  const { from, to } = direction(reverse);
  return {
    sql: [
      `UPDATE predictions SET predictor_id = '${to}' || substr(predictor_id, ${from.length + 1})`,
      `WHERE id IN (SELECT id FROM predictions WHERE ${startsWith('predictor_id', from)} LIMIT ${batch})`,
    ].join(' '),
    params: [],
  };
}

/**
 * Served rows under Jev's ID (?1, the incumbent model, in any of `prefixes`, bare or `@<version>`) answered by the
 * challenger ?2, by model snapshot.
 */
function servedWhere(prefixes) {
  const jevId = (prefix) =>
    `(predictor_id = '${prefix}' || ?1 OR substr(predictor_id, 1, length(?1) + ${prefix.length + 1}) = '${prefix}' || ?1 || '@')`;
  return [
    `role IN (${SERVED_ROLES.map((r) => `'${r}'`).join(', ')})`,
    'AND substr(model_snapshot, 1, length(?2)) = ?2',
    `AND (${prefixes.map(jevId).join(' OR ')})`,
  ].join(' ');
}

/** Step 3's rows for one challenger. In a dry run step 2 hasn't run, so both spellings count. */
export function servedCountQuery(challenger, prefixes = [DECISION_PREFIX]) {
  return {
    sql: `SELECT role, COUNT(*) AS n FROM predictions WHERE ${servedWhere(prefixes)} GROUP BY role ORDER BY role`,
    params: [JEV_MODEL, challenger],
  };
}

/** Step 3, one batch (after step 2, so canonical rows only): the challenger's model in place of Jev's. */
export function servedRewriteQuery(challenger, batch) {
  return {
    sql: [
      `UPDATE predictions SET predictor_id = '${DECISION_PREFIX}' || ?2 || substr(predictor_id, length(?1) + ${DECISION_PREFIX.length + 1})`,
      `WHERE id IN (SELECT id FROM predictions WHERE ${servedWhere([DECISION_PREFIX])} LIMIT ${batch})`,
    ].join(' '),
    params: [JEV_MODEL, challenger],
  };
}

/** Model snapshots on served rows still under Jev's ID: anything not pinned is listed, never relabelled. */
export function snapshotsQuery() {
  const jevAny = [DECISION_PREFIX, LEGACY_DECISION_PREFIX]
    .map(
      (prefix) =>
        `predictor_id = '${prefix}' || ?1 OR substr(predictor_id, 1, length(?1) + ${prefix.length + 1}) = '${prefix}' || ?1 || '@'`,
    )
    .join(' OR ');
  return {
    sql: [
      'SELECT model_snapshot AS snapshot, COUNT(*) AS n FROM predictions',
      `WHERE role IN (${SERVED_ROLES.map((r) => `'${r}'`).join(', ')}) AND (${jevAny})`,
      'GROUP BY 1 ORDER BY n DESC LIMIT 20',
    ].join(' '),
    params: [JEV_MODEL],
  };
}

/** Jobs keyed `jev:` still queued or retrying: they run under the new code and store `decision:`. */
export function legacyJobsQuery() {
  return {
    sql: [
      `SELECT COUNT(*) AS n FROM jobs WHERE instr(key, ':${LEGACY_DECISION_PREFIX}') > 0`,
      `AND status != 'done' AND NOT (status = 'failed' AND attempts >= ${MAX_ATTEMPTS})`,
    ].join(' '),
    params: [],
  };
}

/** The challengers step 3 relabels to: every pinned decision model but the incumbent. */
export const CHALLENGERS = Object.entries(DECISION_MODELS).filter(([, model]) => model !== JEV_MODEL);

// ---------------------------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------------------------

const sum = (rows) => rows.reduce((s, r) => s + Number(r.n), 0);
const byRole = (rows) =>
  rows.length ? rows.map((r) => `${r.role} ${Number(r.n).toLocaleString('en-US')}`).join(' · ') : 'none';
const when = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '');

/**
 * Runs `step` until `remaining()` reaches 0, one batch at a time. A batch that changes nothing means something else is
 * writing these rows (or a statement matched nothing it could change), so it stops rather than loop.
 */
async function drain(target, step, remaining) {
  let left = await remaining();
  let batches = 0;
  let done = 0;
  while (left > 0) {
    try {
      await target.query(step());
    } catch (e) {
      const unique = /UNIQUE/i.test(e instanceof Error ? e.message : String(e));
      throw new Error(
        unique
          ? 'a shadow under both spellings appeared since step 1 (is old code still running?): re-run once CD is done'
          : String(e instanceof Error ? e.message : e),
      );
    }
    batches++;
    const now = await remaining();
    if (now >= left)
      throw new Error(`no progress after batch ${batches} (${now} rows left): re-run to retry`);
    done += left - now;
    left = now;
  }
  return { rows: done, batches };
}

/** Dry run, or with `--yes` the three steps in order. Returns the counts, for tests and the summary. */
export async function relabel(opts, target, { log = console.log } = {}) {
  const { from, to } = direction(opts.reverse);
  log(`Relabel predictor IDs on ${target.name}${opts.yes ? '' : ' (dry run)'}`);

  const legacyRows = await target.query(countQuery(opts.reverse));
  const newest = legacyRows.reduce((m, r) => Math.max(m, Number(r.newest ?? 0)), 0);
  log(`  ${from} → ${to} (ADR-0052): ${byRole(legacyRows)}${newest ? ` (newest ${when(newest)} UTC)` : ''}`);

  const [twins] = await target.query(twinCountQuery());
  const twinCount = Number(twins?.n ?? 0);
  log(
    `  shadows under both spellings: ${twinCount}${twinCount ? ` (the worse of each pair, and its ${Number(twins.scores)} score(s), are deleted first)` : ''}`,
  );

  // Step 3 (forward only). Step 2 hasn't run yet, so these rows may still be under either spelling.
  const served = [];
  if (!opts.reverse) {
    for (const [variant, model] of CHALLENGERS) {
      const rows = await target.query(servedCountQuery(model, [DECISION_PREFIX, LEGACY_DECISION_PREFIX]));
      served.push({ variant, model, rows });
      log(`  served by ${variant} under Jev's ID → ${DECISION_PREFIX}${model}@…: ${byRole(rows)}`);
    }
    const unknown = (await target.query(snapshotsQuery())).filter(
      (r) => !Object.values(DECISION_MODELS).some((m) => String(r.snapshot).startsWith(m)),
    );
    log(
      unknown.length
        ? `  not relabelled, snapshot not pinned in DECISION_MODELS: ${unknown.map((r) => `${r.snapshot} (${r.n})`).join(', ')}`
        : '  not relabelled: no unrecognized snapshots on Jev rows',
    );
  }
  if (!opts.reverse) {
    const [jobs] = await target.query(legacyJobsQuery());
    log(
      `  jobs keyed ${LEGACY_DECISION_PREFIX} still queued or retrying: ${Number(jobs?.n ?? 0)} (they store ${DECISION_PREFIX} when they run)`,
    );
  }
  log('  Not rewritten: configs (hashed), job keys (the ledger), eval reports, model_calls.');

  const result = { legacy: sum(legacyRows), twins: twinCount, served: 0, rewritten: 0 };
  for (const s of served) result.served += sum(s.rows);
  if (!opts.yes) {
    const total = result.legacy + result.twins + result.served;
    log(total ? 'Dry run: nothing changed. Re-run with --yes to apply.' : 'Nothing to relabel.');
    return result;
  }

  if (opts.reverse)
    log(
      '  --reverse: run this only after the rollback deploy has finished, and again if a dry run still counts rows.',
    );
  if (twinCount) {
    for (const q of twinDeleteQueries()) await target.query(q);
    log(`  deleted ${twinCount} duplicate shadow(s)`);
  }
  const step2 = await drain(
    target,
    () => rewriteQuery(opts.reverse, opts.batch),
    async () => sum(await target.query(countQuery(opts.reverse))),
  );
  result.rewritten = step2.rows;
  log(`  renamed ${from} to ${to} on ${step2.rows} row(s) in ${step2.batches} batch(es)`);
  if (!opts.reverse) {
    result.served = 0;
    for (const { variant, model } of served) {
      const step3 = await drain(
        target,
        () => servedRewriteQuery(model, opts.batch),
        async () => sum(await target.query(servedCountQuery(model))),
      );
      result.served += step3.rows;
      log(
        `  served by ${variant} → ${DECISION_PREFIX}${model}@…: ${step3.rows} row(s) in ${step3.batches} batch(es)`,
      );
    }
  }
  log('Done. Re-run without --yes: every count should be 0.');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseRelabelArgs(process.argv.slice(2));
    const target =
      opts.env === 'local' ? localTarget() : remoteTarget(opts.env, cloudflareFromEnv(process.env));
    await relabel(opts, target);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}

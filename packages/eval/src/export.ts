import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { openLocalDb } from '@mimic/db/local';
import { remoteFlags, WORKER_DIR } from './wrangler';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface ExportOptions {
  env: 'local' | 'preview' | 'prod';
  out: string;
  /**
   * Keep names, locations and original IDs. Only for the internal reproducibility check (replay --mode online),
   * never for sharing (ADR-0018).
   */
  keepIdentity?: boolean;
}

export interface ExportResult {
  path: string;
  mimics: number;
  dropped: number;
  datasetHash: string;
}

/** `wrangler d1 export --no-schema` for a remote environment; returns the SQL. */
function d1Export(env: 'preview' | 'prod'): string {
  const dir = mkdtempSync(join(tmpdir(), 'mimic-export-'));
  const file = join(dir, 'data.sql');
  const r = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'export', 'DB', ...remoteFlags(env), '--no-schema', '--output', file],
    { cwd: WORKER_DIR, encoding: 'utf8' },
  );
  if (r.status !== 0 || !existsSync(file))
    throw new Error(`wrangler d1 export failed:\n${r.stderr || r.stdout}`);
  const sql = readFileSync(file, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

/**
 * The local D1 is a SQLite file under the shared miniflare state (`wrangler d1 export` has no `--persist-to`):
 * the one holding a `mimics` table, most recently written if several.
 */
function localD1File(): string {
  const dir = join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  if (!existsSync(dir)) throw new Error(`No local D1 at ${dir}; run pnpm dev first`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => join(dir, f))
    .filter((f) => readFileSync(f, 'latin1').includes('CREATE TABLE `mimics`'))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files[0]) throw new Error(`No local D1 database with a mimics table in ${dir}`);
  return files[0];
}

/** Copies every table of our schema from the local D1 file into `client`, column by column. */
async function copyLocal(client: Client): Promise<void> {
  await client.execute({ sql: 'attach database ? as src', args: [localD1File()] });
  const tables = (
    await client.execute(
      "select name from main.sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite%'",
    )
  ).rows.map((r) => String(r.name));
  for (const t of tables) {
    const cols = (await client.execute(`pragma main.table_info(${t})`)).rows
      .map((r) => `"${String(r.name)}"`)
      .join(', ');
    await client.execute(`insert into main."${t}" (${cols}) select ${cols} from src."${t}"`);
  }
  await client.execute('detach database src');
}

/** Tables whose rows are keyed by mimic_id (hard-delete scope). */
const MIMIC_TABLES = [
  'identity_candidates',
  'facts',
  'questions',
  'predictions',
  'answers',
  'answer_rewinds',
  'scores',
  'trait_estimates',
  'trait_history',
  'insights',
  'kg_nodes',
  'kg_edges',
  'fidelity',
  'model_calls',
  'snapshots',
  'mimic_facets',
  'vectors',
  'soul_drafts',
  'soul_curations',
];

/**
 * `mimic-eval export` (PLAN §12.3–12.4): D1 → SQLite with the same schema. Only `consent_research` mimics are kept;
 * names, locations, links and URLs are dropped and IDs are replaced with salted hashes (unless keepIdentity).
 */
export async function exportData(opts: ExportOptions): Promise<ExportResult> {
  const out = resolve(opts.out);
  rmSync(out, { force: true });
  const { client, close } = await openLocalDb(out);
  if (opts.env === 'local') await copyLocal(client);
  else {
    // Data only: skip wrangler/D1 bookkeeping tables that the local migration history doesn't have.
    const inserts = d1Export(opts.env)
      .split('\n')
      .filter(
        (l) => l.startsWith('INSERT INTO') && !/INSERT INTO "?(d1_migrations|_cf_|sqlite_sequence)/.test(l),
      )
      .join('\n');
    if (inserts.trim()) await client.executeMultiple(inserts);
  }

  const { dropped } = await scrubExport(client, { keepIdentity: opts.keepIdentity ?? false });
  const mimics = Number((await client.execute('select count(*) as n from mimics')).rows[0]!.n);
  await client.execute('vacuum');
  const hash = await datasetHash(client);
  close();
  return { path: out, mimics, dropped, datasetHash: hash };
}

/**
 * Applies the export policy in place (PLAN §12.4): drops every mimic without research consent, then (unless
 * keepIdentity) drops names, locations, links and URLs and replaces mimic and participant IDs with salted hashes.
 */
export async function scrubExport(
  client: Client,
  opts: { keepIdentity: boolean },
): Promise<{ dropped: number }> {
  // Consent gates research use (PLAN §3.8).
  const nonConsented = (await client.execute('select id from mimics where consent_research = 0')).rows.map(
    (r) => String(r.id),
  );
  for (const id of nonConsented) {
    for (const t of MIMIC_TABLES)
      await client.execute({ sql: `delete from ${t} where mimic_id = ?`, args: [id] });
    await client.execute({ sql: 'delete from mimics where id = ?', args: [id] });
  }
  await client.execute('delete from jobs');
  // SOUL.md curation is the person's own writing and choices, not research data (ADR-0037). Drafts are free text
  // written from location and sourced facts, so they go too whenever identity is scrubbed (below).
  await client.execute('delete from soul_curations');
  await client.execute('delete from vectors');
  await client.execute('delete from participants where id not in (select participant_id from mimics)');

  if (!opts.keepIdentity) {
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const pseudo = (prefix: string, id: string) =>
      `${prefix}_${createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 20)}`;
    await client.executeMultiple(`
      update mimics set display_name = 'Participant', location = '', employer = null, links_json = '[]';
      update participants set email = null;
      delete from identity_candidates;
      delete from soul_drafts;
      delete from facts where predicate in ('livesIn', 'headline');
      update facts set source_url = null, source_ref = null;
      update kg_nodes set props_json = '{}';
      delete from kg_nodes where type = 'Place';
      update model_calls set r2_trace_key = '', job_key = null;
      update snapshots set r2_key = '';
      update answers set idempotency_key = 'k_' || id;
      update answer_rewinds set idempotency_key = 'k_' || answer_id;
    `);
    const mimics = (await client.execute('select id, participant_id from mimics')).rows;
    for (const r of mimics) {
      const oldId = String(r.id);
      const newId = pseudo('m', oldId);
      for (const t of MIMIC_TABLES) {
        await client.execute({
          sql: `update ${t} set mimic_id = ? where mimic_id = ?`,
          args: [newId, oldId],
        });
      }
      await client.execute({
        sql: 'update kg_nodes set id = replace(id, ?, ?) where mimic_id = ?',
        args: [oldId, newId, newId],
      });
      await client.execute({
        sql: 'update kg_edges set src = replace(src, ?, ?), dst = replace(dst, ?, ?) where mimic_id = ?',
        args: [oldId, newId, oldId, newId, newId],
      });
      await client.execute({ sql: 'update mimics set id = ? where id = ?', args: [newId, oldId] });
    }
    for (const r of (await client.execute('select id from participants')).rows) {
      const oldId = String(r.id);
      const newId = pseudo('p', oldId);
      await client.execute({ sql: 'update participants set id = ? where id = ?', args: [newId, oldId] });
      await client.execute({
        sql: 'update mimics set participant_id = ? where participant_id = ?',
        args: [newId, oldId],
      });
    }
  }
  return { dropped: nonConsented.length };
}

/**
 * Content hash of a data file's tables, excluding `eval_runs` and migration bookkeeping, so recording eval runs in
 * the file keeps its dataset identity. Row order doesn't matter.
 */
export async function datasetHash(client: Client): Promise<string> {
  const h = createHash('sha256');
  const tables = (
    await client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite%' and name not like '\\_%' escape '\\' and name != 'eval_runs' order by name",
    )
  ).rows.map((r) => String(r.name));
  const cell = (v: unknown) => (v instanceof ArrayBuffer ? Buffer.from(v).toString('base64') : v);
  for (const t of tables) {
    const rs = await client.execute(`select * from "${t}"`);
    const rows = rs.rows.map((r) => JSON.stringify(rs.columns.map((_, i) => cell(r[i])))).sort();
    h.update(`${t}\n${rs.columns.join(',')}\n${rows.join('\n')}\n`);
  }
  return h.digest('hex');
}

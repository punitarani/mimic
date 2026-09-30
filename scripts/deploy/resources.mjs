// Find-or-create every Cloudflare resource an environment binds, then write the deploy configs with real IDs.
//
// Names come from the checked-in wrangler.jsonc (apps/worker is the superset: it binds every resource the web app
// does, plus the queue consumer and its dead-letter queue). Nothing is created by hand, and running this twice is a
// no-op: each resource is looked up by name first. Wrangler's own auto-provisioning is not enough here: it would
// give the web app and the worker separate KV namespaces, and it never creates queues or Vectorize indexes.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEPLOY_CONFIG_NAME, envBlock, readConfig, WEB_CONFIG, WORKER_CONFIG } from './lib.mjs';
import { resolveSettings } from './settings.mjs';

/** bge-base-en-v1.5 embeddings: 768 dimensions, cosine; metadata indexes for filtering by mimic and kind. */
export const VECTOR_INDEX = { dimensions: 768, metric: 'cosine', metadata: ['mimicId', 'kind'] };

/** What an environment needs, read from the worker's wrangler config. */
export function resourceSpec(workerConfig, env) {
  const e = envBlock(workerConfig, env);
  const d1 = e.d1_databases?.[0]?.database_name;
  const r2 = e.r2_buckets?.[0]?.bucket_name;
  const vectorize = e.vectorize?.[0]?.index_name;
  const queues = new Set();
  for (const p of e.queues?.producers ?? []) queues.add(p.queue);
  for (const c of e.queues?.consumers ?? []) {
    queues.add(c.queue);
    if (c.dead_letter_queue) queues.add(c.dead_letter_queue);
  }
  if (!d1 || !r2) throw new Error(`env.${env} must bind a D1 database and an R2 bucket`);
  // KV bindings carry only an id, so the namespace title is a convention: mimic-cache-<env>.
  return { d1, kv: `mimic-cache-${env}`, r2, queues: [...queues], vectorize: vectorize ?? null };
}

/** Finds or creates each resource; returns the IDs the configs need. Logs what it did, never secrets. */
export async function ensureResources(cf, spec, log = console.log) {
  const note = (kind, name, created) => log(`  ${kind} ${name}: ${created ? 'created' : 'exists'}`);

  // D1: the name filter is a substring match, so compare exactly.
  let db = ((await cf.get(`/d1/database?name=${encodeURIComponent(spec.d1)}`)) ?? []).find(
    (d) => d.name === spec.d1,
  );
  const dbCreated = !db;
  if (!db) db = await cf.post('/d1/database', { name: spec.d1 });
  note('D1', spec.d1, dbCreated);

  const namespaces = await cf.list('/storage/kv/namespaces');
  let kv = namespaces.find((n) => n.title === spec.kv);
  const kvCreated = !kv;
  if (!kv) kv = await cf.post('/storage/kv/namespaces', { title: spec.kv });
  note('KV', spec.kv, kvCreated);

  const bucket = await cf.find(`/r2/buckets/${encodeURIComponent(spec.r2)}`);
  if (!bucket) await cf.post('/r2/buckets', { name: spec.r2 });
  note('R2', spec.r2, !bucket);

  for (const q of spec.queues) {
    const found = ((await cf.get(`/queues?name=${encodeURIComponent(q)}`)) ?? []).some(
      (x) => x.queue_name === q,
    );
    if (!found) await cf.post('/queues', { queue_name: q });
    note('Queue', q, !found);
  }

  if (spec.vectorize) {
    const name = spec.vectorize;
    const index = await cf.find(`/vectorize/v2/indexes/${encodeURIComponent(name)}`);
    if (!index) {
      await cf.post('/vectorize/v2/indexes', {
        name,
        description: 'Mimic question and answer embeddings',
        config: { dimensions: VECTOR_INDEX.dimensions, metric: VECTOR_INDEX.metric },
      });
    } else if (
      index.config?.dimensions !== VECTOR_INDEX.dimensions ||
      index.config?.metric !== VECTOR_INDEX.metric
    ) {
      throw new Error(
        `Vectorize ${name} is ${index.config?.dimensions}-d ${index.config?.metric}; the app needs ` +
          `${VECTOR_INDEX.dimensions}-d ${VECTOR_INDEX.metric}. An index's shape can't change: delete and recreate it.`,
      );
    }
    note('Vectorize', name, !index);
    const listed = await cf.get(`/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/list`);
    const have = new Set((listed?.metadataIndexes ?? []).map((m) => m.propertyName));
    for (const prop of VECTOR_INDEX.metadata) {
      if (!have.has(prop)) {
        await cf.post(`/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/create`, {
          propertyName: prop,
          indexType: 'string',
        });
      }
      note('Vectorize metadata index', `${name}.${prop}`, !have.has(prop));
    }
  }

  const d1Id = db.uuid ?? db.id;
  if (!d1Id || !kv.id) throw new Error('Cloudflare returned no id for the D1 database or KV namespace');
  return { d1Id, kvId: kv.id };
}

/**
 * The checked-in config with this environment's resource IDs (in place of the REPLACE_ME_<ENV>_* placeholders) and,
 * when given, its resolved vars. The Flagship app ID is pinned in the config (ADR-0050), so it passes through.
 */
export function deployConfig(config, env, ids, vars) {
  const out = structuredClone(config);
  const e = envBlock(out, env);
  for (const d of e.d1_databases ?? []) d.database_id = ids.d1Id;
  for (const k of e.kv_namespaces ?? []) k.id = ids.kvId;
  if (vars) e.vars = vars;
  return out;
}

/** Writes the deploy config next to the original, so relative paths (main, assets, migrations) still resolve. */
export function writeDeployConfig(configPath, config) {
  const path = join(dirname(configPath), DEPLOY_CONFIG_NAME);
  writeFileSync(
    path,
    `// Generated by scripts/deploy for one deploy; real resource IDs. Never commit.\n${JSON.stringify(config, null, 2)}\n`,
  );
  return path;
}

/**
 * Step 2 of a deploy: resources found or created, and both apps' deploy configs written with real IDs and the
 * settings from `source` (settings.mjs). Returns their paths.
 */
export async function prepareConfigs(cf, env, source, log = console.log) {
  const worker = readConfig(WORKER_CONFIG);
  const web = readConfig(WEB_CONFIG);
  const ids = await ensureResources(cf, resourceSpec(worker, env), log);
  const vars = (config) => resolveSettings(config, env, source).vars;
  return {
    worker: writeDeployConfig(WORKER_CONFIG, deployConfig(worker, env, ids, vars(worker))),
    web: writeDeployConfig(WEB_CONFIG, deployConfig(web, env, ids, vars(web))),
  };
}

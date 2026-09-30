import { configHash, DEFAULT_CONFIG, DEFAULT_CONFIG_LABEL, JEV_MODEL, LLM, PipelineConfig } from '../config';
import type { CallContext, Gateway } from '../gateway';
import { unitHash } from '../hash';
import type { JobQueue } from '../jobs';
import { getOntology } from '../ontology';
import type { BlobStore, KvStore, MimicRecord, Store, VectorIndex } from '../store';
import type { Facet } from '../types';

export interface EngineDeps {
  store: Store;
  gateway: Gateway;
  blobs: BlobStore;
  kv: KvStore;
  vectors: VectorIndex;
  jobs: JobQueue;
  clock: () => number;
  newId: () => string;
  /** Jev model used for gates, trait reads and identity pre-ranking. */
  jevModel?: string;
  /** LLM used when the Jev primary errors (PLAN §16), and for playground wording. */
  fallbackModel?: string;
}

export class EngineError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid' | 'forbidden' | 'budget',
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

const configCache = new Map<string, PipelineConfig>();

/** Configs are immutable, so they are cached by hash for the life of the isolate. */
export async function loadConfig(deps: EngineDeps, hash: string): Promise<PipelineConfig> {
  const hit = configCache.get(hash);
  if (hit) return hit;
  const rec = await deps.store.getConfig(hash);
  if (!rec) throw new EngineError('not_found', `Config ${hash} not found`);
  const cfg = PipelineConfig.parse(JSON.parse(rec.json));
  configCache.set(hash, cfg);
  return cfg;
}

export async function registerConfig(
  deps: EngineDeps,
  cfg: PipelineConfig,
  label: string | null,
): Promise<string> {
  const hash = configHash(cfg);
  if (!(await deps.store.getConfig(hash))) {
    await deps.store.putConfig({
      hash,
      json: JSON.stringify(PipelineConfig.parse(cfg)),
      label,
      createdAt: deps.clock(),
    });
  }
  return hash;
}

export function ensureDefaultConfig(deps: EngineDeps): Promise<string> {
  return registerConfig(deps, DEFAULT_CONFIG, DEFAULT_CONFIG_LABEL);
}

/** 80/20 dev/test split by hash(mimicId); never changes (PLAN §12.4). */
export function splitFor(mimicId: string): 'dev' | 'test' {
  return unitHash(`split:${mimicId}`) < 0.8 ? 'dev' : 'test';
}

/** Weighted arm allocation by hash(mimicId) (PLAN §12.1). */
export function allocateArm<T extends { weight: number }>(
  mimicId: string,
  experimentId: string,
  arms: T[],
): T {
  const total = arms.reduce((a, b) => a + Math.max(0, b.weight), 0);
  let u = unitHash(`arm:${experimentId}:${mimicId}`) * total;
  for (const arm of arms) {
    u -= Math.max(0, arm.weight);
    if (u < 0) return arm;
  }
  return arms[arms.length - 1]!;
}

export function jevModel(deps: EngineDeps): string {
  return deps.jevModel ?? JEV_MODEL;
}

export function fallbackModel(deps: EngineDeps): string {
  return deps.fallbackModel ?? LLM.deepseek;
}

export function ctxFor(
  m: Pick<MimicRecord, 'id' | 'configHash'>,
  purpose: string,
  jobKey?: string,
): CallContext {
  return { purpose, mimicId: m.id, configHash: m.configHash, jobKey: jobKey ?? null };
}

export async function facetsFor(deps: EngineDeps, m: MimicRecord, cfg: PipelineConfig): Promise<Facet[]> {
  const base = getOntology(cfg.ontologyVersion);
  const extra = await deps.store.listMimicFacets(m.id);
  return [...base, ...extra.map((e) => e.facet)];
}

export async function requireMimic(deps: EngineDeps, id: string): Promise<MimicRecord> {
  const m = await deps.store.getMimic(id);
  if (!m) throw new EngineError('not_found', 'Mimic not found');
  return m;
}

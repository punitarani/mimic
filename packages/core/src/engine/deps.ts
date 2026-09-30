import {
  configHash,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_LABEL,
  JEV_MODEL,
  LLM,
  PipelineConfig,
  type SpendCaps,
  type SpendLimits,
  spendCaps,
} from '../config';
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
  /**
   * Runs work that may finish after the response is sent (Next's `after()` / `ctx.waitUntil`). Defaults to running it
   * inline. Never used for anything the client must see persisted first (PLAN §3.2).
   */
  defer?: (task: () => Promise<void>) => void;
  /** Receives phase timings (ms), e.g. for Server-Timing headers. */
  timing?: (phase: string, ms: number) => void;
  /** Deploy-time spend limits (ADR-0034); unset fields fall back to the config's budget and an 80% session share. */
  spend?: SpendLimits;
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

/** This mimic's caps: the session stops at `sessionUsd`; asking, teaching and SOUL.md run to `totalUsd`. */
export function capsFor(deps: EngineDeps, cfg: PipelineConfig): SpendCaps {
  return spendCaps(cfg, deps.spend);
}

/** True once the session has spent its share: no new session questions, pool refills or hypotheses. */
export function sessionSpent(
  deps: EngineDeps,
  m: Pick<MimicRecord, 'spendUsd'>,
  cfg: PipelineConfig,
): boolean {
  return m.spendUsd >= capsFor(deps, cfg).sessionUsd;
}

/** True once the whole cap is spent; the gateway refuses every call for the mimic from here. */
export function budgetSpent(
  deps: EngineDeps,
  m: Pick<MimicRecord, 'spendUsd'>,
  cfg: PipelineConfig,
): boolean {
  return m.spendUsd >= capsFor(deps, cfg).totalUsd;
}

export function jevModel(deps: EngineDeps): string {
  return deps.jevModel ?? JEV_MODEL;
}

export function fallbackModel(deps: EngineDeps): string {
  return deps.fallbackModel ?? LLM.deepseek;
}

/** Runs `task` via deps.defer when provided, else inline. */
export async function deferred(deps: EngineDeps, task: () => Promise<void>): Promise<void> {
  if (deps.defer) deps.defer(task);
  else await task();
}

/** Times an async phase and reports it through deps.timing. */
export async function timed<T>(deps: EngineDeps, phase: string, fn: () => Promise<T>): Promise<T> {
  if (!deps.timing) return fn();
  const t0 = deps.clock();
  try {
    return await fn();
  } finally {
    deps.timing(phase, deps.clock() - t0);
  }
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

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
import { BudgetExceededError, type CallContext, type Gateway } from '../gateway';
import { unitHash } from '../hash';
import type { JobQueue } from '../jobs';
import { getOntology } from '../ontology';
import { scopedFacets } from '../scope';
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
  /** Deploy-time spend limits (ADR-0035); unset fields fall back to the config's budget and an 80% session share. */
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

/** True once the session has spent its share: `/next` stops serving, and session background work stops. */
export function sessionSpent(
  deps: EngineDeps,
  m: Pick<MimicRecord, 'spendUsd'>,
  cfg: PipelineConfig,
): boolean {
  return m.spendUsd >= capsFor(deps, cfg).sessionUsd;
}

/**
 * Stops session background work (shadows, refills, hypotheses) once the session has spent its share, before it loads
 * anything. The job ledger records the refusal without marking the job done, so a raised cap can run it again.
 */
export function requireSessionBudget(
  deps: EngineDeps,
  m: Pick<MimicRecord, 'id' | 'spendUsd'>,
  cfg: PipelineConfig,
): void {
  const { sessionUsd } = capsFor(deps, cfg);
  if (m.spendUsd >= sessionUsd) throw new BudgetExceededError(m.id, m.spendUsd, sessionUsd);
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

/**
 * `deps` whose store refuses derived writes and serves once an undo moves the mimic's evidence past what `m` saw
 * (ADR-0036). Use it for anything built from data read along with `m`.
 */
export function guardedDeps(deps: EngineDeps, m: Pick<MimicRecord, 'id' | 'evidenceEpoch'>): EngineDeps {
  return { ...deps, store: deps.store.guarded(m.id, m.evidenceEpoch) };
}

export function ctxFor(
  m: Pick<MimicRecord, 'id' | 'configHash'>,
  purpose: string,
  jobKey?: string,
): CallContext {
  return { purpose, mimicId: m.id, configHash: m.configHash, jobKey: jobKey ?? null };
}

/**
 * The mimic's facets: the config's ontology plus its occupation facets, limited to what the person's scope allows
 * (ADR-0040). This is the single source every generator, gate, trait read, reflection, hypothesis, belief and view
 * uses, so a deselected category or a sensitive area without consent never reaches any of them. `scoped: false` is
 * for code that needs to know what is blocked (the loaders, the export scrub) or what already exists.
 */
export async function facetsFor(
  deps: EngineDeps,
  m: Pick<MimicRecord, 'id' | 'scope'>,
  cfg: PipelineConfig,
  opts: { scoped?: boolean } = {},
): Promise<Facet[]> {
  const base = getOntology(cfg.ontologyVersion);
  const extra = await deps.store.listMimicFacets(m.id);
  // Occupation facets stored before ADR-0040 carry no category; they are always "Work and money".
  const all = [
    ...base,
    ...extra.map((e) => ({ ...e.facet, category: e.facet.category ?? ('work' as const) })),
  ];
  return opts.scoped === false ? all : scopedFacets(m.scope, all);
}

export async function requireMimic(deps: EngineDeps, id: string): Promise<MimicRecord> {
  const m = await deps.store.getMimic(id);
  if (!m) throw new EngineError('not_found', 'Mimic not found');
  return m;
}

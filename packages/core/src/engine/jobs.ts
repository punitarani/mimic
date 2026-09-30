import { domainQuota, overExposed, splitQuota, targetFacets } from '../belief';
import type { PipelineConfig } from '../config';
import { BudgetExceededError } from '../gateway';
import { hashJson } from '../hash';
import { GATES_VERSION } from '../jev';
import { type Job, jobFromKey, jobKey, type QueuedJob } from '../jobs';
import {
  generateCandidates,
  generateHypotheses,
  generateOccupationFacets,
  psychometricTraits,
  readTraits,
  reflect,
  runQualityGates,
} from '../learning';
import { getAnchorSet } from '../ontology';
import { computeItemStats, type ScoredItemRow } from '../population';
import { assertPredictorId, makePredictor, promptVersionOf } from '../predictors';
import { scorePrediction } from '../scoring';
import { facetCoverage, usesHypotheses } from '../selectors';
import { buildState, cosine, type EvidenceItem, toStateEvidence } from '../state-builder';
import {
  type FactRecord,
  type InsightRecord,
  type KgEdgeRecord,
  type KgNodeRecord,
  type MimicRecord,
  type PredictionRecord,
  type QuestionRecord,
  StaleEvidenceError,
} from '../store';
import { type Domain, isScoredKind, learnsFrom, type PersonState } from '../types';
import { writeSnapshot } from './artifact';
import { beliefFromLoaded, loadBeliefSources } from './belief';
import {
  facetCounts,
  type LoadedMimic,
  loadMimicData,
  qaText,
  stateBlobKey,
  stateOptions,
  vectorId,
} from './data';
import {
  budgetSpent,
  ctxFor,
  type EngineDeps,
  EngineError,
  facetsFor,
  jevModel,
  loadConfig,
  requireMimic,
  requireSessionBudget,
  sessionSpent,
} from './deps';
import { addFacts, personNodeId, runIdentityEnrich, runIdentitySearch } from './identity';
import { PENDING_WINDOW_MS } from './lab';
import { refreshQaVector } from './rewind';
import { invalidateItemStatsCache, loadHypotheses, MAX_POOL, MIN_POOL } from './session';

export const MAX_JOB_ATTEMPTS = 5;

/**
 * Runs one job idempotently via the `jobs` ledger (PLAN §6.4). Returns 'skipped' for duplicates. Throws on failure
 * so the queue retries with backoff; after MAX_JOB_ATTEMPTS the queue's dead-letter queue takes over.
 *
 * A job refused by the budget guard is 'skipped', not retried (a retry would be refused the same way), and is never
 * marked done, so the same job runs again if it is enqueued after the cap is raised (ADR-0035). Its row is written
 * with the attempts used up, so the stale-job requeue leaves it alone.
 */
export async function runJob(deps: EngineDeps, job: Job): Promise<'done' | 'skipped'> {
  const key = jobKey(job);
  const prev = await deps.store.getJob(key);
  if (prev?.status === 'done') return 'skipped';
  const attempts = (prev?.attempts ?? 0) + 1;
  await deps.store.putJob({
    key,
    type: job.type,
    status: 'running',
    attempts,
    lastError: null,
    updatedAt: deps.clock(),
  });
  try {
    await dispatch(deps, job, key, attempts);
    await deps.store.putJob({
      key,
      type: job.type,
      status: 'done',
      attempts,
      lastError: null,
      updatedAt: deps.clock(),
    });
    return 'done';
  } catch (e) {
    // An undo landed while the job ran and its writes were refused (ADR-0036): a retry would only be refused again.
    if (e instanceof StaleEvidenceError) {
      await deps.store.putJob({
        key,
        type: job.type,
        status: 'done',
        attempts,
        lastError: e.message,
        updatedAt: deps.clock(),
      });
      return 'done';
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof BudgetExceededError) {
      await deps.store.putJob({
        key,
        type: job.type,
        status: 'failed',
        attempts: Math.max(attempts, MAX_JOB_ATTEMPTS),
        lastError: `budget: ${msg}`.slice(0, 1000),
        updatedAt: deps.clock(),
      });
      return 'skipped';
    }
    await deps.store.putJob({
      key,
      type: job.type,
      status: 'failed',
      attempts,
      lastError: msg.slice(0, 1000),
      updatedAt: deps.clock(),
    });
    throw e;
  }
}

/** A queue consumer invocation can't run past 15 minutes on Workers, so a job `running` longer than that is dead. */
export const STALE_JOB_MS = 15 * 60 * 1000;

/**
 * Cron safety net: re-enqueues jobs stuck in `running`/`failed` (for example a lost message in local dev). Queues
 * already redeliver unacked messages in deployed envs; the ledger makes a duplicate run a no-op.
 */
export async function requeueStaleJobs(deps: EngineDeps, limit = 200): Promise<number> {
  const stale = await deps.store.listStaleJobs(deps.clock() - STALE_JOB_MS, limit);
  let n = 0;
  for (const j of stale) {
    if (j.attempts >= MAX_JOB_ATTEMPTS) continue;
    const job = jobFromKey(j.key);
    if (!job) continue;
    await deps.jobs.enqueue(job);
    n++;
  }
  return n;
}

/**
 * Cron safety net for shadows whose enqueue was lost outright (no ledger row to requeue): enqueues every expected
 * shadow missing on the mimic's questions served before `servedBefore`. Shadows read the sealed state blob, so a late
 * one is still sealed (PLAN §3.1); job keys make repeats no-ops.
 */
export async function enqueueMissingShadows(
  deps: EngineDeps,
  mimicId: string,
  servedBefore: number,
): Promise<number> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  // Shadows stop with the session's share (ADR-0035); enqueueing them past it would only queue refusals.
  if (sessionSpent(deps, m, cfg)) return 0;
  return enqueueMissingPredictions(deps, mimicId, servedBefore, cfg.predictor.shadows);
}

/**
 * Enqueues a `predict.shadow` for each of `predictorIds` on each of the mimic's served anchor and adaptive questions
 * that has no prediction from it yet, in any role, and none in flight. A shadow whose job used up its attempts
 * without storing anything is left alone, so the cron can't retry it forever.
 */
export async function enqueueMissingPredictions(
  deps: EngineDeps,
  mimicId: string,
  servedBefore: number,
  predictorIds: readonly string[],
): Promise<number> {
  const work = await missingPredictions(deps, mimicId, servedBefore, predictorIds, { live: true });
  for (const w of work) await deps.jobs.enqueue({ type: 'predict.shadow', mimicId, ...w });
  return work.length;
}

/**
 * A shadow whose call failed before the model answered (a transport error after every attempt, or the budget
 * guard): a backfill with `retryFailed` may redo it. Unusable output and timeouts are the model's, and stand.
 */
export function isFailedCall(p: Pick<PredictionRecord, 'role' | 'ok' | 'errorKind'>): boolean {
  return p.role === 'shadow' && !p.ok && p.errorKind === 'transport';
}

/** `${questionId}|${predictorId}` of the mimic's shadow jobs, live or backfill, that are queued or being retried. */
async function shadowJobs(deps: EngineDeps, mimicId: string) {
  const now = deps.clock();
  const [live, backfill] = await Promise.all([
    deps.store.listJobs(`predict.shadow:${mimicId}:`),
    deps.store.listJobs(`backfill.shadow:${mimicId}:`),
  ]);
  const inFlight = new Set<string>();
  const exhausted = new Set<string>();
  for (const r of [...live, ...backfill]) {
    const job = jobFromKey(r.key);
    if (r.status === 'done' || !job || !('questionId' in job)) continue;
    const id = `${job.questionId}|${job.predictorId}`;
    if (r.attempts >= MAX_JOB_ATTEMPTS && r.status === 'failed') {
      // A budget refusal isn't exhaustion: it runs again once the cap allows (ADR-0035).
      if (job.type === 'predict.shadow' && !r.lastError?.startsWith('budget:')) exhausted.add(id);
    } else if (r.updatedAt >= now - STALE_JOB_MS) inFlight.add(id); // older: its message was lost
  }
  return { inFlight, exhausted };
}

/**
 * The mimic's anchor and adaptive questions served before `servedBefore`, with a primary (so a sealed state), no
 * prediction from each predictor in any role (a failed call counts as none with `retryFailed`), and no shadow job
 * for it in flight. `live`: also skips shadows whose live job gave up. In `seq` order. The same rule as `pnpm
 * backfill`'s dry run (scripts/backfill.mjs).
 */
async function missingPredictions(
  deps: EngineDeps,
  mimicId: string,
  servedBefore: number,
  predictorIds: readonly string[],
  opts: { retryFailed?: boolean | undefined; live?: boolean } = {},
): Promise<Array<{ questionId: string; predictorId: string }>> {
  if (!predictorIds.length) return [];
  const [questions, predictions, jobs] = await Promise.all([
    deps.store.listQuestions(mimicId),
    deps.store.listPredictions({ mimicId }),
    shadowJobs(deps, mimicId),
  ]);
  // Hypothesis rows carry the primary's predictor id but are exploration artifacts, not predictions of the question.
  const have = new Set(
    predictions
      .filter((p) => p.role !== 'hypothesis' && !(opts.retryFailed && isFailedCall(p)))
      .map((p) => `${p.questionId}|${p.predictorId}`),
  );
  // A shadow reads the primary's sealed state; without a primary there is nothing to predict from.
  const sealed = new Set(predictions.filter((p) => p.role === 'primary').map((p) => p.questionId));
  const out: Array<{ questionId: string; predictorId: string }> = [];
  for (const q of [...questions].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (q.seq === null || q.servedAt === null || q.servedAt >= servedBefore) continue;
    if (!isScoredKind(q.kind)) continue;
    if (!sealed.has(q.id)) continue;
    for (const predictorId of predictorIds) {
      const id = `${q.id}|${predictorId}`;
      if (have.has(id) || jobs.inFlight.has(id) || (opts.live && jobs.exhausted.has(id))) continue;
      out.push({ questionId: q.id, predictorId });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Backfill (ADR-0024, ADR-0037): a new shadow model run over questions already served, on the same sealed states.
// ---------------------------------------------------------------------------------------------------------------

/** Default pace, per predictor: one prediction every 2 s, about what a few live sessions produce. */
export const BACKFILL_PER_MINUTE = 30;
/** At most this many predictions per backfill job; a re-run enqueues the rest. */
export const BACKFILL_MAX_JOBS = 5000;
/** Queues delay a message by at most 24 h; a run spans at most this, and a re-run enqueues the rest. */
export const BACKFILL_MAX_DELAY_SECONDS = 12 * 3600;

/** How many predictions one run enqueues at this pace: the job cap, or what fits in the delay horizon. */
export function backfillLimit(perMinute = BACKFILL_PER_MINUTE, offsetSeconds = 0): number {
  const fit = Math.floor(((BACKFILL_MAX_DELAY_SECONDS - offsetSeconds) * perMinute) / 60) + 1;
  return Math.max(0, Math.min(BACKFILL_MAX_JOBS, fit));
}

function checkPredictorId(id: string): void {
  try {
    // The ID must parse and any `@<promptVersion>` must be registered (ADR-0028).
    assertPredictorId(id);
  } catch (e) {
    throw new EngineError('invalid', e instanceof Error ? e.message : String(e));
  }
}

interface BackfillRun {
  predictorId: string;
  perMinute?: number | undefined;
  retryFailed?: boolean | undefined;
}

export interface BackfillEnqueued {
  enqueued: number;
  /** Stopped at backfillLimit(): anything left waits for a re-run. */
  capped: boolean;
}

/**
 * Enqueues one `backfill.shadow` per missing prediction of these mimics, spaced `60 / perMinute` seconds apart from
 * `offsetSeconds` on. Pacing keeps a backfill from flooding the queue (live sessions share it) and the provider
 * (rate limits, slower answers), so its failures and latencies look like a live shadow's. Each one is written to
 * the ledger as `queued` first: a re-run skips it, and the cron requeues it if its message is lost. Questions
 * served in the last PENDING_WINDOW_MS are left to the live path.
 */
async function enqueueBackfill(
  deps: EngineDeps,
  run: BackfillRun,
  mimicIds: readonly string[],
  opts: { offsetSeconds?: number | undefined; allMimics: boolean },
): Promise<BackfillEnqueued> {
  const offset = opts.offsetSeconds ?? 0;
  const gap = 60 / (run.perMinute ?? BACKFILL_PER_MINUTE);
  const limit = backfillLimit(run.perMinute, offset);
  const now = deps.clock();
  let enqueued = 0;
  for (const mimicId of mimicIds) {
    if (enqueued >= limit) return { enqueued, capped: true };
    const m = await deps.store.getMimic(mimicId);
    // Held to the session's share like a shadow (ADR-0035): a mimic that spent it would only queue refusals.
    if (!m || sessionSpent(deps, m, await loadConfig(deps, m.configHash))) continue;
    const work = await missingPredictions(deps, mimicId, now - PENDING_WINDOW_MS, [run.predictorId], {
      retryFailed: run.retryFailed,
    });
    const batch: Array<QueuedJob & { delaySeconds: number }> = [];
    for (const { questionId } of work.slice(0, limit - enqueued)) {
      const job: Job = { type: 'backfill.shadow', mimicId, questionId, predictorId: run.predictorId };
      if (run.retryFailed) job.retryFailed = true;
      if (opts.allMimics) job.allMimics = true;
      batch.push({ job, delaySeconds: Math.round(offset + (enqueued + batch.length) * gap) });
    }
    if (!batch.length) continue;
    await deps.store.putJobs(
      batch.map((b) => ({
        key: jobKey(b.job),
        type: b.job.type,
        status: 'queued' as const,
        attempts: 0,
        lastError: null,
        updatedAt: now + b.delaySeconds * 1000,
      })),
    );
    await deps.jobs.enqueueBatch(batch.map((b) => (b.delaySeconds > 0 ? b : { job: b.job })));
    enqueued += batch.length;
    if (work.length > batch.length) return { enqueued, capped: true };
  }
  return { enqueued, capped: false };
}

/** Every (consented) mimic, paced as one stream so the predictor sees a steady rate. */
export async function runBackfillPredictor(
  deps: EngineDeps,
  job: BackfillRun & { consentedOnly: boolean },
): Promise<BackfillEnqueued & { mimics: number }> {
  checkPredictorId(job.predictorId);
  const mimics = await deps.store.listMimics(job.consentedOnly ? { consentResearch: true } : {});
  const ids = mimics.map((m) => m.id);
  return {
    mimics: mimics.length,
    ...(await enqueueBackfill(deps, job, ids, { allMimics: !job.consentedOnly })),
  };
}

/** One named mimic (the CLI's `--mimic`), chosen by the operator; with `consentedOnly`, only while it consents. */
export async function runBackfillMimic(
  deps: EngineDeps,
  job: BackfillRun & {
    mimicId: string;
    offsetSeconds?: number | undefined;
    consentedOnly?: boolean | undefined;
  },
): Promise<BackfillEnqueued> {
  checkPredictorId(job.predictorId);
  if (job.consentedOnly && !(await requireMimic(deps, job.mimicId)).consentResearch)
    return { enqueued: 0, capped: false };
  return enqueueBackfill(deps, job, [job.mimicId], {
    offsetSeconds: job.offsetSeconds,
    allMimics: !job.consentedOnly,
  });
}

async function dispatch(deps: EngineDeps, job: Job, key: string, attempt: number): Promise<void> {
  // A job for a deleted mimic is a no-op.
  if ('mimicId' in job && !(await deps.store.getMimic(job.mimicId))) return;
  switch (job.type) {
    case 'noop':
      return;
    case 'identity.search':
      return runIdentitySearch(deps, job.mimicId, key);
    case 'identity.enrich':
      return runIdentityEnrich(deps, job.mimicId, job.candidateId, key);
    case 'pool.refill':
      return runPoolRefill(deps, job.mimicId, key);
    case 'predict.shadow':
      return runShadow(deps, job.mimicId, job.questionId, job.predictorId, key, { attempt });
    case 'learn.answer':
      return runLearn(deps, job.mimicId, job.seq, key, job.answerId);
    case 'hypotheses.refresh':
      return runHypotheses(deps, job.mimicId, job.seqUpTo, key);
    case 'snapshot.write':
      await writeSnapshot(deps, job.mimicId, job.seqUpTo);
      return;
    case 'backfill.predictor':
      await runBackfillPredictor(deps, job);
      return;
    case 'backfill.mimic':
      await runBackfillMimic(deps, job);
      return;
    case 'backfill.shadow':
      return runShadow(deps, job.mimicId, job.questionId, job.predictorId, key, {
        backfill: true,
        retryFailed: job.retryFailed ?? false,
        allMimics: job.allMimics ?? false,
        attempt,
      });
    case 'stats.refresh':
      await runStatsRefresh(deps);
      return;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// stats.refresh (ADR-0027): cross-person item statistics over research-consented, dev-split mimics.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Recomputes `item_stats` from scratch in one query and replaces the table atomically, so a deleted mimic (or a
 * withdrawn consent) drops out at the next run and nothing stale survives. Aggregate only: groups below
 * POP_MIN_PEOPLE are never written, no row names a person, and the result ranks pooled candidates without ever
 * entering a prompt or a state (PLAN §3.8).
 */
export async function runStatsRefresh(deps: EngineDeps): Promise<number> {
  const sources = await deps.store.listScoredForStats({ consentResearch: true, split: 'dev' });
  const baselineByQ = new Map(
    sources.filter((r) => r.role === 'baseline').map((r) => [r.questionId, r.itemAcc]),
  );
  const rows: ScoredItemRow[] = [];
  for (const r of sources) {
    if (r.role !== 'primary' || r.fallback) continue;
    if (!isScoredKind(r.question.kind)) continue;
    rows.push({
      mimicId: r.mimicId,
      itemKey: r.question.itemKey ?? null,
      facetIds: r.question.facetIds,
      domain: r.question.domain,
      type: r.question.type,
      answer: r.answer.value,
      nOptions: r.question.options.length,
      primaryItemAcc: r.itemAcc,
      primaryLogLoss: r.logLoss,
      baselineItemAcc: baselineByQ.get(r.questionId) ?? null,
      latencyMs: r.answer.latencyMs,
    });
  }
  const stats = computeItemStats(rows, deps.clock());
  await deps.store.replaceItemStats(stats);
  invalidateItemStatsCache();
  return stats.length;
}

// ---------------------------------------------------------------------------------------------------------------
// predict.shadow (PLAN §9.6): the same sealed state (identical stateHash) as the primary.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A call that failed before the model answered (a rate limit, provider error or network failure) is thrown, so the
 * queue retries it with backoff; on the last attempt (MAX_JOB_ATTEMPTS) it is stored as a failed call instead, so
 * nothing retries it forever and a backfill with `retryFailed` can redo it later. The model's own failures
 * (unusable output, a timeout) are stored at once (ADR-0037). The unique shadow index makes a concurrent run of
 * the same shadow a no-op.
 *
 * `backfill`: operator research work (ADR-0024). The call is logged as `predict.backfill`, held like a shadow to the
 * session's share of the budget (ADR-0035); it skips a mimic that no longer consents (unless `allMimics`), and with
 * `retryFailed` it replaces this predictor's failed call instead of skipping the question.
 */
export async function runShadow(
  deps: EngineDeps,
  mimicId: string,
  questionId: string,
  predictorId: string,
  key?: string,
  opts: { backfill?: boolean; retryFailed?: boolean; allMimics?: boolean; attempt?: number } = {},
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  if (opts.backfill && !opts.allMimics && !m.consentResearch) return;
  // Shadows (and `pnpm backfill`) are session and research work, so they never draw on the page's reserve.
  requireSessionBudget(deps, m, await loadConfig(deps, m.configHash));
  const q = await deps.store.getQuestion(questionId);
  if (!q || q.mimicId !== m.id) return;
  const preds = await deps.store.listPredictions({ questionId });
  const mine = preds.filter((p) => p.predictorId === predictorId && p.role !== 'hypothesis');
  const redo = opts.backfill && opts.retryFailed ? mine.filter(isFailedCall) : [];
  if (opts.backfill ? mine.length > redo.length : mine.some((p) => p.role === 'shadow')) return;
  const primary = preds.find((p) => p.role === 'primary');
  if (!primary) return;
  const raw = await deps.blobs.get(stateBlobKey(m.id, primary.stateHash));
  if (!raw) throw new Error(`Sealed state ${primary.stateHash} missing`);
  const state = JSON.parse(raw) as PersonState;
  const { meta, ...body } = state;
  if (hashJson(body) !== meta.stateHash) throw new Error('Sealed state hash mismatch');

  const ctx = ctxFor(m, opts.backfill ? 'predict.backfill' : 'predict.shadow', key);
  const [r] = await makePredictor(deps.gateway, predictorId, ctx).predict(state, [q]);
  const attempt = opts.attempt ?? MAX_JOB_ATTEMPTS;
  if (!r!.ok && r!.retryable && attempt < MAX_JOB_ATTEMPTS)
    throw new Error(`${predictorId} call failed (attempt ${attempt} of ${MAX_JOB_ATTEMPTS}): ${r!.error}`);
  const now = deps.clock();
  const rec: PredictionRecord = {
    id: deps.newId(),
    questionId: q.id,
    mimicId: m.id,
    predictorId,
    role: 'shadow',
    dist: r!.dist,
    confidence: r!.confidence ?? null,
    stateHash: meta.stateHash,
    evidenceSeqMax: meta.evidenceSeqMax,
    configHash: m.configHash,
    promptVersion: promptVersionOf(predictorId),
    modelSnapshot: r!.modelSnapshot,
    costUsd: r!.costUsd,
    latencyMs: r!.latencyMs,
    ok: r!.ok,
    error: r!.error ?? null,
    errorKind: r!.ok ? null : (r!.errorKind ?? null),
    fallback: false,
    createdAt: now,
  };
  const stored = await deps.store.insertShadow(
    rec,
    redo.map((p) => p.id),
  );
  if (!stored) return; // another run of this shadow got there first
  // Discarded by an undo while this ran (ADR-0036): its state held the retracted answer.
  if ((await deps.store.getQuestion(q.id))?.status === 'discarded') {
    await deps.store.deletePredictions([rec.id]);
    return;
  }
  // Sealing is defined by state contents, so a shadow may finish after the answer and still be scored.
  const answer = await deps.store.getAnswerForQuestion(q.id);
  if (answer && rec.ok) {
    await deps.store.insertScores([
      {
        predictionId: rec.id,
        answerId: answer.id,
        ...scorePrediction(q.type, rec.dist, answer.value),
        createdAt: now,
      },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// pool.refill (PLAN §9.4)
// ---------------------------------------------------------------------------------------------------------------

export const DEDUPE_SIMILARITY = 0.9;

export async function runPoolRefill(deps: EngineDeps, mimicId: string, key?: string): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const loaded = await loadMimicData(deps, m);
  const pool = loaded.questions.filter((q) => q.kind === 'adaptive' && q.status === 'pooled');
  if (pool.length >= MIN_POOL) return;
  // Candidates only feed the session, so refills stop with it and never draw on the page's reserve.
  requireSessionBudget(deps, m, cfg);
  const facets = await facetsFor(deps, m, cfg);
  const n = Math.min(cfg.generator.batchSize, MAX_POOL - pool.length + 4);
  const mix = cfg.generator.domainMix;
  let targets: string[];
  let quota: Record<Domain, number>;
  let targetDetails: ReturnType<typeof targetFacets> | undefined;
  let avoid: string[] | undefined;
  if (cfg.generator.promptVersion === 'gen.v2') {
    // Belief-driven targets (docs/SELECTION.md §5): the facets with the highest need, each with why and the
    // person's current reading; the domain quota tilts toward the domains the mimic is weakest in.
    const belief = beliefFromLoaded(loaded, facets, cfg, await loadBeliefSources(deps, m), { pooled: pool });
    const cap = cfg.selector.type === 'voi' ? cfg.selector.exposureCap : 1;
    targetDetails = targetFacets(belief, facets, 5, cap);
    targets = targetDetails.map((t) => t.id);
    avoid = facets.filter((f) => overExposed(belief, f.id, cap)).map((f) => f.id);
    quota = domainQuota(belief, mix, n);
  } else {
    const counts = facetCounts(loaded.questions);
    for (const q of pool) for (const f of q.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
    const traitConf = new Map(
      loaded.data.traits.filter((t) => t.method === 'jev').map((t) => [t.facetId, t.confidence]),
    );
    targets = [...facets]
      .sort(
        (a, b) =>
          facetCoverage(counts, a.id) - facetCoverage(counts, b.id) ||
          (traitConf.get(a.id) ?? 0) - (traitConf.get(b.id) ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 5)
      .map((f) => f.id);
    quota = splitQuota(mix, n);
  }

  const state = buildState(
    loaded.data,
    stateOptions(cfg, Number.MAX_SAFE_INTEGER, { strategy: 'structured' }),
  );
  const traitSummary = (state.traits ?? [])
    .filter((t) => t.confidence >= 0.3)
    .slice(0, 12)
    .map((t) => `${t.facet}=${t.mean}`)
    .join(', ');
  const recent = loaded.questions
    .filter((q) => q.seq !== null)
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, 10)
    .map((q) => q.prompt);
  const ctx = ctxFor(m, 'pool.generate', key);
  const gen = await generateCandidates(deps.gateway, ctx, {
    model: cfg.generator.model,
    reasoningEffort: cfg.generator.reasoningEffort,
    promptVersion: cfg.generator.promptVersion,
    facets,
    targets,
    ...(targetDetails ? { targetDetails } : {}),
    ...(avoid ? { avoid } : {}),
    quota,
    identity: state.identity,
    traitSummary,
    recentPrompts: recent,
    n,
  });
  if (!gen.drafts.length) return;

  const gates = await runQualityGates(deps.gateway, ctxFor(m, 'pool.gate', key), jevModel(deps), gen.drafts);
  const passed = gen.drafts.map((d, i) => ({ d, g: gates[i]! })).filter((x) => x.g.passed);
  if (!passed.length) return;

  // Dedupe: cosine > 0.9 against asked or pooled questions, and within the batch.
  let vectors: number[][] | null = null;
  try {
    vectors = (
      await deps.gateway.embed(
        ctxFor(m, 'embed.question', key),
        passed.map((x) => x.d.prompt),
      )
    ).vectors;
  } catch {
    vectors = null;
  }
  const existing = loaded.questions.filter((q) => q.kind !== 'repeat' && q.status !== 'discarded');
  const existingVecs = vectors
    ? await deps.vectors.getByIds(existing.map((q) => vectorId.question(m.id, q.id))).catch(() => [])
    : [];
  const kept: Array<{ d: (typeof passed)[number]['d']; g: (typeof passed)[number]['g']; v?: number[] }> = [];
  const lowerPrompts = new Set(existing.map((q) => q.prompt.toLowerCase()));
  passed.forEach((x, i) => {
    if (lowerPrompts.has(x.d.prompt.toLowerCase())) return;
    const v = vectors?.[i];
    if (v) {
      const dup =
        existingVecs.some((e) => cosine(e.values, v) > DEDUPE_SIMILARITY) ||
        kept.some((k) => k.v && cosine(k.v, v) > DEDUPE_SIMILARITY);
      if (dup) return;
    }
    lowerPrompts.add(x.d.prompt.toLowerCase());
    kept.push(v ? { ...x, v } : x);
  });

  const now = deps.clock();
  const recs: QuestionRecord[] = kept.slice(0, MAX_POOL - pool.length).map(({ d, g }, i) => ({
    id: deps.newId(),
    mimicId: m.id,
    seq: null,
    kind: 'adaptive',
    type: d.type,
    domain: d.domain,
    prompt: d.prompt,
    options: d.options,
    facetIds: d.facetIds,
    provenance: {
      generator: cfg.generator.model,
      configHash: m.configHash,
      promptVersion: cfg.generator.promptVersion,
    },
    status: 'pooled',
    quality: { gates: g.p, gatesVersion: GATES_VERSION, rationale: d.rationale ?? null },
    createdAt: now + i,
    servedAt: null,
    stateAt: null,
  }));
  if (!recs.length) return;
  await deps.store.insertQuestions(recs);
  const vecRecs = recs.flatMap((r, i) => {
    const v = kept[i]?.v;
    return v
      ? [
          {
            id: vectorId.question(m.id, r.id),
            values: v,
            metadata: { mimicId: m.id, kind: 'question' as const, facetIds: r.facetIds.join(','), seq: 0 },
          },
        ]
      : [];
  });
  if (vecRecs.length) await deps.vectors.upsert(vecRecs).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------
// learn.answer (PLAN §9.8)
// ---------------------------------------------------------------------------------------------------------------

export const SNAPSHOT_DEBOUNCE_SECONDS = 10;

/**
 * `answerId` (absent on jobs queued before ADR-0036) names the answer being learned; if the person undid it, the job
 * is a no-op. Every derived write goes through a store guarded by the evidence epoch read here, so if they undo it
 * while the job runs, nothing the job computes lands after the undo (which removed what had already landed).
 */
export async function runLearn(
  deps: EngineDeps,
  mimicId: string,
  seq: number,
  key?: string,
  answerId?: string,
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const loaded = await loadMimicData(deps, m);
  if (answerId && !loaded.answers.some((a) => a.seq === seq && a.id === answerId)) return;
  const item = loaded.data.evidence.find((e) => e.seq === seq);
  if (!item || !learnsFrom(item.kind)) return;
  const epoch = m.evidenceEpoch;
  const snapshot = () =>
    deps.jobs.enqueue(
      { type: 'snapshot.write', mimicId: m.id, seqUpTo: seq, epoch },
      { delaySeconds: SNAPSHOT_DEBOUNCE_SECONDS },
    );
  try {
    await learnGuarded({ ...deps, store: deps.store.guarded(m.id, epoch) }, m, cfg, loaded, item, seq, key);
  } catch (e) {
    if (!(e instanceof StaleEvidenceError)) throw e;
    await refreshQaVector(deps, m, seq);
    // An undo of a later answer refuses this job too, though its own answer still stands: learn it again.
    const current = await deps.store.getAnswerForQuestion(item.questionId);
    if (current && (!answerId || current.id === answerId))
      throw new Error('Evidence changed while learning; retrying');
    throw e;
  }
  // The Q&A vector isn't in D1, so the guard can't cover it: an undo after the last guarded write is caught here.
  if ((await deps.store.getMimic(m.id))?.evidenceEpoch !== epoch) {
    await refreshQaVector(deps, m, seq);
    return;
  }
  await snapshot();
}

/** Steps 1–4 of `learn.answer`, with `deps.store` guarded by the epoch the job read. */
async function learnGuarded(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  loaded: LoadedMimic,
  item: EvidenceItem,
  seq: number,
  key: string | undefined,
): Promise<void> {
  const learnable = loaded.data.evidence.filter((e) => learnsFrom(e.kind));
  const nAnswered = learnable.filter((e) => e.seq <= seq).length;

  // Learning runs to the whole cap, so answers taught on the mimic page after the session still count (ADR-0035).
  // Over it every model call is refused, and the job would retry until dropped. The answer is kept as evidence and
  // goes into the snapshot (queued by runLearn); only the reads that need a model are skipped.
  if (budgetSpent(deps, m, cfg)) return;

  // 1) Embed the Q&A (plus the "why").
  try {
    const emb = await deps.gateway.embed(ctxFor(m, 'embed.qa', key), [qaText(item)]);
    await deps.vectors.upsert([
      {
        id: vectorId.qa(m.id, seq),
        values: emb.vectors[0]!,
        metadata: { mimicId: m.id, kind: 'qa', facetIds: item.facetIds.join(','), seq },
      },
    ]);
  } catch {
    // Index only; rebuildable from evidence.
  }

  const facets = await facetsFor(deps, m, cfg);

  // 2) Trait read (Jev) on the state including this answer; psychometric scoring for Big Five anchors.
  const traitWrites = [];
  const psych = psychometricTraits(
    [
      {
        seq,
        itemKey: loaded.questions.find((q) => q.id === item.questionId)?.itemKey ?? null,
        answer: item.answer,
      },
    ],
    getAnchorSet(cfg.anchors.setId),
  );
  for (const t of psych)
    traitWrites.push({
      ...t,
      mimicId: m.id,
      configHash: m.configHash,
      modelSnapshot: null,
      createdAt: deps.clock(),
    });
  if (
    cfg.traitReader.type === 'jev' &&
    cfg.traitReader.everyN > 0 &&
    nAnswered % cfg.traitReader.everyN === 0
  ) {
    // Traits are read from identity + evidence only, so a read never anchors on the previous read.
    const state = buildState(loaded.data, stateOptions(cfg, seq + 1, { strategy: 'raw' }));
    const counts = new Map<string, number>();
    for (const e of learnable.filter((x) => x.seq <= seq))
      for (const f of e.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
    const { traits, modelSnapshot } = await readTraits(
      deps.gateway,
      ctxFor(m, 'traits.read', key),
      jevModel(deps),
      state,
      facets,
      seq,
      counts,
    );
    for (const t of traits)
      traitWrites.push({
        ...t,
        mimicId: m.id,
        configHash: m.configHash,
        modelSnapshot,
        createdAt: deps.clock(),
      });
  }
  if (traitWrites.length) await deps.store.upsertTraits(traitWrites);

  // 3) Reflection every N answers, with the citation guard.
  if (cfg.reflector.model && cfg.reflector.everyN > 0 && nAnswered % cfg.reflector.everyN === 0) {
    await runReflection(deps, m.id, seq, key);
    if (usesHypotheses(cfg.selector))
      await deps.jobs.enqueue({
        type: 'hypotheses.refresh',
        mimicId: m.id,
        seqUpTo: seq,
        epoch: m.evidenceEpoch,
      });
  }

  // 4) Occupation facets, on the first learn after identity is settled.
  const settled = m.identityState === 'done' || m.identityState === 'skipped';
  if (settled && m.occupation && cfg.generator.model && !facets.some((f) => f.occupation)) {
    try {
      const occ = await generateOccupationFacets(deps.gateway, ctxFor(m, 'facets.occupation', key), {
        model: cfg.generator.model,
        occupation: m.occupation,
        employer: m.employer,
      });
      const known = new Set(facets.map((f) => f.id));
      const fresh = occ.filter((f) => !known.has(f.id));
      if (fresh.length) {
        await deps.store.insertMimicFacets(
          fresh.map((facet) => ({ mimicId: m.id, facet, source: 'occfacets.v1', createdAt: deps.clock() })),
        );
      }
    } catch {
      // Optional enrichment; retried on a later learn.
    }
  }
}

export async function runReflection(
  deps: EngineDeps,
  mimicId: string,
  seq: number,
  key?: string,
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (!cfg.reflector.model) return;
  const loaded = await loadMimicData(deps, m);
  const existing = loaded.data.insights;
  if (existing.some((i) => i.seqUpTo >= seq)) return; // monotonic
  const facets = await facetsFor(deps, m, cfg);
  const lastReflected = existing.reduce((a, i) => Math.max(a, i.seqUpTo), 0);
  const learnable = loaded.data.evidence
    .filter((e) => learnsFrom(e.kind) && e.seq <= seq)
    .map((e) => toStateEvidence(e));
  const newEvidence = learnable.filter((e) => e.seq > lastReflected);
  const earlier = learnable.filter((e) => e.seq <= lastReflected).slice(-20);
  const delta = await reflect(deps.gateway, ctxFor(m, 'reflect', key), {
    model: cfg.reflector.model,
    facets,
    existing: existing.map((i) => ({ id: i.id, text: i.text, evidenceSeqs: i.evidenceSeqs })),
    newEvidence,
    earlierEvidence: earlier,
  });
  const now = deps.clock();
  for (const c of delta.contradictions)
    await deps.store.updateInsightStatus(c.insightId, 'superseded', now, seq);
  const insights: InsightRecord[] = delta.insights.map((i) => ({
    id: deps.newId(),
    mimicId: m.id,
    seqUpTo: seq,
    text: i.text,
    facetIds: i.facetIds,
    evidenceSeqs: i.evidenceSeqs,
    confidence: i.confidence,
    model: delta.modelSnapshot,
    promptVersion: cfg.reflector.promptVersion,
    status: 'active',
    createdAt: now,
    statusChangedAt: null,
  }));
  if (insights.length) await deps.store.insertInsights(insights);
  const facts: FactRecord[] = delta.facts.map((f) => ({
    id: deps.newId(),
    mimicId: m.id,
    predicate: f.predicate,
    object: f.object,
    source: 'reflection',
    sourceRef: `answers:${f.evidenceSeqs.join(',')}`,
    sourceUrl: null,
    confidence: 0.6,
    userState: 'active',
    createdAt: now,
    userStateAt: null,
    seqUpTo: seq,
  }));
  await addFacts(deps, m, facts);
  // Fact vectors aren't in D1: if an undo landed after the facts did (and removed them), drop the vectors too, or a
  // hard delete, which finds vectors through facts, would miss them.
  if (facts.length && (await deps.store.getMimic(m.id))?.evidenceEpoch !== m.evidenceEpoch)
    await deps.vectors.deleteByIds(facts.map((f) => vectorId.fact(m.id, f.id))).catch(() => {});
  // Link insights to facet nodes in the KG.
  const kg = await deps.store.listKg(m.id);
  const nodes: KgNodeRecord[] = [];
  const edges: KgEdgeRecord[] = [];
  const have = new Set(kg.nodes.map((n) => n.id));
  for (const i of insights) {
    for (const f of i.facetIds) {
      const id = `${m.id}:facet:${f}`;
      if (!have.has(id)) {
        have.add(id);
        nodes.push({
          id,
          mimicId: m.id,
          type: 'Facet',
          label: facets.find((x) => x.id === f)?.name ?? f,
          props: { facetId: f },
          source: 'reflection',
          createdAt: now,
        });
      }
      edges.push({
        id: deps.newId(),
        mimicId: m.id,
        src: personNodeId(m.id),
        dst: id,
        predicate: 'exhibits',
        weight: i.confidence,
        source: 'reflection',
        sourceRef: i.id,
        createdAt: now,
      });
    }
  }
  if (nodes.length || edges.length) await deps.store.insertKg(nodes, edges);
}

// ---------------------------------------------------------------------------------------------------------------
// hypotheses.refresh (BALD, PLAN §9.5)
// ---------------------------------------------------------------------------------------------------------------

export async function runHypotheses(
  deps: EngineDeps,
  mimicId: string,
  seqUpTo: number,
  key?: string,
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const sel = cfg.selector;
  const k = sel.type === 'bald' || sel.type === 'voi' ? sel.k : 0;
  if (k < 2) return;
  // Hypotheses only steer session selection, so they stop with the session's share.
  requireSessionBudget(deps, m, cfg);
  if (((await loadHypotheses(deps, m.id))?.seqUpTo ?? -1) >= seqUpTo) return;
  const loaded = await loadMimicData(deps, m);
  const state = buildState(loaded.data, stateOptions(cfg, seqUpTo + 1));
  const facets = await facetsFor(deps, m, cfg);
  const conf = new Map(
    loaded.data.traits.filter((t) => t.method === 'jev').map((t) => [t.facetId, t.confidence]),
  );
  const lowFacets = [...facets]
    .sort((a, b) => (conf.get(a.id) ?? 0) - (conf.get(b.id) ?? 0))
    .slice(0, 6)
    .map((f) => f.id);
  const hypotheses = await generateHypotheses(deps.gateway, ctxFor(m, 'hypotheses', key), {
    model: cfg.reflector.model ?? cfg.generator.model,
    state,
    lowFacets,
    k,
  });
  if (!hypotheses.length) return;
  const body = JSON.stringify({ seqUpTo, hypotheses });
  await deps.kv.put(`hyp:${m.id}`, body);
  // KV can't join the D1 guard (ADR-0036): if an undo landed while these were drawn from its state, take them back,
  // unless a newer set has replaced them already.
  if (
    (await deps.store.getMimic(m.id))?.evidenceEpoch !== m.evidenceEpoch &&
    (await deps.kv.get(`hyp:${m.id}`)) === body
  )
    await deps.kv.delete(`hyp:${m.id}`);
}

import { z } from 'zod';
import { BEHIND_SHORTFALL, categoryShares, EXPOSURE_MIN_ADAPTIVE } from '../belief';
import { DEFAULT_PROMPT_VERSION } from '../components';
import type { PipelineConfig } from '../config';
import { argmax } from '../distribution';
import { computeFidelity, type FidelityResult } from '../fidelity';
import { seededRng } from '../hash';
import { allOntologyFacets, getReserveSet, type ItemTemplate, reserveSetId } from '../ontology';
import { type ItemStatRecord, populationScore } from '../population';
import { LlmPredictor, makePredictor, promptVersionOf, rawScale, selectionView } from '../predictors';
import { pickRepeat } from '../repeats';
import { questionAllowed } from '../scope';
import { repeatAgreement, scorePrediction } from '../scoring';
import {
  hypothesisPosterior,
  makeSelector,
  questionCoverage,
  type SelectContext,
  usesHypotheses,
} from '../selectors';
import { cosine, lexicalSimilarity } from '../state-builder';
import {
  type AnswerRecord,
  type FidelityRecord,
  type MimicRecord,
  type PredictionRecord,
  type QuestionRecord,
  StaleEvidenceError,
  type Store,
} from '../store';
import {
  CATEGORIES,
  type Distribution,
  isScoredKind,
  isSessionKind,
  learnsFrom,
  type PersonState,
  type PredictionResult,
  type Question,
} from '../types';
import { beliefFromLoaded, loadBeliefSources, visibleScoredAnswers, visibleServedScored } from './belief';
import {
  contextState,
  facetCounts,
  type LoadedMimic,
  loadMimicDataAt,
  needsScores,
  STATE_SETTLE_MS,
  sealedState,
  stateBlobKey,
  vectorId,
} from './data';
import {
  ctxFor,
  deferred,
  type EngineDeps,
  EngineError,
  facetsFor,
  fallbackModel,
  guardedDeps,
  loadConfig,
  requireMimic,
  sessionSpent,
  timed,
} from './deps';
import { footprintPrediction } from './footprint';

export const JEV_PROMPT_VERSION = DEFAULT_PROMPT_VERSION.jev;
export const MIN_POOL = 6;
export const MAX_POOL = 15;

export interface PublicQuestion {
  id: string;
  seq: number;
  /** Repeats are shown as adaptive so the person can't tell a probe from a new question. */
  kind: 'anchor' | 'adaptive' | 'playground' | 'feedback';
  type: Question['type'];
  prompt: string;
  options: Question['options'];
  /** Touches a sensitive facet: the session offers "Prefer not to say" (ADR-0050). */
  sensitive?: true;
}

export type NextResult =
  | { status: 'question'; question: PublicQuestion; progress: Progress }
  | { status: 'waiting' | 'budget' | 'identity'; progress: Progress };

export interface Progress {
  answered: number;
  target: number;
}

const FACETS = allOntologyFacets();

export function toPublic(q: QuestionRecord): PublicQuestion {
  return {
    id: q.id,
    seq: q.seq!,
    kind: q.kind === 'repeat' ? 'adaptive' : q.kind,
    type: q.type,
    prompt: q.prompt,
    options: q.options,
    ...(q.facetIds.some((f) => FACETS.get(f)?.sensitive) ? { sensitive: true as const } : {}),
  };
}

export function progressOf(questions: QuestionRecord[], cfg: PipelineConfig): Progress {
  const answered = questions.filter((q) => q.status === 'answered' && isSessionKind(q.kind)).length;
  return { answered, target: cfg.session.target };
}

export function maxSeq(questions: QuestionRecord[]): number {
  return questions.reduce((a, q) => Math.max(a, q.seq ?? 0), 0);
}

const SERVE_ATTEMPTS = 3;

/**
 * Marks a question served, with its sealed predictions, at `seq`, or at the next free seq when a question the
 * person wrote on the mimic page took it meanwhile (ADR-0032). The predictions stay sealed at a later seq, and the
 * answer that took the seq was given after `stateAt`, so replay leaves it out of the state too. Returns the seq
 * used, or null when the question was served elsewhere or, for a session question, another session serve won.
 */
export async function serveAtFreeSeq(
  deps: EngineDeps,
  args: Parameters<Store['serveQuestion']>[0],
): Promise<number | null> {
  let seq = args.seq;
  for (let attempt = 0; attempt < SERVE_ATTEMPTS; attempt++) {
    if (await deps.store.serveQuestion({ ...args, seq })) return seq;
    const qs = await deps.store.listQuestions(args.mimicId);
    const q = qs.find((x) => x.id === args.questionId);
    if (q?.status !== 'pooled') return null;
    if (isSessionKind(q.kind) && qs.some((x) => x.status === 'served' && isSessionKind(x.kind))) return null;
    seq = maxSeq(qs) + 1;
  }
  return null;
}

/**
 * `POST /next` (PLAN §6.4). Idempotent per seq: returns the served-but-unanswered question if there is one.
 * The primary and baseline predictions are persisted before the question is returned (PLAN §3.2).
 */
export async function serveNext(deps: EngineDeps, mimicId: string): Promise<NextResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await serveOnce(deps, mimicId);
    } catch (e) {
      // Built from evidence an undo changed meanwhile, so nothing was served (ADR-0036): build it again.
      if (!(e instanceof StaleEvidenceError)) throw e;
      if (attempt >= 2) throw new EngineError('conflict', 'Your last answer changed; try again');
    }
  }
}

/**
 * Fresh pool copies of served questions being taken back (ADR-0036). A repeat probe gets none: the repeat schedule
 * picks it again. Copies keep `createdAt`, so anchors keep their per-person order.
 */
export function poolCopies(
  deps: EngineDeps,
  questions: QuestionRecord[],
): Array<{ from: QuestionRecord; copy: QuestionRecord }> {
  return questions
    .filter((q) => isScoredKind(q.kind))
    .map((from) => ({
      from,
      copy: {
        ...from,
        id: deps.newId(),
        seq: null,
        status: 'pooled',
        servedAt: null,
        stateAt: null,
        selection: null,
      },
    }));
}

/** Copies keep their prompt embedding (redundancy and retrieval read it by question ID). Best effort. */
export async function copyQuestionVectors(
  deps: EngineDeps,
  mimicId: string,
  copies: Array<{ from: QuestionRecord; copy: QuestionRecord }>,
): Promise<void> {
  if (!copies.length) return;
  try {
    const vecs = await deps.vectors.getByIds(copies.map((c) => vectorId.question(mimicId, c.from.id)));
    const byId = new Map(vecs.map((v) => [v.id, v]));
    const moved = copies.flatMap(({ from, copy }) => {
      const v = byId.get(vectorId.question(mimicId, from.id));
      return v ? [{ ...v, id: vectorId.question(mimicId, copy.id) }] : [];
    });
    if (moved.length) await deps.vectors.upsert(moved);
  } catch {
    // Falls back to lexical similarity.
  }
}

/** Puts pool copies of already-discarded questions back (ADR-0036). */
export async function requeueDiscarded(deps: EngineDeps, mimicId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const discarded = (await Promise.all(ids.map((id) => deps.store.getQuestion(id)))).filter(
    (q): q is QuestionRecord => q?.mimicId === mimicId,
  );
  const copies = poolCopies(deps, discarded);
  if (copies.length) await deps.store.insertQuestions(copies.map((c) => c.copy));
  await copyQuestionVectors(deps, mimicId, copies);
}

async function serveOnce(deps: EngineDeps, mimicId: string): Promise<NextResult> {
  const m = await timed(deps, 'mimic', () => requireMimic(deps, mimicId));
  const cfg = await loadConfig(deps, m.configHash);
  // Derived data is pinned to `stateAt` so the sealed states can be rebuilt exactly from an export (ADR-0017).
  const stateAt = deps.clock() - STATE_SETTLE_MS;
  const loaded = await timed(deps, 'load', () =>
    loadMimicDataAt(deps, m, stateAt, m.seqMax + 1, { scores: needsScores(cfg) }),
  );
  const { questions } = loaded;
  const progress = progressOf(questions, cfg);

  const current = questions.find((q) => q.status === 'served' && isSessionKind(q.kind));
  if (current) return { status: 'question', question: toPublic(current), progress };
  if (m.status !== 'learning') return { status: 'identity', progress };
  if (sessionSpent(deps, m, cfg)) return { status: 'budget', progress };

  const seq = maxSeq(questions) + 1;
  const rng = seededRng(`select:${m.id}:${seq}`);

  // Nothing the person's scope hides is ever served (ADR-0040): out-of-scope anchors, repeat sources and pooled
  // questions are skipped here even if a scope change raced the discard in setScope.
  const inScope = (q: QuestionRecord) => !loaded.scope.hiddenQuestionIds.has(q.id);

  // 1) Anchors first, in the per-person order fixed at intake.
  const anchor = questions
    .filter((q) => q.kind === 'anchor' && q.status === 'pooled' && inScope(q))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (anchor)
    return serveWithPredictions(deps, m, cfg, loaded, stateAt, seq, anchor, [anchor], progress, rng);

  // 2) Repeat probes, scheduled outside the selector; no predictions (PLAN §9.5).
  const served = questions
    .filter((q) => q.seq !== null && isSessionKind(q.kind) && inScope(q))
    .map((q) => ({
      questionId: q.id,
      seq: q.seq!,
      kind: q.kind,
      repeatOf: q.repeatOf ?? null,
      answered: q.status === 'answered',
    }));
  const repeatOf = pickRepeat(served, cfg.repeats, rng);
  if (repeatOf) {
    const src = questions.find((q) => q.id === repeatOf)!;
    const rep: QuestionRecord = {
      ...src,
      id: deps.newId(),
      seq: null,
      kind: 'repeat',
      repeatOf: src.id,
      status: 'pooled',
      createdAt: deps.clock(),
      servedAt: null,
      stateAt: null,
    };
    await deps.store.insertQuestions([rep]);
    let at: number | null;
    try {
      // Scheduled from the answers read above, so guarded by their epoch like any serve (ADR-0036).
      at = await serveAtFreeSeq(guardedDeps(deps, m), {
        questionId: rep.id,
        mimicId: m.id,
        seq,
        servedAt: deps.clock(),
        stateAt: null,
        predictions: [],
      });
    } catch (e) {
      if (e instanceof StaleEvidenceError) await deps.store.updateQuestionStatus(rep.id, 'discarded');
      throw e;
    }
    if (at === null) return raced(deps, m.id);
    return { status: 'question', question: toPublic({ ...rep, seq: at, status: 'served' }), progress };
  }

  // 3) Adaptive pool (reserve bank when the generated pool is empty). Before the trust ramp opens, nothing touching
  // a sensitive facet is offered at all (ADR-0044).
  const ramp = rampAllows(cfg, loaded);
  // A reserve item is asked once: two serves racing through the top-up below can each pool a copy of it.
  const askedKeys = new Set(
    questions.filter((q) => q.status === 'served' || q.status === 'answered').map((q) => q.itemKey),
  );
  let pool = questions.filter(
    (q) =>
      q.kind === 'adaptive' &&
      q.status === 'pooled' &&
      inScope(q) &&
      ramp(q) &&
      !(q.itemKey && askedKeys.has(q.itemKey)),
  );
  if (pool.length < MIN_POOL) {
    await deferred(deps, () => deps.jobs.enqueue({ type: 'pool.refill', mimicId: m.id, seq }));
  }
  if (pool.length > 0) pool = [...pool, ...(await coverageTopUp(deps, m, cfg, loaded, pool, ramp, seq))];
  if (pool.length === 0) {
    pool = await addReserve(deps, m, cfg, questions, loaded.scope.blocked, ramp);
    if (pool.length === 0) return { status: 'waiting', progress };
  }
  return serveWithPredictions(deps, m, cfg, loaded, stateAt, seq, null, pool, progress, rng);
}

/**
 * The trust ramp (ADR-0044): until the person has answered `minAnswered` anchor and adaptive questions, a question
 * touching a sensitive facet may not be served. Counts what the belief state counts: answered, in scope.
 */
export function rampAllows(
  cfg: PipelineConfig,
  loaded: Pick<LoadedMimic, 'questions' | 'answers' | 'scope'>,
): (q: { facetIds: string[] }) => boolean {
  const ramp = cfg.selector.type === 'voi' ? cfg.selector.trustRamp : undefined;
  if (!ramp) return () => true;
  // The belief's own count (`person.nAnswered`), so this pre-filter and the selector's ramp agree.
  if (visibleScoredAnswers(loaded).length >= ramp.minAnswered) return () => true;
  return (q) => !q.facetIds.some((f) => loaded.scope.sensitiveFacets.has(f));
}

async function raced(deps: EngineDeps, mimicId: string): Promise<NextResult> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const qs = await deps.store.listQuestions(m.id);
  const current = qs.find((q) => q.status === 'served' && isSessionKind(q.kind));
  const progress = progressOf(qs, cfg);
  if (!current) throw new EngineError('conflict', 'Concurrent serve; retry');
  return { status: 'question', question: toPublic(current), progress };
}

const RESERVE_BATCH = 3;

/** At most this many reserve items are added per serve to back coverage (ADR-0044). */
const TOP_UP_MAX = RESERVE_BATCH;

/**
 * Coverage backed by the reserve bank (ADR-0044): the selector's deadlines and floor can only choose from the pool,
 * so when the pool has nothing for what they need, reserve items are added, one per need, up to TOP_UP_MAX per serve:
 * first facet groups nothing has touched (until `balance.groupsBy`), then consented sensitive facets not yet asked
 * about (once the sweep has begun), then categories below BEHIND_SHORTFALL of their even share (once a few adaptive
 * questions are answered). A generator that missed its targets, or whose drafts the gates rejected, can't leave a gap.
 * Reserve items are hand-written, concrete and plainly worded (reserve.v2). Configs without balance or ramp skip this.
 */
async function coverageTopUp(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  loaded: LoadedMimic,
  pool: QuestionRecord[],
  ramp: (q: { facetIds: string[] }) => boolean,
  seq: number,
): Promise<QuestionRecord[]> {
  if (cfg.selector.type !== 'voi') return [];
  const { balance, trustRamp } = cfg.selector;
  if (!balance && !trustRamp) return [];
  // The belief's own answered and waiting questions, so the top-up covers exactly what the selector sees as missing.
  const answered = visibleScoredAnswers(loaded);
  const asked = [...answered, ...visibleServedScored(loaded)];
  const facets = await facetsFor(deps, m, cfg);
  const byId = new Map(facets.map((f) => [f.id, f]));
  const pooledHas = (want: (q: { facetIds: string[] }) => boolean) => pool.some(want);
  const wants: Array<(q: { facetIds: string[] }) => boolean> = [];

  if (balance && seq <= balance.groupsBy) {
    const touched = new Set(asked.flatMap((q) => q.facetIds.map((f) => byId.get(f)?.group)));
    for (const g of new Set(facets.map((f) => f.group))) {
      const want = (q: { facetIds: string[] }) => q.facetIds.some((f) => byId.get(f)?.group === g);
      if (!touched.has(g) && !pooledHas(want)) wants.push(want);
    }
  }
  if (trustRamp && answered.length >= Math.max(trustRamp.minAnswered, trustRamp.sweepFrom)) {
    const hit = new Set(answered.flatMap((q) => q.facetIds));
    for (const f of facets) {
      const want = (q: { facetIds: string[] }) => q.facetIds.includes(f.id);
      if (f.sensitive && !hit.has(f.id) && !pooledHas(want)) wants.push(want);
    }
  }
  if (balance && answered.filter((q) => q.kind === 'adaptive').length >= EXPOSURE_MIN_ADAPTIVE) {
    const shares = categoryShares(
      facets,
      asked.map((q) => q.facetIds),
    );
    for (const c of CATEGORIES) {
      const want = (q: { facetIds: string[] }) => q.facetIds.some((f) => byId.get(f)?.category === c);
      if ((shares[c]?.shortfall ?? 0) >= BEHIND_SHORTFALL && !pooledHas(want)) wants.push(want);
    }
  }

  // One pass over the reserve in its usual order, one item per need, and a single insert.
  const ordered = reserveItems(m, cfg, loaded.questions, loaded.scope.blocked, ramp);
  const picked: ItemTemplate[] = [];
  for (const want of wants) {
    if (picked.length >= TOP_UP_MAX) break;
    const item = ordered.find((r) => want(r) && !picked.includes(r));
    if (item) picked.push(item);
  }
  return insertReserve(deps, m, cfg, picked);
}

/**
 * Reserve items for an empty pool (ADR-0006), from the config's set (ADR-0042), inside the person's scope. reserve.v1
 * keeps its fixed order; later sets put items whose facets have been asked least first, so a stalled generator
 * still spreads questions across what the person agreed to be asked about.
 */
async function addReserve(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  questions: QuestionRecord[],
  blocked: ReadonlySet<string>,
  allow: (q: { facetIds: string[] }) => boolean = () => true,
): Promise<QuestionRecord[]> {
  return insertReserve(deps, m, cfg, reserveItems(m, cfg, questions, blocked, allow).slice(0, RESERVE_BATCH));
}

/** The reserve items not yet used that the scope and `allow` admit, in the order `addReserve` offers them. */
function reserveItems(
  m: MimicRecord,
  cfg: PipelineConfig,
  questions: QuestionRecord[],
  blocked: ReadonlySet<string>,
  allow: (q: { facetIds: string[] }) => boolean,
): ItemTemplate[] {
  const setId = reserveSetId(cfg);
  const used = new Set(questions.map((q) => q.itemKey).filter(Boolean));
  // Without "Work and money", no workplace scenes either (ADR-0042).
  const professional = m.scope.categories.includes('work');
  const items = getReserveSet(setId).filter(
    (r) =>
      !used.has(r.itemKey) &&
      questionAllowed(r, blocked) &&
      allow(r) &&
      (professional || r.domain !== 'professional'),
  );
  if (setId === 'reserve.v1') return items;
  const asked = new Map<string, number>();
  for (const q of questions)
    if (q.seq !== null) for (const f of q.facetIds) asked.set(f, (asked.get(f) ?? 0) + 1);
  const load = (r: { facetIds: string[] }) => Math.max(...r.facetIds.map((f) => asked.get(f) ?? 0));
  return items
    .map((r, i) => ({ r, i, l: load(r) }))
    .sort((a, b) => a.l - b.l || a.i - b.i)
    .map((x) => x.r);
}

async function insertReserve(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  items: ItemTemplate[],
): Promise<QuestionRecord[]> {
  const setId = reserveSetId(cfg);
  const now = deps.clock();
  const recs: QuestionRecord[] = items.map((item, i) => ({
    id: deps.newId(),
    mimicId: m.id,
    seq: null,
    kind: 'adaptive',
    type: item.type,
    domain: item.domain,
    prompt: item.prompt,
    options: item.options,
    facetIds: item.facetIds,
    itemKey: item.itemKey,
    provenance: { generator: setId, configHash: m.configHash, promptVersion: setId },
    status: 'pooled',
    quality: null,
    createdAt: now + i,
    servedAt: null,
    stateAt: null,
  }));
  if (recs.length) await deps.store.insertQuestions(recs);
  return recs;
}

/**
 * Question-prompt vectors never change, so they are cached per isolate; only unseen IDs are fetched (keeps the
 * redundancy term off the critical path after the first request).
 */
const VECTOR_CACHE = new Map<string, number[]>();
const VECTOR_CACHE_MAX = 5000;

async function redundancyFn(
  deps: EngineDeps,
  m: MimicRecord,
  pool: QuestionRecord[],
  asked: QuestionRecord[],
): Promise<(q: Question) => number> {
  const all = [...pool, ...asked];
  const missing = all.filter((q) => !VECTOR_CACHE.has(vectorId.question(m.id, q.id)));
  const remember = (id: string, v: number[]) => {
    if (VECTOR_CACHE.size >= VECTOR_CACHE_MAX) VECTOR_CACHE.delete(VECTOR_CACHE.keys().next().value!);
    VECTOR_CACHE.set(id, v);
  };
  // Anchors and reserve items (item keys) are never embedded; remember that so they aren't refetched.
  for (const q of missing) if (q.itemKey) remember(vectorId.question(m.id, q.id), []);
  const toFetch = missing.filter((q) => !q.itemKey).map((q) => vectorId.question(m.id, q.id));
  if (toFetch.length) {
    try {
      for (const r of await deps.vectors.getByIds(toFetch)) remember(r.id, r.values);
    } catch {
      // fall back to lexical similarity
    }
  }
  const vecs = VECTOR_CACHE;
  return (q) => {
    let best = 0;
    const vq = vecs.get(vectorId.question(m.id, q.id));
    for (const a of asked) {
      const va = vecs.get(vectorId.question(m.id, a.id));
      const s = vq?.length && va?.length ? cosine(vq, va) : lexicalSimilarity(q.prompt, a.prompt);
      if (s > best) best = s;
    }
    return Math.max(0, Math.min(1, best));
  };
}

async function serveWithPredictions(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  loaded: LoadedMimic,
  stateAt: number,
  seq: number,
  fixed: QuestionRecord | null,
  pool: QuestionRecord[],
  progress: Progress,
  rng: () => number,
): Promise<NextResult> {
  const primarySpec = cfg.predictor.primary;
  // A primary may name a prompt variant (`jev:<model>@<version>`, ADR-0028); the baseline uses the same prompt.
  const baselinePredictor = makePredictor(deps.gateway, primarySpec, ctxFor(m, 'predict.baseline'));
  // Selection scores candidates on the primary's raw scale and calibrates only what it stores, so a calibrated primary
  // changes what is stored and shown, not which question is asked (ADR-0048).
  const view = selectionView(deps.gateway, primarySpec);

  const state = await timed(deps, 'state', () => sealedState(deps, loaded, cfg, seq, pool));
  const baseState = contextState(loaded, cfg);
  if (state.meta.evidenceSeqMax >= seq) throw new Error('Sealing violated: state contains answer ≥ seq');

  const asked = loaded.questions.filter((q) => q.seq !== null && isSessionKind(q.kind));
  const counts = facetCounts(loaded.questions);

  // Baseline for every candidate in one batched call, in parallel with selection (PLAN §6.4).
  const baselinePromise = baselinePredictor.predict(baseState, pool);
  let chosen: QuestionRecord;
  let primaryResult: PredictionResult;
  let selection: Record<string, unknown> | null = null;
  const hypothesisRows: PredictionRecord[] = [];
  const hypothesisStates: PersonState[] = [];
  if (fixed) {
    chosen = fixed;
    const primary = makePredictor(deps.gateway, primarySpec, ctxFor(m, 'predict.primary'));
    [primaryResult] = (await timed(deps, 'select', () => primary.predict(state, [fixed]))) as [
      PredictionResult,
    ];
  } else {
    const selector = makeSelector(cfg.selector);
    // Same prompt and scale as selection's primary (ADR-0028, ADR-0048); logged under its own purpose.
    const explore = view.predictor(ctxFor(m, 'select.bald'));
    const [hyp, redundancy, voi] = await Promise.all([
      usesHypotheses(cfg.selector) ? loadHypothesisSet(deps, m, loaded) : undefined,
      timed(deps, 'redundancy', () => redundancyFn(deps, m, pool, asked)),
      cfg.selector.type === 'voi' ? timed(deps, 'belief', () => voiContext(deps, m, cfg, loaded)) : undefined,
    ]);
    const sel = await timed(deps, 'select', () =>
      selector.select({
        pool,
        state,
        primary: view.predictor(ctxFor(m, 'predict.primary')),
        coverage: (q) => questionCoverage(counts, q),
        redundancy,
        rng,
        sessionTarget: cfg.session.target,
        seq,
        repeatsEvery: cfg.repeats.every,
        ...(hyp ? { hypotheses: hyp.hypotheses, hypothesisWeights: hyp.weights, explore } : {}),
        ...(voi ?? {}),
      }),
    );
    chosen = sel.question as QuestionRecord;
    primaryResult = view.calibrate(sel.primary, chosen);
    selection = { selector: cfg.selector.type, ...sel.diagnostics };
    if (hyp && sel.hypothesisPreds) {
      selection.hypothesisWeights = hyp.weights.map((w) => Math.round(w * 1000) / 1000);
      for (const h of sel.hypothesisPreds) {
        hypothesisStates.push(h.state);
        // Stored as the primary's own output, like every row it makes; the posterior reads it on the raw scale.
        const r = view.calibrate(h.result, chosen);
        hypothesisRows.push({
          id: deps.newId(),
          questionId: chosen.id,
          mimicId: m.id,
          predictorId: primarySpec,
          role: 'hypothesis',
          dist: r.dist,
          confidence: r.confidence ?? null,
          stateHash: h.state.meta.stateHash,
          evidenceSeqMax: h.state.meta.evidenceSeqMax,
          configHash: m.configHash,
          promptVersion: promptVersionOf(primarySpec),
          modelSnapshot: h.result.modelSnapshot,
          costUsd: h.result.costUsd,
          latencyMs: h.result.latencyMs,
          ok: h.result.ok,
          error: h.result.error ?? null,
          fallback: false,
          hypothesis: hypothesisTag(hyp.seqUpTo, h.index),
          createdAt: deps.clock(),
        });
      }
    }
  }
  const baselines = await timed(deps, 'baseline', () => baselinePromise);
  const baselineResult = baselines[pool.indexOf(chosen)]!;

  let primaryId = primarySpec;
  let fallback = false;
  if (!primaryResult.ok) {
    // Jev errored: LLM fallback on the same sealed state, marked as fallback (PLAN §16).
    const fb = new LlmPredictor(deps.gateway, fallbackModel(deps), ctxFor(m, 'predict.fallback'));
    const [r] = await fb.predict(state, [chosen]);
    if (r?.ok) {
      primaryResult = { ...r, error: `fallback: ${primaryResult.error ?? 'primary failed'}` };
      primaryId = fb.id;
      fallback = true;
    }
  }

  const now = deps.clock();
  const pred = (
    role: PredictionRecord['role'],
    predictorId: string,
    s: PersonState,
    r: PredictionResult,
    isFallback = false,
  ): PredictionRecord => ({
    id: deps.newId(),
    questionId: chosen.id,
    mimicId: m.id,
    predictorId,
    role,
    dist: r.dist,
    confidence: r.confidence ?? null,
    stateHash: s.meta.stateHash,
    evidenceSeqMax: s.meta.evidenceSeqMax,
    configHash: m.configHash,
    promptVersion: promptVersionOf(predictorId),
    modelSnapshot: r.modelSnapshot,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    ok: r.ok,
    error: r.error ?? null,
    errorKind: r.ok ? null : (r.errorKind ?? null),
    fallback: isFallback,
    createdAt: now,
  });
  // A question a footprint proposed carries the answer its documents implied; stored as a prediction of its own so
  // the real answer scores the footprint like any model (ADR-0057). It reads no answers, so it is sealed trivially.
  const footprint = footprintPrediction(deps, m, chosen);
  const predictions = [
    pred('primary', primaryId, state, primaryResult, fallback),
    pred('baseline', primarySpec, baseState, baselineResult),
    // The chosen question's prediction under each persona hypothesis feeds the hypothesis posterior (§6); not scored.
    ...hypothesisRows,
    ...(footprint ? [footprint] : []),
  ];
  // Primary and baseline are persisted before the question is returned (PLAN §3.2).
  // Guarded: if an undo changed the evidence since `loaded` was read, nothing is written (ADR-0036).
  const at = await timed(deps, 'persist', () =>
    serveAtFreeSeq(guardedDeps(deps, m), {
      questionId: chosen.id,
      mimicId: m.id,
      seq,
      servedAt: now,
      stateAt,
      predictions,
      selection,
    }),
  );
  if (at === null) return raced(deps, m.id);

  // The sealed states must exist before shadow jobs read them; both can finish after the response. Hypothesis
  // states are written too, so every stored prediction resolves to its state (ADR-0010).
  await deferred(deps, async () => {
    await Promise.all([
      deps.blobs.put(stateBlobKey(m.id, state.meta.stateHash), JSON.stringify(state), 'application/json'),
      deps.blobs.put(
        stateBlobKey(m.id, baseState.meta.stateHash),
        JSON.stringify(baseState),
        'application/json',
      ),
      ...hypothesisStates.map((s) =>
        deps.blobs.put(stateBlobKey(m.id, s.meta.stateHash), JSON.stringify(s), 'application/json'),
      ),
    ]);
    await Promise.all(
      cfg.predictor.shadows.map((s) =>
        deps.jobs.enqueue({ type: 'predict.shadow', mimicId: m.id, questionId: chosen.id, predictorId: s }),
      ),
    );
  });
  return { status: 'question', question: toPublic({ ...chosen, seq: at, status: 'served' }), progress };
}

export interface HypothesisSet {
  /** The evidence seq the hypotheses were written from; their posterior counts answers after it. */
  seqUpTo: number;
  hypotheses: string[];
}

export async function loadHypotheses(deps: EngineDeps, mimicId: string): Promise<HypothesisSet | undefined> {
  const raw = await deps.kv.get(`hyp:${mimicId}`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { seqUpTo?: number; hypotheses?: string[] };
    if (!Array.isArray(parsed.hypotheses)) return undefined;
    return { seqUpTo: parsed.seqUpTo ?? 0, hypotheses: parsed.hypotheses };
  } catch {
    return undefined;
  }
}

/** `predictions.hypothesis` for hypothesis `index` of the set written at `seqUpTo`. */
export function hypothesisTag(seqUpTo: number, index: number): string {
  return `${seqUpTo}:${index}`;
}

export function parseHypothesisTag(tag: string): { seqUpTo: number; index: number } | null {
  const m = /^(\d+):(\d+)$/.exec(tag);
  return m ? { seqUpTo: Number(m[1]), index: Number(m[2]) } : null;
}

/**
 * The current hypothesis set with its posterior weights (docs/SELECTION.md §6): each hypothesis's likelihood of the
 * answers given since the set was written, read from the stored `role = hypothesis` rows. No mutable state.
 */
export async function loadHypothesisSet(
  deps: EngineDeps,
  m: MimicRecord,
  loaded: LoadedMimic,
): Promise<(HypothesisSet & { weights: number[] }) | undefined> {
  const set = await loadHypotheses(deps, m.id);
  if (!set || set.hypotheses.length < 2) return undefined;
  const rows = await deps.store.listPredictions({ mimicId: m.id, roles: ['hypothesis'] });
  const answerByQ = new Map(loaded.answers.map((a) => [a.questionId, a]));
  const obs: Array<{ index: number; pAnswer: number }> = [];
  for (const r of rows) {
    if (!r.ok || !r.hypothesis) continue;
    const tag = parseHypothesisTag(r.hypothesis);
    if (!tag || tag.seqUpTo !== set.seqUpTo) continue;
    const a = answerByQ.get(r.questionId);
    if (!a) continue;
    // On the raw scale the posterior was built for, whatever the primary's calibration (ADR-0048).
    obs.push({ index: tag.index, pAnswer: rawScale(r.predictorId, r.dist)[a.value] ?? 0 });
  }
  return { ...set, weights: hypothesisPosterior(obs, set.hypotheses.length) };
}

/**
 * `item_stats` changes hourly (`stats.refresh`) and is read on every `/next`, so it is cached per isolate for a
 * short while, like question vectors. `stats.refresh` invalidates the cache of its own isolate; other isolates see
 * the new rows within ITEM_STATS_TTL_MS.
 */
export const ITEM_STATS_TTL_MS = 5 * 60 * 1000;
let ITEM_STATS_CACHE: { at: number; byKey: Map<string, ItemStatRecord> } | null = null;

export function invalidateItemStatsCache(): void {
  ITEM_STATS_CACHE = null;
}

async function itemStatsByKey(deps: EngineDeps): Promise<Map<string, ItemStatRecord>> {
  const now = deps.clock();
  if (ITEM_STATS_CACHE && now - ITEM_STATS_CACHE.at < ITEM_STATS_TTL_MS && now >= ITEM_STATS_CACHE.at)
    return ITEM_STATS_CACHE.byKey;
  const byKey = new Map((await deps.store.listItemStats()).map((s) => [s.key, s]));
  ITEM_STATS_CACHE = { at: now, byKey };
  return byKey;
}

/** Belief state and population prior for the `voi` selector. */
async function voiContext(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  loaded: LoadedMimic,
): Promise<Pick<SelectContext, 'belief' | 'population'>> {
  const wantStats = cfg.selector.type === 'voi' && cfg.selector.piPopulation > 0;
  const [facets, sources, byKey] = await Promise.all([
    facetsFor(deps, m, cfg),
    loadBeliefSources(deps, m),
    wantStats ? itemStatsByKey(deps) : Promise.resolve(new Map<string, ItemStatRecord>()),
  ]);
  const belief = beliefFromLoaded(loaded, facets, cfg, sources);
  return {
    belief,
    population: (q) => (byKey.size ? populationScore(q, byKey) : null),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------------------------

export const AnswerInput = z.object({
  questionId: z.string().min(1),
  value: z.string().min(1).max(32),
  why: z.string().trim().max(1000).optional(),
  latencyMs: z.number().int().min(0).max(3_600_000),
  idempotencyKey: z.string().min(8).max(100),
  /**
   * False when the person turned guesses off for their session. The reveal is then neither returned nor recorded
   * as shown, so `revealedPrediction` stays true to what they saw. Defaults to shown.
   */
  revealShown: z.boolean().optional(),
});
export type AnswerInput = z.infer<typeof AnswerInput>;

export interface Reveal {
  optionKey: string;
  label: string;
  p: number;
  match: boolean;
  /** The sealed primary distribution over every option, shown after the answer. */
  dist: Distribution;
}

export interface AnswerResult {
  reveal: Reveal | null;
  fidelity: FidelityResult | null;
  seq: number;
}

/** `POST /answers` (PLAN §6.4): persist, score the sealed predictions, update fidelity, enqueue learning. */
export async function submitAnswer(
  deps: EngineDeps,
  mimicId: string,
  input: AnswerInput,
): Promise<AnswerResult> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const [existing, undone] = await Promise.all([
    deps.store.getAnswerByIdempotencyKey(input.idempotencyKey),
    deps.store.getAnswerRewindByIdempotencyKey(input.idempotencyKey),
  ]);
  if (existing) {
    if (existing.mimicId !== m.id) throw new EngineError('conflict', 'Idempotency key reused');
    return replayResult(deps, m, cfg, existing);
  }
  // A resend of an answer the person undid (a retrying outbox, another tab) must not bring it back (ADR-0036).
  if (undone) throw new EngineError('conflict', 'This answer was undone');
  // Feedback given while this question is served moves it to a later seq (ADR-0032); an answer that raced the
  // move is recorded again at the question's new seq.
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = await deps.store.getQuestion(input.questionId);
    if (!q || q.mimicId !== m.id) throw new EngineError('not_found', 'Question not found');
    if (q.status === 'answered') throw new EngineError('conflict', 'Question already answered');
    if (q.status !== 'served' || q.seq === null)
      throw new EngineError('conflict', 'Question is not being asked');
    if (!q.options.some((o) => o.key === input.value)) throw new EngineError('invalid', 'Unknown option');

    const now = deps.clock();
    const predictions = q.kind === 'repeat' ? [] : await deps.store.listPredictions({ questionId: q.id });
    const primary = predictions.find((p) => p.role === 'primary' && p.ok);
    const reveal =
      cfg.reveal === 'after_answer' && input.revealShown !== false && q.kind !== 'repeat' && primary
        ? revealOf(q, primary)
        : null;
    const answer: AnswerRecord = {
      id: deps.newId(),
      questionId: q.id,
      mimicId: m.id,
      seq: q.seq,
      value: input.value,
      why: input.why?.length ? input.why : null,
      latencyMs: input.latencyMs,
      revealedPrediction: reveal !== null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    if (reveal) reveal.match = reveal.optionKey === input.value;
    // Hypothesis rows are exploration artifacts, not predictors: they are never scored (docs/SELECTION.md §6).
    const scores = predictions
      .filter((p) => p.ok && p.role !== 'hypothesis')
      .map((p) => ({
        predictionId: p.id,
        answerId: answer.id,
        ...scorePrediction(q.type, p.dist, input.value),
        createdAt: now,
      }));
    if (!(await timed(deps, 'record', () => deps.store.recordAnswer({ answer, scores })))) {
      const dup = await deps.store.getAnswerByIdempotencyKey(input.idempotencyKey);
      if (dup?.mimicId === m.id) return replayResult(deps, m, cfg, dup);
      continue;
    }
    return afterAnswer(deps, m, q, answer, scores, reveal);
  }
  throw new EngineError('conflict', 'Busy; try again');
}

async function afterAnswer(
  deps: EngineDeps,
  m: MimicRecord,
  q: QuestionRecord,
  answer: AnswerRecord,
  scores: Array<{ predictionId: string }>,
  reveal: Reveal | null,
): Promise<AnswerResult> {
  const seq = answer.seq;
  // Guarded like any derived write: if the answer was undone right after it was recorded, no fidelity row counts it.
  const fidelity = isSessionKind(q.kind)
    ? await timed(deps, 'fidelity', () => recomputeFidelity(guardedDeps(deps, m), m, seq)).catch(
        (e: unknown) => {
          if (e instanceof StaleEvidenceError) return null;
          throw e;
        },
      )
    : null;
  if (learnsFrom(q.kind)) {
    // Keyed by answer, so a re-answer after an undo is learned again (ADR-0036).
    await deferred(deps, () =>
      deps.jobs.enqueue({ type: 'learn.answer', mimicId: m.id, seq, answerId: answer.id }),
    );
  }
  if (isScoredKind(q.kind)) await deferred(deps, () => scoreLateShadows(deps, q, answer, scores));
  return { reveal, fidelity, seq };
}

/**
 * A shadow that inserts its prediction after this answer listed them, but looks for the answer before it was
 * recorded, would be scored by neither side. Listing again after the answer is recorded closes that gap: whichever
 * write lands second sees the other. Scores are keyed by prediction, so a duplicate is a no-op.
 */
async function scoreLateShadows(
  deps: EngineDeps,
  q: QuestionRecord,
  answer: AnswerRecord,
  scored: Array<{ predictionId: string }>,
): Promise<void> {
  const have = new Set(scored.map((s) => s.predictionId));
  const late = (await deps.store.listPredictions({ questionId: q.id })).filter(
    // Hypothesis rows are never scored (docs/SELECTION.md §6).
    (p) => p.ok && p.role !== 'hypothesis' && !have.has(p.id),
  );
  if (!late.length) return;
  const now = deps.clock();
  await deps.store.insertScores(
    late.map((p) => ({
      predictionId: p.id,
      answerId: answer.id,
      ...scorePrediction(q.type, p.dist, answer.value),
      createdAt: now,
    })),
  );
}

function revealOf(q: QuestionRecord, p: PredictionRecord): Reveal {
  const key = argmax(p.dist);
  return {
    optionKey: key,
    label: q.options.find((o) => o.key === key)?.label ?? key,
    p: p.dist[key] ?? 0,
    match: false,
    dist: p.dist,
  };
}

async function replayResult(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  a: AnswerRecord,
): Promise<AnswerResult> {
  const q = await deps.store.getQuestion(a.questionId);
  const primary = (await deps.store.listPredictions({ questionId: a.questionId, roles: ['primary'] })).find(
    (p) => p.ok,
  );
  let reveal: Reveal | null = null;
  if (q && primary && a.revealedPrediction && cfg.reveal === 'after_answer') {
    reveal = revealOf(q, primary);
    reveal.match = reveal.optionKey === a.value;
  }
  const fid = (await deps.store.listFidelity(m.id)).filter((f) => f.seqUpTo <= a.seq).at(-1);
  return { reveal, fidelity: fid ? fidelityFromRecord(fid) : null, seq: a.seq };
}

export function fidelityFromRecord(f: FidelityRecord): FidelityResult {
  return {
    acc: f.acc,
    accBaseline: f.accBaseline,
    selfConsistency: f.selfConsistency,
    fidelity: f.fidelity,
    ciLow: f.ciLow,
    ciHigh: f.ciHigh,
    nScored: f.nScored,
    nRepeats: f.nRepeats,
    state: f.state,
  };
}

/** Headline fidelity after every answer (PLAN §9.10), appended to the fidelity table. */
export async function recomputeFidelity(
  deps: EngineDeps,
  m: MimicRecord,
  seqUpTo: number,
): Promise<FidelityResult> {
  const [scored, questions, answers] = await Promise.all([
    deps.store.listScoredPredictions(m.id, ['primary', 'baseline']),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
  ]);
  const input = fidelityInput(scored, questions, answers);
  const result = computeFidelity({ ...input, seed: `fidelity:${m.id}:${seqUpTo}` });
  await deps.store.insertFidelity({ mimicId: m.id, seqUpTo, ...result, createdAt: deps.clock() });
  return result;
}

export function fidelityInput(
  scored: Awaited<ReturnType<EngineDeps['store']['listScoredPredictions']>>,
  questions: QuestionRecord[],
  answers: AnswerRecord[],
): { scored: Array<{ itemAcc: number; baselineItemAcc: number | null }>; repeatAgreements: number[] } {
  const primaries = scored
    .filter((r) => r.prediction.role === 'primary' && isScoredKind(r.question.kind))
    .sort((a, b) => (a.question.seq ?? 0) - (b.question.seq ?? 0));
  const baselineByQ = new Map(
    scored.filter((r) => r.prediction.role === 'baseline').map((r) => [r.question.id, r.score.itemAcc]),
  );
  const answerByQ = new Map(answers.map((a) => [a.questionId, a]));
  const repeatAgreements: number[] = [];
  for (const q of questions) {
    if (q.kind !== 'repeat' || !q.repeatOf) continue;
    const a2 = answerByQ.get(q.id);
    const a1 = answerByQ.get(q.repeatOf);
    if (a1 && a2) repeatAgreements.push(repeatAgreement(q.type, a1.value, a2.value));
  }
  return {
    scored: primaries.map((r) => ({
      itemAcc: r.score.itemAcc,
      baselineItemAcc: baselineByQ.get(r.question.id) ?? null,
    })),
    repeatAgreements,
  };
}

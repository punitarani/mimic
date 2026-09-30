import { z } from 'zod';
import type { PipelineConfig } from '../config';
import { argmax } from '../distribution';
import { computeFidelity, type FidelityResult } from '../fidelity';
import { seededRng } from '../hash';
import { RESERVE_V1 } from '../ontology';
import { JevPredictor, LlmPredictor } from '../predictors';
import { pickRepeat } from '../repeats';
import { repeatAgreement, scorePrediction } from '../scoring';
import { makeSelector, questionCoverage } from '../selectors';
import { cosine, lexicalSimilarity } from '../state-builder';
import type { AnswerRecord, FidelityRecord, MimicRecord, PredictionRecord, QuestionRecord } from '../store';
import type { PersonState, PredictionResult, Question } from '../types';
import {
  contextState,
  facetCounts,
  type LoadedMimic,
  loadMimicData,
  sealedState,
  stateBlobKey,
  vectorId,
} from './data';
import {
  ctxFor,
  deferred,
  type EngineDeps,
  EngineError,
  fallbackModel,
  loadConfig,
  requireMimic,
  timed,
} from './deps';

export const JEV_PROMPT_VERSION = 'jev-predict.v1';
export const MIN_POOL = 6;
export const MAX_POOL = 15;

export interface PublicQuestion {
  id: string;
  seq: number;
  /** Repeats are shown as adaptive so the person can't tell a probe from a new question. */
  kind: 'anchor' | 'adaptive' | 'playground';
  type: Question['type'];
  prompt: string;
  options: Question['options'];
}

export type NextResult =
  | { status: 'question'; question: PublicQuestion; progress: Progress }
  | { status: 'waiting' | 'budget' | 'identity'; progress: Progress };

export interface Progress {
  answered: number;
  target: number;
}

export function toPublic(q: QuestionRecord): PublicQuestion {
  return {
    id: q.id,
    seq: q.seq!,
    kind: q.kind === 'repeat' ? 'adaptive' : q.kind,
    type: q.type,
    prompt: q.prompt,
    options: q.options,
  };
}

function progressOf(questions: QuestionRecord[], cfg: PipelineConfig): Progress {
  const answered = questions.filter((q) => q.status === 'answered' && q.kind !== 'playground').length;
  return { answered, target: cfg.session.target };
}

function maxSeq(questions: QuestionRecord[]): number {
  return questions.reduce((a, q) => Math.max(a, q.seq ?? 0), 0);
}

/**
 * `POST /next` (PLAN §6.4). Idempotent per seq: returns the served-but-unanswered question if there is one.
 * The primary and baseline predictions are persisted before the question is returned (PLAN §3.2).
 */
export async function serveNext(deps: EngineDeps, mimicId: string): Promise<NextResult> {
  const m = await timed(deps, 'mimic', () => requireMimic(deps, mimicId));
  const cfg = await loadConfig(deps, m.configHash);
  const loaded = await timed(deps, 'load', () => loadMimicData(deps, m));
  const { questions } = loaded;
  const progress = progressOf(questions, cfg);

  const current = questions.find((q) => q.status === 'served' && q.kind !== 'playground');
  if (current) return { status: 'question', question: toPublic(current), progress };
  if (m.status !== 'learning') return { status: 'identity', progress };
  if (m.spendUsd >= cfg.session.budgetUsd) return { status: 'budget', progress };

  const seq = maxSeq(questions) + 1;
  const rng = seededRng(`select:${m.id}:${seq}`);

  // 1) Anchors first, in the per-person order fixed at intake.
  const anchor = questions
    .filter((q) => q.kind === 'anchor' && q.status === 'pooled')
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (anchor) return serveWithPredictions(deps, m, cfg, loaded, seq, anchor, [anchor], progress, rng);

  // 2) Repeat probes, scheduled outside the selector; no predictions (PLAN §9.5).
  const served = questions
    .filter((q) => q.seq !== null && q.kind !== 'playground')
    .map((q) => ({
      questionId: q.id,
      seq: q.seq!,
      kind: q.kind,
      repeatOf: q.repeatOf ?? null,
      answered: q.status === 'answered',
    }));
  const repeatOf = pickRepeat(served, seq, cfg.repeats, rng);
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
    };
    await deps.store.insertQuestions([rep]);
    const ok = await deps.store.serveQuestion({
      questionId: rep.id,
      mimicId: m.id,
      seq,
      servedAt: deps.clock(),
      predictions: [],
    });
    if (!ok) return raced(deps, m.id);
    return { status: 'question', question: toPublic({ ...rep, seq, status: 'served' }), progress };
  }

  // 3) Adaptive pool (reserve bank when the generated pool is empty).
  let pool = questions.filter((q) => q.kind === 'adaptive' && q.status === 'pooled');
  if (pool.length < MIN_POOL) {
    await deferred(deps, () => deps.jobs.enqueue({ type: 'pool.refill', mimicId: m.id, seq }));
  }
  if (pool.length === 0) {
    pool = await addReserve(deps, m, questions);
    if (pool.length === 0) return { status: 'waiting', progress };
  }
  return serveWithPredictions(deps, m, cfg, loaded, seq, null, pool, progress, rng);
}

async function raced(deps: EngineDeps, mimicId: string): Promise<NextResult> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const qs = await deps.store.listQuestions(m.id);
  const current = qs.find((q) => q.status === 'served' && q.kind !== 'playground');
  const progress = progressOf(qs, cfg);
  if (!current) throw new EngineError('conflict', 'Concurrent serve; retry');
  return { status: 'question', question: toPublic(current), progress };
}

const RESERVE_BATCH = 3;

async function addReserve(
  deps: EngineDeps,
  m: MimicRecord,
  questions: QuestionRecord[],
): Promise<QuestionRecord[]> {
  const used = new Set(questions.map((q) => q.itemKey).filter(Boolean));
  const now = deps.clock();
  const recs: QuestionRecord[] = RESERVE_V1.filter((r) => !used.has(r.itemKey))
    .slice(0, RESERVE_BATCH)
    .map((item, i) => ({
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
      provenance: { generator: 'reserve.v1', configHash: m.configHash, promptVersion: 'reserve.v1' },
      status: 'pooled',
      quality: null,
      createdAt: now + i,
      servedAt: null,
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
  seq: number,
  fixed: QuestionRecord | null,
  pool: QuestionRecord[],
  progress: Progress,
  rng: () => number,
): Promise<NextResult> {
  const primarySpec = cfg.predictor.primary;
  const ctxPrimary = ctxFor(m, 'predict.primary');
  const primary = primarySpec.startsWith('jev:')
    ? new JevPredictor(deps.gateway, primarySpec.slice(4), ctxPrimary)
    : new LlmPredictor(deps.gateway, primarySpec.slice(4), ctxPrimary);
  const baselinePredictor = primarySpec.startsWith('jev:')
    ? new JevPredictor(deps.gateway, primarySpec.slice(4), ctxFor(m, 'predict.baseline'))
    : new LlmPredictor(deps.gateway, primarySpec.slice(4), ctxFor(m, 'predict.baseline'));

  const state = await timed(deps, 'state', () => sealedState(deps, loaded, cfg, seq, pool));
  const baseState = contextState(loaded, cfg);
  if (state.meta.evidenceSeqMax >= seq) throw new Error('Sealing violated: state contains answer ≥ seq');

  const asked = loaded.questions.filter((q) => q.seq !== null && q.kind !== 'playground');
  const counts = facetCounts(loaded.questions);

  // Baseline for every candidate in one batched call, in parallel with selection (PLAN §6.4).
  const baselinePromise = baselinePredictor.predict(baseState, pool);
  let chosen: QuestionRecord;
  let primaryResult: PredictionResult;
  if (fixed) {
    chosen = fixed;
    [primaryResult] = (await timed(deps, 'select', () => primary.predict(state, [fixed]))) as [
      PredictionResult,
    ];
  } else {
    const selector = makeSelector(cfg.selector);
    const hypotheses = cfg.selector.type === 'bald' ? await loadHypotheses(deps, m.id) : undefined;
    const redundancy = await timed(deps, 'redundancy', () => redundancyFn(deps, m, pool, asked));
    const sel = await timed(deps, 'select', () =>
      selector.select({
        pool,
        state,
        primary,
        coverage: (q) => questionCoverage(counts, q),
        redundancy,
        rng,
        ...(hypotheses ? { hypotheses } : {}),
      }),
    );
    chosen = sel.question as QuestionRecord;
    primaryResult = sel.primary;
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
    promptVersion: predictorId.startsWith('jev:') ? JEV_PROMPT_VERSION : 'predict.v1',
    modelSnapshot: r.modelSnapshot,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    ok: r.ok,
    error: r.error ?? null,
    fallback: isFallback,
    createdAt: now,
  });
  const predictions = [
    pred('primary', primaryId, state, primaryResult, fallback),
    pred('baseline', primarySpec, baseState, baselineResult),
  ];
  // Primary and baseline are persisted before the question is returned (PLAN §3.2).
  const ok = await timed(deps, 'persist', () =>
    deps.store.serveQuestion({ questionId: chosen.id, mimicId: m.id, seq, servedAt: now, predictions }),
  );
  if (!ok) return raced(deps, m.id);

  // The sealed states must exist before shadow jobs read them; both can finish after the response.
  await deferred(deps, async () => {
    await Promise.all([
      deps.blobs.put(stateBlobKey(m.id, state.meta.stateHash), JSON.stringify(state), 'application/json'),
      deps.blobs.put(
        stateBlobKey(m.id, baseState.meta.stateHash),
        JSON.stringify(baseState),
        'application/json',
      ),
    ]);
    await Promise.all(
      cfg.predictor.shadows.map((s) =>
        deps.jobs.enqueue({ type: 'predict.shadow', mimicId: m.id, questionId: chosen.id, predictorId: s }),
      ),
    );
  });
  return { status: 'question', question: toPublic({ ...chosen, seq, status: 'served' }), progress };
}

export async function loadHypotheses(deps: EngineDeps, mimicId: string): Promise<string[] | undefined> {
  const raw = await deps.kv.get(`hyp:${mimicId}`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { hypotheses?: string[] };
    return parsed.hypotheses;
  } catch {
    return undefined;
  }
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
});
export type AnswerInput = z.infer<typeof AnswerInput>;

export interface Reveal {
  optionKey: string;
  label: string;
  p: number;
  match: boolean;
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
  const existing = await deps.store.getAnswerByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    if (existing.mimicId !== m.id) throw new EngineError('conflict', 'Idempotency key reused');
    return replayResult(deps, m, cfg, existing);
  }
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
    cfg.reveal === 'after_answer' && q.kind !== 'repeat' && primary ? revealOf(q, primary) : null;
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
  const scores = predictions
    .filter((p) => p.ok)
    .map((p) => ({
      predictionId: p.id,
      answerId: answer.id,
      ...scorePrediction(q.type, p.dist, input.value),
      createdAt: now,
    }));
  await timed(deps, 'record', () => deps.store.recordAnswer({ answer, scores }));

  const seqAnswered = q.seq;
  const fidelity =
    q.kind === 'playground'
      ? null
      : await timed(deps, 'fidelity', () => recomputeFidelity(deps, m, seqAnswered));
  if (q.kind === 'anchor' || q.kind === 'adaptive') {
    const seq = q.seq;
    await deferred(deps, () => deps.jobs.enqueue({ type: 'learn.answer', mimicId: m.id, seq }));
  }
  return { reveal, fidelity, seq: q.seq };
}

function revealOf(q: QuestionRecord, p: PredictionRecord): Reveal {
  const key = argmax(p.dist);
  return {
    optionKey: key,
    label: q.options.find((o) => o.key === key)?.label ?? key,
    p: p.dist[key] ?? 0,
    match: false,
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
    .filter(
      (r) =>
        r.prediction.role === 'primary' && (r.question.kind === 'anchor' || r.question.kind === 'adaptive'),
    )
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

import { z } from 'zod';
import { servedPredictorId } from '../config';
import { argmax } from '../distribution';
import {
  type DraftQuestion,
  generateRationale,
  MAX_PROMPT_WORDS,
  scenarioToQuestion,
  validateDraft,
} from '../learning';
import { makePredictor, promptVersionOf } from '../predictors';
import type { AnswerRecord, PredictionRecord, QuestionRecord } from '../store';
import { type Distribution, isSessionKind } from '../types';
import {
  contextState,
  loadMimicDataAt,
  needsScores,
  STATE_SETTLE_MS,
  sealedState,
  stateBlobKey,
} from './data';
import {
  budgetSpent,
  ctxFor,
  deferred,
  type EngineDeps,
  EngineError,
  loadConfig,
  requireMimic,
} from './deps';
import { maxSeq, type PublicQuestion, serveAtFreeSeq, toPublic } from './session';

export const ScenarioInput = z.object({ scenario: z.string().trim().min(8).max(1000) });

export const DraftInput = z.object({
  type: z.enum(['choice', 'noul', 'score']),
  prompt: z.string().trim().min(5).max(300),
  options: z
    .array(z.object({ key: z.string(), label: z.string().trim().min(1).max(160) }))
    .min(2)
    .max(5),
  rationale: z.boolean().default(false),
});
export type DraftInput = z.infer<typeof DraftInput>;

const DRAFT_ERRORS: Record<string, string> = {
  schema: 'Write a question of at least 8 characters, and fill in every option.',
  'too long': `Keep the question under ${MAX_PROMPT_WORDS} words.`,
  'hedge option': 'Options can\'t hedge, like "it depends" or "not sure". Make each one a real choice.',
  'duplicate options': 'Two options say the same thing.',
  'score needs 5 options': 'A scale needs exactly 5 steps.',
  'choice needs 2–5 options': 'Give 2 to 5 options.',
};

/** The same schema gate as generated questions (choice 2–5, yes/no, 5-step scale), with errors a person can act on. */
function validateQuestion(input: Omit<DraftInput, 'rationale'>): DraftQuestion {
  const v = validateDraft({ ...input, domain: 'casual', facetIds: ['__pg'] }, new Set(['__pg']));
  if ('error' in v) throw new EngineError('invalid', DRAFT_ERRORS[v.error] ?? `Invalid question: ${v.error}`);
  return v;
}

/** Step 2 of PLAN §9.11: an LLM turns the scenario into a typed question the person can edit. */
export async function draftFromScenario(deps: EngineDeps, mimicId: string, scenario: string) {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (budgetSpent(deps, m, cfg)) throw new EngineError('budget', 'Budget reached');
  const d = await scenarioToQuestion(deps.gateway, ctxFor(m, 'playground.draft'), {
    model: cfg.generator.model,
    scenario,
  });
  return { type: d.type, prompt: d.prompt, options: d.options };
}

export interface PlaygroundPrediction {
  question: PublicQuestion;
  dist: Distribution;
  guess: { optionKey: string; label: string; p: number };
  /** One generated sentence in the person's voice; always labeled "generated" in the UI. */
  rationale: string | null;
}

/**
 * Step 3: Jev predicts on the full state; the question is stored as `kind = playground` with sealed primary and
 * baseline predictions, so the person's own answer (step 4) is scored separately via the normal answer path.
 */
export async function predictPlayground(
  deps: EngineDeps,
  mimicId: string,
  input: DraftInput,
): Promise<PlaygroundPrediction> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (budgetSpent(deps, m, cfg)) throw new EngineError('budget', 'Budget reached');
  const { rationale: _wantsRationale, ...question } = input;
  const v = validateQuestion(question);
  const stateAt = deps.clock() - STATE_SETTLE_MS;
  const loaded = await loadMimicDataAt(deps, m, stateAt, m.seqMax + 1, { scores: needsScores(cfg) });
  const seq = maxSeq(loaded.questions) + 1;
  const now = deps.clock();
  const q: QuestionRecord = {
    id: deps.newId(),
    mimicId: m.id,
    seq: null,
    kind: 'playground',
    type: v.type,
    domain: 'casual',
    prompt: v.prompt,
    options: v.options,
    facetIds: [],
    provenance: { generator: 'playground', configHash: m.configHash, promptVersion: 'ask.v1' },
    status: 'pooled',
    quality: null,
    createdAt: now,
    servedAt: null,
    stateAt: null,
  };
  // The primary may name a prompt variant (`decision:<model>@<version>`, ADR-0028); the baseline uses the same prompt.
  const primarySpec = cfg.predictor.primary;
  const state = await sealedState(deps, loaded, cfg, seq, [q]);
  const base = contextState(loaded, cfg);
  const [[primary], [baseline]] = await Promise.all([
    makePredictor(deps.gateway, primarySpec, ctxFor(m, 'playground.predict')).predict(state, [q]),
    makePredictor(deps.gateway, primarySpec, ctxFor(m, 'playground.baseline')).predict(base, [q]),
  ]);
  if (!primary?.ok) throw new EngineError('conflict', 'The mimic could not predict this one. Try again.');
  const rec = (
    role: 'primary' | 'baseline',
    s: typeof state,
    r: NonNullable<typeof primary>,
  ): PredictionRecord => ({
    id: deps.newId(),
    questionId: q.id,
    mimicId: m.id,
    // Named after the model that answered, should the flag have rerouted the call (ADR-0051, ADR-0054).
    predictorId: servedPredictorId(primarySpec, r.servedModel),
    role,
    dist: r.dist,
    confidence: r.confidence ?? null,
    stateHash: s.meta.stateHash,
    evidenceSeqMax: s.meta.evidenceSeqMax,
    configHash: m.configHash,
    promptVersion: promptVersionOf(primarySpec),
    modelSnapshot: r.modelSnapshot,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    ok: r.ok,
    error: r.error ?? null,
    errorKind: r.ok ? null : (r.errorKind ?? null),
    fallback: false,
    createdAt: now,
  });
  // Stored only once predicted, so a failed prediction leaves nothing behind.
  await deps.store.insertQuestions([q]);
  const at = await serveAtFreeSeq(deps, {
    questionId: q.id,
    mimicId: m.id,
    seq,
    servedAt: now,
    stateAt,
    predictions: [rec('primary', state, primary), rec('baseline', base, baseline!)],
  });
  if (at === null) {
    await deps.store.updateQuestionStatus(q.id, 'discarded');
    throw new EngineError('conflict', 'Busy; try again');
  }
  await deps.blobs.put(stateBlobKey(m.id, state.meta.stateHash), JSON.stringify(state), 'application/json');

  const key = argmax(primary.dist);
  const label = q.options.find((o) => o.key === key)?.label ?? key;
  let rationale: string | null = null;
  if (input.rationale) {
    rationale = await generateRationale(deps.gateway, ctxFor(m, 'playground.rationale'), {
      model: cfg.generator.model,
      state,
      prompt: q.prompt,
      optionLabel: label,
    }).catch(() => null);
  }
  return {
    question: toPublic({ ...q, seq: at, status: 'served' }),
    dist: primary.dist,
    guess: { optionKey: key, label, p: primary.dist[key] ?? 0 },
    rationale,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Feedback (ADR-0032): the person writes a question and picks the right answer themselves, without asking the
// mimic. The answer is evidence the mimic learns from; with no prediction, it is never scored.
// ---------------------------------------------------------------------------------------------------------------

export const FeedbackInput = z.object({
  question: DraftInput.omit({ rationale: true }),
  /** The key of the chosen option, as sent in `question.options`. */
  answer: z.string().min(1).max(32),
  why: z.string().trim().max(1000).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

export interface FeedbackResult {
  question: PublicQuestion;
  answer: { optionKey: string; label: string };
  /** False once the mimic has spent its budget: the answer is kept, but no model reads it (ADR-0032). */
  learns: boolean;
}

const FEEDBACK_ATTEMPTS = 3;

/**
 * Where a feedback answer came from (ADR-0060): the person on the mimic page by default, or an agent's observation
 * ledger, which names the agent and keeps the observation's own metadata on the question.
 */
export interface FeedbackOrigin {
  generator: string;
  promptVersion: string;
  quality: Record<string, unknown> | null;
}

export const PERSON_FEEDBACK: FeedbackOrigin = {
  generator: 'feedback',
  promptVersion: 'feedback.v1',
  quality: null,
};

/**
 * Stores a question the person wrote together with their own answer, as `kind = feedback`, in one atomic write.
 * It enters later sealed states and learning like a session answer. Learnable answers must arrive in seq order,
 * so when a session question is served and not yet answered, the feedback takes that seq and the question moves
 * past it (its predictions were sealed below it, so they stay sealed). Idempotent per key; a write that loses a
 * race for a seq is retried.
 */
export async function submitFeedback(
  deps: EngineDeps,
  mimicId: string,
  input: FeedbackInput,
  origin: FeedbackOrigin = PERSON_FEEDBACK,
): Promise<FeedbackResult> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const learns = !budgetSpent(deps, m, cfg);
  const v = validateQuestion(input.question);
  // Keys are renormalized by the gate (a, b, c… for choices, 0–4 for a scale), so the pick is carried over by
  // position; yes/no keeps its keys whatever order they came in.
  const i = input.question.options.findIndex((o) => o.key === input.answer);
  const optionKey =
    v.type === 'noul' && (input.answer === 'yes' || input.answer === 'no')
      ? input.answer
      : i >= 0
        ? v.options[i]?.key
        : undefined;
  if (!optionKey) throw new EngineError('invalid', 'Pick one of the options.');

  const replay = async (): Promise<FeedbackResult | null> => {
    const a = await deps.store.getAnswerByIdempotencyKey(input.idempotencyKey);
    if (!a) return null;
    const q = a.mimicId === m.id ? await deps.store.getQuestion(a.questionId) : null;
    // A retry must be the same request; a key reused for anything else is refused.
    if (q?.kind !== 'feedback' || q.prompt !== v.prompt || a.value !== optionKey)
      throw new EngineError('conflict', 'Idempotency key reused');
    return feedbackResult(q, a, learns);
  };
  const done = await replay();
  if (done) return done;

  for (let attempt = 0; attempt < FEEDBACK_ATTEMPTS; attempt++) {
    const questions = await deps.store.listQuestions(m.id);
    const top = maxSeq(questions);
    const open = questions.find((q) => q.status === 'served' && isSessionKind(q.kind));
    const seq = open ? open.seq! : top + 1;
    const now = deps.clock();
    const q: QuestionRecord = {
      id: deps.newId(),
      mimicId: m.id,
      seq,
      kind: 'feedback',
      type: v.type,
      domain: 'casual',
      prompt: v.prompt,
      options: v.options,
      facetIds: [],
      provenance: {
        generator: origin.generator,
        configHash: m.configHash,
        promptVersion: origin.promptVersion,
      },
      status: 'answered',
      quality: origin.quality,
      createdAt: now,
      servedAt: now,
      stateAt: null,
    };
    const answer: AnswerRecord = {
      id: deps.newId(),
      questionId: q.id,
      mimicId: m.id,
      seq,
      value: optionKey,
      why: input.why?.length ? input.why : null,
      latencyMs: 0,
      revealedPrediction: false,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    const move = open ? { questionId: open.id, toSeq: top + 1 } : undefined;
    if (await deps.store.recordFeedback({ question: q, answer, ...(move ? { move } : {}) })) {
      await deferred(deps, () => deps.jobs.enqueue({ type: 'learn.answer', mimicId: m.id, seq }));
      return feedbackResult(q, answer, learns);
    }
    const raced = await replay();
    if (raced) return raced;
  }
  throw new EngineError('conflict', 'Busy; try again');
}

function feedbackResult(q: QuestionRecord, a: AnswerRecord, learns: boolean): FeedbackResult {
  return {
    question: toPublic(q),
    answer: { optionKey: a.value, label: q.options.find((o) => o.key === a.value)?.label ?? a.value },
    learns,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// History: what the person asked and taught on the mimic page.
// ---------------------------------------------------------------------------------------------------------------

export interface PlaygroundItem {
  question: PublicQuestion;
  /** The person's own answer; null for an asked question they haven't answered yet. */
  answer: { optionKey: string; label: string; why: string | null } | null;
  /** The mimic's sealed guess, for asked questions; feedback has none. */
  guess: { optionKey: string; label: string; p: number } | null;
  dist: Distribution | null;
  createdAt: number;
}

export interface PlaygroundHistory {
  items: PlaygroundItem[];
  /** Answers given directly as feedback, which the mimic learns from. */
  taught: number;
  /** Asked questions the person answered, and how many of those the mimic's top guess matched. */
  checked: number;
  matched: number;
}

export async function listPlayground(
  deps: EngineDeps,
  mimicId: string,
  limit = 20,
): Promise<PlaygroundHistory> {
  const m = await requireMimic(deps, mimicId);
  const [questions, answers, primaries] = await Promise.all([
    deps.store.listQuestions(m.id, ['served', 'answered'], ['playground', 'feedback']),
    deps.store.listAnswers(m.id),
    deps.store.listPredictions({ mimicId: m.id, roles: ['primary'] }),
  ]);
  const answerByQ = new Map(answers.map((a) => [a.questionId, a]));
  const primaryByQ = new Map(primaries.filter((p) => p.ok).map((p) => [p.questionId, p]));
  const label = (q: QuestionRecord, key: string) => q.options.find((o) => o.key === key)?.label ?? key;
  const all = questions
    .filter((q) => q.seq !== null)
    .sort((a, b) => b.seq! - a.seq!)
    .map((q): PlaygroundItem => {
      const a = answerByQ.get(q.id);
      const p = primaryByQ.get(q.id);
      const key = p ? argmax(p.dist) : null;
      return {
        question: toPublic(q),
        answer: a ? { optionKey: a.value, label: label(q, a.value), why: a.why } : null,
        guess: p && key ? { optionKey: key, label: label(q, key), p: p.dist[key] ?? 0 } : null,
        dist: p?.dist ?? null,
        createdAt: q.servedAt ?? q.createdAt,
      };
    })
    // An asked question whose prediction failed has nothing to show or answer.
    .filter((it) => it.question.kind === 'feedback' || it.guess);
  const checked = all.filter((it) => it.question.kind === 'playground' && it.answer);
  return {
    items: all.slice(0, limit),
    taught: all.filter((it) => it.question.kind === 'feedback').length,
    checked: checked.length,
    matched: checked.filter((it) => it.guess?.optionKey === it.answer?.optionKey).length,
  };
}

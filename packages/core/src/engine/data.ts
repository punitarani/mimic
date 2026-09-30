import type { PipelineConfig } from '../config';
import { type BuildOptions, buildState, type EvidenceItem, type MimicData } from '../state-builder';
import type {
  AnswerRecord,
  FactRecord,
  InsightRecord,
  MimicRecord,
  QuestionRecord,
  TraitRecord,
} from '../store';
import type { PersonState, Question } from '../types';
import type { EngineDeps } from './deps';

export interface LoadedMimic {
  data: MimicData;
  questions: QuestionRecord[];
  answers: AnswerRecord[];
}

/**
 * How far the as-of time of a sealed state's derived data lags the serve (ADR-0017). A trait or insight write that
 * is in flight while a question is served lands clearly on one side of it, so replay sees exactly what serving saw.
 */
export const STATE_SETTLE_MS = 2_000;

function assemble(
  m: MimicRecord,
  rows: {
    facts: FactRecord[];
    questions: QuestionRecord[];
    answers: AnswerRecord[];
    traits: TraitRecord[];
    insights: InsightRecord[];
  },
): LoadedMimic {
  const { facts, questions, answers, traits, insights } = rows;
  const qById = new Map(questions.map((q) => [q.id, q]));
  const evidence: EvidenceItem[] = [];
  for (const a of answers) {
    const q = qById.get(a.questionId);
    if (!q) continue;
    const item: EvidenceItem = {
      seq: a.seq,
      questionId: q.id,
      kind: q.kind,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      answer: a.value,
      facetIds: q.facetIds,
      latencyMs: a.latencyMs,
    };
    if (a.why) item.why = a.why;
    evidence.push(item);
  }
  return {
    data: {
      mimicId: m.id,
      identity: {
        displayName: m.displayName,
        location: m.location,
        occupation: m.occupation,
        employer: m.employer,
      },
      facts,
      evidence,
      traits,
      insights,
    },
    questions,
    answers,
  };
}

/** Loads everything the state builder needs, as it stands now. Evidence is the raw source of truth (PLAN §3.3). */
export async function loadMimicData(deps: EngineDeps, m: MimicRecord): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraits(m.id),
    deps.store.listInsights(m.id),
  ]);
  return assemble(m, {
    facts,
    questions,
    answers,
    traits,
    insights: insights.filter((i) => i.status === 'active'),
  });
}

/**
 * The mimic's data with its derived parts as they stood at `at` (ADR-0017): trait estimates from the append-only
 * history, insights created by then and not yet superseded, facts created by then and never re-activated after it. Serving builds sealed
 * states from this view and records `at` as the question's `stateAt`, so replay can rebuild them exactly from an
 * export. Evidence is not time-filtered; sealing by seq happens in the state builder.
 */
export async function loadMimicDataAt(
  deps: EngineDeps,
  m: MimicRecord,
  at: number,
  beforeSeq: number,
): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraitsAsOf(m.id, at, beforeSeq),
    deps.store.listInsights(m.id),
  ]);
  return assemble(m, {
    facts: facts
      .filter((f) => f.createdAt <= at)
      .map((f) => ({
        ...f,
        // Removal is never time-travelled: a fact removed now, or toggled after `at`, stays out (PLAN §3.8; ADR-0017).
        userState:
          f.userState === 'removed' || (f.userStateAt !== null && f.userStateAt > at) ? 'removed' : 'active',
      })),
    questions,
    answers,
    traits,
    insights: insights.filter(
      (i) =>
        i.createdAt <= at &&
        (i.status === 'active' || (i.statusChangedAt !== null && i.statusChangedAt > at)),
    ),
  });
}

export function stateOptions(
  cfg: PipelineConfig,
  beforeSeq: number,
  extra: Partial<BuildOptions> = {},
): BuildOptions {
  return {
    beforeSeq,
    budgetTokens: cfg.stateBuilder.budgetTokens,
    strategy: cfg.stateBuilder.strategy,
    retrievalK: cfg.stateBuilder.retrievalK,
    recentN: cfg.stateBuilder.recentN,
    ...(cfg.stateBuilder.latencyHints ? { latencyHints: true } : {}),
    ...extra,
  };
}

export const vectorId = {
  qa: (mimicId: string, seq: number) => `${mimicId}:qa:${seq}`,
  fact: (mimicId: string, factId: string) => `${mimicId}:fact:${factId}`,
  question: (mimicId: string, questionId: string) => `${mimicId}:q:${questionId}`,
};

/**
 * Sealed state for question `beforeSeq`. When evidence outgrows the budget, embeddings are loaded for retrieval
 * (PLAN §9.9); otherwise every answered item fits and no vector lookup is needed.
 */
export async function sealedState(
  deps: EngineDeps,
  loaded: LoadedMimic,
  cfg: PipelineConfig,
  beforeSeq: number,
  forQuestions: Question[],
): Promise<PersonState> {
  const opts = stateOptions(cfg, beforeSeq, { forQuestions });
  const first = buildState(loaded.data, opts);
  const eligible = loaded.data.evidence.filter(
    (e) => e.seq < beforeSeq && (e.kind === 'anchor' || e.kind === 'adaptive'),
  );
  if (first.evidence.length >= eligible.length || cfg.stateBuilder.strategy === 'structured') return first;
  try {
    const ids = eligible.map((e) => vectorId.qa(loaded.data.mimicId, e.seq));
    const qIds = forQuestions.map((q) => vectorId.question(loaded.data.mimicId, q.id));
    const recs = await deps.vectors.getByIds([...ids, ...qIds]);
    const bySeq = new Map<number, number[]>();
    const targets: number[][] = [];
    for (const r of recs) {
      if (r.metadata.kind === 'qa') bySeq.set(r.metadata.seq, r.values);
      else targets.push(r.values);
    }
    if (!targets.length) return first;
    const centroid = targets[0]!.map((_, i) => targets.reduce((a, t) => a + (t[i] ?? 0), 0) / targets.length);
    return buildState({ ...loaded.data, embeddings: bySeq }, { ...opts, queryEmbedding: centroid });
  } catch {
    return first;
  }
}

export function contextState(loaded: LoadedMimic, cfg: PipelineConfig): PersonState {
  return buildState(loaded.data, stateOptions(cfg, 0, { contextOnly: true }));
}

export function stateBlobKey(mimicId: string, stateHash: string): string {
  return `states/${mimicId}/${stateHash}.json`;
}

/** Facet → number of served/answered anchor+adaptive questions touching it. */
export function facetCounts(questions: QuestionRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const q of questions) {
    if (q.kind !== 'anchor' && q.kind !== 'adaptive') continue;
    if (q.status !== 'answered' && q.status !== 'served') continue;
    for (const f of q.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

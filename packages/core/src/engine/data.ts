import type { PipelineConfig } from '../config';
import { type BuildOptions, buildState, type EvidenceItem, type MimicData } from '../state-builder';
import type { AnswerRecord, MimicRecord, QuestionRecord } from '../store';
import type { PersonState, Question } from '../types';
import type { EngineDeps } from './deps';

export interface LoadedMimic {
  data: MimicData;
  questions: QuestionRecord[];
  answers: AnswerRecord[];
}

/** Loads everything the state builder needs. Evidence is the raw source of truth (PLAN §3.3). */
export async function loadMimicData(deps: EngineDeps, m: MimicRecord): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraits(m.id),
    deps.store.listInsights(m.id),
  ]);
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
      insights: insights.filter((i) => i.status === 'active'),
    },
    questions,
    answers,
  };
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

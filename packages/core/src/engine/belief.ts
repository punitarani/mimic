import { type BeliefAnswer, type BeliefState, buildBelief } from '../belief';
import type { PipelineConfig } from '../config';
import { repeatAgreement } from '../scoring';
import type { AnswerRecord, InsightRecord, MimicRecord, QuestionRecord, ScoredPredictionRow } from '../store';
import { type Facet, isScoredKind } from '../types';
import type { LoadedMimic } from './data';
import type { EngineDeps } from './deps';

export interface BeliefSources {
  /** Every insight, including superseded ones (contradictions raise a facet's conflict). */
  insights: InsightRecord[];
  /** Scored sealed primaries (the prequential error behind `weakness`). */
  scored: ScoredPredictionRow[];
}

export async function loadBeliefSources(deps: EngineDeps, m: MimicRecord): Promise<BeliefSources> {
  const [insights, scored] = await Promise.all([
    deps.store.listInsights(m.id),
    deps.store.listScoredPredictions(m.id, ['primary']),
  ]);
  return { insights, scored };
}

/**
 * Answered anchor and adaptive questions with seq < `beforeSeq` as the belief state sees them, with the sealed
 * primary's item accuracy where one is known. Shared by the engine and the offline selection simulation.
 */
export function beliefAnswers(
  answers: AnswerRecord[],
  qById: ReadonlyMap<string, QuestionRecord>,
  itemAccByQuestion: ReadonlyMap<string, number>,
  beforeSeq = Number.MAX_SAFE_INTEGER,
): BeliefAnswer[] {
  const out: BeliefAnswer[] = [];
  for (const a of answers) {
    const q = qById.get(a.questionId);
    if (!q || !isScoredKind(q.kind) || a.seq >= beforeSeq) continue;
    out.push({
      seq: a.seq,
      kind: q.kind,
      type: q.type,
      domain: q.domain,
      facetIds: q.facetIds,
      answer: a.value,
      latencyMs: a.latencyMs,
      itemAcc: itemAccByQuestion.get(q.id) ?? null,
    });
  }
  return out;
}

/**
 * The person's belief state from loaded data (docs/SELECTION.md §3). Answered anchor and adaptive questions with
 * seq < `beforeSeq` count as answers; served, unanswered ones count toward coverage and exposure only.
 */
export function beliefFromLoaded(
  loaded: LoadedMimic,
  facets: Facet[],
  cfg: PipelineConfig,
  sources: BeliefSources,
  opts: { beforeSeq?: number; pooled?: Array<{ facetIds: string[] }> } = {},
): BeliefState {
  const beforeSeq = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER;
  const qById = new Map(loaded.questions.map((q) => [q.id, q]));
  const accByQ = new Map(sources.scored.map((r) => [r.question.id, r.score.itemAcc]));
  // Answers the scope hides (a withdrawn category) never count toward any belief (ADR-0040).
  const visible = loaded.answers.filter((a) => !loaded.scope.hiddenQuestionIds.has(a.questionId));
  const answers = beliefAnswers(visible, qById, accByQ, beforeSeq);
  const answerByQ = new Map(loaded.answers.map((a) => [a.questionId, a]));
  const served = loaded.questions
    .filter((q) => q.status === 'served' && isScoredKind(q.kind) && !loaded.scope.hiddenQuestionIds.has(q.id))
    .map((q) => ({ type: q.type, domain: q.domain, facetIds: q.facetIds }));
  const repeats: Array<{ facetIds: string[]; agreement: number }> = [];
  for (const q of loaded.questions) {
    if (q.kind !== 'repeat' || !q.repeatOf || loaded.scope.hiddenQuestionIds.has(q.id)) continue;
    const src = qById.get(q.repeatOf) as QuestionRecord | undefined;
    const a1 = answerByQ.get(q.repeatOf);
    const a2 = answerByQ.get(q.id);
    if (!src || !a1 || !a2 || a2.seq >= beforeSeq) continue;
    repeats.push({ facetIds: src.facetIds, agreement: repeatAgreement(q.type, a1.value, a2.value) });
  }
  return buildBelief({
    facets,
    answers,
    served,
    ...(opts.pooled ? { pooled: opts.pooled } : {}),
    traits: loaded.data.traits,
    insights: sources.insights.map((i) => ({ facetIds: i.facetIds, status: i.status })),
    repeats,
    domainMix: cfg.generator.domainMix,
  });
}

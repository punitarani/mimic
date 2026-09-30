import type { PipelineConfig } from '../config';
import { factHidden, insightHidden, type ScopeView, scopeView } from '../scope';
import {
  type BuildOptions,
  buildState,
  type EvidenceItem,
  type MimicData,
  toStateEvidence,
} from '../state-builder';
import type {
  AnswerRecord,
  FactRecord,
  InsightRecord,
  MimicRecord,
  QuestionRecord,
  TraitRecord,
} from '../store';
import { type Facet, isScoredKind, learnsFrom, type PersonState, type Question } from '../types';
import { type EngineDeps, facetsFor, loadConfig } from './deps';

export interface LoadedMimic {
  /** Evidence, traits, insights and facts within the person's scope (ADR-0040). */
  data: MimicData;
  /** Every question and answer, in or out of scope (seq bookkeeping, repeats, fidelity). */
  questions: QuestionRecord[];
  answers: AnswerRecord[];
  /** What the scope hides: served views and states never include it. */
  scope: ScopeView;
}

/**
 * How far the as-of time of a sealed state's derived data lags the serve (ADR-0017). A trait or insight write that
 * is in flight while a question is served lands clearly on one side of it, so replay sees exactly what serving saw.
 */
export const STATE_SETTLE_MS = 2_000;

/**
 * Builds the loaded view and applies the person's current scope (ADR-0040): answers to questions touching a blocked
 * facet, trait estimates of blocked facets, insights naming a blocked facet or citing a hidden answer, and reflection
 * facts citing a hidden answer are left out. With the default scope nothing is blocked and the view is unchanged.
 */
function assemble(
  m: MimicRecord,
  facets: Facet[],
  rows: {
    facts: FactRecord[];
    questions: QuestionRecord[];
    answers: AnswerRecord[];
    traits: TraitRecord[];
    insights: InsightRecord[];
  },
): LoadedMimic {
  const { questions, answers } = rows;
  const view = scopeView(m.scope, facets, questions);
  const facts = rows.facts.filter((f) => !factHidden(view, f));
  const traits = rows.traits.filter((t) => !view.blocked.has(t.facetId));
  const insights = rows.insights.filter((i) => !insightHidden(view, i));
  const qById = new Map(questions.map((q) => [q.id, q]));
  const evidence: EvidenceItem[] = [];
  for (const a of answers) {
    const q = qById.get(a.questionId);
    if (!q || view.hiddenQuestionIds.has(q.id)) continue;
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
    scope: view,
  };
}

/** Every facet the mimic's config knows, in scope or not: what the scope view classifies. */
async function allFacets(deps: EngineDeps, m: MimicRecord): Promise<Facet[]> {
  return facetsFor(deps, m, await loadConfig(deps, m.configHash), { scoped: false });
}

/** Loads everything the state builder needs, as it stands now. Evidence is the raw source of truth (PLAN §3.3). */
export async function loadMimicData(deps: EngineDeps, m: MimicRecord): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights, facets] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraits(m.id),
    deps.store.listInsights(m.id),
    allFacets(deps, m),
  ]);
  return assemble(m, facets, {
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
 * export. Evidence is sealed by seq in the state builder, and only feedback is also time-filtered: it is written
 * without a serve, so it can take a seq below a question that was already predicted (ADR-0032).
 */
export async function loadMimicDataAt(
  deps: EngineDeps,
  m: MimicRecord,
  at: number,
  beforeSeq: number,
): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights, facets] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraitsAsOf(m.id, at, beforeSeq),
    deps.store.listInsights(m.id),
    allFacets(deps, m),
  ]);
  const kindOf = new Map(questions.map((q) => [q.id, q.kind]));
  // The scope is today's, never time-travelled: what the person withdrew stays out of rebuilt states too (ADR-0040,
  // as fact removal in ADR-0017). Replay reports states served before `scopeAt` as rescoped.
  return assemble(m, facets, {
    facts: facts
      .filter((f) => f.createdAt <= at)
      .map((f) => ({
        ...f,
        // Removal is never time-travelled: a fact removed now, or toggled after `at`, stays out (PLAN §3.8; ADR-0017).
        userState:
          f.userState === 'removed' || (f.userStateAt !== null && f.userStateAt > at) ? 'removed' : 'active',
      })),
    questions,
    answers: answers.filter((a) => kindOf.get(a.questionId) !== 'feedback' || a.createdAt <= at),
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

/** The text a Q&A is embedded from (plus the "why"). */
export function qaText(item: EvidenceItem): string {
  return `${item.prompt} → ${toStateEvidence(item).answer}${item.why ? ` (why: ${item.why})` : ''}`;
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
  const eligible = loaded.data.evidence.filter((e) => e.seq < beforeSeq && learnsFrom(e.kind));
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
    if (!isScoredKind(q.kind)) continue;
    if (q.status !== 'answered' && q.status !== 'served') continue;
    for (const f of q.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

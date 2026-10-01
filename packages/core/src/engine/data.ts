import type { PipelineConfig } from '../config';
import { rawScale } from '../predictors';
import { factHidden, insightHidden, type ScopeView, scopeView } from '../scope';
import { scorePrediction } from '../scoring';
import {
  type BuildOptions,
  buildState,
  type EvidenceItem,
  type MimicData,
  surpriseOf,
  toStateEvidence,
} from '../state-builder';
import type {
  AnswerRecord,
  FactRecord,
  InsightRecord,
  MimicRecord,
  QuestionRecord,
  ScoredPredictionRow,
  TraitRecord,
} from '../store';
import { type Facet, isScoredKind, learnsFrom, type PersonState, type Question } from '../types';
import { type EngineDeps, facetsFor, loadConfig } from './deps';

/** What a loader may fetch beyond the evidence: the sealed scores that annotate surprise and novelty (ADR-0054). */
export interface LoadOptions {
  scores?: boolean;
}

/** Whether a config's states read the stored scores: only the `surprise` and `novelty` policies do (ADR-0054). */
export function needsScores(cfg: Pick<PipelineConfig, 'stateBuilder'>): boolean {
  const p = cfg.stateBuilder.evidencePolicy;
  return p === 'surprise' || p === 'novelty';
}

/**
 * Surprise and novelty per answered question from the stored primary and baseline scores (ADR-0054): each is the
 * prediction's log loss on the answer over log|options|, on the predictor's raw scale (`rawScale`, ADR-0048), so a
 * calibrated primary ranks evidence exactly as an uncalibrated one. A fallback primary carries no novelty. Scores are
 * written with the answer in one transaction and removed with it on an undo, so the annotation of an answer is
 * fixed from the moment it exists: a state built online and one rebuilt from an export agree.
 */
export function evidenceSignals(
  rows: ScoredPredictionRow[],
  questions: QuestionRecord[],
  answers: AnswerRecord[],
): Map<string, { surprise?: number; novelty?: number }> {
  const qById = new Map(questions.map((q) => [q.id, q]));
  const valueByQ = new Map(answers.map((a) => [a.questionId, a.value]));
  const out = new Map<string, { surprise?: number; novelty?: number }>();
  for (const r of rows) {
    const p = r.prediction;
    if (!p.ok || (p.role !== 'primary' && p.role !== 'baseline')) continue;
    if (p.role === 'primary' && p.fallback) continue;
    const q = qById.get(p.questionId);
    const value = valueByQ.get(p.questionId);
    if (!q || value === undefined) continue;
    const { logLoss } = scorePrediction(q.type, rawScale(p.predictorId, p.dist), value);
    const s = out.get(q.id) ?? {};
    if (p.role === 'baseline') s.surprise = surpriseOf(logLoss, q.options.length);
    else s.novelty = surpriseOf(logLoss, q.options.length);
    out.set(q.id, s);
  }
  return out;
}

export interface LoadedMimic {
  /** Evidence, traits, insights and facts within the person's scope (ADR-0040). */
  data: MimicData;
  /** Fact rows within the scope, removed ones included, for views that need their IDs and provenance. */
  facts: FactRecord[];
  /** Every question and answer, in or out of scope (seq bookkeeping, repeats, fidelity). */
  questions: QuestionRecord[];
  answers: AnswerRecord[];
  /** What the scope hides: served views and states never include it. */
  scope: ScopeView;
  /** Facts and insights the scope hid, so views can drop the graph edges built from them. */
  hidden: { factIds: Set<string>; insightIds: Set<string> };
}

/**
 * The knowledge graph as the person's scope allows it (ADR-0043): no edge built from a hidden fact or insight, no
 * facet node for a blocked facet, and no node left without a kept edge (the person node stays).
 */
export function scopedKg<
  N extends { id: string; type: string; props: Record<string, unknown> },
  E extends { src: string; dst: string; sourceRef: string | null },
>(kg: { nodes: N[]; edges: E[] }, loaded: Pick<LoadedMimic, 'scope' | 'hidden'>): { nodes: N[]; edges: E[] } {
  const blockedNode = (n: N) => n.type === 'Facet' && loaded.scope.blocked.has(String(n.props.facetId ?? ''));
  const dropped = new Set(kg.nodes.filter(blockedNode).map((n) => n.id));
  const edges = kg.edges.filter(
    (e) =>
      !dropped.has(e.src) &&
      !dropped.has(e.dst) &&
      !(e.sourceRef && (loaded.hidden.factIds.has(e.sourceRef) || loaded.hidden.insightIds.has(e.sourceRef))),
  );
  const linked = new Set(edges.flatMap((e) => [e.src, e.dst]));
  const nodes = kg.nodes.filter((n) => !dropped.has(n.id) && (n.type === 'Person' || linked.has(n.id)));
  return { nodes, edges };
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
    /** Scored primaries and baselines, when the state's evidence policy reads them (ADR-0054). */
    scores?: ScoredPredictionRow[];
  },
): LoadedMimic {
  const { questions, answers } = rows;
  const signals = rows.scores ? evidenceSignals(rows.scores, questions, answers) : null;
  const view = scopeView(m.scope, facets, questions);
  const facts = rows.facts.filter((f) => !factHidden(view, f));
  const traits = rows.traits.filter((t) => !view.blocked.has(t.facetId));
  const insights = rows.insights.filter((i) => !insightHidden(view, i));
  const hidden = {
    factIds: new Set(rows.facts.filter((f) => factHidden(view, f)).map((f) => f.id)),
    insightIds: new Set(rows.insights.filter((i) => insightHidden(view, i)).map((i) => i.id)),
  };
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
    const sig = signals?.get(q.id);
    if (sig?.surprise !== undefined) item.surprise = sig.surprise;
    if (sig?.novelty !== undefined) item.novelty = sig.novelty;
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
    facts,
    questions,
    answers,
    scope: view,
    hidden,
  };
}

/** Every facet the mimic's config knows, in scope or not: what the scope view classifies. */
async function allFacets(deps: EngineDeps, m: MimicRecord): Promise<Facet[]> {
  return facetsFor(deps, m, await loadConfig(deps, m.configHash), { scoped: false });
}

/** Loads everything the state builder needs, as it stands now. Evidence is the raw source of truth (PLAN §3.3). */
export async function loadMimicData(
  deps: EngineDeps,
  m: MimicRecord,
  opts: LoadOptions = {},
): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights, facets, scores] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraits(m.id),
    deps.store.listInsights(m.id),
    allFacets(deps, m),
    opts.scores ? deps.store.listScoredPredictions(m.id, ['primary', 'baseline']) : undefined,
  ]);
  return assemble(m, facets, {
    facts,
    questions,
    answers,
    traits,
    insights: insights.filter((i) => i.status === 'active'),
    ...(scores ? { scores } : {}),
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
  opts: LoadOptions = {},
): Promise<LoadedMimic> {
  const [facts, questions, answers, traits, insights, facets, scores] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listTraitsAsOf(m.id, at, beforeSeq),
    deps.store.listInsights(m.id),
    allFacets(deps, m),
    opts.scores ? deps.store.listScoredPredictions(m.id, ['primary', 'baseline']) : undefined,
  ]);
  const kindOf = new Map(questions.map((q) => [q.id, q.kind]));
  // The scope is today's, never time-travelled: what the person withdrew stays out of rebuilt states too (ADR-0040,
  // as fact removal in ADR-0017). Replay reports states served before `scopeAt` as rescoped.
  return assemble(m, facets, {
    // Scores are sealed by seq inside the state builder, like the answers they belong to; never by time (ADR-0054).
    ...(scores ? { scores } : {}),
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
    ...(cfg.stateBuilder.evidencePolicy ? { evidencePolicy: cfg.stateBuilder.evidencePolicy } : {}),
    ...(cfg.stateBuilder.maxEvidence !== undefined ? { maxEvidence: cfg.stateBuilder.maxEvidence } : {}),
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

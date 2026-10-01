import { LATENCY_MIN_N, medianOf, paceOf } from './belief';
import { fill, INCUMBENT_COMPONENTS, type PredictComponents } from './components';
import { canonicalJson, sha256Hex } from './hash';
import {
  type Insight,
  learnsFrom,
  type Option,
  type PersonState,
  type QKind,
  type QType,
  type Question,
  type StateEvidence,
  type TraitEstimate,
} from './types';

/**
 * What a state holds (PLAN §9.9). `card` (ADR-0056) is the compact one: identity, traits and a capped number of
 * answers chosen by the evidence policy, for transfer to other agents and for measuring how small a state can be.
 */
export type StateStrategy = 'raw' | 'structured' | 'summary' | 'full' | 'card';
export const STATE_STRATEGIES = ['raw', 'structured', 'summary', 'full', 'card'] as const;

/**
 * Which answers are kept once evidence outgrows the budget or the cap (ADR-0056):
 * - `mixed` (the incumbent): the last `recentN`, the `retrievalK` most similar to the targets, and every anchor;
 * - `recent`: the latest answers only;
 * - `similar`: the answers most similar to the target questions only;
 * - `surprise`: the answers the context-only baseline predicted worst, i.e. what the person's profile alone gets
 *   wrong about them (the residual from the stereotype);
 * - `novelty`: the answers the sealed primary predicted worst at the time, i.e. what the earlier answers did not
 *   already imply.
 */
export type EvidencePolicy = 'mixed' | 'recent' | 'similar' | 'surprise' | 'novelty';
export const EVIDENCE_POLICIES = ['mixed', 'recent', 'similar', 'surprise', 'novelty'] as const;

export interface EvidenceItem {
  seq: number;
  questionId: string;
  kind: QKind;
  type: QType;
  prompt: string;
  options: Option[];
  /** The chosen option key. */
  answer: string;
  why?: string | null;
  facetIds: string[];
  /** Time from question shown to answer, for latency hints. */
  latencyMs?: number;
  /**
   * How badly the context-only baseline predicted this answer: its log loss divided by log|options|, in [0, 1]
   * (ADR-0056). Absent without a sealed baseline (repeats, feedback, imported answers).
   */
  surprise?: number;
  /** The same for the sealed primary at the time, on its raw scale: how much the earlier answers failed to imply it. */
  novelty?: number;
}

/** Surprise of an answer from a prediction's log loss on it, normalised by the number of options (ADR-0056). */
export function surpriseOf(logLoss: number, nOptions: number): number {
  return Math.min(1, Math.max(0, logLoss / Math.log(Math.max(2, nOptions))));
}

export interface MimicData {
  mimicId: string;
  identity: { displayName: string; location: string; occupation?: string | null; employer?: string | null };
  facts: Array<{ predicate: string; object: string; userState: 'active' | 'removed' }>;
  evidence: EvidenceItem[];
  traits: TraitEstimate[];
  insights: Insight[];
  /** seq → embedding of that Q&A, for retrieval once evidence outgrows the budget. */
  embeddings?: Map<number, number[]>;
}

export interface BuildOptions {
  /** Sealing boundary (exclusive): only information derived from answers with seq < beforeSeq is included. */
  beforeSeq: number;
  budgetTokens: number;
  strategy: StateStrategy;
  retrievalK: number;
  recentN: number;
  contextOnly?: boolean;
  forQuestions?: Question[];
  queryEmbedding?: number[];
  /** Annotate evidence with `pace` against the person's median latency over the sealed evidence (builder `.v2`). */
  latencyHints?: boolean;
  /** Which answers survive the budget and the cap (ADR-0056); `mixed` when absent. */
  evidencePolicy?: EvidencePolicy;
  /** At most this many answers in the state, whatever the budget (ADR-0056); unlimited when absent. */
  maxEvidence?: number;
}

export const SECTION_BUDGETS = { identity: 600, traits: 500, insights: 800 } as const;
export const WHY_MAX_CHARS = 200;

export function estimateTokens(value: unknown): number {
  return Math.ceil(canonicalJson(value).length / 4);
}

/**
 * Budgeted state builder (PLAN §9.9). Deterministic: the same inputs always give the same stateHash.
 * Sealing (PLAN §3.1) is enforced here: evidence, traits and insights at or after `beforeSeq` never enter.
 */
export function buildState(m: MimicData, opts: BuildOptions): PersonState {
  const identity = buildIdentity(m);
  const policy = opts.evidencePolicy ?? 'mixed';
  const builder = opts.contextOnly
    ? 'context.v1'
    : `${opts.strategy}.${opts.latencyHints ? 'v2' : 'v1'}${policy === 'mixed' ? '' : `.${policy}`}`;
  if (opts.contextOnly) return finalize({ identity, evidence: [] }, builder, 0);

  const includeTraits =
    opts.strategy === 'structured' || opts.strategy === 'full' || opts.strategy === 'card';
  const includeInsights = opts.strategy === 'summary' || opts.strategy === 'full';
  const includeEvidence = opts.strategy === 'raw' || opts.strategy === 'full' || opts.strategy === 'card';
  let seqMax = 0;

  let traits: PersonState['traits'];
  if (includeTraits) {
    const sealed = latestTraits(m.traits.filter((t) => t.seqUpTo < opts.beforeSeq));
    const out: NonNullable<PersonState['traits']> = [];
    for (const t of sealed.sort(
      (a, b) => b.confidence - a.confidence || a.facetId.localeCompare(b.facetId),
    )) {
      const row = { facet: t.facetId, mean: round2(t.mean), confidence: round2(t.confidence) };
      if (estimateTokens([...out, row]) > SECTION_BUDGETS.traits) break;
      out.push(row);
      seqMax = Math.max(seqMax, t.seqUpTo);
    }
    if (out.length) traits = out.sort((a, b) => a.facet.localeCompare(b.facet));
  }

  let insights: PersonState['insights'];
  if (includeInsights) {
    const sealed = m.insights
      .filter((i) => i.seqUpTo < opts.beforeSeq && i.evidenceSeqs.length > 0)
      .filter((i) => i.evidenceSeqs.every((s) => s < opts.beforeSeq))
      .sort((a, b) => b.seqUpTo - a.seqUpTo || b.confidence - a.confidence);
    const out: NonNullable<PersonState['insights']> = [];
    for (const i of sealed) {
      const row = { text: i.text, evidence: [...i.evidenceSeqs].sort((a, b) => a - b) };
      if (estimateTokens([...out, row]) > SECTION_BUDGETS.insights) break;
      out.push(row);
      seqMax = Math.max(seqMax, i.seqUpTo);
    }
    if (out.length) insights = out;
  }

  let evidence: StateEvidence[] = [];
  if (includeEvidence) {
    const eligible = m.evidence
      .filter((e) => e.seq < opts.beforeSeq && learnsFrom(e.kind))
      .sort((a, b) => a.seq - b.seq);
    // The incumbent accounts for the sections alone; a policy fill runs closer to the line, so it also counts the
    // evidence key itself, and the budget then holds exactly (ADR-0056).
    const used =
      policy === 'mixed'
        ? estimateTokens({ identity, traits, insights })
        : estimateTokens({ identity, traits, insights, evidence: [] });
    const remaining = Math.max(0, opts.budgetTokens - used);
    // The median is over every sealed answer, not only the ones that fit the budget, so it is stable as evidence
    // grows and reproducible from an export.
    const median = opts.latencyHints ? latencyMedian(eligible) : null;
    evidence = selectEvidence(eligible, remaining, m, opts, median).map((e) =>
      toStateEvidence(e, { medianLatencyMs: median }),
    );
    for (const e of evidence) seqMax = Math.max(seqMax, e.seq);
  }

  const body: Omit<PersonState, 'meta'> = { identity, evidence };
  if (traits) body.traits = traits;
  if (insights) body.insights = insights;
  return finalize(body, builder, seqMax);
}

function finalize(body: Omit<PersonState, 'meta'>, builder: string, evidenceSeqMax: number): PersonState {
  const stateHash = sha256Hex(canonicalJson(body));
  return { ...body, meta: { evidenceSeqMax, stateHash, builder, tokens: estimateTokens(body) } };
}

function buildIdentity(m: MimicData): Record<string, unknown> {
  const id: Record<string, unknown> = { name: m.identity.displayName, location: m.identity.location };
  if (m.identity.occupation) id.occupation = m.identity.occupation;
  if (m.identity.employer) id.employer = m.identity.employer;
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const f of m.facts) {
    if (f.userState !== 'active') continue; // removed facts never enter any state (PLAN §9.2.5)
    const line = `${f.predicate}: ${f.object}`;
    if (seen.has(line)) continue;
    if (estimateTokens({ ...id, facts: [...facts, line] }) > SECTION_BUDGETS.identity) break;
    seen.add(line);
    facts.push(line);
  }
  if (facts.length) id.facts = facts;
  return id;
}

/** Latest estimate per facet, preferring the Jev read over psychometric scoring. */
function latestTraits(traits: TraitEstimate[]): TraitEstimate[] {
  const by = new Map<string, TraitEstimate>();
  for (const t of traits) {
    const cur = by.get(t.facetId);
    const better =
      !cur ||
      (t.method === 'jev' && cur.method !== 'jev') ||
      (t.method === cur.method && t.seqUpTo > cur.seqUpTo);
    if (better) by.set(t.facetId, t);
  }
  return [...by.values()];
}

function selectEvidence(
  items: EvidenceItem[],
  budget: number,
  m: MimicData,
  opts: BuildOptions,
  medianLatencyMs: number | null,
): EvidenceItem[] {
  // Costed exactly as rendered, pace marks included, so the budget holds with latency hints on.
  const cost = (xs: EvidenceItem[]) => estimateTokens(xs.map((e) => toStateEvidence(e, { medianLatencyMs })));
  const cap = opts.maxEvidence ?? Number.POSITIVE_INFINITY;
  if (cost(items) <= budget && items.length <= cap) return items;

  const policy = opts.evidencePolicy ?? 'mixed';
  if (policy !== 'mixed') {
    // One ranking, then a greedy fill under the cap and the budget, rendered in seq order (ADR-0056).
    const kept: EvidenceItem[] = [];
    for (const e of rankByPolicy(items, policy, m, opts)) {
      if (kept.length >= cap) break;
      if (cost([...kept, e]) > budget) continue;
      kept.push(e);
    }
    return kept.sort((a, b) => a.seq - b.seq);
  }

  // Outgrown the budget: anchors + top-K by similarity to the targets + the last recentN (PLAN §9.9).
  const chosen = new Map<number, EvidenceItem>();
  const recent = items.slice(-opts.recentN);
  for (const e of recent) chosen.set(e.seq, e);
  const ranked = rankBySimilarity(
    items.filter((e) => !chosen.has(e.seq) && e.kind !== 'anchor'),
    m,
    opts,
  );
  for (const e of ranked.slice(0, opts.retrievalK)) chosen.set(e.seq, e);
  for (const e of items.filter((x) => x.kind === 'anchor')) chosen.set(e.seq, e);

  // Priority for trimming if still over budget: recent > retrieved > anchors.
  const priority = [
    ...recent,
    ...ranked.slice(0, opts.retrievalK),
    ...items.filter((x) => x.kind === 'anchor'),
  ];
  const kept: EvidenceItem[] = [];
  const seen = new Set<number>();
  for (const e of priority) {
    if (seen.has(e.seq)) continue;
    if (kept.length >= cap) break;
    if (cost([...kept, e]) > budget) continue;
    seen.add(e.seq);
    kept.push(e);
  }
  return kept.sort((a, b) => a.seq - b.seq);
}

/**
 * The answers in the order a policy keeps them (ADR-0056). Ties, and answers without the policy's signal, fall back
 * to recency, so the ranking is total and deterministic from exported data.
 */
export function rankByPolicy(
  items: EvidenceItem[],
  policy: Exclude<EvidencePolicy, 'mixed'>,
  m: MimicData,
  opts: Pick<BuildOptions, 'forQuestions' | 'queryEmbedding'>,
): EvidenceItem[] {
  const byRecency = (a: EvidenceItem, b: EvidenceItem) => b.seq - a.seq;
  if (policy === 'recent') return [...items].sort(byRecency);
  if (policy === 'similar') return rankBySimilarity(items, m, opts);
  const signal = (e: EvidenceItem) => (policy === 'surprise' ? e.surprise : e.novelty) ?? -1;
  return [...items].sort((a, b) => signal(b) - signal(a) || byRecency(a, b));
}

function rankBySimilarity(
  items: EvidenceItem[],
  m: MimicData,
  opts: Pick<BuildOptions, 'forQuestions' | 'queryEmbedding'>,
): EvidenceItem[] {
  const targets = opts.forQuestions ?? [];
  const scored = items.map((e) => {
    let s = 0;
    const v = m.embeddings?.get(e.seq);
    if (v && opts.queryEmbedding) s = cosine(v, opts.queryEmbedding);
    else if (targets.length) s = Math.max(...targets.map((t) => lexicalSimilarity(t.prompt, e.prompt)));
    return { e, s };
  });
  return scored.sort((a, b) => b.s - a.s || b.e.seq - a.e.seq).map((x) => x.e);
}

/** Median answer latency over the items that carry one; null below LATENCY_MIN_N answers. */
export function latencyMedian(items: EvidenceItem[]): number | null {
  const xs = items.map((e) => e.latencyMs).filter((x): x is number => typeof x === 'number' && x > 0);
  return xs.length >= LATENCY_MIN_N ? medianOf(xs) : null;
}

/**
 * With `opts.medianLatencyMs`, decisive and torn answers are marked (`pace`); even-paced ones carry no mark. The
 * option is an object so that `xs.map(toStateEvidence)`, which passes the index as the second argument, can never
 * inject a median.
 */
export function toStateEvidence(e: EvidenceItem, opts?: { medianLatencyMs: number | null }): StateEvidence {
  const medianLatencyMs = typeof opts === 'object' && opts !== null ? opts.medianLatencyMs : null;
  const label = e.options.find((o) => o.key === e.answer)?.label ?? e.answer;
  const out: StateEvidence = {
    seq: e.seq,
    q: e.prompt,
    type: e.type,
    options: e.options.map((o) => o.label),
    answer: label,
  };
  if (e.why) out.why = e.why.slice(0, WHY_MAX_CHARS);
  if (medianLatencyMs !== null && typeof e.latencyMs === 'number' && e.latencyMs > 0) {
    const pace = paceOf(e.latencyMs, medianLatencyMs);
    if (pace !== 'even') out.pace = pace;
  }
  return out;
}

/**
 * What a predictor is shown of a sealed state (E6, docs/EVIDENCE.md). Each view is a subset of the state, never more,
 * so sealing (invariant 1) holds by construction:
 * - `full`: the state as served;
 * - `context`: identity and sourced facts only, exactly what the context-only baseline sees (same stateHash);
 * - `answers`: identity and the person's answers, without derived traits and insights;
 * - `derived`: identity, traits and insights, without the answers they were derived from;
 * - `relevant`: identity and the RELEVANT_K answers most similar to the question (lexical, ties to the latest).
 */
export const STATE_VIEWS = ['full', 'context', 'answers', 'derived', 'relevant'] as const;
export type StateView = (typeof STATE_VIEWS)[number];
export const RELEVANT_K = 8;

export function viewState(
  state: PersonState,
  view: StateView,
  question?: Pick<Question, 'prompt'>,
): PersonState {
  if (view === 'full') return state;
  let evidence: StateEvidence[] = [];
  if (view === 'answers') evidence = state.evidence;
  if (view === 'relevant') {
    if (!question) throw new Error('The relevant view needs the question it is for');
    evidence = state.evidence
      .map((e) => ({ e, s: lexicalSimilarity(question.prompt, e.q) }))
      .sort((a, b) => b.s - a.s || b.e.seq - a.e.seq)
      .slice(0, RELEVANT_K)
      .map((x) => x.e)
      .sort((a, b) => a.seq - b.seq);
  }
  const body: Omit<PersonState, 'meta'> = { identity: state.identity, evidence };
  if (view === 'derived') {
    if (state.traits) body.traits = state.traits;
    if (state.insights) body.insights = state.insights;
  }
  // Traits carry no seq in a state, so a view that keeps derived data keeps the state's bound; otherwise it is the
  // last answer the view kept. Either way it never exceeds the state's.
  const seqMax =
    view === 'derived'
      ? state.meta.evidenceSeqMax
      : Math.min(state.meta.evidenceSeqMax, Math.max(0, ...evidence.map((e) => e.seq)));
  return finalize(body, view === 'context' ? 'context.v1' : `${state.meta.builder}>${view}`, seqMax);
}

/** What is sent to providers: the state without builder metadata. */
export function stateForProvider(state: PersonState): Omit<PersonState, 'meta'> {
  const { meta: _meta, ...body } = state;
  return body;
}

/** One earlier answer as a line of state text, from the `state.evidence.line` component. */
export function renderEvidenceLine(
  e: StateEvidence,
  template: string = INCUMBENT_COMPONENTS['state.evidence.line'],
): string {
  return fill(template, {
    seq: String(e.seq),
    q: e.q,
    options: e.options.join(' | '),
    answer: e.answer,
    pace: e.pace === 'quick' ? ' (answered quickly)' : e.pace === 'slow' ? ' (took a while)' : '',
    why: e.why ? ` (why: ${e.why})` : '',
  });
}

/** Compact text rendering of a state for LLM prompts. */
export function renderStateText(
  state: Omit<PersonState, 'meta'>,
  c: Pick<PredictComponents, 'state.evidence.line'> = INCUMBENT_COMPONENTS,
): string {
  const lines: string[] = [];
  lines.push('IDENTITY');
  for (const [k, v] of Object.entries(state.identity)) {
    if (Array.isArray(v)) for (const x of v) lines.push(`- ${String(x)}`);
    else lines.push(`${k}: ${String(v)}`);
  }
  if (state.traits?.length) {
    lines.push('', 'TRAITS (mean 0–1, confidence 0–1)');
    for (const t of state.traits) lines.push(`${t.facet}: ${t.mean} (conf ${t.confidence})`);
  }
  if (state.insights?.length) {
    lines.push('', 'INSIGHTS');
    for (const i of state.insights) lines.push(`- ${i.text} [answers ${i.evidence.join(', ')}]`);
  }
  if (state.evidence.length) {
    lines.push('', 'ANSWERS');
    for (const e of state.evidence) lines.push(renderEvidenceLine(e, c['state.evidence.line']));
  }
  return lines.join('\n');
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Jaccard similarity over lowercased word tokens; the fallback when embeddings are unavailable. */
export function lexicalSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((t) => t.length > 2),
  );
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

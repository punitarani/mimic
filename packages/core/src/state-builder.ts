import { canonicalJson, sha256Hex } from './hash';
import type {
  Insight,
  Option,
  PersonState,
  QKind,
  QType,
  Question,
  StateEvidence,
  TraitEstimate,
} from './types';

export type StateStrategy = 'raw' | 'structured' | 'summary' | 'full';

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
  const builder = opts.contextOnly ? 'context.v1' : `${opts.strategy}.v1`;
  if (opts.contextOnly) return finalize({ identity, evidence: [] }, builder, 0);

  const includeTraits = opts.strategy === 'structured' || opts.strategy === 'full';
  const includeInsights = opts.strategy === 'summary' || opts.strategy === 'full';
  const includeEvidence = opts.strategy === 'raw' || opts.strategy === 'full';
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
      .filter((e) => e.seq < opts.beforeSeq && (e.kind === 'anchor' || e.kind === 'adaptive'))
      .sort((a, b) => a.seq - b.seq);
    const used = estimateTokens({ identity, traits, insights });
    const remaining = Math.max(0, opts.budgetTokens - used);
    evidence = selectEvidence(eligible, remaining, m, opts).map(toStateEvidence);
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
): EvidenceItem[] {
  const cost = (xs: EvidenceItem[]) => estimateTokens(xs.map(toStateEvidence));
  if (cost(items) <= budget) return items;

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
    if (cost([...kept, e]) > budget) continue;
    seen.add(e.seq);
    kept.push(e);
  }
  return kept.sort((a, b) => a.seq - b.seq);
}

function rankBySimilarity(items: EvidenceItem[], m: MimicData, opts: BuildOptions): EvidenceItem[] {
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

export function toStateEvidence(e: EvidenceItem): StateEvidence {
  const label = e.options.find((o) => o.key === e.answer)?.label ?? e.answer;
  const out: StateEvidence = {
    seq: e.seq,
    q: e.prompt,
    type: e.type,
    options: e.options.map((o) => o.label),
    answer: label,
  };
  if (e.why) out.why = e.why.slice(0, WHY_MAX_CHARS);
  return out;
}

/** What is sent to providers: the state without builder metadata. */
export function stateForProvider(state: PersonState): Omit<PersonState, 'meta'> {
  const { meta: _meta, ...body } = state;
  return body;
}

/** Compact text rendering of a state for LLM prompts. */
export function renderStateText(state: PersonState): string {
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
    for (const e of state.evidence) {
      lines.push(
        `#${e.seq} ${e.q} [${e.options.join(' | ')}] → ${e.answer}${e.why ? ` (why: ${e.why})` : ''}`,
      );
    }
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

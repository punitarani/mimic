import { z } from 'zod';

export const QType = z.enum(['choice', 'noul', 'score']);
export type QType = z.infer<typeof QType>;
export const QKind = z.enum(['anchor', 'adaptive', 'repeat', 'playground', 'feedback']);
export type QKind = z.infer<typeof QKind>;

/**
 * Kinds whose answers the mimic learns from: they enter sealed states, trait reads and reflection. `feedback` is a
 * question the person wrote and answered themselves on the mimic page, with no prediction (ADR-0032).
 */
export function learnsFrom(kind: QKind): boolean {
  return kind === 'anchor' || kind === 'adaptive' || kind === 'feedback';
}

/** Kinds the session serves. `playground` and `feedback` are written by the person on the mimic page instead. */
export function isSessionKind(kind: QKind): boolean {
  return kind === 'anchor' || kind === 'adaptive' || kind === 'repeat';
}

/** Kinds scored for fidelity, shadows and backfill (PLAN §9.10): the session's new questions. */
export function isScoredKind(kind: QKind): kind is 'anchor' | 'adaptive' {
  return kind === 'anchor' || kind === 'adaptive';
}

/** Kinds served with sealed primary and baseline predictions (PLAN §3.2). Repeats and feedback carry none. */
export function isPredictedKind(kind: QKind): boolean {
  return kind === 'anchor' || kind === 'adaptive' || kind === 'playground';
}
export const Domain = z.enum(['core', 'casual', 'professional']);
export type Domain = z.infer<typeof Domain>;

export const Option = z.object({
  key: z.string().min(1).max(32),
  label: z.string().min(1).max(200),
  description: z.string().max(400).optional(),
});
export type Option = z.infer<typeof Option>;

export const Provenance = z.object({
  generator: z.string(),
  configHash: z.string(),
  promptVersion: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export interface Question {
  id: string;
  mimicId: string;
  seq: number | null; // assigned when served
  kind: QKind;
  type: QType;
  domain: Domain;
  prompt: string;
  options: Option[]; // choice: 2–5; noul: yes/no; score: 5 ordered, low → high
  facetIds: string[];
  repeatOf?: string;
  /** Stable item identifier for cross-person items (anchors, reserve bank), e.g. 'anchors.v1/risk_gamble'. */
  itemKey?: string;
  provenance: Provenance;
}

/** option key → probability, sums to 1. */
export type Distribution = Record<string, number>;

export interface Evidence {
  questionId: string;
  seq: number;
  answer: string;
  why?: string;
  latencyMs: number;
}

export interface Facet {
  id: string;
  group: string;
  name: string;
  low: string;
  high: string;
  /** 5 ordered labels for trait reads, low → high. */
  labels: [string, string, string, string, string];
  /** Present for per-mimic occupation facets. */
  occupation?: boolean;
}

export type TraitMethod = 'jev' | 'psychometric';

export interface TraitEstimate {
  facetId: string;
  method: TraitMethod;
  seqUpTo: number;
  mean: number; // 0..1
  dist: Distribution; // "0".."4"
  confidence: number;
  nEvidence: number;
}

export interface Insight {
  id: string;
  seqUpTo: number;
  text: string;
  facetIds: string[];
  evidenceSeqs: number[];
  confidence: number;
}

export interface StateEvidence {
  seq: number;
  q: string;
  type: QType;
  options: string[];
  answer: string;
  why?: string;
  /**
   * With `stateBuilder.latencyHints`: 'quick' when answered in under half the person's median latency (a decisive
   * answer), 'slow' when over twice it (a torn one). Docs/SELECTION.md §8.
   */
  pace?: 'quick' | 'slow';
}

export interface PersonState {
  identity: Record<string, unknown>;
  traits?: Array<{ facet: string; mean: number; confidence: number }>;
  insights?: Array<{ text: string; evidence: number[] }>;
  evidence: StateEvidence[];
  /** BALD only: one persona hypothesis added on top of the sealed state. */
  hypothesis?: string;
  meta: { evidenceSeqMax: number; stateHash: string; builder: string; tokens: number };
}

export type PredictionErrorKind = 'transport' | 'output' | 'timeout';

export interface PredictionResult {
  dist: Distribution;
  confidence?: number;
  costUsd: number;
  latencyMs: number;
  modelSnapshot: string;
  ok: boolean;
  error?: string;
  /**
   * Why it failed (set on failures only; stored with the prediction, ADR-0034):
   * - `output`: the model answered but the answer was unusable (the prompt's or model's fault);
   * - `timeout`: the model didn't answer within the call's timeout (too slow; the model's failure, never redone);
   * - `transport`: the call failed before the model answered (provider error, rate limit, network, budget guard).
   */
  errorKind?: PredictionErrorKind;
  /** `transport` only: the call may succeed if retried later (a transient status or network error). */
  retryable?: boolean;
  /** Raw model output (LLM only, truncated). Kept in memory for eval traces; never persisted with the prediction. */
  raw?: string;
}

export interface Predictor {
  id: string; // 'jev:typesafe/jev-1.13', 'llm:openai/gpt-6-luna', …
  predict(state: PersonState, qs: Question[]): Promise<PredictionResult[]>;
}

// ---------- Decision provider (Jev now, OpenAI Decisions later) ----------

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface DecisionRequest {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence?: number; probabilities: Record<string, number> };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DecisionResponse {
  modelSnapshot: string;
  answers: Record<string, DecisionAnswer>;
  usage: Usage;
  /** The attempt that returned this response, excluding earlier failed attempts and retry backoff. */
  latencyMs: number;
  /** HTTP attempts it took (1 unless an earlier one got a transient error). */
  attempts?: number;
  raw: unknown;
}

export interface DecisionProvider {
  readonly provider: string;
  decide(req: DecisionRequest): Promise<DecisionResponse>;
}

// ---------- LLM chat ----------

export type ReasoningEffort = 'none' | 'low' | 'medium';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  modelSnapshot: string;
  provider?: string;
  /** Why generation stopped, as the provider reports it: 'stop', 'length' (hit maxTokens), ... */
  finishReason?: string;
  usage: Usage;
  /** The attempt that returned this response, excluding earlier failed attempts and retry backoff. */
  latencyMs: number;
  /** HTTP attempts it took (1 unless an earlier one got a transient error). */
  attempts?: number;
  raw: unknown;
}

export interface LlmClient {
  readonly provider: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---------- Search / enrichment / embeddings ----------

export interface PersonCandidate {
  provider: string;
  name: string;
  headline?: string;
  location?: string;
  url: string;
  summary: string;
}

export interface PeopleSearchResult {
  candidates: PersonCandidate[];
  costUsd: number;
  latencyMs: number;
  raw: unknown;
}

export interface PeopleSearch {
  readonly provider: string;
  search(query: string, opts: { numResults: number }): Promise<PeopleSearchResult>;
  /** Resolves a profile URL the person gave into a candidate (none if the page can't be read). */
  lookup?(url: string): Promise<PeopleSearchResult>;
}

export interface EnrichedFact {
  predicate: string;
  object: string;
  sourceUrl?: string;
  confidence: number;
}

export interface EnrichmentResult {
  facts: EnrichedFact[];
  costUsd: number;
  latencyMs: number;
  raw: unknown;
}

export interface Enricher {
  readonly provider: string;
  enrich(subject: {
    name: string;
    location: string;
    url: string;
    occupation?: string;
    employer?: string;
  }): Promise<EnrichmentResult>;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  usage: Usage;
  latencyMs: number;
  attempts?: number;
}

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

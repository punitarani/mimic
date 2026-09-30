import type { FidelityState } from './fidelity';
import type { PersonaCuration, PersonaDraft } from './persona';
import type {
  Distribution,
  Facet,
  Insight,
  PredictionErrorKind,
  QKind,
  Question,
  TraitEstimate,
} from './types';

export type MimicStatus = 'intake' | 'identity' | 'learning' | 'paused' | 'archived';
/** ADR-0007: sub-state of identity resolution, so the UI can show progress. */
export type IdentityState =
  | 'skipped'
  | 'searching'
  | 'candidates'
  | 'none_found'
  | 'enriching'
  | 'review'
  | 'done';
export type QuestionStatus = 'pooled' | 'served' | 'answered' | 'discarded';
export type PredictionRole = 'primary' | 'baseline' | 'shadow' | 'hypothesis';
export type FactSource = 'intake' | 'search' | 'answer' | 'reflection';

export interface MimicRecord {
  id: string;
  participantId: string;
  displayName: string;
  location: string;
  occupation: string | null;
  employer: string | null;
  links: string[];
  status: MimicStatus;
  identityState: IdentityState;
  configHash: string;
  experimentId: string | null;
  arm: string | null;
  consentApp: boolean;
  consentSearch: boolean;
  consentResearch: boolean;
  split: 'dev' | 'test';
  seqMax: number;
  snapshotVersion: number;
  spendUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface QuestionRecord extends Question {
  status: QuestionStatus;
  quality: Record<string, unknown> | null;
  createdAt: number;
  servedAt: number | null;
  /** As-of time of the derived data in this question's sealed states; replay rebuilds them from it (ADR-0017). */
  stateAt: number | null;
  /** The selector's diagnostics for the winning score, written when served (ADR-0027). */
  selection?: Record<string, unknown> | null;
}

export interface PredictionRecord {
  id: string;
  questionId: string;
  mimicId: string;
  predictorId: string;
  role: PredictionRole;
  dist: Distribution;
  confidence: number | null;
  stateHash: string;
  evidenceSeqMax: number;
  configHash: string;
  promptVersion: string;
  modelSnapshot: string;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  /** Failed predictions only: `output`, `timeout` (the model's) or `transport` (the call's); ADR-0034. */
  errorKind?: PredictionErrorKind | null;
  /** True when the primary came from the LLM fallback because Jev errored (PLAN §16). */
  fallback: boolean;
  /** `role = hypothesis` only: `{hypothesis set seqUpTo}:{index}` (docs/SELECTION.md §6). */
  hypothesis?: string | null;
  createdAt: number;
}

export interface AnswerRecord {
  id: string;
  questionId: string;
  mimicId: string;
  seq: number;
  value: string;
  why: string | null;
  latencyMs: number;
  /** Whether the mimic's guess was revealed after this answer (reveal is an experiment variable). */
  revealedPrediction: boolean;
  idempotencyKey: string;
  createdAt: number;
}

export interface ScoreRecord {
  predictionId: string;
  answerId: string;
  top1: number;
  itemAcc: number;
  logLoss: number;
  brier: number;
  createdAt: number;
}

export interface FactRecord {
  id: string;
  mimicId: string;
  predicate: string;
  object: string;
  source: FactSource;
  sourceRef: string | null;
  sourceUrl: string | null;
  confidence: number;
  userState: 'active' | 'removed';
  createdAt: number;
  /** When userState last changed (null = never). */
  userStateAt: number | null;
}

export interface CandidateRecord {
  id: string;
  mimicId: string;
  provider: string;
  rank: number;
  name: string;
  headline: string | null;
  location: string | null;
  url: string;
  summary: string;
  jevSamePersonP: number | null;
  r2Key: string | null;
  /** `superseded`: set aside by a newer search, not judged by the person (ADR-0029). */
  status: CandidateStatus;
  createdAt: number;
}

export type CandidateStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded';

export interface TraitRecord extends TraitEstimate {
  mimicId: string;
  configHash: string;
  modelSnapshot: string | null;
  createdAt: number;
}

export interface InsightRecord extends Insight {
  mimicId: string;
  model: string;
  promptVersion: string;
  status: 'active' | 'superseded' | 'user_rejected';
  createdAt: number;
  /** When status left `active` (null = still active). */
  statusChangedAt: number | null;
}

export type KgNodeType = 'Person' | 'Organization' | 'Place' | 'Occupation' | 'Skill' | 'Interest' | 'Facet';

export interface KgNodeRecord {
  id: string;
  mimicId: string;
  type: KgNodeType;
  label: string;
  props: Record<string, unknown>;
  source: string;
  createdAt: number;
}

export interface KgEdgeRecord {
  id: string;
  mimicId: string;
  src: string;
  dst: string;
  predicate: string;
  weight: number;
  source: string;
  sourceRef: string | null;
  createdAt: number;
}

export interface FidelityRecord {
  mimicId: string;
  seqUpTo: number;
  acc: number;
  accBaseline: number | null;
  selfConsistency: number;
  fidelity: number;
  ciLow: number;
  ciHigh: number;
  nScored: number;
  nRepeats: number;
  state: FidelityState;
  createdAt: number;
}

export interface SnapshotRecord {
  mimicId: string;
  version: number;
  r2Key: string;
  seqUpTo: number;
  createdAt: number;
}

/** A `persona.v1` draft (ADR-0033): derived from the evidence up to `seqUpTo`, versioned, recomputable. */
export interface PersonaDraftRecord {
  id: string;
  mimicId: string;
  seqUpTo: number;
  configHash: string;
  promptVersion: string;
  model: string;
  modelSnapshot: string;
  draft: PersonaDraft;
  createdAt: number;
}

/** The person's choices for Persona.md: one row per mimic. */
export interface PersonaCurationRecord {
  mimicId: string;
  curation: PersonaCuration;
  /** The client's revision of this curation; a save with a lower or equal rev never overwrites a newer one. */
  rev: number;
  updatedAt: number;
}

export interface ConfigRecord {
  hash: string;
  json: string;
  label: string | null;
  createdAt: number;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'stopped';
  arms: Array<{ arm: string; configHash: string; weight: number }>;
  createdAt: number;
}

export interface EvalRunRecord {
  id: string;
  name: string;
  spec: Record<string, unknown>;
  datasetHash: string;
  status: 'running' | 'done' | 'failed';
  metrics: Record<string, unknown> | null;
  r2ReportKey: string | null;
  createdAt: number;
}

export interface JobRecord {
  key: string;
  type: string;
  /**
   * `queued`: enqueued to run at `updatedAt` (a paced backfill, ADR-0034), so a re-run knows it's in flight; a
   * queued job still not done 15 minutes after its time is stale and the cron requeues it.
   */
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  updatedAt: number;
}

export interface MimicFacetRecord {
  mimicId: string;
  facet: Facet;
  source: string;
  createdAt: number;
}

export interface ScoredPredictionRow {
  prediction: PredictionRecord;
  score: ScoreRecord;
  question: Pick<QuestionRecord, 'id' | 'kind' | 'type' | 'seq' | 'itemKey'>;
}

/** One scored primary or baseline with what the item statistics need (ADR-0027). */
export interface ScoredItemSource {
  mimicId: string;
  questionId: string;
  role: 'primary' | 'baseline';
  fallback: boolean;
  itemAcc: number;
  logLoss: number;
  question: Pick<QuestionRecord, 'kind' | 'type' | 'domain' | 'facetIds' | 'options' | 'itemKey'>;
  answer: { value: string; latencyMs: number };
}

/** Persistence port used by the engine. Implemented with Drizzle over D1 (Workers) and libSQL (Node CLI). */
export interface Store {
  // participants
  ensureParticipant(id: string, now: number): Promise<void>;
  // configs & experiments
  putConfig(rec: ConfigRecord): Promise<void>;
  getConfig(hash: string): Promise<ConfigRecord | null>;
  listConfigs(): Promise<ConfigRecord[]>;
  putExperiment(rec: ExperimentRecord): Promise<void>;
  listExperiments(): Promise<ExperimentRecord[]>;
  // mimics
  insertMimic(rec: MimicRecord): Promise<void>;
  getMimic(id: string): Promise<MimicRecord | null>;
  listMimics(filter: { participantId?: string; consentResearch?: boolean }): Promise<MimicRecord[]>;
  updateMimic(id: string, patch: Partial<Omit<MimicRecord, 'id'>>): Promise<void>;
  addSpend(id: string, usd: number): Promise<void>;
  /** Removes every row for the mimic across all tables. */
  deleteMimic(id: string): Promise<void>;
  /**
   * Applies the patch only if the mimic's identity state is one of `from`, in one statement. False when it isn't,
   * for example because a concurrent request moved it first.
   */
  transitionIdentity(
    id: string,
    from: readonly IdentityState[],
    patch: Partial<Omit<MimicRecord, 'id'>>,
  ): Promise<boolean>;
  // identity
  insertCandidates(recs: CandidateRecord[]): Promise<void>;
  listCandidates(mimicId: string): Promise<CandidateRecord[]>;
  /** Sets the status of the mimic's candidates with these IDs. */
  setCandidateStatus(mimicId: string, ids: readonly string[], status: CandidateStatus): Promise<void>;
  insertFacts(recs: FactRecord[]): Promise<void>;
  listFacts(mimicId: string): Promise<FactRecord[]>;
  updateFact(
    mimicId: string,
    id: string,
    patch: Pick<FactRecord, 'userState' | 'userStateAt'>,
  ): Promise<boolean>;
  // questions
  insertQuestions(recs: QuestionRecord[]): Promise<void>;
  getQuestion(id: string): Promise<QuestionRecord | null>;
  listQuestions(mimicId: string, status?: QuestionStatus[], kinds?: QKind[]): Promise<QuestionRecord[]>;
  updateQuestionStatus(id: string, status: QuestionStatus): Promise<void>;
  /**
   * Atomically marks a question served at `seq` and persists its sealed predictions (PLAN §3.2). Returns false
   * if `seq` was already taken (a concurrent serve won).
   */
  serveQuestion(args: {
    questionId: string;
    mimicId: string;
    seq: number;
    servedAt: number;
    stateAt: number | null;
    predictions: PredictionRecord[];
    selection?: Record<string, unknown> | null;
  }): Promise<boolean>;
  // predictions & answers
  insertPredictions(recs: PredictionRecord[]): Promise<void>;
  /**
   * Stores one shadow unless this question already has one from this predictor (a unique index, so concurrent runs
   * can't both insert), first deleting `replaceIds` if they are failed shadows (a backfill redoing a failed call,
   * ADR-0034). Primary and baseline rows are never deleted. True if `rec` was stored.
   */
  insertShadow(rec: PredictionRecord, replaceIds?: string[]): Promise<boolean>;
  listPredictions(filter: {
    mimicId?: string;
    questionId?: string;
    roles?: PredictionRole[];
  }): Promise<PredictionRecord[]>;
  getAnswerByIdempotencyKey(key: string): Promise<AnswerRecord | null>;
  getAnswerForQuestion(questionId: string): Promise<AnswerRecord | null>;
  listAnswers(mimicId: string): Promise<AnswerRecord[]>;
  /**
   * Atomically stores the answer, marks the question answered and writes the scores. Returns false, writing
   * nothing, if the answer's seq or idempotency key is already taken (the question moved, or a duplicate raced).
   */
  recordAnswer(args: { answer: AnswerRecord; scores: ScoreRecord[] }): Promise<boolean>;
  /**
   * Atomically inserts a question the person wrote and answered themselves (`kind = feedback`, ADR-0032) at
   * `answer.seq`, with its answer, and advances the mimic's `seqMax`. With `move`, the served session question at
   * that seq first moves to `move.toSeq`, so it is answered after the feedback. Returns false, writing nothing, if a
   * seq was already taken, the moved question was answered meanwhile, or the idempotency key was used.
   */
  recordFeedback(args: {
    question: QuestionRecord;
    answer: AnswerRecord;
    move?: { questionId: string; toSeq: number };
  }): Promise<boolean>;
  insertScores(recs: ScoreRecord[]): Promise<void>;
  listScoredPredictions(mimicId: string, roles: PredictionRole[]): Promise<ScoredPredictionRow[]>;
  // derived state
  listTraits(mimicId: string): Promise<TraitRecord[]>;
  listTraitHistory(mimicId: string): Promise<TraitRecord[]>;
  /**
   * The estimates as they stood at `at`, sealed below `beforeSeq`: per facet and method, the history row with the
   * highest seqUpTo, first write winning ties (the same rule as the monotonic upsert).
   */
  listTraitsAsOf(mimicId: string, at: number, beforeSeq: number): Promise<TraitRecord[]>;
  /** Monotonic: only writes estimates whose seqUpTo is greater than the stored one. Always appends history. */
  upsertTraits(recs: TraitRecord[]): Promise<number>;
  listInsights(mimicId: string): Promise<InsightRecord[]>;
  insertInsights(recs: InsightRecord[]): Promise<void>;
  updateInsightStatus(id: string, status: InsightRecord['status'], at: number): Promise<void>;
  listKg(mimicId: string): Promise<{ nodes: KgNodeRecord[]; edges: KgEdgeRecord[] }>;
  insertKg(nodes: KgNodeRecord[], edges: KgEdgeRecord[]): Promise<void>;
  insertFidelity(rec: FidelityRecord): Promise<void>;
  listFidelity(mimicId: string): Promise<FidelityRecord[]>;
  insertSnapshot(rec: SnapshotRecord): Promise<void>;
  listSnapshots(mimicId: string): Promise<SnapshotRecord[]>;
  listMimicFacets(mimicId: string): Promise<MimicFacetRecord[]>;
  // Persona.md (ADR-0033)
  insertPersonaDraft(rec: PersonaDraftRecord): Promise<void>;
  latestPersonaDraft(mimicId: string): Promise<PersonaDraftRecord | null>;
  getPersonaCuration(mimicId: string): Promise<PersonaCurationRecord | null>;
  /** Writes only if `rec.rev` is newer than the stored rev; returns whether it wrote. */
  putPersonaCuration(rec: PersonaCurationRecord): Promise<boolean>;
  insertMimicFacets(recs: MimicFacetRecord[]): Promise<void>;
  // cross-person item statistics (aggregate only; ADR-0027)
  /** Every scored primary and baseline of the matching mimics' anchor and adaptive questions, in one query. */
  listScoredForStats(filter: {
    consentResearch: boolean;
    split: 'dev' | 'test';
  }): Promise<ScoredItemSource[]>;
  /** Replaces the whole table atomically, so keys absent from `recs` are removed. */
  replaceItemStats(recs: import('./population').ItemStatRecord[]): Promise<void>;
  listItemStats(): Promise<import('./population').ItemStatRecord[]>;
  // jobs ledger
  getJob(key: string): Promise<JobRecord | null>;
  putJob(rec: JobRecord): Promise<void>;
  /** Upserts many ledger rows in few statements. */
  putJobs(recs: JobRecord[]): Promise<void>;
  /** Ledger rows whose key starts with `prefix` (e.g. every shadow job of one mimic). */
  listJobs(prefix: string): Promise<JobRecord[]>;
  /** Jobs not done whose last update is older than `before`. */
  listStaleJobs(before: number, limit: number): Promise<JobRecord[]>;
  // observability
  insertModelCall(rec: import('./gateway').ModelCallRecord): Promise<void>;
  listModelCalls(filter: {
    mimicId?: string;
    since?: number;
    limit?: number;
  }): Promise<import('./gateway').ModelCallRecord[]>;
  // evals
  putEvalRun(rec: EvalRunRecord): Promise<void>;
  listEvalRuns(): Promise<EvalRunRecord[]>;
}

export interface BlobStore {
  put(key: string, body: string, contentType?: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: { mimicId: string; kind: 'qa' | 'fact' | 'question'; facetIds: string; seq: number };
}

export interface VectorIndex {
  upsert(recs: VectorRecord[]): Promise<void>;
  getByIds(ids: string[]): Promise<VectorRecord[]>;
  query(
    values: number[],
    opts: { mimicId: string; kind?: VectorRecord['metadata']['kind']; topK: number },
  ): Promise<Array<{ id: string; score: number }>>;
  deleteByIds(ids: string[]): Promise<void>;
}

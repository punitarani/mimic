import {
  type AnswerRecord,
  type AnswerRewindRecord,
  type CandidateRecord,
  type CandidateStatus,
  type ConfigRecord,
  type DerivedRollback,
  type EvalRunRecord,
  type ExperimentRecord,
  type FactRecord,
  type FidelityRecord,
  type IdentityState,
  type InsightRecord,
  type ItemStatRecord,
  type JobRecord,
  type KgEdgeRecord,
  type KgNodeRecord,
  type MimicFacetRecord,
  type MimicRecord,
  type ModelCallRecord,
  Option,
  PersonaCuration,
  type PersonaCurationRecord,
  PersonaDraft,
  type PersonaDraftRecord,
  type PredictionRecord,
  type PredictionRole,
  type QKind,
  type QuestionRecord,
  type QuestionStatus,
  type ScoredItemSource,
  type ScoredPredictionRow,
  type ScoreRecord,
  SESSION_KINDS,
  type SnapshotRecord,
  StaleEvidenceError,
  type Store,
  type TraitRecord,
} from '@mimic/core';
import type { SQL } from 'drizzle-orm';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import * as s from './schema';

type Schema = typeof s;
/** D1 (Workers) and libSQL (Node) drizzle databases both satisfy this: async + atomic batch. */
export type MimicDb = BaseSQLiteDatabase<'async', unknown, Schema> & {
  batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>;
};

/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 100;

function chunk<T>(rows: T[], cols: number): T[][] {
  const size = Math.max(1, Math.floor(MAX_PARAMS / cols));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function parse<T>(schema: z.ZodType<T>, text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  const r = schema.safeParse(JSON.parse(text));
  if (!r.success) throw new Error(`Invalid JSON column: ${r.error.message}`);
  return r.data;
}

const Dist = z.record(z.string(), z.number());
const StrArr = z.array(z.string());
const IntArr = z.array(z.number().int());
const Options = z.array(Option);
const Obj = z.record(z.string(), z.unknown());
const Arms = z.array(z.object({ arm: z.string(), configHash: z.string(), weight: z.number() }));

type QRow = typeof s.questions.$inferSelect;
type PRow = typeof s.predictions.$inferSelect;
type MRow = typeof s.mimics.$inferSelect;
type TRow = typeof s.traitEstimates.$inferSelect;

/** A MimicRecord patch as column values (`links` is stored as JSON). */
function mimicPatch(patch: Partial<Omit<MimicRecord, 'id'>>): Partial<typeof s.mimics.$inferInsert> {
  const { links, ...rest } = patch;
  const set: Partial<typeof s.mimics.$inferInsert> = { ...rest };
  if (links) set.linksJson = JSON.stringify(links);
  return set;
}

const toMimic = (r: MRow): MimicRecord => ({
  id: r.id,
  participantId: r.participantId,
  displayName: r.displayName,
  location: r.location,
  occupation: r.occupation,
  employer: r.employer,
  links: parse(StrArr, r.linksJson, []),
  status: r.status,
  identityState: r.identityState,
  configHash: r.configHash,
  experimentId: r.experimentId,
  arm: r.arm,
  consentApp: r.consentApp,
  consentSearch: r.consentSearch,
  consentResearch: r.consentResearch,
  split: r.split,
  seqMax: r.seqMax,
  evidenceEpoch: r.evidenceEpoch,
  snapshotVersion: r.snapshotVersion,
  spendUsd: r.spendUsd,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** A write lost a race on a unique index (seq, idempotency key or primary key); D1 and libSQL word it alike. */
function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as { cause?: unknown }).cause ?? e));
}

/**
 * A batch guard fired. Guards set a NOT NULL column from a subquery that is NULL when the condition fails, which
 * aborts the whole batch (a D1 batch is one transaction) with no trigger and no extra round trip (ADR-0036).
 */
function isGuardViolation(e: unknown, column: string): boolean {
  return String((e as { cause?: unknown }).cause ?? e).includes(`NOT NULL constraint failed: ${column}`);
}

/** Session kinds as SQL values, from the same list as `isSessionKind`. */
const SESSION_KIND_LIST = [...SESSION_KINDS];

const toQuestion = (r: QRow): QuestionRecord => {
  const q: QuestionRecord = {
    id: r.id,
    mimicId: r.mimicId,
    seq: r.seq,
    kind: r.kind,
    type: r.type,
    domain: r.domain,
    prompt: r.prompt,
    options: parse(Options, r.optionsJson, []),
    facetIds: parse(StrArr, r.facetIdsJson, []),
    provenance: { generator: r.generator, configHash: r.configHash, promptVersion: r.promptVersion },
    status: r.status,
    quality: parse(Obj, r.qualityJson, null as Record<string, unknown> | null),
    createdAt: r.createdAt,
    servedAt: r.servedAt,
    stateAt: r.stateAt,
  };
  if (r.repeatOf) q.repeatOf = r.repeatOf;
  if (r.itemKey) q.itemKey = r.itemKey;
  if (r.selectionJson) q.selection = parse(Obj, r.selectionJson, null as Record<string, unknown> | null);
  return q;
};

const fromQuestion = (q: QuestionRecord): typeof s.questions.$inferInsert => ({
  id: q.id,
  mimicId: q.mimicId,
  seq: q.seq,
  kind: q.kind,
  type: q.type,
  domain: q.domain,
  prompt: q.prompt,
  optionsJson: JSON.stringify(q.options),
  facetIdsJson: JSON.stringify(q.facetIds),
  repeatOf: q.repeatOf ?? null,
  itemKey: q.itemKey ?? null,
  status: q.status,
  configHash: q.provenance.configHash,
  promptVersion: q.provenance.promptVersion,
  generator: q.provenance.generator,
  qualityJson: q.quality ? JSON.stringify(q.quality) : null,
  createdAt: q.createdAt,
  servedAt: q.servedAt,
  stateAt: q.stateAt,
  selectionJson: q.selection ? JSON.stringify(q.selection) : null,
});

const toPrediction = (r: PRow): PredictionRecord => ({
  id: r.id,
  questionId: r.questionId,
  mimicId: r.mimicId,
  predictorId: r.predictorId,
  role: r.role,
  dist: parse(Dist, r.distJson, {}),
  confidence: r.confidence,
  stateHash: r.stateHash,
  evidenceSeqMax: r.evidenceSeqMax,
  configHash: r.configHash,
  promptVersion: r.promptVersion,
  modelSnapshot: r.modelSnapshot,
  costUsd: r.costUsd,
  latencyMs: r.latencyMs,
  ok: r.ok,
  error: r.error,
  fallback: r.fallback,
  hypothesis: r.hypothesis,
  createdAt: r.createdAt,
});

/** 20 columns per row (D1's 100-parameter limit bounds the batch size below). */
const PREDICTION_COLS = 20;
const fromPrediction = (p: PredictionRecord): typeof s.predictions.$inferInsert => ({
  ...p,
  hypothesis: p.hypothesis ?? null,
  distJson: JSON.stringify(p.dist),
});

const toTrait = (r: TRow): TraitRecord => ({
  mimicId: r.mimicId,
  facetId: r.facetId,
  method: r.method,
  seqUpTo: r.seqUpTo,
  mean: r.mean,
  dist: parse(Dist, r.distJson, {}),
  confidence: r.confidence,
  nEvidence: r.nEvidence,
  configHash: r.configHash,
  modelSnapshot: r.modelSnapshot,
  createdAt: r.createdAt,
});

const fromTrait = (t: TraitRecord) => ({
  mimicId: t.mimicId,
  facetId: t.facetId,
  method: t.method,
  seqUpTo: t.seqUpTo,
  mean: t.mean,
  distJson: JSON.stringify(t.dist),
  confidence: t.confidence,
  nEvidence: t.nEvidence,
  configHash: t.configHash,
  modelSnapshot: t.modelSnapshot,
  createdAt: t.createdAt,
});

const toAnswer = (r: typeof s.answers.$inferSelect): AnswerRecord => ({ ...r });
const toRewind = (r: typeof s.answerRewinds.$inferSelect): AnswerRewindRecord => ({ ...r });

type Batch = [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];

/** Splits an IN list so no statement binds more than D1's 100 parameters (a few are left for the other terms). */
function idChunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_PARAMS - 5) out.push(ids.slice(i, i + MAX_PARAMS - 5));
  return out;
}

export class DrizzleStore implements Store {
  constructor(
    readonly db: MimicDb,
    private readonly epoch: { mimicId: string; epoch: number } | null = null,
  ) {}

  guarded(mimicId: string, epoch: number): Store {
    return new DrizzleStore(this.db, { mimicId, epoch });
  }

  /**
   * Sets the mimic's `updated_at` to itself, or to NULL (aborting the batch) when `evidence_epoch` moved on
   * (ADR-0036). The subquery aliases the table so it reads the stored row, not the one being updated.
   */
  private epochGuard(mimicId: string, epoch: number) {
    return this.db
      .update(s.mimics)
      .set({
        updatedAt: sql`(select g.updated_at from mimics g where g.id = ${mimicId} and g.evidence_epoch = ${epoch})`,
      })
      .where(eq(s.mimics.id, mimicId));
  }

  /**
   * Runs statements as one batch, behind the epoch guard when this store is guarded. Returns each statement's
   * result (the guard's is dropped).
   */
  private async write(stmts: BatchItem<'sqlite'>[]): Promise<unknown[]> {
    if (!stmts.length) return [];
    if (!this.epoch) return this.db.batch(stmts as Batch);
    try {
      const res = await this.db.batch([
        this.epochGuard(this.epoch.mimicId, this.epoch.epoch),
        ...stmts,
      ] as Batch);
      return res.slice(1);
    } catch (e) {
      if (isGuardViolation(e, 'mimics.updated_at')) throw new StaleEvidenceError();
      throw e;
    }
  }

  /** Insert statements for `rows`, chunked by their column count to stay under D1's parameter limit. */
  private inserts<T extends object>(
    table: Parameters<MimicDb['insert']>[0],
    rows: T[],
  ): BatchItem<'sqlite'>[] {
    if (!rows.length) return [];
    const cols = Object.keys(rows[0]!).length;
    return chunk(rows, cols).map((part) => this.db.insert(table).values(part as never));
  }

  private async insertChunked<T extends object>(
    table: Parameters<MimicDb['insert']>[0],
    rows: T[],
  ): Promise<void> {
    await this.write(this.inserts(table, rows));
  }

  // participants
  async ensureParticipant(id: string, now: number) {
    await this.db.insert(s.participants).values({ id, createdAt: now }).onConflictDoNothing();
  }

  // configs & experiments
  async putConfig(rec: ConfigRecord) {
    await this.db.insert(s.configs).values(rec).onConflictDoNothing();
  }
  async getConfig(hash: string) {
    return (await this.db.select().from(s.configs).where(eq(s.configs.hash, hash)).get()) ?? null;
  }
  async listConfigs() {
    return this.db.select().from(s.configs).orderBy(asc(s.configs.createdAt)).all();
  }
  async putExperiment(rec: ExperimentRecord) {
    const row = {
      id: rec.id,
      name: rec.name,
      status: rec.status,
      armsJson: JSON.stringify(rec.arms),
      createdAt: rec.createdAt,
    };
    await this.db
      .insert(s.experiments)
      .values(row)
      .onConflictDoUpdate({
        target: s.experiments.id,
        set: { name: row.name, status: row.status, armsJson: row.armsJson },
      });
  }
  async listExperiments(): Promise<ExperimentRecord[]> {
    const rows = await this.db.select().from(s.experiments).orderBy(asc(s.experiments.createdAt)).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      arms: parse(Arms, r.armsJson, []),
      createdAt: r.createdAt,
    }));
  }

  // mimics
  async insertMimic(m: MimicRecord) {
    const { links, ...rest } = m;
    await this.db.insert(s.mimics).values({ ...rest, linksJson: JSON.stringify(links) });
  }
  async getMimic(id: string) {
    const r = await this.db.select().from(s.mimics).where(eq(s.mimics.id, id)).get();
    return r ? toMimic(r) : null;
  }
  async listMimics(filter: { participantId?: string; consentResearch?: boolean }) {
    const conds = [];
    if (filter.participantId) conds.push(eq(s.mimics.participantId, filter.participantId));
    if (filter.consentResearch !== undefined)
      conds.push(eq(s.mimics.consentResearch, filter.consentResearch));
    const rows = await this.db
      .select()
      .from(s.mimics)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(s.mimics.createdAt))
      .all();
    return rows.map(toMimic);
  }
  async updateMimic(id: string, patch: Partial<Omit<MimicRecord, 'id'>>) {
    const set = mimicPatch(patch);
    if (Object.keys(set).length) await this.db.update(s.mimics).set(set).where(eq(s.mimics.id, id));
  }
  async transitionIdentity(
    id: string,
    from: readonly IdentityState[],
    patch: Partial<Omit<MimicRecord, 'id'>>,
  ) {
    const r = await this.db
      .update(s.mimics)
      .set(mimicPatch(patch))
      .where(and(eq(s.mimics.id, id), inArray(s.mimics.identityState, [...from])))
      .returning({ id: s.mimics.id });
    return r.length > 0;
  }
  async addSpend(id: string, usd: number) {
    await this.db
      .update(s.mimics)
      .set({ spendUsd: sql`${s.mimics.spendUsd} + ${usd}` })
      .where(eq(s.mimics.id, id));
  }
  async deleteMimic(id: string) {
    const stmts = [
      ...s.MIMIC_TABLES.map((t) => this.db.delete(t).where(eq(t.mimicId, id))),
      this.db.delete(s.jobs).where(like(s.jobs.key, `%:${id}%`)),
      this.db.delete(s.mimics).where(eq(s.mimics.id, id)),
    ];
    await this.db.batch(stmts as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  }

  // identity
  async insertCandidates(recs: CandidateRecord[]) {
    await this.insertChunked(s.identityCandidates, recs);
  }
  async listCandidates(mimicId: string) {
    return this.db
      .select()
      .from(s.identityCandidates)
      .where(eq(s.identityCandidates.mimicId, mimicId))
      .orderBy(asc(s.identityCandidates.rank))
      .all();
  }
  async setCandidateStatus(mimicId: string, ids: readonly string[], status: CandidateStatus) {
    for (let i = 0; i < ids.length; i += 90) {
      await this.db
        .update(s.identityCandidates)
        .set({ status })
        .where(
          and(
            eq(s.identityCandidates.mimicId, mimicId),
            inArray(s.identityCandidates.id, ids.slice(i, i + 90)),
          ),
        );
    }
  }
  async insertFacts(recs: FactRecord[]) {
    await this.insertChunked(s.facts, recs);
  }
  async listFacts(mimicId: string) {
    return this.db
      .select()
      .from(s.facts)
      .where(eq(s.facts.mimicId, mimicId))
      .orderBy(asc(s.facts.createdAt))
      .all();
  }
  async updateFact(mimicId: string, id: string, patch: Pick<FactRecord, 'userState' | 'userStateAt'>) {
    const r = await this.db
      .update(s.facts)
      .set(patch)
      .where(and(eq(s.facts.id, id), eq(s.facts.mimicId, mimicId)))
      .returning({ id: s.facts.id });
    return r.length > 0;
  }

  // questions
  async insertQuestions(recs: QuestionRecord[]) {
    await this.insertChunked(s.questions, recs.map(fromQuestion));
  }
  async getQuestion(id: string) {
    const r = await this.db.select().from(s.questions).where(eq(s.questions.id, id)).get();
    return r ? toQuestion(r) : null;
  }
  async listQuestions(mimicId: string, status?: QuestionStatus[], kinds?: QKind[]) {
    const rows = await this.db
      .select()
      .from(s.questions)
      .where(
        and(
          eq(s.questions.mimicId, mimicId),
          status?.length ? inArray(s.questions.status, status) : undefined,
          kinds?.length ? inArray(s.questions.kind, kinds) : undefined,
        ),
      )
      .orderBy(asc(s.questions.createdAt))
      .all();
    return rows.map(toQuestion);
  }
  async updateQuestionStatus(id: string, status: QuestionStatus) {
    await this.db.update(s.questions).set({ status }).where(eq(s.questions.id, id));
  }
  async serveQuestion(args: {
    questionId: string;
    mimicId: string;
    seq: number;
    servedAt: number;
    stateAt: number | null;
    predictions: PredictionRecord[];
    selection?: Record<string, unknown> | null;
  }) {
    const stmts: BatchItem<'sqlite'>[] = [
      this.db
        .update(s.questions)
        .set({
          seq: args.seq,
          status: 'served',
          servedAt: args.servedAt,
          stateAt: args.stateAt,
          selectionJson: args.selection ? JSON.stringify(args.selection) : null,
        })
        .where(and(eq(s.questions.id, args.questionId), eq(s.questions.status, 'pooled'))),
      this.db
        .update(s.mimics)
        .set({ seqMax: sql`max(${s.mimics.seqMax}, ${args.seq})`, updatedAt: args.servedAt })
        .where(eq(s.mimics.id, args.mimicId)),
    ];
    for (const part of chunk(args.predictions.map(fromPrediction), PREDICTION_COLS)) {
      stmts.push(this.db.insert(s.predictions).values(part));
    }
    try {
      // Guarded, a serve whose state was built before an undo writes nothing (ADR-0036).
      await this.write(stmts);
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
    const q = await this.getQuestion(args.questionId);
    return q?.seq === args.seq && q.status === 'served';
  }

  // predictions & answers
  async insertPredictions(recs: PredictionRecord[]) {
    await this.insertChunked(s.predictions, recs.map(fromPrediction));
  }
  async deletePredictions(ids: string[]) {
    for (const part of idChunks(ids))
      await this.db.delete(s.predictions).where(inArray(s.predictions.id, part));
  }
  async listPredictions(filter: { mimicId?: string; questionId?: string; roles?: PredictionRole[] }) {
    const conds = [];
    if (filter.mimicId) conds.push(eq(s.predictions.mimicId, filter.mimicId));
    if (filter.questionId) conds.push(eq(s.predictions.questionId, filter.questionId));
    if (filter.roles?.length) conds.push(inArray(s.predictions.role, filter.roles));
    const rows = await this.db
      .select()
      .from(s.predictions)
      .where(and(...conds))
      .orderBy(asc(s.predictions.createdAt))
      .all();
    return rows.map(toPrediction);
  }
  async getAnswerByIdempotencyKey(key: string) {
    const r = await this.db.select().from(s.answers).where(eq(s.answers.idempotencyKey, key)).get();
    return r ? toAnswer(r) : null;
  }
  async getAnswerForQuestion(questionId: string) {
    const r = await this.db.select().from(s.answers).where(eq(s.answers.questionId, questionId)).get();
    return r ? toAnswer(r) : null;
  }
  async listAnswers(mimicId: string) {
    const rows = await this.db
      .select()
      .from(s.answers)
      .where(eq(s.answers.mimicId, mimicId))
      .orderBy(asc(s.answers.seq))
      .all();
    return rows.map(toAnswer);
  }
  async recordAnswer(args: { answer: AnswerRecord; scores: ScoreRecord[] }) {
    const a = args.answer;
    const stmts: BatchItem<'sqlite'>[] = [
      // The guard: the seq comes from the question, still served at that seq. Feedback that moved it (ADR-0032) or
      // an undo that discarded it (ADR-0036) leaves it NULL, and the whole batch aborts, so no answer ever lands on a
      // question that isn't being asked.
      this.db.insert(s.answers).values({
        ...a,
        seq: sql`(select q.seq from questions q where q.id = ${a.questionId} and q.status = 'served' and q.seq = ${a.seq})`,
      }),
      this.db.update(s.questions).set({ status: 'answered' }).where(eq(s.questions.id, a.questionId)),
    ];
    // A shadow racing an undo can leave a score for the retracted answer; this answer's scores replace it.
    for (const ids of idChunks(args.scores.map((x) => x.predictionId)))
      stmts.push(this.db.delete(s.scores).where(inArray(s.scores.predictionId, ids)));
    stmts.push(
      ...this.inserts(
        s.scores,
        args.scores.map((x) => ({ ...x, mimicId: a.mimicId })),
      ),
    );
    try {
      await this.db.batch(stmts as Batch);
    } catch (e) {
      if (isUniqueViolation(e) || isGuardViolation(e, 'answers.seq')) return false;
      throw e;
    }
    return true;
  }
  async recordFeedback(args: {
    question: QuestionRecord;
    answer: AnswerRecord;
    move?: { questionId: string; toSeq: number };
  }) {
    const { question: q, answer: a, move } = args;
    const stmts: BatchItem<'sqlite'>[] = [];
    // If the moved question was answered meanwhile it keeps its seq, and the insert below fails on it.
    if (move)
      stmts.push(
        this.db
          .update(s.questions)
          .set({ seq: move.toSeq })
          .where(
            and(
              eq(s.questions.id, move.questionId),
              eq(s.questions.status, 'served'),
              eq(s.questions.seq, a.seq),
            ),
          ),
      );
    stmts.push(
      this.db.insert(s.questions).values(fromQuestion(q)),
      this.db
        .update(s.mimics)
        .set({
          seqMax: sql`max(${s.mimics.seqMax}, ${Math.max(a.seq, move?.toSeq ?? 0)})`,
          updatedAt: a.createdAt,
        })
        .where(eq(s.mimics.id, a.mimicId)),
      this.db.insert(s.answers).values(a),
    );
    try {
      await this.db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
    return true;
  }
  async insertScores(recs: ScoreRecord[]) {
    const byAnswer = new Map<string, ScoreRecord[]>();
    for (const r of recs) byAnswer.set(r.answerId, [...(byAnswer.get(r.answerId) ?? []), r]);
    for (const [answerId, rows] of byAnswer) {
      // Each row takes its mimic_id from its answer in the same statement, so a score for an answer undone
      // meanwhile (ADR-0036) aborts instead of landing as an orphan.
      const mimicId = sql`(select a.mimic_id from answers a where a.id = ${answerId})`;
      try {
        await this.write(
          chunk(rows, 8).map((part) =>
            this.db
              .insert(s.scores)
              .values(part.map((r) => ({ ...r, mimicId })))
              .onConflictDoNothing(),
          ),
        );
      } catch (e) {
        if (!isGuardViolation(e, 'scores.mimic_id')) throw e;
      }
    }
  }

  // rewinds (ADR-0036)
  async rewindAnswer(args: {
    rewind: AnswerRewindRecord;
    requeue: QuestionRecord[];
    derived: DerivedRollback;
  }) {
    const { rewind: r, requeue, derived } = args;
    const t = r.seq;
    const sessionKinds = sql.join(
      SESSION_KIND_LIST.map((k) => sql`${k}`),
      sql`, `,
    );
    // The guard, checked inside the batch: the answer is still there, nothing was answered after it, and nothing was
    // asked or taught on the mimic page after it. Otherwise `value` is NULL and the whole batch aborts.
    const guarded = sql`(select a.value from answers a where a.id = ${r.answerId}
      and not exists (select 1 from answers b where b.mimic_id = ${r.mimicId} and b.seq > ${t})
      and not exists (select 1 from questions q where q.mimic_id = ${r.mimicId} and q.seq > ${t}
        and q.kind not in (${sessionKinds})))`;
    const predsOf = this.db
      .select({ id: s.predictions.id })
      .from(s.predictions)
      .where(eq(s.predictions.questionId, r.questionId));
    // A concurrent undo of the same answer fails on the unique answer_id, also aborting the batch.
    const stmts: BatchItem<'sqlite'>[] = [
      this.db.insert(s.answerRewinds).values({ ...r, value: guarded }),
      this.db
        .delete(s.scores)
        .where(or(eq(s.scores.answerId, r.answerId), inArray(s.scores.predictionId, predsOf))),
      this.db.delete(s.answers).where(eq(s.answers.id, r.answerId)),
      this.db
        .update(s.questions)
        .set({ status: 'served' })
        .where(and(eq(s.questions.id, r.questionId), eq(s.questions.status, 'answered'))),
    ];
    // By condition, not by the IDs the engine read, so a serve that committed after that read is caught too.
    stmts.push(...this.discardStmts(r.mimicId, t));
    const discardAt = stmts.length - 1;
    stmts.push(
      ...this.inserts(s.questions, requeue.map(fromQuestion)),
      this.db.delete(s.fidelity).where(and(eq(s.fidelity.mimicId, r.mimicId), gte(s.fidelity.seqUpTo, t))),
      // Derived writes and serves still holding the old epoch are refused from here on (Store.guarded).
      this.db
        .update(s.mimics)
        .set({ seqMax: t, evidenceEpoch: sql`${s.mimics.evidenceEpoch} + 1`, updatedAt: r.rewoundAt })
        .where(eq(s.mimics.id, r.mimicId)),
    );
    const derivedAt = stmts.length;
    const d = this.derivedStmts(derived);
    stmts.push(...d.stmts);
    try {
      const res = await this.db.batch(stmts as Batch);
      const ids = (x: unknown) => (x as Array<{ id: string }>).map((row) => row.id);
      return {
        discarded: ids(res[discardAt]),
        factIds: d.factsAt.flatMap((i) => ids(res[derivedAt + i])),
      };
    } catch (e) {
      if (isUniqueViolation(e) || isGuardViolation(e, 'answer_rewinds.value')) return null;
      throw e;
    }
  }
  /** Discards served session questions after `seq`, with their predictions; the last statement returns their IDs. */
  private discardStmts(mimicId: string, seq: number): BatchItem<'sqlite'>[] {
    const q = s.questions;
    const servedAfter = and(
      eq(q.mimicId, mimicId),
      gt(q.seq, seq),
      eq(q.status, 'served'),
      inArray(q.kind, SESSION_KIND_LIST),
    );
    const ids = this.db.select({ id: q.id }).from(q).where(servedAfter);
    const preds = this.db
      .select({ id: s.predictions.id })
      .from(s.predictions)
      .where(inArray(s.predictions.questionId, ids));
    return [
      this.db.delete(s.scores).where(inArray(s.scores.predictionId, preds)),
      this.db.delete(s.predictions).where(inArray(s.predictions.questionId, ids)),
      this.db.update(q).set({ status: 'discarded', seq: null }).where(servedAfter).returning({ id: q.id }),
    ];
  }
  /**
   * Derived rows built from evidence at or after `fromSeq`. Trait estimates are rebuilt from what remains of the
   * history with the same query serving and replay read. `factsAt` indexes the statements returning removed facts.
   */
  private derivedStmts(d: DerivedRollback): { stmts: BatchItem<'sqlite'>[]; factsAt: number[] } {
    const { mimicId, fromSeq } = d;
    const insightsFrom = this.db
      .select({ id: s.insights.id })
      .from(s.insights)
      .where(and(eq(s.insights.mimicId, mimicId), gte(s.insights.seqUpTo, fromSeq)));
    const stmts: BatchItem<'sqlite'>[] = [
      this.db
        .delete(s.traitHistory)
        .where(and(eq(s.traitHistory.mimicId, mimicId), gte(s.traitHistory.seqUpTo, fromSeq))),
      this.db.delete(s.traitEstimates).where(eq(s.traitEstimates.mimicId, mimicId)),
      this.db.insert(s.traitEstimates).select(this.latestTraits(eq(s.traitHistory.mimicId, mimicId))),
      this.db
        .update(s.insights)
        .set({ status: 'active', statusChangedAt: null, supersededSeq: null })
        .where(
          and(
            eq(s.insights.mimicId, mimicId),
            eq(s.insights.status, 'superseded'),
            gte(s.insights.supersededSeq, fromSeq),
          ),
        ),
      this.db
        .delete(s.kgEdges)
        .where(and(eq(s.kgEdges.mimicId, mimicId), inArray(s.kgEdges.sourceRef, insightsFrom))),
      this.db
        .delete(s.insights)
        .where(and(eq(s.insights.mimicId, mimicId), gte(s.insights.seqUpTo, fromSeq))),
    ];
    // Reflection facts from a reflection at or after `fromSeq`, whatever they cite; older rows by citation.
    const factsAt: number[] = [];
    const factGroups = [undefined, ...idChunks(d.factIds)];
    for (const legacy of factGroups) {
      const cond = and(
        eq(s.facts.mimicId, mimicId),
        eq(s.facts.source, 'reflection'),
        legacy ? inArray(s.facts.id, legacy) : gte(s.facts.seqUpTo, fromSeq),
      );
      const factIds = this.db.select({ id: s.facts.id }).from(s.facts).where(cond);
      stmts.push(
        this.db
          .delete(s.kgEdges)
          .where(and(eq(s.kgEdges.mimicId, mimicId), inArray(s.kgEdges.sourceRef, factIds))),
      );
      factsAt.push(stmts.length);
      stmts.push(this.db.delete(s.facts).where(cond).returning({ id: s.facts.id }));
    }
    const edgesOf = (col: typeof s.kgEdges.src | typeof s.kgEdges.dst) =>
      this.db.select({ id: col }).from(s.kgEdges).where(eq(s.kgEdges.mimicId, mimicId));
    stmts.push(
      // Reflection nodes left without an edge.
      this.db
        .delete(s.kgNodes)
        .where(
          and(
            eq(s.kgNodes.mimicId, mimicId),
            eq(s.kgNodes.source, 'reflection'),
            notInArray(s.kgNodes.id, edgesOf(s.kgEdges.dst)),
            notInArray(s.kgNodes.id, edgesOf(s.kgEdges.src)),
          ),
        ),
      // Persona drafts cite the evidence up to their seq (ADR-0033); the page drafts again on request.
      this.db
        .delete(s.personaDrafts)
        .where(and(eq(s.personaDrafts.mimicId, mimicId), gte(s.personaDrafts.seqUpTo, fromSeq))),
    );
    return { stmts, factsAt };
  }
  async getAnswerRewindByIdempotencyKey(key: string) {
    const r = await this.db
      .select()
      .from(s.answerRewinds)
      .where(eq(s.answerRewinds.idempotencyKey, key))
      .get();
    return r ? toRewind(r) : null;
  }
  async listAnswerRewinds(mimicId: string) {
    const rows = await this.db
      .select()
      .from(s.answerRewinds)
      .where(eq(s.answerRewinds.mimicId, mimicId))
      .orderBy(asc(s.answerRewinds.rewoundAt))
      .all();
    return rows.map(toRewind);
  }
  async listScoredPredictions(mimicId: string, roles: PredictionRole[]): Promise<ScoredPredictionRow[]> {
    const rows = await this.db
      .select({ p: s.predictions, sc: s.scores, q: s.questions })
      .from(s.scores)
      .innerJoin(s.predictions, eq(s.predictions.id, s.scores.predictionId))
      .innerJoin(s.questions, eq(s.questions.id, s.predictions.questionId))
      .where(and(eq(s.scores.mimicId, mimicId), inArray(s.predictions.role, roles)))
      .orderBy(asc(s.questions.seq))
      .all();
    return rows.map((r) => ({
      prediction: toPrediction(r.p),
      score: {
        predictionId: r.sc.predictionId,
        answerId: r.sc.answerId,
        top1: r.sc.top1,
        itemAcc: r.sc.itemAcc,
        logLoss: r.sc.logLoss,
        brier: r.sc.brier,
        createdAt: r.sc.createdAt,
      },
      question: {
        id: r.q.id,
        kind: r.q.kind,
        type: r.q.type,
        seq: r.q.seq,
        ...(r.q.itemKey ? { itemKey: r.q.itemKey } : {}),
      },
    }));
  }

  // derived state
  async listTraits(mimicId: string) {
    return (
      await this.db.select().from(s.traitEstimates).where(eq(s.traitEstimates.mimicId, mimicId)).all()
    ).map(toTrait);
  }
  async listTraitHistory(mimicId: string) {
    const rows = await this.db
      .select()
      .from(s.traitHistory)
      .where(eq(s.traitHistory.mimicId, mimicId))
      .orderBy(asc(s.traitHistory.id))
      .all();
    return rows.map(({ id: _id, ...r }) => toTrait(r));
  }
  /**
   * Per facet and method, the history row with the highest seqUpTo among `where`, first write winning ties: the
   * monotonic upsert's rule. Serving, replay and the undo's rebuild of `trait_estimates` all use this one query.
   */
  private latestTraits(where: SQL | undefined) {
    const h = s.traitHistory;
    const { id: _id, ...cols } = getTableColumns(h);
    const ranked = this.db
      .select({
        ...cols,
        rank: sql<number>`row_number() over (partition by ${h.facetId}, ${h.method} order by ${h.seqUpTo} desc, ${h.id} asc)`.as(
          'rank',
        ),
      })
      .from(h)
      .where(where)
      .as('ranked');
    return this.db
      .select({
        mimicId: ranked.mimicId,
        facetId: ranked.facetId,
        method: ranked.method,
        seqUpTo: ranked.seqUpTo,
        mean: ranked.mean,
        distJson: ranked.distJson,
        confidence: ranked.confidence,
        nEvidence: ranked.nEvidence,
        configHash: ranked.configHash,
        modelSnapshot: ranked.modelSnapshot,
        createdAt: ranked.createdAt,
      })
      .from(ranked)
      .where(eq(ranked.rank, 1));
  }
  async listTraitsAsOf(mimicId: string, at: number, beforeSeq: number) {
    const h = s.traitHistory;
    const rows = await this.latestTraits(
      and(eq(h.mimicId, mimicId), lte(h.createdAt, at), lt(h.seqUpTo, beforeSeq)),
    ).all();
    return rows.map(toTrait);
  }
  async upsertTraits(recs: TraitRecord[]) {
    if (!recs.length) return 0;
    const rows = recs.map(fromTrait);
    const stmts: BatchItem<'sqlite'>[] = [];
    for (const row of rows) {
      stmts.push(
        this.db
          .insert(s.traitEstimates)
          .values(row)
          .onConflictDoUpdate({
            target: [s.traitEstimates.mimicId, s.traitEstimates.facetId, s.traitEstimates.method],
            set: {
              seqUpTo: row.seqUpTo,
              mean: row.mean,
              distJson: row.distJson,
              confidence: row.confidence,
              nEvidence: row.nEvidence,
              configHash: row.configHash,
              modelSnapshot: row.modelSnapshot,
              createdAt: row.createdAt,
            },
            setWhere: sql`excluded.seq_up_to > ${s.traitEstimates.seqUpTo}`,
          }),
      );
    }
    stmts.push(...this.inserts(s.traitHistory, rows));
    await this.write(stmts);
    return rows.length;
  }
  async listInsights(mimicId: string): Promise<InsightRecord[]> {
    const rows = await this.db
      .select()
      .from(s.insights)
      .where(eq(s.insights.mimicId, mimicId))
      .orderBy(asc(s.insights.createdAt))
      .all();
    return rows.map((r) => ({
      id: r.id,
      mimicId: r.mimicId,
      seqUpTo: r.seqUpTo,
      text: r.text,
      facetIds: parse(StrArr, r.facetIdsJson, []),
      evidenceSeqs: parse(IntArr, r.evidenceSeqsJson, []),
      confidence: r.confidence,
      model: r.model,
      promptVersion: r.promptVersion,
      status: r.status,
      createdAt: r.createdAt,
      statusChangedAt: r.statusChangedAt,
    }));
  }
  async insertInsights(recs: InsightRecord[]) {
    await this.insertChunked(
      s.insights,
      recs.map(({ facetIds, evidenceSeqs, ...r }) => ({
        ...r,
        facetIdsJson: JSON.stringify(facetIds),
        evidenceSeqsJson: JSON.stringify(evidenceSeqs),
      })),
    );
  }
  async updateInsightStatus(id: string, status: InsightRecord['status'], at: number, seq?: number) {
    await this.write([
      this.db
        .update(s.insights)
        .set({ status, statusChangedAt: at, supersededSeq: status === 'superseded' ? (seq ?? null) : null })
        .where(eq(s.insights.id, id)),
    ]);
  }
  async listKg(mimicId: string) {
    const [nodes, edges] = await Promise.all([
      this.db
        .select()
        .from(s.kgNodes)
        .where(eq(s.kgNodes.mimicId, mimicId))
        .orderBy(asc(s.kgNodes.createdAt))
        .all(),
      this.db
        .select()
        .from(s.kgEdges)
        .where(eq(s.kgEdges.mimicId, mimicId))
        .orderBy(asc(s.kgEdges.createdAt))
        .all(),
    ]);
    return {
      nodes: nodes.map(({ propsJson, ...n }): KgNodeRecord => ({ ...n, props: parse(Obj, propsJson, {}) })),
      edges: edges as KgEdgeRecord[],
    };
  }
  async insertKg(nodes: KgNodeRecord[], edges: KgEdgeRecord[]) {
    const rows = nodes.map(({ props, ...n }) => ({ ...n, propsJson: JSON.stringify(props) }));
    await this.write([
      ...chunk(rows, 7).map((part) => this.db.insert(s.kgNodes).values(part).onConflictDoNothing()),
      ...this.inserts(s.kgEdges, edges),
    ]);
  }
  async insertFidelity(rec: FidelityRecord) {
    await this.write([this.db.insert(s.fidelity).values(rec)]);
  }
  async listFidelity(mimicId: string) {
    const rows = await this.db
      .select()
      .from(s.fidelity)
      .where(eq(s.fidelity.mimicId, mimicId))
      .orderBy(asc(s.fidelity.seqUpTo), asc(s.fidelity.id))
      .all();
    return rows.map(({ id: _id, ...r }) => r);
  }
  async insertSnapshot(rec: SnapshotRecord) {
    await this.write([this.db.insert(s.snapshots).values(rec)]);
  }
  async listSnapshots(mimicId: string) {
    return this.db
      .select()
      .from(s.snapshots)
      .where(eq(s.snapshots.mimicId, mimicId))
      .orderBy(asc(s.snapshots.version))
      .all();
  }
  async listMimicFacets(mimicId: string): Promise<MimicFacetRecord[]> {
    const rows = await this.db
      .select()
      .from(s.mimicFacets)
      .where(eq(s.mimicFacets.mimicId, mimicId))
      .orderBy(asc(s.mimicFacets.createdAt))
      .all();
    return rows.map((r) => ({
      mimicId: r.mimicId,
      facet: JSON.parse(r.json),
      source: r.source,
      createdAt: r.createdAt,
    }));
  }
  async insertMimicFacets(recs: MimicFacetRecord[]) {
    const rows = recs.map((r) => ({
      mimicId: r.mimicId,
      facetId: r.facet.id,
      json: JSON.stringify(r.facet),
      source: r.source,
      createdAt: r.createdAt,
    }));
    for (const part of chunk(rows, 5)) await this.db.insert(s.mimicFacets).values(part).onConflictDoNothing();
  }

  // Persona.md (ADR-0033)
  async insertPersonaDraft(rec: PersonaDraftRecord) {
    const { draft, ...row } = rec;
    await this.write([
      this.db
        .insert(s.personaDrafts)
        .values({ ...row, draftJson: JSON.stringify(PersonaDraft.parse(draft)) }),
    ]);
  }
  async latestPersonaDraft(mimicId: string): Promise<PersonaDraftRecord | null> {
    const row = await this.db
      .select()
      .from(s.personaDrafts)
      .where(eq(s.personaDrafts.mimicId, mimicId))
      .orderBy(desc(s.personaDrafts.createdAt), desc(s.personaDrafts.id))
      .get();
    if (!row) return null;
    const { draftJson, ...rest } = row;
    return { ...rest, draft: parse(PersonaDraft, draftJson, { summary: '', statements: [] }) };
  }
  async getPersonaCuration(mimicId: string): Promise<PersonaCurationRecord | null> {
    const row = await this.db
      .select()
      .from(s.personaCurations)
      .where(eq(s.personaCurations.mimicId, mimicId))
      .get();
    if (!row) return null;
    return {
      mimicId: row.mimicId,
      curation: parse(PersonaCuration, row.json, PersonaCuration.parse({})),
      rev: row.rev,
      updatedAt: row.updatedAt,
    };
  }
  async putPersonaCuration(rec: PersonaCurationRecord) {
    const json = JSON.stringify(PersonaCuration.parse(rec.curation));
    const rows = await this.db
      .insert(s.personaCurations)
      .values({ mimicId: rec.mimicId, json, rev: rec.rev, updatedAt: rec.updatedAt })
      .onConflictDoUpdate({
        target: s.personaCurations.mimicId,
        set: { json, rev: rec.rev, updatedAt: rec.updatedAt },
        // Out-of-order saves (a slow request, a keepalive flush on leaving the page) never overwrite a newer one.
        setWhere: lt(s.personaCurations.rev, rec.rev),
      })
      .returning({ rev: s.personaCurations.rev })
      .all();
    return rows.length > 0;
  }

  // cross-person item statistics (ADR-0027)
  async listScoredForStats(filter: { consentResearch: boolean; split: 'dev' | 'test' }) {
    const rows = await this.db
      .select({
        mimicId: s.predictions.mimicId,
        questionId: s.predictions.questionId,
        role: s.predictions.role,
        fallback: s.predictions.fallback,
        itemAcc: s.scores.itemAcc,
        logLoss: s.scores.logLoss,
        kind: s.questions.kind,
        type: s.questions.type,
        domain: s.questions.domain,
        facetIdsJson: s.questions.facetIdsJson,
        optionsJson: s.questions.optionsJson,
        itemKey: s.questions.itemKey,
        value: s.answers.value,
        latencyMs: s.answers.latencyMs,
      })
      .from(s.scores)
      .innerJoin(s.predictions, eq(s.predictions.id, s.scores.predictionId))
      .innerJoin(s.questions, eq(s.questions.id, s.predictions.questionId))
      .innerJoin(s.answers, eq(s.answers.questionId, s.predictions.questionId))
      .innerJoin(s.mimics, eq(s.mimics.id, s.predictions.mimicId))
      .where(
        and(
          eq(s.mimics.consentResearch, filter.consentResearch),
          eq(s.mimics.split, filter.split),
          inArray(s.predictions.role, ['primary', 'baseline']),
          inArray(s.questions.kind, ['anchor', 'adaptive']),
        ),
      )
      .all();
    return rows.map(
      (r): ScoredItemSource => ({
        mimicId: r.mimicId,
        questionId: r.questionId,
        role: r.role as 'primary' | 'baseline',
        fallback: r.fallback,
        itemAcc: r.itemAcc,
        logLoss: r.logLoss,
        question: {
          kind: r.kind,
          type: r.type,
          domain: r.domain,
          facetIds: parse(StrArr, r.facetIdsJson, []),
          options: parse(Options, r.optionsJson, []),
          ...(r.itemKey ? { itemKey: r.itemKey } : {}),
        },
        answer: { value: r.value, latencyMs: r.latencyMs },
      }),
    );
  }
  async replaceItemStats(recs: ItemStatRecord[]) {
    const stmts: BatchItem<'sqlite'>[] = [this.db.delete(s.itemStats)];
    for (const part of chunk(recs, 11)) stmts.push(this.db.insert(s.itemStats).values(part));
    await this.db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  }
  async listItemStats(): Promise<ItemStatRecord[]> {
    return this.db.select().from(s.itemStats).orderBy(asc(s.itemStats.key)).all();
  }

  // jobs
  async getJob(key: string) {
    return (await this.db.select().from(s.jobs).where(eq(s.jobs.key, key)).get()) ?? null;
  }
  async putJob(rec: JobRecord) {
    await this.db
      .insert(s.jobs)
      .values(rec)
      .onConflictDoUpdate({
        target: s.jobs.key,
        set: {
          status: rec.status,
          attempts: rec.attempts,
          lastError: rec.lastError,
          updatedAt: rec.updatedAt,
        },
      });
  }

  async listStaleJobs(before: number, limit: number) {
    return this.db
      .select()
      .from(s.jobs)
      .where(and(inArray(s.jobs.status, ['running', 'failed']), lt(s.jobs.updatedAt, before)))
      .orderBy(asc(s.jobs.updatedAt))
      .limit(limit)
      .all();
  }

  // observability
  async insertModelCall(rec: ModelCallRecord) {
    await this.db.insert(s.modelCalls).values(rec);
  }
  async listModelCalls(filter: { mimicId?: string; since?: number; limit?: number }) {
    const conds = [];
    if (filter.mimicId) conds.push(eq(s.modelCalls.mimicId, filter.mimicId));
    if (filter.since) conds.push(gte(s.modelCalls.createdAt, filter.since));
    return this.db
      .select()
      .from(s.modelCalls)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(s.modelCalls.createdAt))
      .limit(filter.limit ?? 1000)
      .all();
  }

  // evals
  async putEvalRun(rec: EvalRunRecord) {
    const row = {
      id: rec.id,
      name: rec.name,
      specJson: JSON.stringify(rec.spec),
      datasetHash: rec.datasetHash,
      status: rec.status,
      metricsJson: rec.metrics ? JSON.stringify(rec.metrics) : null,
      r2ReportKey: rec.r2ReportKey,
      createdAt: rec.createdAt,
    };
    await this.db
      .insert(s.evalRuns)
      .values(row)
      .onConflictDoUpdate({
        target: s.evalRuns.id,
        set: { status: row.status, metricsJson: row.metricsJson, r2ReportKey: row.r2ReportKey },
      });
  }
  async listEvalRuns(): Promise<EvalRunRecord[]> {
    const rows = await this.db.select().from(s.evalRuns).orderBy(desc(s.evalRuns.createdAt)).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      spec: parse(Obj, r.specJson, {}),
      datasetHash: r.datasetHash,
      status: r.status,
      metrics: parse(Obj, r.metricsJson, null as Record<string, unknown> | null),
      r2ReportKey: r.r2ReportKey,
      createdAt: r.createdAt,
    }));
  }
}

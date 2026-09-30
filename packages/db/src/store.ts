import {
  type AnswerRecord,
  type CandidateRecord,
  type CandidateStatus,
  type ConfigRecord,
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
  type PredictionRecord,
  type PredictionRole,
  type QuestionRecord,
  type QuestionStatus,
  type ScoredItemSource,
  type ScoredPredictionRow,
  type ScoreRecord,
  type SnapshotRecord,
  type Store,
  type TraitRecord,
} from '@mimic/core';
import { and, asc, desc, eq, getTableColumns, gte, inArray, like, lt, lte, sql } from 'drizzle-orm';
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
  snapshotVersion: r.snapshotVersion,
  spendUsd: r.spendUsd,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

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

export class DrizzleStore implements Store {
  constructor(readonly db: MimicDb) {}

  private async insertChunked<T extends object>(
    table: Parameters<MimicDb['insert']>[0],
    rows: T[],
  ): Promise<void> {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]!).length;
    for (const part of chunk(rows, cols)) await this.db.insert(table).values(part as never);
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
  async listQuestions(mimicId: string, status?: QuestionStatus[]) {
    const rows = await this.db
      .select()
      .from(s.questions)
      .where(
        status?.length
          ? and(eq(s.questions.mimicId, mimicId), inArray(s.questions.status, status))
          : eq(s.questions.mimicId, mimicId),
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
      await this.db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String((e as { cause?: unknown }).cause ?? e))) return false;
      throw e;
    }
    const q = await this.getQuestion(args.questionId);
    return q?.seq === args.seq && q.status === 'served';
  }

  // predictions & answers
  async insertPredictions(recs: PredictionRecord[]) {
    await this.insertChunked(s.predictions, recs.map(fromPrediction));
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
    const stmts: BatchItem<'sqlite'>[] = [
      this.db.insert(s.answers).values(args.answer),
      this.db
        .update(s.questions)
        .set({ status: 'answered' })
        .where(eq(s.questions.id, args.answer.questionId)),
    ];
    const scoreRows = args.scores.map((x) => ({ ...x, mimicId: args.answer.mimicId }));
    for (const part of chunk(scoreRows, 8)) stmts.push(this.db.insert(s.scores).values(part));
    await this.db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  }
  async insertScores(recs: ScoreRecord[]) {
    if (!recs.length) return;
    const answers = await this.db
      .select({ id: s.answers.id, mimicId: s.answers.mimicId })
      .from(s.answers)
      .where(inArray(s.answers.id, [...new Set(recs.map((r) => r.answerId))]))
      .all();
    const mimicOf = new Map(answers.map((a) => [a.id, a.mimicId]));
    const rows = recs.map((r) => ({ ...r, mimicId: mimicOf.get(r.answerId) ?? '' }));
    for (const part of chunk(rows, 8)) await this.db.insert(s.scores).values(part).onConflictDoNothing();
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
  async listTraitsAsOf(mimicId: string, at: number, beforeSeq: number) {
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
      .where(and(eq(h.mimicId, mimicId), lte(h.createdAt, at), lt(h.seqUpTo, beforeSeq)))
      .as('ranked');
    const rows = await this.db.select().from(ranked).where(eq(ranked.rank, 1)).all();
    return rows.map(({ rank: _rank, ...r }) => toTrait(r));
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
    for (const part of chunk(rows, 11)) stmts.push(this.db.insert(s.traitHistory).values(part));
    await this.db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
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
  async updateInsightStatus(id: string, status: InsightRecord['status'], at: number) {
    await this.db.update(s.insights).set({ status, statusChangedAt: at }).where(eq(s.insights.id, id));
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
    if (nodes.length) {
      const rows = nodes.map(({ props, ...n }) => ({ ...n, propsJson: JSON.stringify(props) }));
      for (const part of chunk(rows, 7)) await this.db.insert(s.kgNodes).values(part).onConflictDoNothing();
    }
    await this.insertChunked(s.kgEdges, edges);
  }
  async insertFidelity(rec: FidelityRecord) {
    await this.db.insert(s.fidelity).values(rec);
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
    await this.db.insert(s.snapshots).values(rec);
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

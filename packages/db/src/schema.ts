import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** PLAN §8. IDs are ULIDs; timestamps are integer ms; *_json columns are validated with zod on read. */

const bool = (name: string) => integer(name, { mode: 'boolean' });

export const participants = sqliteTable('participants', {
  id: text('id').primaryKey(),
  email: text('email'),
  isAdmin: bool('is_admin').notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const mimics = sqliteTable(
  'mimics',
  {
    id: text('id').primaryKey(),
    participantId: text('participant_id').notNull(),
    displayName: text('display_name').notNull(),
    location: text('location').notNull(),
    occupation: text('occupation'),
    employer: text('employer'),
    linksJson: text('links_json').notNull().default('[]'),
    status: text('status', { enum: ['intake', 'identity', 'learning', 'paused', 'archived'] }).notNull(),
    identityState: text('identity_state', {
      enum: ['skipped', 'searching', 'candidates', 'none_found', 'enriching', 'review', 'done'],
    }).notNull(),
    configHash: text('config_hash').notNull(),
    experimentId: text('experiment_id'),
    arm: text('arm'),
    consentApp: bool('consent_app').notNull(),
    consentSearch: bool('consent_search').notNull(),
    consentResearch: bool('consent_research').notNull(),
    split: text('split', { enum: ['dev', 'test'] }).notNull(),
    seqMax: integer('seq_max').notNull().default(0),
    snapshotVersion: integer('snapshot_version').notNull().default(0),
    spendUsd: real('spend_usd').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('mimics_participant_idx').on(t.participantId)],
);

export const identityCandidates = sqliteTable(
  'identity_candidates',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    provider: text('provider').notNull(),
    rank: integer('rank').notNull(),
    name: text('name').notNull(),
    headline: text('headline'),
    location: text('location'),
    url: text('url').notNull(),
    summary: text('summary').notNull(),
    jevSamePersonP: real('jev_same_person_p'),
    r2Key: text('r2_key'),
    status: text('status', { enum: ['proposed', 'confirmed', 'rejected'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('identity_candidates_mimic_idx').on(t.mimicId)],
);

export const facts = sqliteTable(
  'facts',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    predicate: text('predicate').notNull(),
    object: text('object').notNull(),
    source: text('source', { enum: ['intake', 'search', 'answer', 'reflection'] }).notNull(),
    sourceRef: text('source_ref'),
    sourceUrl: text('source_url'),
    confidence: real('confidence').notNull(),
    userState: text('user_state', { enum: ['active', 'removed'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    /** Last change of user_state (ADR-0017). */
    userStateAt: integer('user_state_at'),
  },
  (t) => [index('facts_mimic_idx').on(t.mimicId)],
);

export const questions = sqliteTable(
  'questions',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    seq: integer('seq'),
    kind: text('kind', { enum: ['anchor', 'adaptive', 'repeat', 'playground'] }).notNull(),
    type: text('type', { enum: ['choice', 'noul', 'score'] }).notNull(),
    domain: text('domain', { enum: ['core', 'casual', 'professional'] }).notNull(),
    prompt: text('prompt').notNull(),
    optionsJson: text('options_json').notNull(),
    facetIdsJson: text('facet_ids_json').notNull(),
    repeatOf: text('repeat_of'),
    itemKey: text('item_key'),
    status: text('status', { enum: ['pooled', 'served', 'answered', 'discarded'] }).notNull(),
    configHash: text('config_hash').notNull(),
    promptVersion: text('prompt_version').notNull(),
    generator: text('generator').notNull(),
    qualityJson: text('quality_json'),
    createdAt: integer('created_at').notNull(),
    servedAt: integer('served_at'),
    /** As-of time of the derived data (traits, insights, facts) in this question's sealed states (ADR-0017). */
    stateAt: integer('state_at'),
  },
  (t) => [
    index('questions_mimic_idx').on(t.mimicId),
    // Unique per mimic: two concurrent serves can never take the same seq.
    uniqueIndex('questions_mimic_seq_idx').on(t.mimicId, t.seq),
  ],
);

export const predictions = sqliteTable(
  'predictions',
  {
    id: text('id').primaryKey(),
    questionId: text('question_id').notNull(),
    mimicId: text('mimic_id').notNull(),
    predictorId: text('predictor_id').notNull(),
    role: text('role', { enum: ['primary', 'baseline', 'shadow', 'hypothesis'] }).notNull(),
    distJson: text('dist_json').notNull(),
    confidence: real('confidence'),
    stateHash: text('state_hash').notNull(),
    evidenceSeqMax: integer('evidence_seq_max').notNull(),
    configHash: text('config_hash').notNull(),
    promptVersion: text('prompt_version').notNull(),
    modelSnapshot: text('model_snapshot').notNull(),
    costUsd: real('cost_usd').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    ok: bool('ok').notNull(),
    error: text('error'),
    fallback: bool('fallback').notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('predictions_mimic_idx').on(t.mimicId),
    index('predictions_question_role_idx').on(t.questionId, t.role),
  ],
);

export const answers = sqliteTable(
  'answers',
  {
    id: text('id').primaryKey(),
    questionId: text('question_id').notNull(),
    mimicId: text('mimic_id').notNull(),
    seq: integer('seq').notNull(),
    value: text('value').notNull(),
    why: text('why'),
    latencyMs: integer('latency_ms').notNull(),
    revealedPrediction: bool('revealed_prediction').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('answers_mimic_idx').on(t.mimicId),
    uniqueIndex('answers_mimic_seq_idx').on(t.mimicId, t.seq),
    uniqueIndex('answers_idempotency_idx').on(t.idempotencyKey),
    uniqueIndex('answers_question_idx').on(t.questionId),
  ],
);

/** ADR-0027: answers the person undid to re-answer. One row per retracted answer (answer_id is unique). */
export const answerRewinds = sqliteTable(
  'answer_rewinds',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    questionId: text('question_id').notNull(),
    seq: integer('seq').notNull(),
    answerId: text('answer_id').notNull(),
    value: text('value').notNull(),
    why: text('why'),
    latencyMs: integer('latency_ms').notNull(),
    revealedPrediction: bool('revealed_prediction').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    answeredAt: integer('answered_at').notNull(),
    rewoundAt: integer('rewound_at').notNull(),
  },
  (t) => [
    index('answer_rewinds_mimic_idx').on(t.mimicId, t.seq),
    // Makes a second, concurrent undo of the same answer fail as a whole (ADR-0027).
    uniqueIndex('answer_rewinds_answer_idx').on(t.answerId),
    index('answer_rewinds_idempotency_idx').on(t.idempotencyKey),
  ],
);

export const scores = sqliteTable(
  'scores',
  {
    predictionId: text('prediction_id').primaryKey(),
    answerId: text('answer_id').notNull(),
    mimicId: text('mimic_id').notNull(),
    top1: integer('top1').notNull(),
    itemAcc: real('item_acc').notNull(),
    logLoss: real('log_loss').notNull(),
    brier: real('brier').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('scores_mimic_idx').on(t.mimicId)],
);

const traitColumns = {
  mimicId: text('mimic_id').notNull(),
  facetId: text('facet_id').notNull(),
  method: text('method', { enum: ['jev', 'psychometric'] }).notNull(),
  seqUpTo: integer('seq_up_to').notNull(),
  mean: real('mean').notNull(),
  distJson: text('dist_json').notNull(),
  confidence: real('confidence').notNull(),
  nEvidence: integer('n_evidence').notNull(),
  configHash: text('config_hash').notNull(),
  modelSnapshot: text('model_snapshot'),
  createdAt: integer('created_at').notNull(),
};

export const traitEstimates = sqliteTable('trait_estimates', traitColumns, (t) => [
  primaryKey({ columns: [t.mimicId, t.facetId, t.method] }),
  index('trait_estimates_mimic_idx').on(t.mimicId),
]);

export const traitHistory = sqliteTable(
  'trait_history',
  { id: integer('id').primaryKey({ autoIncrement: true }), ...traitColumns },
  (t) => [index('trait_history_mimic_idx').on(t.mimicId)],
);

export const insights = sqliteTable(
  'insights',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    seqUpTo: integer('seq_up_to').notNull(),
    text: text('text').notNull(),
    facetIdsJson: text('facet_ids_json').notNull(),
    evidenceSeqsJson: text('evidence_seqs_json').notNull(),
    confidence: real('confidence').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: text('status', { enum: ['active', 'superseded', 'user_rejected'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    /** When the status left `active` (ADR-0017: lets replay rebuild the state as it was at serve time). */
    statusChangedAt: integer('status_changed_at'),
    /** seqUpTo of the reflection that superseded it, so undoing that answer restores it (ADR-0027). */
    supersededSeq: integer('superseded_seq'),
  },
  (t) => [index('insights_mimic_idx').on(t.mimicId)],
);

export const kgNodes = sqliteTable(
  'kg_nodes',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    type: text('type', {
      enum: ['Person', 'Organization', 'Place', 'Occupation', 'Skill', 'Interest', 'Facet'],
    }).notNull(),
    label: text('label').notNull(),
    propsJson: text('props_json').notNull().default('{}'),
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('kg_nodes_mimic_idx').on(t.mimicId)],
);

export const kgEdges = sqliteTable(
  'kg_edges',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    src: text('src').notNull(),
    dst: text('dst').notNull(),
    predicate: text('predicate').notNull(),
    weight: real('weight').notNull(),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('kg_edges_mimic_idx').on(t.mimicId)],
);

export const fidelity = sqliteTable(
  'fidelity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mimicId: text('mimic_id').notNull(),
    seqUpTo: integer('seq_up_to').notNull(),
    acc: real('acc').notNull(),
    accBaseline: real('acc_baseline'),
    selfConsistency: real('self_consistency').notNull(),
    fidelity: real('fidelity').notNull(),
    ciLow: real('ci_low').notNull(),
    ciHigh: real('ci_high').notNull(),
    nScored: integer('n_scored').notNull(),
    nRepeats: integer('n_repeats').notNull(),
    state: text('state', { enum: ['calibrating', 'learning', 'stable'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('fidelity_mimic_idx').on(t.mimicId, t.seqUpTo)],
);

export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id'),
    jobKey: text('job_key'),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    modelSnapshot: text('model_snapshot'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    ok: bool('ok').notNull(),
    error: text('error'),
    configHash: text('config_hash'),
    r2TraceKey: text('r2_trace_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('model_calls_created_idx').on(t.createdAt), index('model_calls_mimic_idx').on(t.mimicId)],
);

export const configs = sqliteTable('configs', {
  hash: text('hash').primaryKey(),
  json: text('json').notNull(),
  label: text('label'),
  createdAt: integer('created_at').notNull(),
});

export const experiments = sqliteTable('experiments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'active', 'stopped'] }).notNull(),
  armsJson: text('arms_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const snapshots = sqliteTable(
  'snapshots',
  {
    mimicId: text('mimic_id').notNull(),
    version: integer('version').notNull(),
    r2Key: text('r2_key').notNull(),
    seqUpTo: integer('seq_up_to').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.mimicId, t.version] })],
);

export const evalRuns = sqliteTable('eval_runs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  specJson: text('spec_json').notNull(),
  datasetHash: text('dataset_hash').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  metricsJson: text('metrics_json'),
  r2ReportKey: text('r2_report_key'),
  createdAt: integer('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  key: text('key').primaryKey(),
  type: text('type').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull(),
  lastError: text('last_error'),
  updatedAt: integer('updated_at').notNull(),
});

/** ADR-0008: per-mimic occupation facets (PLAN §9.8 step 4). */
export const mimicFacets = sqliteTable(
  'mimic_facets',
  {
    mimicId: text('mimic_id').notNull(),
    facetId: text('facet_id').notNull(),
    json: text('json').notNull(),
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.mimicId, t.facetId] })],
);

/** ADR-0003: local stand-in for Vectorize (dev and the Node CLI). */
export const vectors = sqliteTable(
  'vectors',
  {
    id: text('id').primaryKey(),
    mimicId: text('mimic_id').notNull(),
    kind: text('kind').notNull(),
    facetIds: text('facet_ids').notNull(),
    seq: integer('seq').notNull(),
    valuesJson: text('values_json').notNull(),
  },
  (t) => [index('vectors_mimic_idx').on(t.mimicId, t.kind)],
);

/** Tables scoped to one mimic, all removed by a hard delete. */
export const MIMIC_TABLES = [
  identityCandidates,
  facts,
  questions,
  predictions,
  answers,
  answerRewinds,
  scores,
  traitEstimates,
  traitHistory,
  insights,
  kgNodes,
  kgEdges,
  fidelity,
  modelCalls,
  snapshots,
  mimicFacets,
  vectors,
] as const;

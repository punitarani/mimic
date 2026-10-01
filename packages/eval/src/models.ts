import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { answerProblems, DECISION_LIST_RATES, type ListRate } from '@mimic/adapters';
import {
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  calibrationTemperatureOf,
  canonicalPredictorId,
  DEFAULT_CONFIG,
  type DecisionRequest,
  decisionModelLimits,
  type EvalRunRecord,
  type Gateway,
  GLIDE_MODEL,
  JEV_MODEL,
  PPLX_DECIDER_MODEL,
  parsePredictorId,
  RejectedResponseError,
  SPAN_MODEL,
  type StateView,
  ulid,
} from '@mimic/core';
import { type RequestStats, requestStats, requestsOf } from './benchmark';
import { clusteredDelta, type Delta, viewInstances } from './evidence';
import { openLocalEngine } from './local';
import { type Loaded, loadData, loadOptsOf, positive, recordRun } from './optimize/commands';
import {
  BudgetStop,
  type Candidate,
  type EvalRecord,
  evaluateCandidate,
  groupBy,
  looTemperatures,
  Meter,
  metricsOf,
  rescaled,
  resolveCandidate,
} from './optimize/evaluate';
import type { EvalInstance } from './optimize/instances';
import { renderReport } from './report';
import {
  configLabel,
  E8_SETTINGS,
  REQUEST_VARIANTS,
  type RequestKey,
  type Setting,
  TUNE_SETTINGS,
  type TuneConfig,
  tune,
} from './tuning';

/**
 * E8 (docs/MODELS.md, ADR-0068): which decision model predicts a person best? Every model answers the same sealed
 * instances from the same states in the same requests, so the arms differ only by model. Served questions (real people)
 * carry the verdict; Twin-2K-500 at k = 30 replicates it. The verdict applies MODELS_RULE, fixed before the first run.
 */

/** The arms in order; the first is the reference the others are judged against. Raw scale: no prompt version. */
export const DEFAULT_PREDICTORS = [
  JEV_MODEL,
  SPAN_MODEL,
  CLEF_MODEL,
  CLEF_FLASH_MODEL,
  PPLX_DECIDER_MODEL,
  GLIDE_MODEL,
].map((model) => `decision:${model}`);
/** `full` first, so `context` reuses its prediction where a state holds no answers yet. */
export const MODELS_VIEWS: StateView[] = E8_SETTINGS.map((s) => s.view);
export const SERVED = 'served';
export const TWIN = 'twin';
const DATASETS = [SERVED, TWIN] as const;

/**
 * Pre-registered (docs/MODELS.md §5). On log loss after each model's leave-one-person-out temperature, `full` view, a
 * challenger against the reference (Jev) is:
 * - `insufficient` with fewer than `minServedInstances` served predictions from `minServedPeople` real people, or
 *   fewer than `minTwinPeople` Twin people at k = `twinK`;
 * - `worse` when the served interval (by question) or the Twin interval (by person) lies entirely above 0;
 * - `better` when the served interval lies entirely below 0, the Twin mean is at most 0, and item accuracy drops by at
 *   most `maxAccuracyDrop` on both;
 * - `level` otherwise.
 * Operational checks sit beside the outcome: error rate at most `maxErrorRateIncrease` above the reference's, and p50
 * and p95 latency per request at most `maxLatencyRatio` × the reference's. Cost is reported, not gated. A challenger
 * is recommended for a shadow only when it is `better` and passes every operational check.
 */
export const MODELS_RULE = {
  twinK: 30,
  minServedInstances: 200,
  minServedPeople: 5,
  minTwinPeople: 30,
  maxAccuracyDrop: 0.01,
  maxErrorRateIncrease: 0.01,
  maxLatencyRatio: 1.5,
} as const;

const NAMES: Record<string, string> = {
  [JEV_MODEL]: 'Jev',
  [SPAN_MODEL]: 'span-01',
  [CLEF_MODEL]: 'clef',
  [CLEF_FLASH_MODEL]: 'clef-flash',
  [PPLX_DECIDER_MODEL]: 'pplx-decider',
  [GLIDE_MODEL]: 'GLiDE',
};

export function modelLabel(predictor: string): string {
  const spec = parsePredictorId(predictor);
  const name = NAMES[spec.model] ?? spec.model;
  return spec.promptVersion ? `${name}@${spec.promptVersion}` : name;
}

// ---------------------------------------------------------------------------------------------------------------
// Canary: one synthetic request per model before anything else is spent
// ---------------------------------------------------------------------------------------------------------------

/** Synthetic, no person's data: its responses re-record the adapter fixtures. */
export function canaryRequest(model: string): DecisionRequest {
  return {
    model,
    state: {
      identity: { occupation: 'Teacher', location: 'Porto, PT' },
      evidence: [{ q: 'How often do you read for pleasure?', a: 'Most evenings' }],
    },
    questions: {
      q_canary_noul: {
        type: 'noul',
        instructions: 'Would the person enjoy a book club?',
        criteria: { true: 'Yes', false: 'No' },
      },
      q_canary_choice: {
        type: 'choice',
        instructions: 'Which weekend plan would the person pick?',
        criteria: { a: 'A quiet day reading', b: 'A loud concert', c: 'A long run' },
      },
      q_canary_score: {
        type: 'score',
        instructions: 'How much does the person value routine?',
        criteria: ['Not at all', 'A little', 'Somewhat', 'Very', 'Extremely'],
      },
    },
  };
}

export interface CanaryResult {
  predictor: string;
  label: string;
  ok: boolean;
  error: string | null;
  modelSnapshot: string | null;
  latencyMs: number | null;
  costUsd: number | null;
}

/** What to fix, for the failures a first run is likely to meet. */
export function canaryHint(model: string, message: string): string {
  if (/CLOUDFLARE_ACCOUNT_ID/.test(message)) return 'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN';
  if (model.startsWith('cloudflare/') && /HTTP 40[13]|Authentication error|10000/.test(message))
    return 'the Cloudflare API token needs Account · Workers AI · Read';
  if (model.startsWith('perplexity/') && /HTTP 401/.test(message))
    return 'set PERPLEXITY_API_KEY to an active Perplexity API key';
  if (model.startsWith('fastino/') && /HTTP 401/.test(message))
    return 'set FASTINO_API_KEY to an active Fastino API key';
  if (model.startsWith('fastino/') && /HTTP 40[23]/.test(message))
    return 'the Fastino account needs credits, a payment method or a higher spend limit';
  if (/No allowed providers/.test(message))
    return "allow the model's provider in OpenRouter's settings (docs/CHALLENGER.md)";
  if (/HTTP 401/.test(message)) return 'check OPENROUTER_API_KEY';
  return '';
}

export async function canary(
  gateway: Gateway,
  predictors: string[],
): Promise<{ results: CanaryResult[]; recorded: unknown[] }> {
  const recorded: unknown[] = [];
  const results = await Promise.all(
    predictors.map(async (predictor): Promise<CanaryResult> => {
      const model = parsePredictorId(predictor).model;
      const req = canaryRequest(model);
      const base = { predictor, label: modelLabel(predictor) };
      try {
        const res = await gateway.decide({ purpose: 'eval.models.canary' }, req);
        const missing = Object.keys(req.questions).filter((k) => !res.answers[k]);
        const problems = [
          ...(missing.length ? [`no answer to ${missing.join(', ')}`] : []),
          ...answerProblems(req, res.answers),
        ];
        recorded.push({ predictor, request: req, response: res.raw });
        return {
          ...base,
          ok: !problems.length,
          error: problems.length ? problems.join('; ') : null,
          modelSnapshot: res.modelSnapshot,
          latencyMs: res.latencyMs,
          costUsd: res.usage.costUsd,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const hint = canaryHint(model, message);
        // A rejected response was answered and billed: keep what it cost and what it said.
        const o = e instanceof RejectedResponseError ? e.outcome : null;
        recorded.push({ predictor, request: req, error: message, ...(o ? { response: o.raw } : {}) });
        return {
          ...base,
          ok: false,
          error: hint ? `${message} (${hint})` : message,
          modelSnapshot: o?.modelSnapshot ?? null,
          latencyMs: o?.latencyMs ?? null,
          costUsd: o?.usage.costUsd ?? null,
        };
      }
    }),
  );
  return { results, recorded };
}

/**
 * The predictors to run after the canary: all of them if it passed. With `dropFailed`, the ones that failed are left out
 * (the report lists them) as long as the reference and a challenger remain; otherwise the run stops here.
 */
export function afterCanary(predictors: string[], results: CanaryResult[], dropFailed: boolean): string[] {
  const failed = results.filter((x) => !x.ok);
  if (!failed.length) return predictors;
  const kept = predictors.filter((p) => !failed.some((x) => x.predictor === p));
  if (!dropFailed || kept[0] !== predictors[0] || kept.length < 2)
    throw new Error(
      `canary failed for ${failed.map((x) => `${x.label}: ${x.error}`).join('; ')}. Nothing else was spent; fix it or leave the model out of --predictors`,
    );
  return kept;
}

// ---------------------------------------------------------------------------------------------------------------
// Running: people in chunks, every model and view per chunk
// ---------------------------------------------------------------------------------------------------------------

export interface Arm {
  dataset: string;
  predictor: string;
  view: StateView;
  /** The setting (`E8_SETTINGS`, `TUNE_SETTINGS`): its view, asked with its request variant. */
  setting: string;
  records: EvalRecord[];
  /** Instance IDs per Decisions request the arm sent (reused predictions sent none). */
  requests: string[][];
}

export interface Chunk {
  dataset: string;
  people: string[];
  instances: EvalInstance[];
}

/** Served people first, then Twin, each in the loader's seeded order, `size` people a chunk. */
export function planChunks(served: EvalInstance[], twin: EvalInstance[], size: number): Chunk[] {
  const out: Chunk[] = [];
  for (const [dataset, instances] of [
    [SERVED, served],
    [TWIN, twin],
  ] as const) {
    const byPerson = groupBy(instances, (i) => i.mimicId);
    const people = [...byPerson.keys()];
    for (let i = 0; i < people.length; i += size) {
      const ps = people.slice(i, i + size);
      out.push({ dataset, people: ps, instances: ps.flatMap((p) => byPerson.get(p)!) });
    }
  }
  return out;
}

/** Each predictor's candidate per request variant its settings use. */
export type ArmCandidates = Map<string, Map<RequestKey, Candidate>>;

export function armCandidates(predictors: string[], settings: Setting[]): ArmCandidates {
  const keys = [...new Set(settings.map((s) => s.request))];
  return new Map(
    predictors.map((p) => [
      p,
      new Map(keys.map((k) => [k, resolveCandidate({ predictor: p, label: p, ...REQUEST_VARIANTS[k] })])),
    ]),
  );
}

/**
 * Every model and setting on one chunk: models side by side, settings in order, one batch limit for all, so each
 * request carries the same questions whichever model answers it. A budget stop anywhere drops the chunk for every
 * arm, so no model keeps a subset the others lack.
 */
export async function runChunk(
  chunk: Chunk,
  cands: ArmCandidates,
  settings: Setting[],
  opts: {
    gateway: Gateway;
    meter: Meter;
    cache: Map<string, EvalRecord>;
    concurrency: number;
    maxQuestions: number;
  },
): Promise<{ arms: Arm[] } | { stop: BudgetStop }> {
  const viewed = new Map(
    [...new Set(settings.map((s) => s.view))].map((v) => [v, viewInstances(chunk.instances, v)]),
  );
  const settled = await Promise.allSettled(
    [...cands].map(async ([predictor, byRequest]) => {
      const arms: Arm[] = [];
      for (const setting of settings) {
        const c = byRequest.get(setting.request)!;
        const vs = viewed.get(setting.view)!;
        const key = (id: string) => `${c.hash}|${id}`;
        // A state another setting already showed this model with the same request (no answers yet: `context` is
        // `full`; on Twin, with no traits, `answers` is `full`) costs nothing again.
        const reused = new Set(vs.filter((x) => opts.cache.has(key(x.v.id))).map((x) => x.v.id));
        const records = await evaluateCandidate(
          c,
          vs.map((x) => x.v),
          {
            gateway: opts.gateway,
            meter: opts.meter,
            concurrency: opts.concurrency,
            cache: opts.cache,
            purpose: 'eval.models',
            maxQuestionsPerRequest: opts.maxQuestions,
          },
        );
        const orig = new Map(vs.map((x) => [x.v.id, x.inst.id]));
        const requests = requestsOf(
          c,
          vs.map((x) => x.v).filter((v) => !reused.has(v.id)),
          opts.maxQuestions,
        ).map((g) => g.map((id) => orig.get(id)!));
        arms.push({
          dataset: chunk.dataset,
          predictor,
          view: setting.view,
          setting: setting.key,
          records: records.map((r) => ({
            ...r,
            instanceId: orig.get(r.instanceId)!,
            ...(reused.has(r.instanceId) ? { costUsd: 0 } : {}),
          })),
          requests,
        });
      }
      return arms;
    }),
  );
  const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  const other = failed.find((s) => !(s.reason instanceof BudgetStop));
  if (other) throw other.reason;
  if (failed.length) return { stop: failed[0]!.reason as BudgetStop };
  return { arms: settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])) };
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------

export interface ModelRow {
  dataset: string;
  predictor: string;
  view: StateView;
  n: number;
  people: number;
  failed: number;
  /** Raw scale: the model's own probabilities. */
  logLoss: number;
  itemAcc: number;
  top1: number;
  brier: number;
  ece: number;
  /** After the leave-one-person-out temperature; `t` is the fit on every person, for reference. */
  cal: { t: number; logLoss: number; itemAcc: number; brier: number; ece: number };
  /** Per Decisions request, `full` view only. */
  requests: RequestStats | null;
  costUsd: number;
  usdPer1k: number;
  snapshots: string[];
  byType: Record<string, { n: number; logLoss: number; itemAcc: number }>;
}

export interface ProductionRow {
  dataset: string;
  t: number;
  n: number;
  logLoss: number;
  itemAcc: number;
  ece: number;
}

export interface ModelDelta {
  dataset: string;
  predictor: string;
  /** Calibrated log loss and item accuracy, challenger − reference. */
  calibrated: Delta;
  /** The same on the raw scale. */
  raw: Delta;
}

export interface LiftRow {
  dataset: string;
  predictor: string;
  /** `full` − `context`, same model, calibrated: below 0 on log loss means it learns from the person's answers. */
  delta: Delta;
  identical: boolean;
}

export interface PairCell {
  dataset: string;
  /** Row − column, calibrated log loss, `full` view. */
  row: string;
  col: string;
  mean: number;
  low: number;
  high: number;
}

export interface OpStats {
  predictions: number;
  errors: number;
  errorRate: number;
  answeredRequests: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  costPerRequestUsd: number;
}

export interface RuleCheck {
  name: string;
  /** Null: reported, not gated. */
  pass: boolean | null;
  detail: string;
}

export type ModelOutcome = 'better' | 'level' | 'worse' | 'insufficient';

export interface ChallengerVerdict {
  predictor: string;
  outcome: ModelOutcome;
  checks: RuleCheck[];
  operational: RuleCheck[];
  recommend: boolean;
}

export interface ModelsVerdict {
  reference: string;
  challengers: ChallengerVerdict[];
  /** The challenger to ship as a shadow next (its own ADR), or null: keep the reference. */
  recommendation: string | null;
}

export interface ModelsReport {
  offline: boolean;
  k: number;
  population: string;
  reference: string;
  predictors: string[];
  /** Left out after a failed canary (`--drop-failed-canary`). */
  dropped: string[];
  views: StateView[];
  maxQuestionsPerRequest: number;
  costUsd: number;
  stopReason: string | null;
  canary: CanaryResult[];
  datasets: Array<{ key: string; people: number; instances: number }>;
  rows: ModelRow[];
  production: ProductionRow[];
  deltas: ModelDelta[];
  lift: LiftRow[];
  pairwise: PairCell[];
  ops: Record<string, OpStats>;
  rates: Record<string, ListRate>;
  verdict: ModelsVerdict;
  /** E8b, on a tuning run (`--tune`). */
  tuning?: TuningReport;
}

export interface TunedModel {
  dataset: string;
  predictor: string;
  /** Chosen on everyone: the configuration to deploy. */
  chosen: TuneConfig;
  /** People whose own fold chose `chosen`, of `people`. */
  agree: number;
  people: number;
  /** E8 as run (`full`, one leave-one-person-out temperature), and the model tuned (nested). */
  incumbent: { logLoss: number; itemAcc: number };
  tuned: { logLoss: number; itemAcc: number };
  /** `chosen` scored on everyone, as E8 scores a setting: optimistic, since everyone also chose it. */
  inSample: number;
  /** Tuned − incumbent, paired. */
  gain: Delta;
  scores: Array<{ config: TuneConfig; logLoss: number }>;
}

export interface TuningReport {
  settings: Setting[];
  models: TunedModel[];
  /** Each tuned challenger − the tuned reference. */
  deltas: Array<{ dataset: string; predictor: string; delta: Delta }>;
  /** The tuned reference − the reference as served (its production temperature, `full`), when the reference is Jev. */
  production: Array<{ dataset: string; t: number; delta: Delta }>;
  /**
   * MODELS_RULE's quality checks, tuned reference against the reference as served: true leads to a shadow for its
   * chosen setting (its own ADR). Null without both datasets.
   */
  productionBetter: boolean | null;
  /** Over the requests of each model's chosen settings, both datasets. */
  ops: Record<string, OpStats>;
  verdict: ModelsVerdict;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : a > 0 ? Number.POSITIVE_INFINITY : 1);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f4 = (x: number) => x.toFixed(4);
const sgn = (x: number, d = 4) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;

/** One seed per comparison, so the verdict, the table against the reference and the pairwise matrix agree. */
const pairSeed = (dataset: string, a: string, b: string) => `models:${dataset}:${a}:${b}`;

/** Each record at the temperature fitted on everyone but its person, and the fit on everyone. */
export function calibrated(recs: EvalRecord[]): { records: EvalRecord[]; t: number } {
  const fit = looTemperatures(recs);
  return { records: recs.map((r) => rescaled(r, fit.byPerson.get(r.mimicId) ?? 1)), t: fit.all };
}

/** The served interval is read by question and Twin's by person, as E6 reads them (docs/EVIDENCE.md §5). */
const interval = (dataset: string, d: Delta): [number, number] =>
  dataset === SERVED ? d.logLoss.byQuestion : [d.logLoss.ciLow, d.logLoss.ciHigh];

export interface RuleInput {
  reference: string;
  challengers: string[];
  k: number;
  /** Calibrated `full` records per predictor. */
  served: Map<string, EvalRecord[]>;
  twin: Map<string, EvalRecord[]>;
  ops: Record<string, OpStats>;
  /** b − a on a dataset; the report passes its memoized deltas so the numbers match. */
  delta?: (dataset: string, a: string, b: string) => Delta;
}

export function decideModels(input: RuleInput, rule = MODELS_RULE): ModelsVerdict {
  const ref = input.reference;
  const recs = (dataset: string, p: string) => (dataset === SERVED ? input.served : input.twin).get(p) ?? [];
  const delta =
    input.delta ??
    ((dataset: string, a: string, b: string) =>
      clusteredDelta(recs(dataset, a), recs(dataset, b), pairSeed(dataset, a, b)));
  const f = (x: number) => sgn(x);
  const challengers = input.challengers.map((c): ChallengerVerdict => {
    const ds = delta(SERVED, ref, c);
    const dt = delta(TWIN, ref, c);
    const [sLow, sHigh] = interval(SERVED, ds);
    const [tLow, tHigh] = interval(TWIN, dt);
    const enoughServed = ds.n >= rule.minServedInstances && ds.people >= rule.minServedPeople;
    const enoughTwin = input.k === rule.twinK && dt.people >= rule.minTwinPeople;
    const accHeld = ds.itemAcc.mean >= -rule.maxAccuracyDrop && dt.itemAcc.mean >= -rule.maxAccuracyDrop;
    const checks: RuleCheck[] = [
      {
        name: 'enough served data',
        pass: enoughServed,
        detail: `${ds.n} paired predictions from ${ds.people} people (needs ${rule.minServedInstances} from ${rule.minServedPeople})`,
      },
      {
        name: 'enough Twin data',
        pass: enoughTwin,
        detail: `${dt.people} people at k = ${input.k} (needs ${rule.minTwinPeople} at k = ${rule.twinK})`,
      },
      {
        name: 'served log loss',
        pass: ds.n > 0 && sHigh < 0,
        detail: `Δ ${f(ds.logLoss.mean)} [${f(sLow)}, ${f(sHigh)}] by question (below 0 is better; the interval must be)`,
      },
      {
        name: 'Twin log loss',
        pass: dt.n > 0 && dt.logLoss.mean <= 0,
        detail: `Δ ${f(dt.logLoss.mean)} [${f(tLow)}, ${f(tHigh)}] by person (the mean must be at most 0)`,
      },
      {
        name: 'accuracy held',
        pass: accHeld,
        detail: `Δ ${pts(ds.itemAcc.mean)} points served, ${pts(dt.itemAcc.mean)} on Twin (no worse than −${(rule.maxAccuracyDrop * 100).toFixed(0)})`,
      },
    ];
    const outcome: ModelOutcome =
      !enoughServed || !enoughTwin
        ? 'insufficient'
        : sLow > 0 || tLow > 0
          ? 'worse'
          : checks.slice(2).every((x) => x.pass)
            ? 'better'
            : 'level';
    const o = input.ops[c];
    const r = input.ops[ref];
    const both = !!o && !!r && o.answeredRequests > 0 && r.answeredRequests > 0;
    const operational: RuleCheck[] = [
      {
        name: 'error rate',
        pass: !!o && !!r && o.errorRate <= r.errorRate + rule.maxErrorRateIncrease,
        detail:
          o && r
            ? `${pct(o.errorRate)} vs ${pct(r.errorRate)} (at most +${pct(rule.maxErrorRateIncrease)})`
            : '—',
      },
      {
        name: 'latency',
        pass:
          both &&
          ratio(o.p50LatencyMs, r.p50LatencyMs) <= rule.maxLatencyRatio &&
          ratio(o.p95LatencyMs, r.p95LatencyMs) <= rule.maxLatencyRatio,
        detail: both
          ? `p50 ${Math.round(o.p50LatencyMs)} vs ${Math.round(r.p50LatencyMs)} ms, p95 ${Math.round(o.p95LatencyMs)} vs ${Math.round(r.p95LatencyMs)} ms (at most ${rule.maxLatencyRatio}×)`
          : 'no answered requests to compare',
      },
      {
        name: 'cost',
        pass: null,
        detail: both
          ? `$${o.costPerRequestUsd.toFixed(6)} vs $${r.costPerRequestUsd.toFixed(6)} per request (${ratio(o.costPerRequestUsd, r.costPerRequestUsd).toFixed(1)}×); reported, not gated`
          : 'reported, not gated',
      },
    ];
    return {
      predictor: c,
      outcome,
      checks,
      operational,
      recommend: outcome === 'better' && operational.every((x) => x.pass !== false),
    };
  });
  // Several may pass: the one with the lowest served log loss.
  const served = (c: string) => metricsOf(input.served.get(c) ?? []).logLoss;
  const recommended = challengers
    .filter((c) => c.recommend)
    .sort((a, b) => served(a.predictor) - served(b.predictor));
  return { reference: ref, challengers, recommendation: recommended[0]?.predictor ?? null };
}

/** Errors, latency and cost over the arms' requests together; null without a prediction. */
export function opsOf(arms: Arm[]): OpStats | null {
  const records = arms.flatMap((a) => a.records);
  if (!records.length) return null;
  const stats = requestStats(
    records,
    arms.flatMap((a) => a.requests),
  );
  const errors = records.filter((r) => !r.ok).length;
  return {
    predictions: records.length,
    errors,
    errorRate: errors / records.length,
    answeredRequests: stats.answeredRequests,
    p50LatencyMs: stats.p50LatencyMs,
    p95LatencyMs: stats.p95LatencyMs,
    costPerRequestUsd: stats.costPerRequestUsd,
  };
}

export function analyzeModels(
  arms: Arm[],
  o: {
    reference: string;
    predictors: string[];
    dropped?: string[];
    views: StateView[];
    k: number;
    population: string;
    maxQuestionsPerRequest: number;
    costUsd: number;
    stopReason: string | null;
    offline: boolean;
    canary: CanaryResult[];
  },
): ModelsReport {
  // E8 as pre-registered reads only its own settings; a tuning run's other settings are E8b's (`analyzeTuning`).
  const e8 = arms.filter((a) => E8_SETTINGS.some((s) => s.key === a.setting));
  const arm = (dataset: string, predictor: string, setting: string) =>
    e8.find((a) => a.dataset === dataset && a.predictor === predictor && a.setting === setting);
  const cal = new Map<Arm, EvalRecord[]>();
  const rows: ModelRow[] = [];
  for (const a of e8) {
    const { records, t } = calibrated(a.records);
    cal.set(a, records);
    const m = metricsOf(a.records);
    const mc = metricsOf(records);
    const costUsd = sum(a.records.map((r) => r.costUsd));
    rows.push({
      dataset: a.dataset,
      predictor: a.predictor,
      view: a.view,
      n: m.n,
      people: new Set(a.records.map((r) => r.mimicId)).size,
      failed: m.failures,
      logLoss: m.logLoss,
      itemAcc: m.itemAcc,
      top1: m.top1,
      brier: m.brier,
      ece: m.ece,
      cal: { t, logLoss: mc.logLoss, itemAcc: mc.itemAcc, brier: mc.brier, ece: mc.ece },
      requests: a.view === 'full' ? requestStats(a.records, a.requests) : null,
      costUsd,
      usdPer1k: m.n ? (1000 * costUsd) / m.n : 0,
      snapshots: [...new Set(a.records.filter((r) => r.ok).map((r) => r.modelSnapshot))].sort(),
      byType: Object.fromEntries(
        [...groupBy(records, (r) => r.type).entries()]
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([type, rs]) => {
            const t = metricsOf(rs);
            return [type, { n: t.n, logLoss: t.logLoss, itemAcc: t.itemAcc }];
          }),
      ),
    });
  }
  const datasets = DATASETS.filter((d) => e8.some((a) => a.dataset === d));
  const calFull = (dataset: string, p: string) => {
    const a = arm(dataset, p, 'full');
    return a ? cal.get(a)! : [];
  };

  // Jev as production serves it: its registered temperature on the raw scale, nothing fitted here.
  const production: ProductionRow[] = [];
  const refSpec = parsePredictorId(o.reference);
  const productionT = calibrationTemperatureOf(canonicalPredictorId(DEFAULT_CONFIG.predictor.primary));
  if (refSpec.model === JEV_MODEL && refSpec.promptVersion === undefined)
    for (const d of datasets) {
      const a = arm(d, o.reference, 'full');
      if (!a) continue;
      const m = metricsOf(a.records.map((r) => rescaled(r, productionT)));
      production.push({
        dataset: d,
        t: productionT,
        n: m.n,
        logLoss: m.logLoss,
        itemAcc: m.itemAcc,
        ece: m.ece,
      });
    }

  const memo = new Map<string, Delta>();
  const pair = (d: string, x: string, y: string): Delta => {
    const seed = pairSeed(d, x, y);
    const hit = memo.get(seed);
    if (hit) return hit;
    const delta = clusteredDelta(calFull(d, x), calFull(d, y), seed);
    memo.set(seed, delta);
    return delta;
  };
  const deltas: ModelDelta[] = [];
  const lift: LiftRow[] = [];
  const pairwise: PairCell[] = [];
  for (const d of datasets) {
    const ref = arm(d, o.reference, 'full');
    for (const p of o.predictors) {
      const a = arm(d, p, 'full');
      if (ref && a && p !== o.reference)
        deltas.push({
          dataset: d,
          predictor: p,
          calibrated: pair(d, o.reference, p),
          raw: clusteredDelta(ref.records, a.records, `${pairSeed(d, o.reference, p)}:raw`),
        });
      const ctx = arm(d, p, 'context');
      if (a && ctx) {
        const states = new Map(a.records.map((r) => [r.instanceId, r.stateHash]));
        lift.push({
          dataset: d,
          predictor: p,
          delta: clusteredDelta(cal.get(ctx)!, cal.get(a)!, `${pairSeed(d, p, p)}:lift`),
          identical: ctx.records.every((r) => states.get(r.instanceId) === r.stateHash),
        });
      }
    }
    for (let i = 0; i < o.predictors.length; i++)
      for (let j = i + 1; j < o.predictors.length; j++) {
        const [x, y] = [o.predictors[i]!, o.predictors[j]!];
        if (!calFull(d, x).length || !calFull(d, y).length) continue;
        // y − x, read both ways.
        const delta = pair(d, x, y);
        const [low, high] = interval(d, delta);
        pairwise.push({ dataset: d, row: y, col: x, mean: delta.logLoss.mean, low, high });
        pairwise.push({ dataset: d, row: x, col: y, mean: -delta.logLoss.mean, low: -high, high: -low });
      }
  }

  // Operations over every request of the `full` view, both datasets together.
  const ops: Record<string, OpStats> = {};
  for (const p of o.predictors) {
    const x = opsOf(e8.filter((a) => a.predictor === p && a.setting === 'full'));
    if (x) ops[p] = x;
  }

  const verdict = decideModels({
    reference: o.reference,
    challengers: o.predictors.filter((p) => p !== o.reference),
    k: o.k,
    served: new Map(o.predictors.map((p) => [p, calFull(SERVED, p)])),
    twin: new Map(o.predictors.map((p) => [p, calFull(TWIN, p)])),
    ops,
    delta: pair,
  });
  const rates: Record<string, ListRate> = {};
  for (const p of o.predictors) {
    const model = parsePredictorId(p).model;
    const rate = DECISION_LIST_RATES[model];
    if (rate) rates[model] = rate;
  }
  return {
    offline: o.offline,
    k: o.k,
    population: o.population,
    reference: o.reference,
    predictors: o.predictors,
    dropped: o.dropped ?? [],
    views: o.views,
    maxQuestionsPerRequest: o.maxQuestionsPerRequest,
    costUsd: o.costUsd,
    stopReason: o.stopReason,
    canary: o.canary,
    datasets: datasets.map((d) => {
      const a = arm(d, o.reference, 'full') ?? e8.find((x) => x.dataset === d)!;
      return { key: d, people: new Set(a.records.map((r) => r.mimicId)).size, instances: a.records.length };
    }),
    rows,
    production,
    deltas,
    lift,
    pairwise,
    ops,
    rates,
    verdict,
  };
}

/**
 * E8b (docs/MODELS.md §9, ADR-0069): every model, Jev included, at the configuration nested leave-one-person-out
 * cross-validation chooses per dataset; MODELS_RULE then compares the tuned challengers with the tuned reference.
 */
export function analyzeTuning(
  arms: Arm[],
  o: { reference: string; predictors: string[]; settings: Setting[]; k: number },
): TuningReport {
  const order = o.settings.map((s) => s.key);
  const datasets = DATASETS.filter((d) => arms.some((a) => a.dataset === d));
  const tuned = new Map<string, EvalRecord[]>();
  const models: TunedModel[] = [];
  const chosenArms = new Map<string, Arm[]>();
  for (const d of datasets)
    for (const p of o.predictors) {
      const mine = arms.filter((a) => a.dataset === d && a.predictor === p);
      if (!mine.length) continue;
      const res = tune(new Map(mine.map((a) => [a.setting, a.records])), order);
      tuned.set(`${d}|${p}`, res.records);
      const incumbent = calibrated(mine.find((a) => a.setting === order[0])!.records).records;
      const mi = metricsOf(incumbent);
      const mt = metricsOf(res.records);
      models.push({
        dataset: d,
        predictor: p,
        chosen: res.chosen,
        agree: res.agree,
        people: res.people,
        incumbent: { logLoss: mi.logLoss, itemAcc: mi.itemAcc },
        tuned: { logLoss: mt.logLoss, itemAcc: mt.itemAcc },
        inSample: res.scores.find((x) => x.config === res.chosen)!.logLoss,
        gain: clusteredDelta(incumbent, res.records, `${pairSeed(d, p, p)}:tuned`),
        scores: res.scores,
      });
      chosenArms.set(p, [...(chosenArms.get(p) ?? []), mine.find((a) => a.setting === res.chosen.setting)!]);
    }

  const recs = (d: string, p: string) => tuned.get(`${d}|${p}`) ?? [];
  const memo = new Map<string, Delta>();
  const pair = (d: string, a: string, b: string): Delta => {
    const seed = `${pairSeed(d, a, b)}:tuned`;
    const hit = memo.get(seed);
    if (hit) return hit;
    const delta = clusteredDelta(recs(d, a), recs(d, b), seed);
    memo.set(seed, delta);
    return delta;
  };
  const challengers = o.predictors.filter((p) => p !== o.reference);
  const deltas = datasets.flatMap((d) =>
    challengers
      .filter((p) => recs(d, p).length && recs(d, o.reference).length)
      .map((p) => ({ dataset: d, predictor: p, delta: pair(d, o.reference, p) })),
  );

  const production: TuningReport['production'] = [];
  const refSpec = parsePredictorId(o.reference);
  if (refSpec.model === JEV_MODEL && refSpec.promptVersion === undefined) {
    const t = calibrationTemperatureOf(canonicalPredictorId(DEFAULT_CONFIG.predictor.primary));
    for (const d of datasets) {
      const full = arms.find((a) => a.dataset === d && a.predictor === o.reference && a.setting === 'full');
      if (!full || !recs(d, o.reference).length) continue;
      const served = full.records.map((r) => rescaled(r, t));
      production.push({
        dataset: d,
        t,
        delta: clusteredDelta(
          served,
          recs(d, o.reference),
          `${pairSeed(d, o.reference, o.reference)}:production`,
        ),
      });
    }
  }

  const ps = production.find((x) => x.dataset === SERVED)?.delta;
  const pt = production.find((x) => x.dataset === TWIN)?.delta;
  const drop = MODELS_RULE.maxAccuracyDrop;
  const productionBetter =
    ps && pt
      ? ps.logLoss.byQuestion[1] < 0 &&
        pt.logLoss.mean <= 0 &&
        ps.itemAcc.mean >= -drop &&
        pt.itemAcc.mean >= -drop
      : null;

  const ops: Record<string, OpStats> = {};
  for (const [p, as] of chosenArms) {
    const x = opsOf(as);
    if (x) ops[p] = x;
  }
  const verdict = decideModels({
    reference: o.reference,
    challengers,
    k: o.k,
    served: new Map(o.predictors.map((p) => [p, recs(SERVED, p)])),
    twin: new Map(o.predictors.map((p) => [p, recs(TWIN, p)])),
    ops,
    delta: pair,
  });
  return { settings: o.settings, models, deltas, production, productionBetter, ops, verdict };
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

export function datasetTitle(key: string, r: Pick<ModelsReport, 'k' | 'population'>): string {
  return key === SERVED
    ? `Mimic: served questions (${r.population === 'real' ? 'real people' : 'all people, not results'})`
    : `Twin-2K-500: wave 4 held out, k = ${r.k}`;
}

/** The verdict heading, the outcome per challenger and every check behind it. */
function verdictLines(v: ModelsVerdict, heading: string): string[] {
  const label = modelLabel;
  const rec = v.recommendation;
  const undecided = v.challengers.every((c) => c.outcome === 'insufficient');
  return [
    `${heading}: ${rec ? `${label(rec)} is better than ${label(v.reference)}; ship it as a shadow next` : undecided ? `insufficient data; keep ${label(v.reference)}` : `keep ${label(v.reference)}`}`,
    '',
    '| Challenger | Outcome | Operational checks | Recommended |',
    '| --- | --- | --- | --- |',
    ...v.challengers.map(
      (c) =>
        `| ${label(c.predictor)} | ${c.outcome} | ${
          c.operational.every((x) => x.pass !== false)
            ? 'pass'
            : `fail (${c.operational
                .filter((x) => x.pass === false)
                .map((x) => x.name)
                .join(', ')})`
        } | ${c.recommend ? 'yes' : 'no'} |`,
    ),
    '',
    '| Challenger | Check | Pass | Detail |',
    '| --- | --- | --- | --- |',
    ...v.challengers.flatMap((c) =>
      [...c.checks, ...c.operational].map(
        (x) =>
          `| ${label(c.predictor)} | ${x.name} | ${x.pass === null ? '—' : x.pass ? 'yes' : 'no'} | ${x.detail} |`,
      ),
    ),
    '',
  ];
}

const ci = (d: Delta, dataset: string) => {
  const [low, high] = dataset === SERVED ? d.logLoss.byQuestion : [d.logLoss.ciLow, d.logLoss.ciHigh];
  return `${sgn(d.logLoss.mean)} [${sgn(low)}, ${sgn(high)}]`;
};

export function renderTuning(t: TuningReport): string[] {
  const label = modelLabel;
  const dsName = (d: string) => (d === SERVED ? 'served' : 'Twin');
  const out = [
    '## E8b: each model at its best',
    '',
    `Every model was also asked in ${t.settings.length} settings (the table at the end), each with one temperature or one per question type. A person is scored at the configuration chosen on everyone else (nested leave-one-person-out), so tuned numbers carry no selection optimism; "in sample" is the chosen configuration scored on everyone, which does. The rule is MODELS_RULE again, tuned challenger against tuned ${label(t.verdict.reference)} (docs/MODELS.md §9).`,
    '',
    ...verdictLines(t.verdict, '### E8b verdict'),
    '### What tuning chose',
    '',
    '| Model | Data | Chosen | Folds agreeing | Log loss: E8 → tuned (in sample) | Tuning gain | Δ item accuracy, points |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...t.models.map(
      (m) =>
        `| ${label(m.predictor)} | ${dsName(m.dataset)} | ${configLabel(m.chosen)} | ${m.agree} of ${m.people} | ${f4(m.incumbent.logLoss)} → ${f4(m.tuned.logLoss)} (${f4(m.inSample)}) | ${ci(m.gain, m.dataset)} | ${pts(m.tuned.itemAcc - m.incumbent.itemAcc)} |`,
    ),
    '',
    `Tuning gain is tuned − E8 on log loss, paired (served by question, Twin by person); below 0 is better.`,
    '',
  ];
  if (t.deltas.length)
    out.push(
      `### Tuned against tuned ${label(t.verdict.reference)} (challenger − ${label(t.verdict.reference)})`,
      '',
      '| Model | Data | Δ log loss | Δ item accuracy, points | People better / worse |',
      '| --- | --- | --- | --- | --- |',
      ...t.deltas.map(
        (x) =>
          `| ${label(x.predictor)} | ${dsName(x.dataset)} | ${ci(x.delta, x.dataset)} | ${pts(x.delta.itemAcc.mean)} | ${x.delta.better} / ${x.delta.worse} |`,
      ),
      '',
    );
  if (t.production.length)
    out.push(
      `### Tuned ${label(t.verdict.reference)} against ${label(t.verdict.reference)} as served`,
      '',
      '| Data | Served at | Δ log loss | Δ item accuracy, points |',
      '| --- | --- | --- | --- |',
      ...t.production.map(
        (x) =>
          `| ${dsName(x.dataset)} | full, T = ${x.t} | ${ci(x.delta, x.dataset)} | ${pts(x.delta.itemAcc.mean)} |`,
      ),
      '',
      ...(t.productionBetter === null
        ? []
        : [
            `By MODELS_RULE's quality checks, tuned ${label(t.verdict.reference)} is ${t.productionBetter ? 'better than' : 'not better than'} ${label(t.verdict.reference)} as served${t.productionBetter ? ': its chosen served setting goes to a shadow next, in its own ADR' : ''}.`,
            '',
          ]),
    );
  const ps = [...new Set(t.models.map((m) => m.predictor))];
  for (const d of DATASETS) {
    const ms = t.models.filter((m) => m.dataset === d);
    if (!ms.length) continue;
    out.push(
      `### Every setting, ${dsName(d)} (log loss at one leave-one-person-out temperature; * chosen)`,
      '',
      `| Setting | View | Request | ${ps.map(label).join(' | ')} |`,
      `| --- | --- | --- | ${ps.map(() => '---').join(' | ')} |`,
      ...t.settings.map((s) => {
        const cell = (p: string) => {
          const m = ms.find((x) => x.predictor === p);
          const x = m?.scores.find((y) => y.config.setting === s.key && y.config.calibration === 'one');
          if (!m || !x) return '—';
          return `${f4(x.logLoss)}${m.chosen.setting === s.key ? '*' : ''}`;
        };
        return `| ${s.key} | ${s.view} | ${s.request} | ${ps.map(cell).join(' | ')} |`;
      }),
      '',
    );
  }
  return out;
}

export function renderModels(r: ModelsReport): string[] {
  const label = modelLabel;
  const out: string[] = [];
  if (r.offline)
    out.push('> Offline run with fake providers: checks the harness only. These numbers mean nothing.', '');
  out.push(
    `E8 compares ${r.predictors.map((p) => `\`${p}\``).join(', ')} on the same sealed instances, from the same states, in the same requests (served questions one per request, Twin's at most ${r.maxQuestionsPerRequest} per request). Every model also predicts from the context alone. Probabilities are compared after a temperature per model, fitted with each person left out; the reference is ${label(r.reference)}.`,
    '',
    `Data: ${r.datasets.map((d) => `${datasetTitle(d.key, r)}, ${d.instances} predictions from ${d.people} people`).join('; ') || 'none'}. Spend $${r.costUsd.toFixed(4)}.`,
    '',
  );
  if (r.dropped?.length)
    out.push(`**Left out after a failed canary:** ${r.dropped.map(label).join(', ')} (see Canary).`, '');
  if (r.stopReason) out.push(`**Stopped early:** ${r.stopReason}`, '');

  out.push(
    ...verdictLines(r.verdict, r.tuning ? '## E8 verdict, every model asked as E8 asked it' : '## Verdict'),
    'The rule is MODELS_RULE in packages/eval/src/models.ts, fixed before the first run (docs/MODELS.md §5). Served intervals resample questions and Twin intervals resample people (2,000 seeded resamples, 5th–95th percentile).',
    '',
  );
  if (r.tuning) out.push(...renderTuning(r.tuning));
  out.push(
    '## Canary',
    '',
    'One synthetic request per model (a yes/no, a choice and a score question) before anything else ran.',
    '',
    '| Model | Snapshot | Latency | Cost | Result |',
    '| --- | --- | --- | --- | --- |',
    ...r.canary.map(
      (c) =>
        `| ${c.label} | ${c.modelSnapshot ? `\`${c.modelSnapshot}\`` : '—'} | ${c.latencyMs === null ? '—' : `${Math.round(c.latencyMs)} ms`} | ${c.costUsd === null ? '—' : `$${c.costUsd.toFixed(6)}`} | ${c.ok ? 'ok' : (c.error ?? 'failed')} |`,
    ),
    '',
  );

  for (const d of r.datasets) {
    const rows = r.rows.filter((x) => x.dataset === d.key);
    out.push(
      `## ${datasetTitle(d.key, r)}`,
      '',
      '| Model | View | n | People | Log loss | T | Raw log loss | Item accuracy | Top-1 | Brier | ECE | Failed | p50 / p95 per request | $ per request | $ per 1k predictions |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(
        (x) =>
          `| ${label(x.predictor)} | ${x.view} | ${x.n} | ${x.people} | ${f4(x.cal.logLoss)} | ${x.cal.t} | ${f4(x.logLoss)} | ${pct(x.cal.itemAcc)} | ${pct(x.top1)} | ${f4(x.cal.brier)} | ${x.cal.ece.toFixed(3)} | ${x.failed} | ${x.requests?.answeredRequests ? `${Math.round(x.requests.p50LatencyMs)} / ${Math.round(x.requests.p95LatencyMs)} ms` : '—'} | ${x.requests?.answeredRequests ? `$${x.requests.costPerRequestUsd.toFixed(6)}` : '—'} | $${x.usdPer1k.toFixed(4)} |`,
      ),
      ...r.production
        .filter((p) => p.dataset === d.key)
        .map(
          (p) =>
            `| Jev as served (T = ${p.t}, fitted on Mimic dev people) | full | ${p.n} | — | ${f4(p.logLoss)} | ${p.t} | — | ${pct(p.itemAcc)} | — | — | ${p.ece.toFixed(3)} | — | — | — | — |`,
        ),
      '',
      'Log loss, item accuracy, Brier and ECE are after the leave-one-person-out temperature; T is the temperature fitted on everyone, for reference. Top-1 never moves with a temperature.',
      '',
      `### Against ${label(r.reference)} (full view, challenger − ${label(r.reference)})`,
      '',
      '| Model | n | People | Δ log loss | By person | By question | Δ item accuracy, points | People better / worse | Δ raw log loss |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...r.deltas
        .filter((x) => x.dataset === d.key)
        .map(
          (x) =>
            `| ${label(x.predictor)} | ${x.calibrated.n} | ${x.calibrated.people} | ${sgn(x.calibrated.logLoss.mean)} | [${sgn(x.calibrated.logLoss.ciLow)}, ${sgn(x.calibrated.logLoss.ciHigh)}] | [${sgn(x.calibrated.logLoss.byQuestion[0])}, ${sgn(x.calibrated.logLoss.byQuestion[1])}] | ${pts(x.calibrated.itemAcc.mean)} | ${x.calibrated.better} / ${x.calibrated.worse} | ${sgn(x.raw.logLoss.mean)} |`,
        ),
      '',
      '### What the answers add (full − context, same model)',
      '',
      '| Model | n | Δ log loss | By person | By question | Δ item accuracy, points | People better / worse |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...r.lift
        .filter((x) => x.dataset === d.key)
        .map((x) =>
          x.identical
            ? `| ${label(x.predictor)} | ${x.delta.n} | identical states | — | — | — | — |`
            : `| ${label(x.predictor)} | ${x.delta.n} | ${sgn(x.delta.logLoss.mean)} | [${sgn(x.delta.logLoss.ciLow)}, ${sgn(x.delta.logLoss.ciHigh)}] | [${sgn(x.delta.logLoss.byQuestion[0])}, ${sgn(x.delta.logLoss.byQuestion[1])}] | ${pts(x.delta.itemAcc.mean)} | ${x.delta.better} / ${x.delta.worse} |`,
        ),
      '',
    );
    const cells = r.pairwise.filter((x) => x.dataset === d.key);
    if (cells.length) {
      const ps = r.predictors.filter((p) => cells.some((c) => c.row === p));
      out.push(
        `### Pairwise (Δ log loss, row − column; * where the interval ${d.key === SERVED ? 'by question' : 'by person'} excludes 0)`,
        '',
        `| | ${ps.map(label).join(' | ')} |`,
        `| --- | ${ps.map(() => '---').join(' | ')} |`,
        ...ps.map((row) => {
          const cell = (col: string) => {
            if (col === row) return '—';
            const c = cells.find((x) => x.row === row && x.col === col);
            return c ? `${sgn(c.mean, 3)}${c.low > 0 || c.high < 0 ? '*' : ''}` : '';
          };
          return `| ${label(row)} | ${ps.map(cell).join(' | ')} |`;
        }),
        '',
      );
    }
    const types = [...new Set(rows.flatMap((x) => Object.keys(x.byType)))].sort();
    const full = rows.filter((x) => x.view === 'full');
    if (types.length)
      out.push(
        '### By question type (full view; log loss / item accuracy)',
        '',
        `| Type | n | ${full.map((x) => label(x.predictor)).join(' | ')} |`,
        `| --- | --- | ${full.map(() => '---').join(' | ')} |`,
        ...types.map((t) => {
          const n = full[0]?.byType[t]?.n ?? 0;
          return `| ${t} | ${n} | ${full
            .map((x) => {
              const b = x.byType[t];
              return b ? `${f4(b.logLoss)} / ${pct(b.itemAcc)}` : '—';
            })
            .join(' | ')} |`;
        }),
        '',
        'span-01 takes only yes/no questions: it answers a choice or score question as one yes/no per option, normalized (ADR-0051).',
        '',
      );
  }

  const rated = Object.entries(r.rates);
  if (rated.length)
    out.push(
      '## Prices',
      '',
      "OpenRouter returns each call's cost. Workers AI and Perplexity return only token counts, so their calls are priced at the registered list rate (ADR-0068):",
      '',
      '| Model | $ per M input tokens | $ per M output tokens | Source | Read |',
      '| --- | --- | --- | --- | --- |',
      ...rated.map(
        ([m, x]) =>
          `| \`${m}\` | ${x.inputUsdPerMTok} | ${x.outputUsdPerMTok} | ${x.source} | ${x.checkedAt} |`,
      ),
      '',
    );
  out.push(
    'Failed predictions count as uniform. Latency is per Decisions request as production batches them, over requests that answered, measured from the machine that ran the eval. Clef and the decider have no dated snapshot: their numbers hold for the day of the run.',
    '',
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------------------------

const csv = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Decision predictors only, distinct, on one prompt version, so the arms differ by model alone. */
export function modelArms(list: string): string[] {
  const ids = csv(list).map(canonicalPredictorId);
  if (ids.length < 2) throw new Error('--predictors needs at least two decision predictors');
  if (new Set(ids).size !== ids.length)
    throw new Error(`--predictors repeats a predictor: ${ids.join(', ')}`);
  const specs = ids.map((id) => parsePredictorId(id));
  const llm = ids.filter((_, i) => specs[i]!.kind !== 'decision');
  if (llm.length) throw new Error(`--predictors takes decision predictors only: ${llm.join(', ')}`);
  if (new Set(specs.map((s) => s.promptVersion ?? '')).size > 1)
    throw new Error('--predictors must share one prompt version, so the arms differ only by model');
  return ids;
}

export async function modelsCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      predictors: { type: 'string', default: DEFAULT_PREDICTORS.join(',') },
      population: { type: 'string', default: 'real' },
      split: { type: 'string', default: 'all' },
      k: { type: 'string', default: String(MODELS_RULE.twinK) },
      limit: { type: 'string' },
      'max-targets': { type: 'string', default: '20' },
      'max-usd': { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      'max-questions': { type: 'string', default: '20' },
      'chunk-people': { type: 'string', default: '10' },
      seed: { type: 'string', default: 'models' },
      'skip-canary': { type: 'boolean', default: false },
      'drop-failed-canary': { type: 'boolean', default: false },
      tune: { type: 'boolean', default: false },
      name: { type: 'string' },
      out: { type: 'string' },
      summary: { type: 'string' },
      publish: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required');
  if (values.publish && !['local', 'preview', 'prod'].includes(values.publish))
    throw new Error('--publish must be local, preview or prod');
  if (!['real', 'all'].includes(values.population)) throw new Error('--population must be real or all');
  const predictors = modelArms(values.predictors);
  const reference = predictors[0]!;
  const k = positive('k', values.k);
  // At 200 Twin people with all six models, E8 spends about $7 and E8b about $28 (docs/MODELS.md §8, §9).
  const maxUsd = positive('max-usd', values['max-usd'] ?? (values.tune ? '40' : '10'), false);
  const concurrency = positive('concurrency', values.concurrency);
  const chunkPeople = positive('chunk-people', values['chunk-people']);
  const settings = values.tune ? TUNE_SETTINGS : E8_SETTINGS;
  const cands = armCandidates(predictors, settings);
  // Twin's targets share a state and go in batches of `--max-questions`, never above any model's own limit. Served
  // states are built per question, so served questions go one per request in both views, keeping lift (full −
  // context) free of batch effects.
  const maxQuestions = Math.min(
    positive('max-questions', values['max-questions']),
    ...predictors.map(
      (p) => decisionModelLimits(parsePredictorId(p).model).maxQuestions ?? Number.POSITIVE_INFINITY,
    ),
  );

  const loaded: Loaded = await loadData(values.data, loadOptsOf({ ...values, k: String(k) }));
  const online = loaded.instances.filter((i) => i.mode === 'online');
  const served = online.filter((i) => values.population === 'all' || i.population === 'real');
  const twin = loaded.instances.filter((i) => i.mode === 'heldout');
  const left = online.length - served.length;
  console.log(
    `E8${values.tune ? 'b' : ''}: ${predictors.map(modelLabel).join(', ')}; ${served.length} served questions${left ? ` (${left} from scripted or imported people left out)` : ''}, ${twin.length} Twin items at k = ${k}; ${settings.length} settings`,
  );
  if (!served.length && !twin.length) throw new Error(`no instances in ${values.data}`);

  const runDir = resolve(values.out ?? `data/models/${ulid()}`);
  mkdirSync(runDir, { recursive: true });
  const engine = await openLocalEngine({
    db: join(runDir, 'calls.sqlite'),
    blobsDir: join(runDir, 'traces'),
    providers: values.offline ? 'offline' : 'live',
  });
  const meter = new Meter(maxUsd);
  const arms = new Map<string, Arm>();
  let stopReason: string | null = null;
  let canaryResults: CanaryResult[] = [];
  let measured = predictors;
  try {
    if (!values['skip-canary']) {
      const c = await canary(engine.deps.gateway, predictors);
      canaryResults = c.results;
      writeFileSync(join(runDir, 'canary.json'), `${JSON.stringify(c.recorded, null, 2)}\n`);
      meter.usd += sum(c.results.map((x) => x.costUsd ?? 0));
      for (const x of c.results)
        console.log(`canary ${x.label}: ${x.ok ? `ok (${x.modelSnapshot}, ${x.latencyMs} ms)` : x.error}`);
      measured = afterCanary(predictors, c.results, values['drop-failed-canary']);
      if (measured.length < predictors.length)
        console.warn(
          `left out after a failed canary: ${predictors.filter((p) => !measured.includes(p)).join(', ')}`,
        );
    }

    const chunks = planChunks(served, twin, chunkPeople);
    const cache = new Map<string, EvalRecord>();
    const costliest = new Map<string, number>();
    for (const [i, chunk] of chunks.entries()) {
      // Don't start a chunk the cap would likely cut: it would be paid for, then dropped. A dataset's first chunk is
      // judged by the costliest chunk of any dataset.
      const estimate = costliest.get(chunk.dataset) ?? Math.max(0, ...costliest.values());
      if (meter.usd + 1.2 * estimate > meter.maxUsd) {
        stopReason = `the next chunk would pass the $${meter.maxUsd} cap ($${meter.usd.toFixed(4)} spent); ${chunks.length - i} of ${chunks.length} chunks not run`;
        break;
      }
      const before = meter.usd;
      const res = await runChunk(chunk, new Map([...cands].filter(([p]) => measured.includes(p))), settings, {
        gateway: engine.deps.gateway,
        meter,
        cache,
        concurrency,
        maxQuestions: chunk.dataset === SERVED ? 1 : maxQuestions,
      });
      if ('stop' in res) {
        stopReason = `${res.stop.message}; chunk ${i + 1} of ${chunks.length} (${chunk.people.length} ${chunk.dataset} people) was dropped for every model, later chunks not run`;
        break;
      }
      costliest.set(chunk.dataset, Math.max(costliest.get(chunk.dataset) ?? 0, meter.usd - before));
      for (const a of res.arms) {
        const key = `${a.dataset}|${a.predictor}|${a.setting}`;
        const prev = arms.get(key);
        if (prev) {
          prev.records.push(...a.records);
          prev.requests.push(...a.requests);
        } else arms.set(key, { ...a, records: [...a.records], requests: [...a.requests] });
      }
      console.log(
        `chunk ${i + 1}/${chunks.length} (${chunk.dataset}, ${chunk.instances.length} items): $${meter.usd.toFixed(4)} so far`,
      );
    }
    if (stopReason) console.warn(`stopped: ${stopReason}`);
  } finally {
    engine.close();
  }

  const dropped = predictors.filter((p) => !measured.includes(p));
  const report = analyzeModels([...arms.values()], {
    reference,
    predictors: measured,
    dropped,
    views: MODELS_VIEWS,
    k,
    population: values.population,
    maxQuestionsPerRequest: maxQuestions,
    costUsd: meter.usd,
    stopReason,
    offline: values.offline,
    canary: canaryResults,
  });
  if (values.tune)
    report.tuning = analyzeTuning([...arms.values()], { reference, predictors: measured, settings, k });
  const run: EvalRunRecord = {
    id: ulid(),
    name:
      values.name ??
      (values.tune ? 'E8b: decision models, each at its best' : 'E8: decision models compared'),
    spec: {
      kind: 'models',
      tune: values.tune,
      predictors: measured,
      dropped,
      reference,
      split: values.split,
      k,
      population: values.population,
      maxTargets: values['max-targets'],
      maxQuestions,
      limit: values.limit ?? null,
      maxUsd,
      seed: values.seed,
      stopReason,
    },
    datasetHash: loaded.datasetHash,
    status: 'done',
    metrics: {
      report,
      modelSnapshots: [...new Set(report.rows.flatMap((x) => x.snapshots))].sort(),
    },
    r2ReportKey: null,
    createdAt: Date.now(),
  };
  const md = await recordRun(run, loaded, { publish: values.publish, summary: values.summary });
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${md}; canary.json, calls and traces in ${runDir} (local only)`);
}

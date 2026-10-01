import {
  argmax,
  COMPONENT_IDS,
  type ComponentId,
  calibrationTemperatureOf,
  canonicalPredictorId,
  componentReadBy,
  DEFAULT_PROMPT_VERSION,
  DecisionPredictor,
  type Distribution,
  expectedCalibrationError,
  expectedIndex,
  formatPredictorId,
  type Gateway,
  HARNESS_STATE_VIEWS,
  type HarnessStateView,
  harnessProblems,
  INCUMBENT_HARNESS,
  LlmPredictor,
  lexicalSimilarity,
  normalizeDist,
  P_FLOOR,
  PREDICT_PROMPTS,
  type PredictHarness,
  type PredictionResult,
  type Predictor,
  type PredictorKind,
  type PredictPrompt,
  parsePredictorId,
  predictionQuestion,
  predictorIdProblem,
  promptHash,
  quantile,
  renderStateText,
  resolvePredictPrompt,
  scorePrediction,
  seededRng,
  selfConsistency,
  temperatureScale,
  uniform,
} from '@mimic/core';
import { z } from 'zod';
import type { EvalInstance } from './instances';
import { personLabel } from './instances';

// ---------------------------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------------------------

export const CandidateInput = z.object({
  label: z.string().max(200).optional(),
  /** Base predictor: `decision:<model>` (or `jev:`) or `llm:<model>`, optionally `@<promptVersion>` for a variant. */
  predictor: z.string(),
  components: z.partialRecord(z.enum(COMPONENT_IDS), z.string()).default({}),
  harness: z
    .object({
      reasoningEffort: z.enum(['none', 'low', 'medium']),
      maxTokens: z.number().int().min(200).max(20_000),
      schema: z.enum(['probs', 'reasoned']),
      jevState: z.enum(['json', 'text']),
      reasoningMaxTokens: z.number().int().min(128).max(32_000).nullable(),
      calibrationTemperature: z.number().min(0.1).max(20),
      keyEnum: z.boolean(),
      labelKeys: z.boolean(),
      stateView: z.enum(HARNESS_STATE_VIEWS),
    })
    .partial()
    .default({}),
});
export type CandidateInput = z.input<typeof CandidateInput>;

/** A fully resolved candidate: every component and harness setting, identified by a content hash. */
export interface Candidate {
  label: string;
  kind: PredictorKind;
  model: string;
  /** The registered version the candidate starts from. */
  baseVersion: string;
  prompt: Omit<PredictPrompt, 'version'>;
  hash: string;
}

export function resolveCandidate(input: CandidateInput): Candidate {
  const c = CandidateInput.parse(input);
  const idProblem = predictorIdProblem(c.predictor);
  if (idProblem) throw new Error(idProblem);
  const spec = parsePredictorId(c.predictor);
  const baseVersion = spec.promptVersion ?? DEFAULT_PROMPT_VERSION[spec.kind];
  const base = resolvePredictPrompt(baseVersion, spec.kind, spec.model);
  const prompt = {
    kind: spec.kind,
    components: { ...base.components, ...c.components },
    harness: { ...base.harness, ...c.harness } as PredictHarness,
  };
  // Refused before anything is spent: a budget that leaves no room for the answer truncates every call.
  const problems = harnessProblems(prompt.harness);
  if (problems.length) throw new Error(`${c.label ?? c.predictor}: ${problems.join('; ')}`);
  const hash = promptHash(prompt).slice(0, 16);
  return {
    label: c.label ?? `${canonicalPredictorId(c.predictor)} ${hash.slice(0, 8)}`,
    kind: spec.kind,
    model: spec.model,
    baseVersion,
    prompt,
    hash: `${spec.model}:${hash}`,
  };
}

/** A child candidate with one component replaced. */
export function withComponent(parent: Candidate, id: ComponentId, text: string, label: string): Candidate {
  const prompt = { ...parent.prompt, components: { ...parent.prompt.components, [id]: text } };
  return { ...parent, label, prompt, hash: `${parent.model}:${promptHash(prompt).slice(0, 16)}` };
}

/**
 * The components that differ from a registered version: the candidate's base version by default (reports, candidate
 * JSON), or the incumbent for a `PREDICT_PROMPTS` entry, whose overrides are merged over the incumbent.
 */
export function changedComponents(
  c: Candidate,
  against: string = c.baseVersion,
): Partial<Record<ComponentId, string>> {
  const base = resolvePredictPrompt(against, c.kind, c.model);
  const out: Partial<Record<ComponentId, string>> = {};
  for (const id of COMPONENT_IDS)
    if (c.prompt.components[id] !== base.components[id]) out[id] = c.prompt.components[id];
  return out;
}

export function changedHarness(c: Candidate, against: string = c.baseVersion): Partial<PredictHarness> {
  const base = resolvePredictPrompt(against, c.kind, c.model).harness;
  const out: Partial<PredictHarness> = {};
  for (const k of Object.keys(INCUMBENT_HARNESS) as Array<keyof PredictHarness>)
    if (c.prompt.harness[k] !== base[k]) Object.assign(out, { [k]: c.prompt.harness[k] });
  return out;
}

export function predictorFor(gateway: Gateway, c: Candidate, purpose: string): Predictor {
  const unchanged = !Object.keys(changedComponents(c)).length && !Object.keys(changedHarness(c)).length;
  const ref = unchanged ? c.baseVersion : c.prompt;
  const ctx = { purpose };
  return c.kind === 'decision'
    ? new DecisionPredictor(gateway, c.model, ctx, ref)
    : new LlmPredictor(gateway, c.model, ctx, ref);
}

// ---------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------

export interface EvalRecord {
  candidate: string;
  predictorId: string;
  instanceId: string;
  mimicId: string;
  split: 'dev' | 'test';
  type: EvalInstance['question']['type'];
  stateHash: string;
  evidenceSeqMax: number;
  stateTokens: number;
  modelSnapshot: string;
  ok: boolean;
  error: string | null;
  /** Failed in transport (provider error after a retry): not the candidate's score, never cached. */
  transient: boolean;
  dist: Distribution;
  answer: string;
  logLoss: number;
  itemAcc: number;
  top1: number;
  brier: number;
  /** Top-1 probability, for calibration. */
  confidence: number;
  /** Baseline item accuracy on the same question (stored context-only prediction), when there is one. */
  baselineItemAcc: number | null;
  /** The optimizer's per-instance score: −log loss; a failed prediction scores as uniform minus 1 nat. */
  value: number;
  costUsd: number;
  latencyMs: number;
  feedback: string;
  /** Raw model output (LLM), truncated; for the reflective dataset only. */
  raw?: string;
}

export const FAILURE_PENALTY = 1;

export function toRecord(
  inst: EvalInstance,
  candidate: string,
  predictorId: string,
  r: Pick<
    PredictionResult,
    'dist' | 'ok' | 'error' | 'errorKind' | 'costUsd' | 'latencyMs' | 'modelSnapshot' | 'raw'
  >,
): EvalRecord {
  const q = inst.question;
  const keys = q.options.map((o) => o.key);
  const dist = r.ok ? r.dist : uniform(keys);
  const s = scorePrediction(q.type, dist, inst.answer);
  const value = r.ok ? -s.logLoss : -(Math.log(keys.length) + FAILURE_PENALTY);
  const baselineItemAcc = inst.baseline ? scorePrediction(q.type, inst.baseline, inst.answer).itemAcc : null;
  const rec: EvalRecord = {
    candidate,
    predictorId,
    instanceId: inst.id,
    mimicId: inst.mimicId,
    split: inst.split,
    type: q.type,
    stateHash: inst.state.meta.stateHash,
    evidenceSeqMax: inst.state.meta.evidenceSeqMax,
    stateTokens: inst.state.meta.tokens,
    modelSnapshot: r.modelSnapshot,
    ok: r.ok,
    error: r.ok ? null : (r.error ?? 'failed'),
    // A timeout counts as transient here, as it did before timeouts had their own kind (ADR-0037).
    transient: !r.ok && (r.errorKind === 'transport' || r.errorKind === 'timeout'),
    dist,
    answer: inst.answer,
    logLoss: s.logLoss,
    itemAcc: s.itemAcc,
    top1: s.top1,
    brier: s.brier,
    confidence: dist[argmax(dist)] ?? 0,
    baselineItemAcc,
    value,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    feedback: '',
  };
  if (r.raw) rec.raw = r.raw;
  rec.feedback = feedbackFor(inst, rec);
  return rec;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const labelOf = (inst: EvalInstance, key: string) =>
  inst.question.options.find((o) => o.key === key)?.label ?? key;

/**
 * Textual feedback for one prediction (docs/OPTIMIZATION.md §5.3): what happened, the person's own reason, what the
 * profile-only baseline said, the most similar earlier answers, and how reliable the answer is.
 */
export function feedbackFor(inst: EvalInstance, rec: EvalRecord): string {
  const lines: string[] = [];
  const guess = argmax(rec.dist);
  const pAns = rec.dist[inst.answer] ?? 0;
  if (!rec.ok)
    lines.push(`The prediction failed (${rec.error}); it was scored as a uniform guess minus a penalty.`);
  else if (inst.question.type === 'score') {
    const e = expectedIndex(rec.dist);
    const spread = 1 - Math.max(...Object.values(rec.dist));
    lines.push(
      `Scale item: expected ${e.toFixed(1)} on 0–4, the person chose ${inst.answer} ("${labelOf(inst, inst.answer)}"), ` +
        `off by ${Math.abs(e - Number(inst.answer)).toFixed(1)} steps; p(answer) = ${pct(pAns)}, ` +
        `${spread > 0.6 ? 'a flat distribution' : spread < 0.2 ? 'a very peaked distribution' : 'moderately spread'}.`,
    );
  } else if (guess === inst.answer) {
    lines.push(
      `Hit: predicted "${labelOf(inst, guess)}" at ${pct(pAns)}${pAns < 0.5 ? ', but with low confidence' : ''}; log loss ${rec.logLoss.toFixed(2)}.`,
    );
  } else {
    lines.push(
      `Miss: predicted "${labelOf(inst, guess)}" at ${pct(rec.dist[guess] ?? 0)}; the person chose "${labelOf(inst, inst.answer)}", ` +
        `which got ${pct(pAns)}; log loss ${rec.logLoss.toFixed(2)}.`,
    );
  }
  if (inst.why) lines.push(`The person's own reason: "${inst.why.slice(0, 300)}"`);
  if (inst.baseline) {
    const b = argmax(inst.baseline);
    lines.push(
      `A profile-only guess (no answers) put ${pct(inst.baseline[inst.answer] ?? 0)} on the true answer` +
        `${b === inst.answer ? ' and got it right' : ` and favored "${labelOf(inst, b)}"`}.`,
    );
  }
  const similar = inst.state.evidence
    .map((e) => ({ e, s: lexicalSimilarity(e.q, inst.question.prompt) }))
    .filter((x) => x.s > 0.08)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (similar.length)
    lines.push(
      `Most related earlier answers: ${similar.map((x) => `#${x.e.seq} "${x.e.q}" → ${x.e.answer}`).join('; ')}.`,
    );
  if (inst.repeatAgreement !== null)
    lines.push(
      inst.repeatAgreement >= 0.99
        ? 'The person gave the same answer when this item was asked again later, so it is a stable preference.'
        : `The person answered this item differently when asked again (agreement ${inst.repeatAgreement.toFixed(2)}), so part of any miss is noise.`,
    );
  return lines.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Running a candidate
// ---------------------------------------------------------------------------------------------------------------

export class BudgetStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetStop';
  }
}

/** A provider kept failing in transport: stop gracefully (like a budget stop) rather than score the outage. */
export class OutageStop extends BudgetStop {
  constructor(message: string) {
    super(message);
    this.name = 'OutageStop';
  }
}

/** Spend and call accounting shared by every evaluation in a run; stops new work past the caps. */
export class Meter {
  usd = 0;
  predictions = 0;
  reflections = 0;
  constructor(
    readonly maxUsd = Number.POSITIVE_INFINITY,
    readonly maxPredictions = Number.POSITIVE_INFINITY,
  ) {}
  check(): void {
    if (this.usd >= this.maxUsd)
      throw new BudgetStop(`spend cap $${this.maxUsd} reached ($${this.usd.toFixed(4)})`);
    if (this.predictions >= this.maxPredictions)
      throw new BudgetStop(`metric-call budget ${this.maxPredictions} reached`);
  }
}

export async function mapLimit<T, R>(
  items: T[],
  n: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  // On the first error no new item starts, but items already in flight finish (and are recorded by `fn`) before the
  // error is rethrown, so work that was paid for is never orphaned behind an early rejection.
  let error: { e: unknown } | null = null;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!error && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (e) {
        error ??= { e };
      }
    }
  });
  await Promise.all(workers);
  if (error) throw (error as { e: unknown }).e;
  return out;
}

/**
 * Jev's context is 32K tokens (PLAN §5.1). Questions that share a state go in one request, as production does, and
 * are split only when state plus questions would pass this budget.
 */
export const JEV_REQUEST_TOKENS = 28_000;

export function jevRequests(
  c: Candidate,
  instances: EvalInstance[],
  maxQuestions = Number.POSITIVE_INFINITY,
): EvalInstance[][] {
  const out: EvalInstance[][] = [];
  const tokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);
  for (const g of groupBy(instances, (i) => i.state.meta.stateHash).values()) {
    const state = g[0]!.state;
    const stateTokens =
      c.prompt.harness.jevState === 'text'
        ? tokens(renderStateText(state, c.prompt.components))
        : state.meta.tokens;
    let cur: EvalInstance[] = [];
    let used = stateTokens;
    for (const i of g) {
      const t = tokens(predictionQuestion(i.question, c.prompt.components));
      if (cur.length && (used + t > JEV_REQUEST_TOKENS || cur.length >= maxQuestions)) {
        out.push(cur);
        cur = [];
        used = stateTokens;
      }
      cur.push(i);
      used += t;
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

export interface EvaluateOptions {
  gateway: Gateway;
  meter: Meter;
  concurrency?: number;
  purpose?: string;
  /** candidate hash | instance id → record. Hits cost nothing and are not counted as metric calls. */
  cache?: Map<string, EvalRecord>;
  /** Ignore the cache and don't overwrite it, e.g. to measure the noise floor. */
  fresh?: boolean;
  /**
   * At most this many Jev questions per request (default: as many as share a state and fit). E6 asks one at a time,
   * so the arms it compares never differ by what else was in the batch.
   */
  maxQuestionsPerRequest?: number;
}

/**
 * Runs a candidate over instances and scores each prediction. Jev questions that share a state go in one request
 * (PLAN §5.1); LLM questions run one call each. A transport failure is retried once, for the failed questions only;
 * an output failure is not, since it is the candidate's fault. A prediction that still fails in transport comes back
 * marked `transient` and is never cached. Every call goes through the gateway, so it is logged (invariant 5).
 */
export async function evaluateCandidate(
  c: Candidate,
  instances: EvalInstance[],
  opts: EvaluateOptions,
): Promise<EvalRecord[]> {
  const predictor = predictorFor(opts.gateway, c, opts.purpose ?? 'eval.evaluate');
  const key = (i: EvalInstance) => `${c.hash}|${i.id}`;
  const out = new Map<string, EvalRecord>();
  const todo: EvalInstance[] = [];
  for (const i of instances) {
    const hit = opts.fresh ? undefined : opts.cache?.get(key(i));
    if (hit) out.set(i.id, hit);
    else todo.push(i);
  }
  const groups =
    c.kind === 'decision' ? jevRequests(c, todo, opts.maxQuestionsPerRequest) : todo.map((i) => [i]);

  await mapLimit(groups, opts.concurrency ?? 8, async (g) => {
    opts.meter.check();
    const state = g[0]!.state;
    const res = await predictor.predict(
      state,
      g.map((i) => i.question),
    );
    let spent = res.reduce((a, r) => a + r.costUsd, 0);
    const retry = res.flatMap((r, j) => (!r.ok && r.errorKind !== 'output' ? [j] : []));
    if (retry.length) {
      const again = await predictor.predict(
        state,
        retry.map((j) => g[j]!.question),
      );
      spent += again.reduce((a, r) => a + r.costUsd, 0);
      retry.forEach((j, n) => {
        res[j] = again[n]!;
      });
    }
    opts.meter.usd += spent;
    opts.meter.predictions += g.length;
    g.forEach((inst, j) => {
      const rec = toRecord(inst, c.hash, predictor.id, res[j]!);
      out.set(inst.id, rec);
      // A transport failure is the provider's fault, not the candidate's: never cache it, so a later pass re-asks.
      if (rec.transient) return;
      // A fresh pass (the noise floor) is a second sample, not the candidate's score: keep the first in the cache.
      if (!opts.fresh || !opts.cache?.has(key(inst))) opts.cache?.set(key(inst), rec);
    });
  });
  return instances.map((i) => out.get(i.id)!);
}

/** Records for the predictions already stored with each question (no model calls). */
export function storedRecords(instances: EvalInstance[]): EvalRecord[] {
  const out: EvalRecord[] = [];
  const derived = new Map<string, Array<{ predictorId: string; t: number }>>();
  for (const inst of instances)
    for (const stored of inst.stored) {
      // Stores read IDs canonically (ADR-0054); instances built in memory may not, and one predictor under two
      // spellings would be reported, fitted and paired as two.
      const p = { ...stored, predictorId: canonicalPredictorId(stored.predictorId) };
      // A primary the LLM fallback served (Jev failed) is reported apart from the configured primary and from any
      // shadow of the same model.
      const role = p.role === 'primary' && p.fallback ? 'fallback' : p.role;
      const r = toRecord(inst, `${p.predictorId}|${role}`, p.predictorId, {
        ...p,
        error: p.ok ? undefined : 'failed',
      });
      out.push(r);
      if (role !== 'primary') continue;
      if (!derived.has(p.predictorId)) derived.set(p.predictorId, derivedCalibrations(p.predictorId));
      for (const d of derived.get(p.predictorId)!)
        out.push(
          toRecord(inst, `${d.predictorId}|derived`, d.predictorId, {
            ...p,
            dist: p.ok ? temperatureScale(p.dist, d.t) : p.dist,
            error: p.ok ? undefined : 'failed',
            costUsd: 0,
            latencyMs: 0,
          }),
        );
    }
  return out;
}

/**
 * Registered Jev variants that differ from a stored primary only by calibration temperature (same model, templates
 * and state format): their prediction is the primary's answer rescaled, so the stored report derives it for free,
 * with no noise, instead of a second Jev call per question (ADR-0041). Rows carry the role `derived`.
 */
export function derivedCalibrations(primaryId: string): Array<{ predictorId: string; t: number }> {
  const spec = parsePredictorId(primaryId);
  if (spec.kind !== 'decision') return [];
  const baseVersion = spec.promptVersion ?? DEFAULT_PROMPT_VERSION.decision;
  const base = resolvePredictPrompt(baseVersion, 'decision', spec.model);
  if (base.harness.calibrationTemperature !== 1) return [];
  const same = (a: PredictPrompt, b: PredictPrompt) =>
    a.harness.jevState === b.harness.jevState &&
    a.harness.stateView === b.harness.stateView &&
    COMPONENT_IDS.every((id) => !componentReadBy(id, a) || a.components[id] === b.components[id]);
  const idOf = (version: string) =>
    formatPredictorId({ kind: 'decision', model: spec.model, promptVersion: version });
  return Object.values(PREDICT_PROMPTS)
    .filter((v) => v.kind === 'decision' && v.id !== baseVersion && !predictorIdProblem(idOf(v.id)))
    .map((v) => ({ v, r: resolvePredictPrompt(v.id, 'decision', spec.model) }))
    .filter(({ r }) => r.harness.calibrationTemperature !== 1 && same(r, base))
    .map(({ v, r }) => ({ predictorId: idOf(v.id), t: r.harness.calibrationTemperature }));
}

// ---------------------------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------------------------

export interface Metrics {
  n: number;
  failures: number;
  logLoss: number;
  itemAcc: number;
  top1: number;
  brier: number;
  ece: number;
  /** Mean paired item accuracy minus the stored baseline's, over questions that have one. */
  lift: number | null;
  costUsd: number;
  p50LatencyMs: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Aggregate metrics. Failures count as uniform predictions in log loss and accuracy (they cost the user too). */
export function metricsOf(rs: EvalRecord[]): Metrics {
  const lifted = rs.filter((r) => r.baselineItemAcc !== null);
  return {
    n: rs.length,
    failures: rs.filter((r) => !r.ok).length,
    logLoss: mean(rs.map((r) => r.logLoss)),
    itemAcc: mean(rs.map((r) => r.itemAcc)),
    top1: mean(rs.map((r) => r.top1)),
    brier: mean(rs.map((r) => r.brier)),
    ece: expectedCalibrationError(rs.map((r) => ({ confidence: r.confidence, correct: r.top1 }))),
    lift: lifted.length ? mean(lifted.map((r) => r.itemAcc - r.baselineItemAcc!)) : null,
    costUsd: rs.reduce((a, r) => a + r.costUsd, 0),
    p50LatencyMs: quantile(
      rs.map((r) => r.latencyMs),
      0.5,
    ),
  };
}

export interface Breakdown {
  all: Metrics;
  bySplit: Record<string, Metrics>;
  byPerson: Record<string, Metrics>;
  byType: Record<string, Metrics>;
}

export function groupBy<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = f(x);
    const g = m.get(k);
    if (g) g.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function breakdown(rs: EvalRecord[]): Breakdown {
  const obj = (m: Map<string, EvalRecord[]>) =>
    Object.fromEntries(
      [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, metricsOf(v)]),
    );
  return {
    all: metricsOf(rs),
    bySplit: obj(groupBy(rs, (r) => r.split)),
    byPerson: obj(groupBy(rs, (r) => `${personLabel(r.mimicId)} (${r.split})`)),
    byType: obj(groupBy(rs, (r) => r.type)),
  };
}

export interface PairedDelta {
  n: number;
  /** Mean of (b − a); for `value` higher is better, for log loss lower is better. */
  mean: number;
  ciLow: number;
  ciHigh: number;
}

/** Paired bootstrap (1,000 resamples by default, seeded) of b − a over the instances both record sets share. */
export function pairedDelta(
  a: EvalRecord[],
  b: EvalRecord[],
  metric: 'value' | 'itemAcc' | 'logLoss' = 'value',
  seed = 'paired',
  resamples = 1000,
): PairedDelta {
  const bi = new Map(b.map((r) => [r.instanceId, r]));
  const d = a.filter((r) => bi.has(r.instanceId)).map((r) => bi.get(r.instanceId)![metric] - r[metric]);
  if (!d.length) return { n: 0, mean: 0, ciLow: 0, ciHigh: 0 };
  const rng = seededRng(seed);
  const samples: number[] = [];
  for (let s = 0; s < resamples; s++) {
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[Math.floor(rng() * d.length)]!;
    samples.push(sum / d.length);
  }
  return { n: d.length, mean: mean(d), ciLow: quantile(samples, 0.05), ciHigh: quantile(samples, 0.95) };
}

/** SD of the per-instance difference between two passes of the same candidate: the noise floor. */
export function noiseSd(
  a: Array<Pick<EvalRecord, 'instanceId' | 'value'> & { transient?: boolean }>,
  b: Array<Pick<EvalRecord, 'instanceId' | 'value'> & { transient?: boolean }>,
): number {
  const bi = new Map(b.map((r) => [r.instanceId, r]));
  // Transport failures are outages, not noise.
  const ok = (r: Pick<EvalRecord, 'instanceId' | 'value'> & { transient?: boolean }) => !r.transient;
  const d = a
    .filter((r) => ok(r) && bi.has(r.instanceId) && ok(bi.get(r.instanceId)!))
    .map((r) => bi.get(r.instanceId)!.value - r.value);
  if (d.length < 2) return 0;
  const m = mean(d);
  return Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Post-hoc calibration and pooling on stored predictions (M11; no model calls)
// ---------------------------------------------------------------------------------------------------------------

/** Moved to core (ADR-0041): a registered prompt variant applies it online. */
export { temperatureScale };

/** Log-linear pool: p ∝ a^w · b^(1−w). */
export function pool(a: Distribution, b: Distribution, w: number): Distribution {
  const keys = Object.keys(a);
  return normalizeDist(
    Object.fromEntries(
      keys.map((k) => [k, Math.max(a[k]!, P_FLOOR) ** w * Math.max(b[k] ?? P_FLOOR, P_FLOOR) ** (1 - w)]),
    ),
    keys,
  );
}

/** Linear shrinkage toward the profile-only baseline. */
export function shrink(p: Distribution, base: Distribution, alpha: number): Distribution {
  const keys = Object.keys(p);
  return normalizeDist(
    Object.fromEntries(keys.map((k) => [k, (1 - alpha) * p[k]! + alpha * (base[k] ?? 0)])),
    keys,
  );
}

export interface FitRow {
  predictor: string;
  method: string;
  param: number;
  nFit: number;
  nTest: number;
  fitBefore: number;
  fitAfter: number;
  testBefore: number | null;
  testAfter: number | null;
  testEceBefore: number | null;
  testEceAfter: number | null;
  /** Item accuracy on test (score questions by expected index, so a temperature can move it; top-1 can't). */
  testAccBefore: number | null;
  testAccAfter: number | null;
}

interface Pair {
  inst: EvalInstance;
  dist: Distribution;
  other?: Distribution;
}

const ll = (ps: Pair[], f: (p: Pair) => Distribution) =>
  mean(ps.map((p) => -Math.log(Math.max(f(p)[p.inst.answer] ?? 0, P_FLOOR))));
const acc = (ps: Pair[], f: (p: Pair) => Distribution) =>
  mean(ps.map((p) => scorePrediction(p.inst.question.type, f(p), p.inst.answer).itemAcc));
const ece = (ps: Pair[], f: (p: Pair) => Distribution) =>
  expectedCalibrationError(
    ps.map((p) => {
      const d = f(p);
      const top = argmax(d);
      return { confidence: d[top] ?? 0, correct: top === p.inst.answer ? 1 : 0 };
    }),
  );

function fitParam(
  predictor: string,
  method: string,
  grid: number[],
  fitSet: Pair[],
  testSet: Pair[],
  apply: (p: Pair, x: number) => Distribution,
  identity: number,
): FitRow {
  let best = identity;
  let bestLl = ll(fitSet, (p) => apply(p, identity));
  for (const x of grid) {
    const v = ll(fitSet, (p) => apply(p, x));
    if (v < bestLl - 1e-9) {
      best = x;
      bestLl = v;
    }
  }
  const has = testSet.length > 0;
  return {
    predictor,
    method,
    param: best,
    nFit: fitSet.length,
    nTest: testSet.length,
    fitBefore: ll(fitSet, (p) => apply(p, identity)),
    fitAfter: bestLl,
    testBefore: has ? ll(testSet, (p) => apply(p, identity)) : null,
    testAfter: has ? ll(testSet, (p) => apply(p, best)) : null,
    testEceBefore: has ? ece(testSet, (p) => apply(p, identity)) : null,
    testEceAfter: has ? ece(testSet, (p) => apply(p, best)) : null,
    testAccBefore: has ? acc(testSet, (p) => apply(p, identity)) : null,
    testAccAfter: has ? acc(testSet, (p) => apply(p, best)) : null,
  };
}

/**
 * Fits on dev people and checks on test people: a temperature per predictor (and, for the primary, per band of
 * answers in the state), shrinkage of the primary toward its baseline, and a log-linear pool of the primary with each
 * LLM shadow. With one or two people these are
 * descriptive; the test columns are the honest ones. "Before" is the stored distribution as served (a temperature of
 * 1 leaves it untouched); other temperatures floor it at P_FLOOR first, a difference under 1e-4 nats.
 */
const EVIDENCE_BANDS: Array<[string, number, number]> = [
  ['0', 0, 0],
  ['1–9', 1, 9],
  ['10–29', 10, 29],
  ['30+', 30, Number.POSITIVE_INFINITY],
];

export function calibrationFits(instances: EvalInstance[]): FitRow[] {
  const rows: FitRow[] = [];
  // 0.25 to 16: the first prod report put Jev's best temperature at the old top of 4 (ADR-0041).
  const temps = Array.from({ length: 46 }, (_, i) => Math.round(0.25 * 2 ** (i / 7.5) * 1000) / 1000);
  const unit = Array.from({ length: 21 }, (_, i) => i / 20);
  const byPredictor = new Map<string, Pair[]>();
  // Primaries by predictor: each config's own scale (a v7 primary is calibrated, a v6 one is not). A primary the LLM
  // fallback served (Jev failed) is not the configured primary's prediction and is left out.
  const primaries = new Map<string, Map<string, Distribution>>();
  for (const inst of instances)
    for (const p of inst.stored) {
      if (!p.ok || (p.role !== 'primary' && p.role !== 'shadow') || (p.role === 'primary' && p.fallback))
        continue;
      // One key per predictor, whichever spelling an in-memory instance carries (ADR-0054).
      const id = canonicalPredictorId(p.predictorId);
      const k = p.role === 'primary' ? `${id} (primary)` : id;
      const list = byPredictor.get(k);
      if (list) list.push({ inst, dist: p.dist });
      else byPredictor.set(k, [{ inst, dist: p.dist }]);
      if (p.role === 'primary') {
        const m = primaries.get(id) ?? new Map<string, Distribution>();
        m.set(inst.id, p.dist);
        primaries.set(id, m);
      }
    }
  const split = (ps: Pair[]) =>
    [ps.filter((p) => p.inst.split === 'dev'), ps.filter((p) => p.inst.split === 'test')] as const;
  for (const [k, ps] of [...byPredictor.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [dev, test] = split(ps);
    if (dev.length < 10) continue;
    // A calibrated predictor's fitted temperature is on top of its own (ADR-0048).
    const own = calibrationTemperatureOf(k.replace(/ \(primary\)$/, ''));
    const method = own === 1 ? 'temperature' : `temperature (on top of its own ${own})`;
    rows.push(fitParam(k, method, temps, dev, test, (p, t) => temperatureScale(p.dist, t), 1));
    if (k.endsWith('(primary)')) {
      // One temperature does not hold across state sizes (Twin: ECE 0.036 at 30 answers, 0.111 at 100), so the
      // primary also gets one fit per size band: the numbers a temperature by evidence count would start from.
      for (const [label, lo, hi] of EVIDENCE_BANDS) {
        const band = ps.filter(
          (p) => p.inst.state.evidence.length >= lo && p.inst.state.evidence.length <= hi,
        );
        const [bd, bt] = split(band);
        if (bd.length >= 10)
          rows.push(
            fitParam(
              k,
              `${method}, ${label} answers in the state`,
              temps,
              bd,
              bt,
              (p, t) => temperatureScale(p.dist, t),
              1,
            ),
          );
      }
      const withBase = ps.filter((p) => p.inst.baseline);
      const [d2, t2] = split(withBase);
      if (d2.length >= 10)
        rows.push(
          fitParam(k, 'shrink to baseline', unit, d2, t2, (p, a) => shrink(p.dist, p.inst.baseline!, a), 0),
        );
    } else if (k.startsWith('llm:')) {
      // Pools with LLM shadows only (a decision shadow pooled with a decision primary is a temperature fit by another name),
      // one fit per primary so a fit never mixes scales.
      for (const [pid, primary] of [...primaries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const paired = ps
          .filter((p) => primary.has(p.inst.id))
          .map((p) => ({ ...p, other: primary.get(p.inst.id)! }));
        const [d3, t3] = split(paired);
        if (d3.length < 10) continue;
        rows.push(
          fitParam(
            `${k} × ${pid} (primary)`,
            'log-linear pool (weight on primary)',
            unit,
            d3,
            t3,
            (p, w) => pool(p.other!, p.dist, w),
            1,
          ),
        );
      }
    }
  }
  return rows;
}

export interface PairedRow {
  model: string;
  from: string;
  to: string;
  n: number;
  /** to − from on the questions both answered; failures count as uniform, as everywhere in this report. */
  logLoss: PairedDelta;
  itemAcc: PairedDelta;
  failedFrom: number;
  failedTo: number;
}

/**
 * Every pair of stored predictors on the same model (prompt versions, calibration, reasoning settings), compared on
 * the questions both answered, with paired 90% CIs (ADR-0048). Unpaired rows compare different question sets while
 * a backfill is still running, which once made a neutral change look 0.05–0.08 nats worse. Primary, shadow and
 * derived rows only: a baseline sees another state and a hypothesis row another person.
 */
export function pairedComparisons(recs: EvalRecord[]): PairedRow[] {
  const roles = new Set(['primary', 'shadow', 'derived']);
  // One row per predictor and question (a fallback primary has its own role and never joins a group).
  const byId = new Map(
    [
      ...groupBy(
        recs.filter((r) => roles.has(r.candidate.split('|')[1]!)),
        (r) => r.predictorId,
      ),
    ].map(([id, rs]) => [id, [...new Map(rs.map((r) => [r.instanceId, r])).values()]]),
  );
  // The incumbent spelling first, then by version in numeric order (v2 before v10), so each pair reads old → new.
  const ids = [...byId.keys()].sort(
    (a, b) =>
      Number(a.includes('@')) - Number(b.includes('@')) || a.localeCompare(b, 'en', { numeric: true }),
  );
  // Rows that no model made (the footprint's implied answers, ADR-0061) have no predictor spec and pair with nothing.
  const specs = new Map(
    ids.map((id) => {
      try {
        return [id, parsePredictorId(id)] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  const rows: PairedRow[] = [];
  for (const [i, from] of ids.entries())
    for (const to of ids.slice(i + 1)) {
      const [f, t] = [specs.get(from), specs.get(to)];
      if (!f || !t || f.model !== t.model || f.kind !== t.kind) continue;
      const b = byId.get(to)!;
      const shared = new Set(b.map((r) => r.instanceId));
      const a = byId.get(from)!.filter((r) => shared.has(r.instanceId));
      if (a.length < 10) continue;
      const inA = new Set(a.map((r) => r.instanceId));
      rows.push({
        model: f.model,
        from,
        to,
        n: a.length,
        logLoss: pairedDelta(a, b, 'logLoss', `${from}>${to}`),
        itemAcc: pairedDelta(a, b, 'itemAcc', `${from}>${to}:acc`),
        failedFrom: a.filter((r) => !r.ok).length,
        failedTo: b.filter((r) => inA.has(r.instanceId) && !r.ok).length,
      });
    }
  return rows;
}

/** A paired difference whose interval resamples people, so correlated questions within a person do not narrow it. */
export interface PersonDelta extends PairedDelta {
  people: number;
  /** People whose own mean difference is an improvement (lower log loss, higher accuracy), and the reverse. */
  better: number;
  worse: number;
}

/** Mean of (b − a) over the questions both answered, with a 90% interval from resampling people (as E6 does). */
export function pairedByPerson(
  a: EvalRecord[],
  b: EvalRecord[],
  metric: 'itemAcc' | 'logLoss',
  seed: string,
  resamples = 2000,
): PersonDelta {
  const bi = new Map(b.map((r) => [r.instanceId, r]));
  const byPerson = new Map<string, number[]>();
  for (const r of a) {
    const o = bi.get(r.instanceId);
    if (!o) continue;
    const d = byPerson.get(r.mimicId) ?? [];
    d.push(o[metric] - r[metric]);
    byPerson.set(r.mimicId, d);
  }
  const people = [...byPerson.values()];
  const n = people.reduce((x, d) => x + d.length, 0);
  if (!n) return { n: 0, mean: 0, ciLow: 0, ciHigh: 0, people: 0, better: 0, worse: 0 };
  const sign = metric === 'logLoss' ? -1 : 1;
  const means = people.map(mean);
  const rng = seededRng(seed);
  const samples: number[] = [];
  for (let s = 0; s < resamples; s++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < people.length; i++) {
      const d = people[Math.floor(rng() * people.length)]!;
      for (const x of d) sum += x;
      count += d.length;
    }
    samples.push(sum / count);
  }
  return {
    n,
    mean: mean(people.flat()),
    ciLow: quantile(samples, 0.05),
    ciHigh: quantile(samples, 0.95),
    people: people.length,
    better: means.filter((m) => sign * m > 0).length,
    worse: means.filter((m) => sign * m < 0).length,
  };
}

/**
 * ADR-0065's rule, fixed before any data: a view shadow earns a calibrated variant of its own only if, on enough
 * people who joined after E6's export, it is more accurate than the primary and no worse on log loss.
 */
export const VIEW_RULE = { minPeople: 25, maxLogLossWorse: 0.01 } as const;
export type ViewVerdict = 'insufficient' | 'passes' | 'fails';

export interface AgainstPrimaryRow {
  primary: string;
  predictor: string;
  role: string;
  /** The view the predictor reads (ADR-0065), when it reads one. */
  view: HarnessStateView | null;
  logLoss: PersonDelta;
  itemAcc: PersonDelta;
  verdict: ViewVerdict | null;
}

function viewOf(predictorId: string): HarnessStateView | null {
  try {
    const spec = parsePredictorId(predictorId);
    const version = spec.promptVersion ?? DEFAULT_PROMPT_VERSION[spec.kind];
    return resolvePredictPrompt(version, spec.kind, spec.model).harness.stateView ?? null;
  } catch {
    return null;
  }
}

/**
 * Every shadow and derived row against the primary that served the same questions, across models, with intervals
 * over people. A view shadow also gets ADR-0065's verdict.
 */
export function againstPrimary(recs: EvalRecord[]): AgainstPrimaryRow[] {
  const role = (r: EvalRecord) => r.candidate.split('|')[1]!;
  const primaries = groupBy(
    recs.filter((r) => role(r) === 'primary'),
    (r) => r.predictorId,
  );
  const others = groupBy(
    recs.filter((r) => role(r) === 'shadow' || role(r) === 'derived'),
    (r) => r.candidate,
  );
  const rows: AgainstPrimaryRow[] = [];
  for (const [primary, ps] of [...primaries.entries()].sort(([a], [b]) => a.localeCompare(b)))
    for (const [candidate, xs] of [...others.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [predictor, r] = candidate.split('|') as [string, string];
      if (predictor === primary) continue;
      const logLoss = pairedByPerson(ps, xs, 'logLoss', `${primary}>${candidate}`);
      if (logLoss.n < 10) continue;
      const itemAcc = pairedByPerson(ps, xs, 'itemAcc', `${primary}>${candidate}:acc`);
      const view = viewOf(predictor);
      const verdict: ViewVerdict | null =
        view === null
          ? null
          : logLoss.people < VIEW_RULE.minPeople
            ? 'insufficient'
            : itemAcc.ciLow > 0 && logLoss.ciHigh < VIEW_RULE.maxLogLossWorse
              ? 'passes'
              : 'fails';
      rows.push({ primary, predictor, role: r, view, logLoss, itemAcc, verdict });
    }
  return rows;
}

/** People besides the one predicted who must have answered an item before its mean is used (as PROBE_RULE's). */
export const RESIDUAL_MIN_OTHERS = 5;

export interface ResidualReport {
  minOthers: number;
  items: number;
  instances: number;
  people: number;
  /** The item mean's own scores on those questions. */
  itemMean: { logLoss: number; itemAcc: number };
  /** Each predictor against the item mean on the same questions: negative log loss is skill beyond the population. */
  rows: Array<{ predictor: string; role: string; logLoss: PersonDelta; itemAcc: PersonDelta }>;
}

/**
 * Residual fidelity (RESEARCH §1.2): on items asked of many people (anchors, reserve items, E7's shared probes, an
 * import's held-out items), the population's answer distribution is a predictor that knows nothing about the person.
 * Each person's item mean leaves their own answer out and is smoothed by half an answer per option. Only aggregates
 * over at least `minOthers` other people are used, and only here, never in a prompt or a state (PLAN §3.8).
 */
export function residualReport(
  instances: EvalInstance[],
  recs: EvalRecord[],
  minOthers = RESIDUAL_MIN_OTHERS,
): ResidualReport {
  const answers = new Map<string, Map<string, string>>();
  for (const i of instances) {
    const key = i.question.itemKey;
    if (!key) continue;
    const m = answers.get(key) ?? new Map<string, string>();
    if (!m.has(i.mimicId)) m.set(i.mimicId, i.answer);
    answers.set(key, m);
  }
  const means: EvalRecord[] = [];
  for (const i of instances) {
    const by = i.question.itemKey ? answers.get(i.question.itemKey) : undefined;
    const others = [...(by?.entries() ?? [])].filter(([m]) => m !== i.mimicId).map(([, a]) => a);
    if (others.length < minOthers) continue;
    const keys = i.question.options.map((o) => o.key);
    const dist: Distribution = Object.fromEntries(
      keys.map((k) => [
        k,
        (others.filter((a) => a === k).length + 0.5) / (others.length + 0.5 * keys.length),
      ]),
    );
    means.push(
      toRecord(i, 'item-mean|population', 'item-mean', {
        dist,
        ok: true,
        costUsd: 0,
        latencyMs: 0,
        modelSnapshot: 'item-mean',
      }),
    );
  }
  const covered = new Set(means.map((r) => r.instanceId));
  const role = (r: EvalRecord) => r.candidate.split('|')[1]!;
  const rows = [
    ...groupBy(
      recs.filter((r) => covered.has(r.instanceId) && role(r) !== 'fallback'),
      (r) => r.candidate,
    ).entries(),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([candidate, xs]) => {
      const [predictor, r] = candidate.split('|') as [string, string];
      return {
        predictor,
        role: r,
        logLoss: pairedByPerson(means, xs, 'logLoss', `residual>${candidate}`),
        itemAcc: pairedByPerson(means, xs, 'itemAcc', `residual>${candidate}:acc`),
      };
    });
  return {
    minOthers,
    items: new Set(instances.filter((i) => covered.has(i.id)).map((i) => i.question.itemKey)).size,
    instances: means.length,
    people: new Set(means.map((r) => r.mimicId)).size,
    itemMean: {
      logLoss: means.length ? mean(means.map((r) => r.logLoss)) : 0,
      itemAcc: means.length ? mean(means.map((r) => r.itemAcc)) : 0,
    },
    rows,
  };
}

/** Self-consistency per person from repeat probes, smoothed toward the 0.8 prior (PLAN §9.10). */
export function selfConsistencyOf(instances: EvalInstance[]): Record<string, { n: number; c: number }> {
  const out: Record<string, { n: number; c: number }> = {};
  for (const [m, xs] of groupBy(instances, (i) => i.mimicId)) {
    const a = xs.map((i) => i.repeatAgreement).filter((x): x is number => x !== null);
    // The product's own smoothing (PLAN §9.10), so the report matches the fidelity people see.
    out[`${personLabel(m)} (${xs[0]!.split})`] = { n: a.length, c: selfConsistency(a) };
  }
  return out;
}

/** For the reflective dataset: the state trimmed to identity plus the answers most related to the question. */
export function stateExcerpt(inst: EvalInstance, maxLines = 8): string {
  // No name: cases from several people share one reflection prompt, and a name is never useful to the rewrite.
  const id = Object.entries(inst.state.identity)
    .filter(([k]) => k !== 'name')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : String(v)}`)
    .join(' | ');
  const related = inst.state.evidence
    .map((e) => ({ e, s: lexicalSimilarity(e.q, inst.question.prompt) }))
    .sort((a, b) => b.s - a.s || b.e.seq - a.e.seq)
    .slice(0, maxLines)
    .sort((a, b) => a.e.seq - b.e.seq)
    .map(({ e }) => `#${e.seq} ${e.q} → ${e.answer}${e.why ? ` (why: ${e.why.slice(0, 120)})` : ''}`);
  return [
    `identity: ${id}`,
    `${inst.state.evidence.length} earlier answers in the state${inst.state.traits?.length ? `, ${inst.state.traits.length} trait estimates` : ''}${inst.state.insights?.length ? `, ${inst.state.insights.length} insights` : ''}; most related:`,
    ...related,
  ].join('\n');
}

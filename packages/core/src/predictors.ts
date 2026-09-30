import { z } from 'zod';
import {
  DEFAULT_PROMPT_VERSION,
  fill,
  PREDICT_PROMPTS,
  type PredictHarness,
  type PredictPrompt,
  promptHash,
  reasoningOf,
  resolvePredictPrompt,
} from './components';
import { parsePredictorId, predictorIdProblem } from './config';
import { argmax, normalizeDist, optionKeys, temperatureScale } from './distribution';
import { type CallContext, type Gateway, isTimeoutError, isTransientError } from './gateway';
import { answerToDistribution, confidenceOf, predictionQuestion } from './jev';
import { PROMPTS } from './prompts';
import { renderStateText, stateForProvider } from './state-builder';
import type {
  ChatMessage,
  DecisionQuestion,
  PersonState,
  PredictionErrorKind,
  PredictionResult,
  Predictor,
  Question,
} from './types';

/** Jev key for a question inside a batched request. */
export function jevKey(q: Pick<Question, 'id'>): string {
  return `q_${q.id}`;
}

/**
 * A predictor's prompt: a registered version (the default when omitted), or an unregistered candidate from the
 * optimizer, which is labeled by its content hash so it can never pass for a registered version.
 */
export type PromptRef = string | Omit<PredictPrompt, 'version'> | undefined;

function promptOf(kind: 'jev' | 'llm', ref: PromptRef, model: string): PredictPrompt {
  // A registered version may set its harness per model (ADR-0041), so it resolves against this predictor's model.
  if (ref === undefined) return resolvePredictPrompt(DEFAULT_PROMPT_VERSION[kind], kind, model);
  if (typeof ref === 'string') return resolvePredictPrompt(ref, kind, model);
  if (ref.kind !== kind) throw new Error(`A ${ref.kind} prompt can't drive a ${kind} predictor`);
  return { ...ref, version: `cand-${promptHash(ref).slice(0, 12)}` };
}

function predictorIdOf(kind: 'jev' | 'llm', model: string, prompt: PredictPrompt): string {
  return prompt.version === DEFAULT_PROMPT_VERSION[kind]
    ? `${kind}:${model}`
    : `${kind}:${model}@${prompt.version}`;
}

/** Primary / baseline predictor: one batched Jev request per shared state (PLAN §5.1). */
export class JevPredictor implements Predictor {
  readonly id: string;
  readonly prompt: PredictPrompt;
  constructor(
    private readonly gateway: Gateway,
    private readonly model: string,
    private readonly ctx: CallContext,
    prompt?: PromptRef,
  ) {
    this.prompt = promptOf('jev', prompt, model);
    this.id = predictorIdOf('jev', model, this.prompt);
  }

  async predict(state: PersonState, qs: Question[]): Promise<PredictionResult[]> {
    if (qs.length === 0) return [];
    const questions: Record<string, DecisionQuestion> = {};
    const c = this.prompt.components;
    for (const q of qs) questions[jevKey(q)] = predictionQuestion(q, c);
    try {
      const res = await this.gateway.decide(this.ctx, {
        model: this.model,
        state:
          this.prompt.harness.jevState === 'text'
            ? renderStateText(stateForProvider(state), c)
            : stateForProvider(state),
        questions,
      });
      const share = res.usage.costUsd / qs.length;
      return qs.map((q) => {
        const a = res.answers[jevKey(q)];
        if (!a)
          return failed(`missing answer for ${jevKey(q)}`, res.latencyMs, res.modelSnapshot, share, 'output');
        try {
          const out: PredictionResult = {
            dist: answerToDistribution(q, a),
            costUsd: share,
            latencyMs: res.latencyMs,
            modelSnapshot: res.modelSnapshot,
            ok: true,
          };
          const c = confidenceOf(a);
          if (c !== undefined) out.confidence = c;
          return calibratedResult(out, q, this.prompt.harness.calibrationTemperature);
        } catch (e) {
          return failed(String(e), res.latencyMs, res.modelSnapshot, share, 'output');
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return qs.map(() => callFailed(e, msg, this.model));
    }
  }
}

const LlmProbs = z.union([
  z.object({ probs: z.array(z.object({ key: z.string(), p: z.number() })) }),
  z.record(z.string(), z.number()),
]);

const REASONED_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    probs: PROMPTS['predict.v1'].schema.properties.probs,
  },
  required: ['reasoning', 'probs'],
  additionalProperties: false,
} as const;

/**
 * The JSON schema an LLM answers in: `probs`, or `reasoned` (a rationale first). With `keyEnum` the key field is an
 * enum of this question's option keys, so a provider that enforces the schema can't return labels or invented keys.
 */
export function probsSchema(
  h: Pick<PredictHarness, 'schema' | 'keyEnum'>,
  keys: string[],
): Record<string, unknown> {
  const base: Record<string, unknown> =
    h.schema === 'reasoned' ? REASONED_SCHEMA : PROMPTS['predict.v1'].schema;
  if (!h.keyEnum) return base;
  const probs = {
    type: 'array',
    items: {
      type: 'object',
      properties: { key: { type: 'string', enum: keys }, p: { type: 'number' } },
      required: ['key', 'p'],
      additionalProperties: false,
    },
  };
  return h.schema === 'reasoned'
    ? { ...REASONED_SCHEMA, properties: { ...REASONED_SCHEMA.properties, probs } }
    : { ...base, properties: { probs } };
}

/** LLM shadow predictor (PLAN §9.6, prompt predict.v1 by default). One chat call per question, run in parallel. */
export class LlmPredictor implements Predictor {
  readonly id: string;
  readonly prompt: PredictPrompt;
  constructor(
    private readonly gateway: Gateway,
    private readonly model: string,
    private readonly ctx: CallContext,
    prompt?: PromptRef,
  ) {
    this.prompt = promptOf('llm', prompt, model);
    this.id = predictorIdOf('llm', model, this.prompt);
  }

  predict(state: PersonState, qs: Question[]): Promise<PredictionResult[]> {
    const stateText = renderStateText(state, this.prompt.components);
    return Promise.all(qs.map((q) => this.one(stateText, q)));
  }

  /** The chat messages for one question (exposed for the optimizer's traces). */
  messages(stateText: string, q: Question): ChatMessage[] {
    const c = this.prompt.components;
    return [
      { role: 'system', content: c['predict.system'] },
      {
        role: 'user',
        content: fill(c['predict.user'], {
          state: stateText,
          prompt: q.prompt,
          options: q.options.map((o) => `${o.key}: ${o.label}`).join('\n'),
        }),
      },
    ];
  }

  private async one(stateText: string, q: Question): Promise<PredictionResult> {
    const h = this.prompt.harness;
    const keys = optionKeys(q);
    try {
      const res = await this.gateway.chat(this.ctx, {
        model: this.model,
        messages: this.messages(stateText, q),
        jsonSchema: { name: 'probs', schema: probsSchema(h, keys) },
        // One reasoning control, so the logged request (invariant 5) shows what was sent.
        ...reasoningOf(h),
        maxTokens: h.maxTokens,
      });
      const base = {
        costUsd: res.usage.costUsd,
        latencyMs: res.latencyMs,
        modelSnapshot: res.modelSnapshot,
        raw: res.content.slice(0, 2000),
      };
      const parsed = LlmProbs.safeParse(parseJsonLoose(res.content));
      if (!parsed.success) {
        // The provider's stop reason says why no JSON came back: the token cap, or a refusal.
        const error =
          res.finishReason === 'length'
            ? `output cut off at max_tokens (${h.maxTokens}; ${res.usage.outputTokens} output tokens)`
            : res.finishReason === 'content_filter'
              ? "output withheld by the provider's content filter"
              : 'invalid JSON output';
        return { ...base, dist: {}, ok: false, error, errorKind: 'output' };
      }
      let raw: Record<string, number> =
        'probs' in parsed.data && Array.isArray(parsed.data.probs)
          ? Object.fromEntries(parsed.data.probs.map((x) => [x.key, x.p]))
          : (parsed.data as Record<string, number>);
      if (h.labelKeys) raw = keyedByLabel(raw, q);
      const covered = keys.filter((k) => typeof raw[k] === 'number' && raw[k]! >= 0);
      const sum = covered.reduce((a, k) => a + raw[k]!, 0);
      if (covered.length < keys.length || !(sum > 0)) {
        return {
          ...base,
          dist: {},
          ok: false,
          error: 'output does not cover every option',
          errorKind: 'output',
        };
      }
      return {
        ...base,
        dist: temperatureScale(normalizeDist(raw, keys), h.calibrationTemperature),
        ok: true,
      };
    } catch (e) {
      return callFailed(e, e instanceof Error ? e.message : String(e), this.model);
    }
  }
}

/**
 * `raw` re-keyed from option labels to option keys (harness `labelKeys`), when the model used labels as keys. It is
 * returned unchanged unless every option is then covered, each by exactly one entry, so a partial or ambiguous answer
 * still fails. An entry that is neither a key nor a label is ignored, as it is for an answer keyed by keys.
 */
export function keyedByLabel(raw: Record<string, number>, q: Question): Record<string, number> {
  const keys = optionKeys(q);
  if (keys.every((k) => Object.hasOwn(raw, k))) return raw;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const byLabel = new Map<string, string>();
  for (const o of q.options) {
    const l = norm(o.label);
    if (byLabel.has(l)) return raw;
    byLabel.set(l, o.key);
  }
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(raw)) {
    const key = keys.includes(k) ? k : byLabel.get(norm(k));
    if (key === undefined) continue;
    if (Object.hasOwn(out, key)) return raw;
    out[key] = p;
  }
  return keys.every((k) => Object.hasOwn(out, k)) ? out : raw;
}

function failed(
  error: string,
  latencyMs: number,
  modelSnapshot: string,
  costUsd: number,
  errorKind: PredictionErrorKind,
): PredictionResult {
  return { dist: {}, costUsd, latencyMs, modelSnapshot, ok: false, error, errorKind };
}

/**
 * The provider call threw, so the model never answered: a timeout (the model was too slow) or a transport failure,
 * which may be worth retrying (ADR-0037).
 */
function callFailed(e: unknown, error: string, model: string): PredictionResult {
  if (isTimeoutError(e)) return failed(error, 0, model, 0, 'timeout');
  return { ...failed(error, 0, model, 0, 'transport'), retryable: isTransientError(e) };
}

/** Parses JSON from model output, tolerating code fences and surrounding prose. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1]);
      } catch {}
    }
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {}
    }
    return undefined;
  }
}

/** A predictor from its ID: `jev:<model>` or `llm:<model>`, optionally `@<promptVersion>` (ADR-0028). */
export function makePredictor(gateway: Gateway, id: string, ctx: CallContext): Predictor {
  const spec = parsePredictorId(id);
  return spec.kind === 'jev'
    ? new JevPredictor(gateway, spec.model, ctx, spec.promptVersion)
    : new LlmPredictor(gateway, spec.model, ctx, spec.promptVersion);
}

/**
 * A successful prediction rescaled by a calibration temperature (harness `calibrationTemperature`): p ∝ p^(1/T), top
 * pick unchanged. The confidence follows on Jev's scale (`confidenceOf`): a yes/no answer's |p − ½|·2, else the top
 * probability. T = 1, or a failed prediction, is returned as it is.
 */
export function calibratedResult(
  r: PredictionResult,
  q: Pick<Question, 'type'>,
  t: number,
): PredictionResult {
  if (t === 1 || !r.ok) return r;
  const dist = temperatureScale(r.dist, t);
  const top = dist[argmax(dist)]!;
  return { ...r, dist, confidence: q.type === 'noul' ? Math.abs(2 * top - 1) : top };
}

/**
 * The primary as selection sees it (ADR-0048). Calibration only rescales the stored prediction, so selection scores
 * candidates on the predictor's raw scale: the scale VOI's weights and the hypothesis posterior were tuned on, and
 * the same model call. Returns that raw predictor, its ID (the registered twin at calibration temperature 1 when
 * there is one, so rows it produces are labelled with what made them), and the rescale that turns its prediction for
 * the chosen question into the stored primary.
 */
export function selectionView(
  gateway: Gateway,
  id: string,
  ctx: CallContext,
): {
  predictor: Predictor;
  id: string;
  calibrate: (r: PredictionResult, q: Pick<Question, 'type'>) => PredictionResult;
} {
  const spec = parsePredictorId(id);
  const prompt = resolvePredictPrompt(
    spec.promptVersion ?? DEFAULT_PROMPT_VERSION[spec.kind],
    spec.kind,
    spec.model,
  );
  const t = prompt.harness.calibrationTemperature;
  if (t === 1) return { predictor: makePredictor(gateway, id, ctx), id, calibrate: (r) => r };
  const raw = { ...prompt, harness: { ...prompt.harness, calibrationTemperature: 1 } };
  const same = (p: PredictPrompt) =>
    JSON.stringify([p.components, p.harness]) === JSON.stringify([raw.components, raw.harness]);
  const rawId = Object.values(PREDICT_PROMPTS)
    .filter((v) => v.kind === spec.kind)
    .map((v) => resolvePredictPrompt(v.id, spec.kind, spec.model))
    .filter(same)
    .map((p) => predictorIdOf(spec.kind, spec.model, p))
    .find((pid) => !predictorIdProblem(pid));
  const predictor = rawId
    ? makePredictor(gateway, rawId, ctx)
    : spec.kind === 'jev'
      ? new JevPredictor(gateway, spec.model, ctx, raw)
      : new LlmPredictor(gateway, spec.model, ctx, raw);
  return { predictor, id: rawId ?? predictor.id, calibrate: (r, q) => calibratedResult(r, q, t) };
}

/** The prompt version stored with a prediction from this predictor (invariant 4). */
export function promptVersionOf(predictorId: string): string {
  const spec = parsePredictorId(predictorId);
  return spec.promptVersion ?? DEFAULT_PROMPT_VERSION[spec.kind];
}

/** Throws unless the ID parses and any `@<version>` is registered, of the right kind, and not the incumbent. */
export function assertPredictorId(id: string): void {
  const problem = predictorIdProblem(id);
  if (problem) throw new Error(problem);
}

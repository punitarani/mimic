import { z } from 'zod';
import { DEFAULT_PROMPT_VERSION, harnessProblems, PREDICT_PROMPTS, resolvePredictPrompt } from './components';
import { canonicalJson, sha256Hex } from './hash';

/**
 * Why a predictor ID can't be served, or null. A config naming an unregistered prompt version would otherwise throw on
 * every /next; the incumbent spelled with a suffix would store a second ID for the same predictor.
 */
export function predictorIdProblem(id: string): string | null {
  let spec: PredictorSpec;
  try {
    spec = parsePredictorId(id);
  } catch (e) {
    return (e as Error).message;
  }
  if (spec.promptVersion === undefined) return null;
  if (spec.promptVersion === DEFAULT_PROMPT_VERSION[spec.kind])
    return `${id} names the incumbent prompt; use ${spec.kind}:${spec.model}`;
  const v = PREDICT_PROMPTS[spec.promptVersion];
  if (!v) return `unknown prediction prompt version in ${id}`;
  if (v.kind !== spec.kind) return `${spec.promptVersion} is a ${v.kind} prompt, not ${spec.kind}`;
  // Reasoning settings and caps are measured per model (ADR-0041): no silent fallback for a model a variant doesn't list.
  if (v.modelHarness && !Object.hasOwn(v.modelHarness, spec.model))
    return `${spec.promptVersion} has no measured reasoning settings for ${spec.model} (it lists ${Object.keys(v.modelHarness).join(', ')}); register a version that lists it`;
  const problems = harnessProblems(resolvePredictPrompt(spec.promptVersion, spec.kind, spec.model).harness);
  if (problems.length) return `${id}: ${problems.join('; ')}`;
  return null;
}

function checkPredictor(id: string, ctx: z.RefinementCtx): void {
  const problem = predictorIdProblem(id);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
}

export const PipelineConfig = z.object({
  version: z.literal(1),
  ontologyVersion: z.string(),
  anchors: z.object({ setId: z.string(), count: z.number().int() }),
  /** Static items served when the generated pool is empty (ADR-0042); reserve.v1 when absent. */
  reserve: z.object({ setId: z.string() }).optional(),
  generator: z.object({
    model: z.string(),
    reasoningEffort: z.enum(['none', 'low', 'medium']),
    promptVersion: z.string(),
    batchSize: z.number().int(),
    domainMix: z.object({ core: z.number(), casual: z.number(), professional: z.number() }),
    /** Quality-gate set (ADR-0042); gates.v2 when absent. Optional and undefaulted, so older hashes are unchanged. */
    gates: z.string().optional(),
  }),
  selector: z.discriminatedUnion('type', [
    z.object({ type: z.literal('random') }),
    z.object({ type: z.literal('coverage') }),
    z.object({ type: z.literal('entropy'), lambdaCoverage: z.number(), muRedundancy: z.number() }),
    z.object({ type: z.literal('bald'), k: z.number().int(), lambdaCoverage: z.number() }),
    /** Value of information (docs/SELECTION.md §4, ADR-0027). */
    z.object({
      type: z.literal('voi'),
      /** Persona hypotheses per selection; below 2 the information term is predictive entropy. */
      k: z.number().int().min(0),
      lambdaCoverage: z.number(),
      muRedundancy: z.number(),
      betaConflict: z.number(),
      gammaWeakness: z.number(),
      /** Weight of the cross-person item prior; 0 turns population statistics off. */
      piPopulation: z.number(),
      nuBurden: z.number(),
      /** A candidate whose facets already take more than this share of the adaptive questions is skipped. */
      exposureCap: z.number().min(0).max(1),
    }),
  ]),
  /** Predictor IDs, optionally `@<version>` naming a registered prompt variant (ADR-0028); checked on parse. */
  predictor: z.object({
    primary: z.string().superRefine(checkPredictor),
    shadows: z.array(z.string().superRefine(checkPredictor)),
  }),
  stateBuilder: z.object({
    strategy: z.enum(['raw', 'structured', 'summary', 'full']),
    budgetTokens: z.number().int(),
    retrievalK: z.number().int(),
    recentN: z.number().int(),
    /**
     * Annotate state evidence with the answer's pace against the person's own median latency (docs/SELECTION.md
     * §8). Optional, not defaulted, so configs written before it keep their hash.
     */
    latencyHints: z.boolean().optional(),
  }),
  traitReader: z.object({ type: z.enum(['jev', 'none']), everyN: z.number().int() }),
  reflector: z.object({
    model: z.string().nullable(),
    everyN: z.number().int(),
    promptVersion: z.string(),
    requireCitations: z.literal(true),
  }),
  repeats: z.object({ every: z.number().int(), minGap: z.number().int() }),
  reveal: z.enum(['after_answer', 'never']),
  session: z.object({ target: z.number().int(), budgetUsd: z.number() }),
  /** ADR-0005: the embedding model is part of the config because it drives dedupe and retrieval. */
  embedding: z.object({ model: z.string() }),
});
export type PipelineConfig = z.infer<typeof PipelineConfig>;

export const JEV_MODEL = 'typesafe/jev-1.13';
/**
 * Respan Span-01 on the same OpenRouter Decisions API, pinned to its dated snapshot: the challenger to Jev behind the
 * `decisions-model` flag (variant `span-01`), off by default (ADR-0050).
 */
export const SPAN_MODEL = 'respan/span-01-20260925';

/**
 * The `decisions-model` flag's variants and the pinned model each serves (ADR-0050). A variant names a model here
 * rather than in the flag, so changing what `span-01` means is a reviewed code change, not a dashboard edit.
 */
export const DECISION_MODELS: Readonly<Record<string, string>> = {
  jev: JEV_MODEL,
  'span-01': SPAN_MODEL,
};
export const LLM = {
  luna: 'openai/gpt-6-luna',
  deepseek: 'deepseek/deepseek-v4.1-flash',
  glm: 'z-ai/glm-5.3-flash',
  mimoFlash: 'xiaomi/mimo-v2.6-flash',
  qwenFlash: 'qwen/qwen3.8-flash',
} as const;
export const EMBEDDING_MODEL = 'baai/bge-base-en-v1.5';

export const VOI_SELECTOR: Extract<PipelineConfig['selector'], { type: 'voi' }> = {
  type: 'voi',
  k: 4,
  lambdaCoverage: 0.3,
  muRedundancy: 0.5,
  betaConflict: 0.25,
  gammaWeakness: 0.25,
  piPopulation: 0.15,
  nuBurden: 0.2,
  exposureCap: 0.35,
};

/**
 * `cfg.default.v3` (ADR-0025): the v1 shadows plus MiMo V2.6 Flash and Qwen3.8 Flash, the `entropy` selector and
 * `gen.v1`. Kept so its hash stays pinned; mimics created under it keep it.
 */
export const DEFAULT_CONFIG_V3: PipelineConfig = {
  version: 1,
  ontologyVersion: 'v1',
  anchors: { setId: 'anchors.v1', count: 10 },
  generator: {
    model: LLM.deepseek,
    reasoningEffort: 'low',
    promptVersion: 'gen.v1',
    batchSize: 12,
    domainMix: { core: 0.1, casual: 0.45, professional: 0.45 },
  },
  selector: { type: 'entropy', lambdaCoverage: 0.3, muRedundancy: 0.5 },
  predictor: {
    primary: `jev:${JEV_MODEL}`,
    shadows: [
      `llm:${LLM.luna}`,
      `llm:${LLM.deepseek}`,
      `llm:${LLM.glm}`,
      `llm:${LLM.mimoFlash}`,
      `llm:${LLM.qwenFlash}`,
    ],
  },
  stateBuilder: { strategy: 'full', budgetTokens: 8000, retrievalK: 12, recentN: 6 },
  traitReader: { type: 'jev', everyN: 1 },
  reflector: { model: LLM.deepseek, everyN: 5, promptVersion: 'reflect.v1', requireCitations: true },
  repeats: { every: 8, minGap: 6 },
  reveal: 'after_answer',
  session: { target: 30, budgetUsd: 0.5 },
  embedding: { model: EMBEDDING_MODEL },
};

/**
 * `cfg.default.v4` (ADR-0027): v3 with the value-of-information selector, belief-driven generation (`gen.v2`) and
 * latency hints in the state. Kept so its hash stays pinned; mimics created under it keep it.
 */
export const DEFAULT_CONFIG_V4: PipelineConfig = {
  ...DEFAULT_CONFIG_V3,
  generator: { ...DEFAULT_CONFIG_V3.generator, promptVersion: 'gen.v2' },
  selector: VOI_SELECTOR,
  stateBuilder: { ...DEFAULT_CONFIG_V3.stateBuilder, latencyHints: true },
};

/**
 * `cfg.default.v5` (ADR-0038): v4 with the Qwen3.8 Flash shadow run with reasoning off (`predict.v1-direct`). At
 * effort low it reasoned for 1–4.5K tokens (about a minute, and often past max_tokens); off, it answers in about 2 s.
 * Configs are immutable, so older mimics keep the config they were created with; `pnpm backfill` adds new shadows to
 * their served questions. Deviation (ADR-0004): generator and reflector default to DeepSeek V4.1 Flash, not GPT-6
 * Luna.
 */
export const DEFAULT_CONFIG_V5: PipelineConfig = {
  ...DEFAULT_CONFIG_V4,
  predictor: {
    ...DEFAULT_CONFIG_V4.predictor,
    shadows: [
      `llm:${LLM.luna}`,
      `llm:${LLM.deepseek}`,
      `llm:${LLM.glm}`,
      `llm:${LLM.mimoFlash}`,
      `llm:${LLM.qwenFlash}@predict.v1-direct`,
    ],
  },
};

/**
 * `cfg.default.v6` (ADR-0041): every LLM shadow on `predict.v2`, which keeps reasoning on at a low setting per model (an
 * effort, or a 1,024-token budget for models that only take one), caps sized from measured usage, and the answer's
 * keys pinned to the options. v5's reasoning-off Qwen stays as a control arm, so real answers show what reasoning buys
 * (about $0.00007 a question). The primary is unchanged; calibrated Jev (`jev-predict.v2`) is measured from the stored
 * primary for free rather than by a second Jev call. Older mimics keep their config; `pnpm backfill` adds the new
 * shadows to questions already served.
 */
export const DEFAULT_CONFIG_V6: PipelineConfig = {
  ...DEFAULT_CONFIG_V5,
  predictor: {
    ...DEFAULT_CONFIG_V5.predictor,
    shadows: [
      `llm:${LLM.luna}@predict.v2`,
      `llm:${LLM.deepseek}@predict.v2`,
      `llm:${LLM.glm}@predict.v2`,
      `llm:${LLM.mimoFlash}@predict.v2`,
      `llm:${LLM.qwenFlash}@predict.v2`,
      `llm:${LLM.qwenFlash}@predict.v1-direct`,
    ],
  },
};

/**
 * `cfg.default.v7` (ADR-0048): v6 with the primary calibrated (`jev-predict.v2`, temperature 4) and without the
 * reasoning-off Qwen control. On the held-out people calibration cut the primary's log loss from 1.80 to 1.12 with
 * accuracy unchanged; selection keeps Jev's raw scale, so the questions asked are chosen as before. The control showed
 * reasoning makes Qwen more accurate and reliable, which answers its question. Everything else is v6.
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  ...DEFAULT_CONFIG_V6,
  predictor: {
    primary: `jev:${JEV_MODEL}@jev-predict.v2`,
    shadows: DEFAULT_CONFIG_V6.predictor.shadows.filter(
      (s) => s !== `llm:${LLM.qwenFlash}@predict.v1-direct`,
    ),
  },
};
export const DEFAULT_CONFIG_LABEL = 'cfg.default.v7';

/**
 * Runtime spend limits (ADR-0035). Deploy settings, not pipeline config: they change what a mimic may spend, never
 * what a prediction sees, so changing them keeps every config hash.
 */
export interface SpendLimits {
  /** Total cap per mimic in USD for configs on the standard budget; default DEFAULT_BUDGET_USD. */
  budgetUsd?: number;
  /** Share of the cap the learning session may spend; the rest is kept for the mimic page. */
  sessionShare?: number;
}

/** The standard cap per mimic when `BUDGET_USD` is unset. */
export const DEFAULT_BUDGET_USD = 1;
export const DEFAULT_SESSION_SHARE = 0.8;
/**
 * The budget every `cfg.default.*` config carries, from before ADR-0035. A config with it is on the standard budget,
 * which the deploy sets; a config that names any other budget (an experiment arm, say) keeps its own.
 */
export const STANDARD_CONFIG_BUDGET_USD = 0.5;

export interface SpendCaps {
  /** Nothing is spent past this: the gateway refuses every call for the mimic. */
  totalUsd: number;
  /** The session stops here, keeping the rest for asking, teaching and SOUL.md. */
  sessionUsd: number;
}

export function spendCaps(cfg: PipelineConfig, limits: SpendLimits = {}): SpendCaps {
  const own = cfg.session.budgetUsd;
  const totalUsd = own === STANDARD_CONFIG_BUDGET_USD ? (limits.budgetUsd ?? DEFAULT_BUDGET_USD) : own;
  return { totalUsd, sessionUsd: totalUsd * (limits.sessionShare ?? DEFAULT_SESSION_SHARE) };
}

/** The same ranges deploy preflight checks (scripts/deploy/settings.mjs); a test keeps the two in step. */
const SpendEnv = z.object({
  BUDGET_USD: z.coerce.number().positive(),
  BUDGET_SESSION_SHARE: z.coerce.number().gt(0).max(1),
});

/**
 * `BUDGET_USD` and `BUDGET_SESSION_SHARE` from a Worker's vars, which may be strings or JSON numbers. An unset value
 * keeps its default; an invalid one does too and is named in `problems` so the caller can log it (preflight refuses
 * invalid values before a deploy, so this is for hand-set vars).
 */
export function parseSpendLimits(env: { BUDGET_USD?: unknown; BUDGET_SESSION_SHARE?: unknown }): {
  limits: SpendLimits;
  problems: string[];
} {
  const problems: string[] = [];
  const read = (k: keyof typeof SpendEnv.shape) => {
    const raw = env[k];
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (raw === undefined || raw === null || text === '') return undefined;
    const r = SpendEnv.shape[k].safeParse(text);
    if (r.success) return r.data;
    problems.push(`${k} is not valid; using the default`);
    return undefined;
  };
  const budgetUsd = read('BUDGET_USD');
  const sessionShare = read('BUDGET_SESSION_SHARE');
  return {
    limits: {
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(sessionShare !== undefined ? { sessionShare } : {}),
    },
    problems,
  };
}

export function configHash(config: PipelineConfig): string {
  return sha256Hex(canonicalJson(PipelineConfig.parse(config)));
}

export type PredictorSpec = { kind: 'jev' | 'llm'; model: string; promptVersion?: string };

/**
 * `jev:<model>` or `llm:<model>`, optionally `@<promptVersion>` for a registered prediction prompt variant
 * (packages/core/src/components.ts, ADR-0028). Without a version the predictor uses the incumbent prompt.
 */
export function parsePredictorId(id: string): PredictorSpec {
  const idx = id.indexOf(':');
  const kind = id.slice(0, idx);
  const rest = id.slice(idx + 1);
  const at = rest.lastIndexOf('@');
  const model = at >= 0 ? rest.slice(0, at) : rest;
  const promptVersion = at >= 0 ? rest.slice(at + 1) : undefined;
  if (idx < 0 || !model) throw new Error(`Invalid predictor id: ${id}`);
  if (promptVersion !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(promptVersion))
    throw new Error(`Invalid prompt version in predictor id: ${id}`);
  if (kind === 'jev' || kind === 'llm')
    return promptVersion === undefined ? { kind, model } : { kind, model, promptVersion };
  throw new Error(`Unknown predictor kind: ${id}`);
}

import { hashJson } from './hash';
import { PROMPTS } from './prompts';
import type { StateView } from './state-builder';

/**
 * Prediction prompts as named text components (docs/OPTIMIZATION.md §4). The optimizer rewrites these; production
 * resolves them from a registered prompt version, so an edit is always a new version ID (PLAN Appendix A).
 *
 * Placeholders are `{name}`. Each component has required and allowed placeholders; `fill` replaces only those.
 */
export const COMPONENT_IDS = [
  'predict.system',
  'predict.user',
  'state.evidence.line',
  'jev.instructions',
  'jev.choice',
  'jev.noul.true',
  'jev.noul.false',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];
export type PredictComponents = Record<ComponentId, string>;

/**
 * How a predictor is called (ADR-0054): `decision`, the OpenRouter Decisions API (Jev, span-01: a state plus typed
 * questions, answered with probabilities), or `llm`, a chat completion that returns JSON probabilities. The kind is the
 * prefix of a predictor ID; the model follows it.
 */
export type PredictorKind = 'decision' | 'llm';

/**
 * A kind by its name in a predictor ID. `jev` is the decision kind's name from before ADR-0054, accepted forever:
 * hashed configs (v3–v8, cfg.e3b.control) spell their primary with it.
 */
export function predictorKindOf(name: string): PredictorKind | null {
  if (name === 'decision' || name === 'jev') return 'decision';
  return name === 'llm' ? 'llm' : null;
}

export interface ComponentSpec {
  /** What the component does, shown to the reflection model. */
  role: string;
  required: string[];
  optional: string[];
  maxWords: number;
  /** Which predictor kinds read this component. */
  kinds: PredictorKind[];
}

export const COMPONENT_SPECS: Record<ComponentId, ComponentSpec> = {
  'predict.system': {
    role: 'System prompt of an LLM that returns a probability for each option of a typed question about one person.',
    required: [],
    optional: [],
    maxWords: 350,
    kinds: ['llm'],
  },
  'predict.user': {
    role: 'User message template of that LLM call: the rendered person state, the question and its options.',
    required: ['state', 'prompt', 'options'],
    optional: [],
    maxWords: 120,
    kinds: ['llm'],
  },
  'state.evidence.line': {
    role: "How one earlier answer is rendered in the state text. {pace} expands to ' (answered quickly)', ' (took a while)' or nothing; {why} to ' (why: …)' or nothing.",
    required: ['seq', 'q', 'answer'],
    optional: ['options', 'pace', 'why'],
    maxWords: 40,
    kinds: ['llm', 'decision'],
  },
  'jev.instructions': {
    role: 'Instructions of a decision-model question asking how the person in the state would answer {prompt}.',
    required: ['prompt'],
    optional: [],
    maxWords: 120,
    kinds: ['decision'],
  },
  'jev.choice': {
    role: 'Criterion text for one option of a multiple-choice prediction; {label} is the option label.',
    required: ['label'],
    optional: [],
    maxWords: 40,
    kinds: ['decision'],
  },
  'jev.noul.true': {
    role: 'Criterion for "yes" when predicting a yes/no question.',
    required: [],
    optional: [],
    maxWords: 40,
    kinds: ['decision'],
  },
  'jev.noul.false': {
    role: 'Criterion for "no" when predicting a yes/no question.',
    required: [],
    optional: [],
    maxWords: 40,
    kinds: ['decision'],
  },
};

/**
 * Whether a predictor with this prompt actually reads a component. Jev reads the evidence line only when it gets the
 * state as text (`harness.jevState: 'text'`); otherwise rewriting it changes nothing.
 */
export function componentReadBy(
  id: ComponentId,
  p: { kind: PredictorKind; harness: Pick<PredictHarness, 'jevState'> },
): boolean {
  if (!COMPONENT_SPECS[id].kinds.includes(p.kind)) return false;
  return !(p.kind === 'decision' && id === 'state.evidence.line' && p.harness.jevState !== 'text');
}

/** The components as they shipped in `predict.v1` and `jev-predict.v1` (byte-identical to the original literals). */
export const INCUMBENT_COMPONENTS: PredictComponents = {
  'predict.system': PROMPTS['predict.v1'].system,
  'predict.user': 'STATE:\n{state}\n\nQUESTION: {prompt}\nOPTIONS:\n{options}',
  'state.evidence.line': '#{seq} {q} [{options}] → {answer}{pace}{why}',
  'jev.instructions':
    'Predict how the person described in the state would answer this question, based only on the state: "{prompt}"',
  'jev.choice': 'The person would choose: {label}',
  'jev.noul.true': 'The person would answer yes',
  'jev.noul.false': 'The person would answer no',
};

export interface PredictHarness {
  /** LLM reasoning effort (never temperature; CLAUDE.md). Used when `reasoningMaxTokens` is null. */
  reasoningEffort: 'none' | 'low' | 'medium';
  /**
   * An explicit reasoning token budget, for models that ignore effort levels and take a budget instead (OpenRouter
   * `reasoning.max_tokens`). Null means use `reasoningEffort`.
   */
  reasoningMaxTokens: number | null;
  /** Output cap. It covers reasoning and the answer together, so it must leave room for both. */
  maxTokens: number;
  /** LLM output schema: `probs`, or `reasoned` (a short rationale written before the probabilities). */
  schema: 'probs' | 'reasoned';
  /** How the state reaches Jev: the JSON object, or the same text rendering the LLMs see. */
  jevState: 'json' | 'text';
  /**
   * Post-hoc calibration of the returned distribution: p ∝ p^(1/T). 1 leaves it alone; above 1 softens an
   * overconfident predictor. Not a sampling temperature: nothing is sent to the provider.
   */
  calibrationTemperature: number;
  /**
   * Constrain the LLM's `key` field to the question's option keys in the JSON schema (an `enum` per question), so a
   * model can't key its answer by labels or invent options.
   */
  keyEnum: boolean;
  /**
   * Accept an LLM's option labels in place of their keys: some models answer a 0–4 scale with "Never", "Often", …
   * as keys. Used only when every option is then covered, each by one label. A fallback for providers that don't
   * enforce `keyEnum`.
   */
  labelKeys: boolean;
  /**
   * The view of the sealed state the predictor reads (`viewState`, ADR-0065); absent reads the whole state. A view is
   * a subset of the state, so a prediction keeps the sealed state's hash and its version names the view.
   */
  stateView?: HarnessStateView;
}

/** Views a predictor may read for a whole batch of questions (`relevant` is chosen per question, so it is not one). */
export const HARNESS_STATE_VIEWS = ['context', 'answers', 'derived'] as const satisfies readonly StateView[];
export type HarnessStateView = (typeof HARNESS_STATE_VIEWS)[number];

/**
 * The harness settings a registered variant may set per model (`modelHarness`): how the model reasons and its token
 * cap, which are measured per model (ADR-0041). Everything else describes the prompt and applies to every model.
 */
export const PER_MODEL_HARNESS_KEYS = ['reasoningEffort', 'reasoningMaxTokens', 'maxTokens'] as const;

/** Room kept for the answer when a reasoning budget shares `maxTokens` with it. */
export const ANSWER_TOKENS_MIN = 256;

/** Problems with a resolved harness: a reasoning budget that leaves no room for the answer. */
export function harnessProblems(h: PredictHarness): string[] {
  const out: string[] = [];
  const b = h.reasoningMaxTokens;
  if (b !== null && (!Number.isInteger(b) || b < 1))
    out.push(
      `reasoningMaxTokens must be a positive integer or null (got ${b}); use reasoningEffort 'none' for no reasoning`,
    );
  if (b !== null && b + ANSWER_TOKENS_MIN > h.maxTokens)
    out.push(
      `maxTokens ${h.maxTokens} leaves under ${ANSWER_TOKENS_MIN} tokens for the answer after a ${b}-token reasoning budget`,
    );
  return out;
}

/** The one reasoning control a request carries: the budget when there is one, else the effort (never both). */
export function reasoningOf(
  h: Pick<PredictHarness, 'reasoningEffort' | 'reasoningMaxTokens'>,
): { reasoningMaxTokens: number } | { reasoningEffort: PredictHarness['reasoningEffort'] } {
  return h.reasoningMaxTokens !== null
    ? { reasoningMaxTokens: h.reasoningMaxTokens }
    : { reasoningEffort: h.reasoningEffort };
}

export const INCUMBENT_HARNESS: PredictHarness = {
  reasoningEffort: 'low',
  reasoningMaxTokens: null,
  maxTokens: 3000,
  schema: 'probs',
  jevState: 'json',
  calibrationTemperature: 1,
  keyEnum: false,
  labelKeys: false,
};

export type PerModelHarness = Partial<Pick<PredictHarness, (typeof PER_MODEL_HARNESS_KEYS)[number]>>;

export interface PredictPromptVariant {
  id: string;
  kind: PredictorKind;
  title: string;
  /** Overrides over the incumbent; omitted components keep the incumbent text. */
  components: Partial<PredictComponents>;
  harness: Partial<PredictHarness>;
  /**
   * Per-model reasoning control and caps (PER_MODEL_HARNESS_KEYS), applied over `harness`. A variant that has them
   * runs only on the models it lists (`predictorIdProblem`), so a new model gets measured settings rather than a
   * silent fallback. Part of the version: changing a model's settings means a new version ID.
   */
  modelHarness?: Record<string, PerModelHarness>;
  /** Where it came from, e.g. the optimize run that produced it. */
  source: string;
}

/** A resolved prompt: every component and harness setting, plus the version ID stored on predictions. */
export interface PredictPrompt {
  version: string;
  kind: PredictorKind;
  components: PredictComponents;
  harness: PredictHarness;
}

/** `predict.v2`'s measured reasoning settings and caps (ADR-0041); its variants that change only the view share them. */
const PREDICT_V2_MODEL_HARNESS: Record<string, PerModelHarness> = {
  'openai/gpt-6-luna': { reasoningEffort: 'low', maxTokens: 1500 },
  'deepseek/deepseek-v4.1-flash': { reasoningEffort: 'low', maxTokens: 6000 },
  'z-ai/glm-5.3-flash': { reasoningEffort: 'low', maxTokens: 3000 },
  'xiaomi/mimo-v2.6-flash': { reasoningMaxTokens: 1024, maxTokens: 2048 },
  'qwen/qwen3.8-flash': { reasoningMaxTokens: 1024, maxTokens: 2048 },
};

/** The incumbent prompt per kind: a predictor ID without `@<version>` uses it. The Jev templates keep their IDs. */
export const DEFAULT_PROMPT_VERSION = { decision: 'jev-predict.v1', llm: 'predict.v1' } as const;

/**
 * Registered prediction prompt versions. Add a variant here (never edit one) to ship an optimized candidate; it is then
 * addressable as `llm:<model>@<id>` or `decision:<model>@<id>` in configs and `pnpm backfill` (ADR-0028).
 */
export const PREDICT_PROMPTS: Record<string, PredictPromptVariant> = {
  'predict.v1': {
    id: 'predict.v1',
    kind: 'llm',
    title: 'LLM predictor (incumbent)',
    components: {},
    harness: {},
    source: 'PLAN Appendix A.3',
  },
  'jev-predict.v1': {
    id: 'jev-predict.v1',
    kind: 'decision',
    title: 'Jev prediction templates (incumbent)',
    components: {},
    harness: {},
    source: 'PLAN §9.6',
  },
  'predict.v1-direct': {
    id: 'predict.v1-direct',
    kind: 'llm',
    title: 'LLM predictor, reasoning off (for models that ignore low effort)',
    components: {},
    harness: { reasoningEffort: 'none' },
    source: 'ADR-0038: Qwen3.8 Flash reasons 1-4.5K tokens at effort low; off, it answers in about 2 s',
  },
  /**
   * ADR-0041: the incumbent prompt with reasoning controls and caps set per model from measured usage, and option
   * labels accepted as keys. Every model reasons at a low setting: an effort level where the model honours one, a
   * 1,024-token budget where it only takes a budget. A cap is about twice the largest completion measured (at least
   * 1,500), twice the budget for a budget model, so reasoning can't eat the answer. A truncated call is billed for its
   * whole cap, so a generous cap costs almost nothing. The key field is an enum of the question's option keys, and
   * label-keyed answers are re-keyed as a fallback. It runs only on the models listed here.
   */
  'predict.v2': {
    id: 'predict.v2',
    kind: 'llm',
    title: 'LLM predictor, per-model reasoning budgets',
    components: {},
    harness: { keyEnum: true, labelKeys: true },
    modelHarness: PREDICT_V2_MODEL_HARNESS,
    source: 'ADR-0041: reasoning usage measured per model on long states',
  },
  /**
   * ADR-0041: the incumbent Jev templates with a calibration temperature of 4. Fitted on the prod dev person and
   * checked on the two test people, it cut their log loss from 1.80 to 1.12 and calibration error from 0.27 to
   * 0.10. It only rescales Jev's answer, so it was never a shadow (a second identical Jev call per question):
   * `evaluate --from stored` derived it from the stored primary for free. The primary since cfg.default.v7 (ADR-0048).
   */
  'jev-predict.v2': {
    id: 'jev-predict.v2',
    kind: 'decision',
    title: 'Jev prediction templates, calibrated (temperature 4)',
    components: {},
    harness: { calibrationTemperature: 4 },
    source: 'ADR-0041: temperature fitted on stored prod predictions (Actions → Optimize report, 2026-09-30)',
  },
  /**
   * ADR-0065: the primary reading only identity, traits and insights. E6 saw it raise Jev's served accuracy by 4.8
   * points over the whole state with no log-loss gain, on six people (exploratory); a shadow tests it on new ones.
   * The primary's temperature, so the two differ only in what they read.
   */
  'jev-derived.v1': {
    id: 'jev-derived.v1',
    kind: 'decision',
    title: 'Jev on derived data only (traits and insights), calibrated (temperature 4)',
    components: {},
    harness: { calibrationTemperature: 4, stateView: 'derived' },
    source: 'ADR-0065: E6 exploratory lead (docs/reports/e6-evidence.md)',
  },
  /**
   * ADR-0065: `predict.v2` reading the context alone. E6 found DeepSeek's context-only prior ahead of every Jev view
   * on served questions; a shadow measures that prior on new people beside the primary.
   */
  'predict.v2-context': {
    id: 'predict.v2-context',
    kind: 'llm',
    title: 'LLM predictor (predict.v2 settings) on the context alone',
    components: {},
    harness: { keyEnum: true, labelKeys: true, stateView: 'context' },
    modelHarness: PREDICT_V2_MODEL_HARNESS,
    source: 'ADR-0065: E6 exploratory lead (docs/reports/e6-evidence.md)',
  },
};

/** A registered variant that only rescales its kind's incumbent (a calibration temperature): same text, same view. */
export function isCalibrationOnly(version: string): boolean {
  const v = PREDICT_PROMPTS[version];
  if (!v) return false;
  const { calibrationTemperature: _t, ...rest } = v.harness;
  return !Object.keys(v.components).length && !Object.keys(rest).length && !v.modelHarness;
}

export function resolvePredictPrompt(version: string, kind: PredictorKind, model?: string): PredictPrompt {
  const v = PREDICT_PROMPTS[version];
  if (!v) throw new Error(`Unknown prediction prompt version: ${version}`);
  if (v.kind !== kind) throw new Error(`Prompt version ${version} is for ${v.kind} predictors, not ${kind}`);
  return {
    version,
    kind,
    components: { ...INCUMBENT_COMPONENTS, ...v.components },
    harness: { ...INCUMBENT_HARNESS, ...v.harness, ...(model ? v.modelHarness?.[model] : undefined) },
  };
}

const PLACEHOLDER = /\{([a-zA-Z_]+)\}/g;

export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Replaces the known placeholders of a component; anything else in braces is left alone. */
export function fill(template: string, vars: Record<string, string>): string {
  // Own keys only: `{constructor}` or `{toString}` must stay literal, not expand to a prototype function's source.
  return template.replace(PLACEHOLDER, (all, name: string) =>
    Object.hasOwn(vars, name) ? vars[name]! : all,
  );
}

/** Words as the component word limits count them. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Problems with a component's text: missing or unknown placeholders, empty text, too many words. */
export function componentProblems(id: ComponentId, text: string): string[] {
  const spec = COMPONENT_SPECS[id];
  const found = placeholdersOf(text);
  const allowed = new Set([...spec.required, ...spec.optional]);
  const out: string[] = [];
  if (!text.trim()) out.push('empty');
  for (const r of spec.required) if (!found.includes(r)) out.push(`missing {${r}}`);
  for (const f of found) if (!allowed.has(f)) out.push(`unknown placeholder {${f}}`);
  const words = wordCount(text);
  if (words > spec.maxWords) out.push(`${words} words (max ${spec.maxWords})`);
  return out;
}

/**
 * The kind as `promptHash` hashes it. Every hash taken before ADR-0054 hashed the decision kind as `jev`, and those
 * hashes label optimizer candidates (`cand-<hash>`) and key the eval caches and run directories, so it still does.
 */
const HASHED_KIND = { decision: 'jev', llm: 'llm' } as const satisfies Record<PredictorKind, string>;

export function promptHash(p: Omit<PredictPrompt, 'version'>): string {
  return hashJson({ kind: HASHED_KIND[p.kind], components: p.components, harness: p.harness });
}

export function renderVariantDoc(v: PredictPromptVariant): string {
  const p = resolvePredictPrompt(v.id, v.kind);
  // The incumbent is named without a suffix: `predictorIdProblem` refuses `@<incumbent>`.
  const use =
    v.id === DEFAULT_PROMPT_VERSION[v.kind]
      ? `\`${v.kind}:<model>\`, the incumbent`
      : `\`${v.kind}:<model>@${v.id}\``;
  const lines = [
    `# ${v.id} — ${v.title}`,
    '',
    '> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).',
    '',
    `- Predictor kind: \`${v.kind}\` (use as ${use})`,
    `- Source: ${v.source}`,
  ];
  const models = Object.keys(v.modelHarness ?? {});
  if (!models.length) lines.push(`- Harness: \`${JSON.stringify(p.harness)}\``, '');
  else {
    const { reasoningEffort: _e, reasoningMaxTokens: _b, maxTokens: _c, ...shared } = p.harness;
    lines.push(
      `- Harness (every model): \`${JSON.stringify(shared)}\``,
      '- Models: only those listed below.',
      '',
      '## Per-model harness',
      '',
      '| Model | Reasoning | Token cap (reasoning and answer) |',
      '| --- | --- | --- |',
      ...models.map((m) => {
        const h = resolvePredictPrompt(v.id, v.kind, m).harness;
        const reasoning =
          h.reasoningMaxTokens !== null
            ? `budget ${h.reasoningMaxTokens} tokens`
            : `effort ${h.reasoningEffort}`;
        return `| \`${m}\` | ${reasoning} | ${h.maxTokens} |`;
      }),
      '',
    );
  }
  for (const id of COMPONENT_IDS) {
    if (!componentReadBy(id, p)) continue;
    const overridden = id in v.components ? '' : ' (incumbent)';
    lines.push(`## ${id}${overridden}`, '', '```', p.components[id], '```', '');
  }
  return lines.join('\n');
}

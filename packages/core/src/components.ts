import { hashJson } from './hash';
import { PROMPTS } from './prompts';

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

export interface ComponentSpec {
  /** What the component does, shown to the reflection model. */
  role: string;
  required: string[];
  optional: string[];
  maxWords: number;
  /** Which predictor kinds read this component. */
  kinds: Array<'jev' | 'llm'>;
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
    role: "How one earlier answer is rendered in the state text. {why} expands to ' (why: …)' or nothing.",
    required: ['seq', 'q', 'answer'],
    optional: ['options', 'why'],
    maxWords: 40,
    kinds: ['llm', 'jev'],
  },
  'jev.instructions': {
    role: 'Instructions of a decision-model question asking how the person in the state would answer {prompt}.',
    required: ['prompt'],
    optional: [],
    maxWords: 120,
    kinds: ['jev'],
  },
  'jev.choice': {
    role: 'Criterion text for one option of a multiple-choice prediction; {label} is the option label.',
    required: ['label'],
    optional: [],
    maxWords: 40,
    kinds: ['jev'],
  },
  'jev.noul.true': {
    role: 'Criterion for "yes" when predicting a yes/no question.',
    required: [],
    optional: [],
    maxWords: 40,
    kinds: ['jev'],
  },
  'jev.noul.false': {
    role: 'Criterion for "no" when predicting a yes/no question.',
    required: [],
    optional: [],
    maxWords: 40,
    kinds: ['jev'],
  },
};

/** The components as they shipped in `predict.v1` and `jev-predict.v1` (byte-identical to the original literals). */
export const INCUMBENT_COMPONENTS: PredictComponents = {
  'predict.system': PROMPTS['predict.v1'].system,
  'predict.user': 'STATE:\n{state}\n\nQUESTION: {prompt}\nOPTIONS:\n{options}',
  'state.evidence.line': '#{seq} {q} [{options}] → {answer}{why}',
  'jev.instructions':
    'Predict how the person described in the state would answer this question, based only on the state: "{prompt}"',
  'jev.choice': 'The person would choose: {label}',
  'jev.noul.true': 'The person would answer yes',
  'jev.noul.false': 'The person would answer no',
};

export interface PredictHarness {
  /** LLM reasoning effort (never temperature; CLAUDE.md). */
  reasoningEffort: 'none' | 'low' | 'medium';
  maxTokens: number;
  /** LLM output schema: `probs`, or `reasoned` (a short rationale written before the probabilities). */
  schema: 'probs' | 'reasoned';
  /** How the state reaches Jev: the JSON object, or the same text rendering the LLMs see. */
  jevState: 'json' | 'text';
}

export const INCUMBENT_HARNESS: PredictHarness = {
  reasoningEffort: 'low',
  maxTokens: 3000,
  schema: 'probs',
  jevState: 'json',
};

export interface PredictPromptVariant {
  id: string;
  kind: 'jev' | 'llm';
  title: string;
  /** Overrides over the incumbent; omitted components keep the incumbent text. */
  components: Partial<PredictComponents>;
  harness: Partial<PredictHarness>;
  /** Where it came from, e.g. the optimize run that produced it. */
  source: string;
}

/** A resolved prompt: every component and harness setting, plus the version ID stored on predictions. */
export interface PredictPrompt {
  version: string;
  kind: 'jev' | 'llm';
  components: PredictComponents;
  harness: PredictHarness;
}

export const DEFAULT_PROMPT_VERSION = { jev: 'jev-predict.v1', llm: 'predict.v1' } as const;

/**
 * Registered prediction prompt versions. Add a variant here (never edit one) to ship an optimized candidate; it is then
 * addressable as `llm:<model>@<id>` or `jev:<model>@<id>` in configs and `pnpm backfill` (ADR-0026).
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
    kind: 'jev',
    title: 'Jev prediction templates (incumbent)',
    components: {},
    harness: {},
    source: 'PLAN §9.6',
  },
};

export function resolvePredictPrompt(version: string, kind: 'jev' | 'llm'): PredictPrompt {
  const v = PREDICT_PROMPTS[version];
  if (!v) throw new Error(`Unknown prediction prompt version: ${version}`);
  if (v.kind !== kind) throw new Error(`Prompt version ${version} is for ${v.kind} predictors, not ${kind}`);
  return {
    version,
    kind,
    components: { ...INCUMBENT_COMPONENTS, ...v.components },
    harness: { ...INCUMBENT_HARNESS, ...v.harness },
  };
}

const PLACEHOLDER = /\{([a-zA-Z_]+)\}/g;

export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Replaces the known placeholders of a component; anything else in braces is left alone. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (all, name: string) => (name in vars ? vars[name]! : all));
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
  const words = text.trim().split(/\s+/).length;
  if (words > spec.maxWords) out.push(`${words} words (max ${spec.maxWords})`);
  return out;
}

export function promptHash(p: Omit<PredictPrompt, 'version'>): string {
  return hashJson({ kind: p.kind, components: p.components, harness: p.harness });
}

export function renderVariantDoc(v: PredictPromptVariant): string {
  const p = resolvePredictPrompt(v.id, v.kind);
  const lines = [
    `# ${v.id} — ${v.title}`,
    '',
    '> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0026).',
    '',
    `- Predictor kind: \`${v.kind}\` (use as \`${v.kind}:<model>@${v.id}\`)`,
    `- Source: ${v.source}`,
    `- Harness: \`${JSON.stringify(p.harness)}\``,
    '',
  ];
  for (const id of COMPONENT_IDS) {
    if (!COMPONENT_SPECS[id].kinds.includes(v.kind)) continue;
    const overridden = id in v.components ? '' : ' (incumbent)';
    lines.push(`## ${id}${overridden}`, '', '```', p.components[id], '```', '');
  }
  return lines.join('\n');
}

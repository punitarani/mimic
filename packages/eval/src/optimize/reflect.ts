import { argmax, type ChatMessage, COMPONENT_SPECS, type ComponentId, type Gateway } from '@mimic/core';
import { type Candidate, type EvalRecord, stateExcerpt } from './evaluate';
import type { EvalInstance } from './instances';

// ---------------------------------------------------------------------------------------------------------------
// Leakage lint (docs/OPTIMIZATION.md §6.4): a candidate prompt must work for anyone and carry nobody's data.
// ---------------------------------------------------------------------------------------------------------------

const N = 6;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function ngrams(s: string, n = N): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export interface LeakCorpus {
  ngrams: Set<string>;
  terms: string[];
}

/** Every person-authored text the optimizer can see: questions, options, answers' reasons, insights, identities. */
export function leakCorpus(instances: EvalInstance[]): LeakCorpus {
  const grams = new Set<string>();
  const terms = new Set<string>();
  const add = (s: string | null | undefined) => {
    if (s) for (const g of ngrams(s)) grams.add(g);
  };
  const seenStates = new Set<string>();
  for (const i of instances) {
    add(i.question.prompt);
    add(i.question.options.map((o) => o.label).join(' '));
    add(i.why);
    for (const t of i.identityTerms) terms.add(t);
    if (seenStates.has(i.state.meta.stateHash)) continue;
    seenStates.add(i.state.meta.stateHash);
    for (const e of i.state.evidence) {
      add(e.q);
      add(e.why);
    }
    for (const ins of i.state.insights ?? []) add(ins.text);
  }
  return { ngrams: grams, terms: [...terms] };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Problems introduced by `text` relative to `parent`: copied person text (6-grams) or identity terms. */
export function leakageProblems(text: string, parent: string, corpus: LeakCorpus): string[] {
  const out: string[] = [];
  const before = ngrams(parent);
  const copied = [...ngrams(text)].filter((g) => corpus.ngrams.has(g) && !before.has(g));
  if (copied.length) out.push(`copies person-authored text ("${copied[0]}")`);
  for (const t of corpus.terms) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'iu');
    if (re.test(text) && !re.test(parent)) out.push('names an identity detail of a person in the data');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------------------------------------------

/**
 * The optimizer's own prompts are offline research tooling, never product prompts; they are versioned here, recorded
 * on every run, and mirrored to docs/prompts/optimize/ (a change means a new version).
 */
export const REFLECT_PROMPT_VERSION = 'optimize.reflect.v1';
export const DIAGNOSE_PROMPT_VERSION = 'optimize.diagnose.v1';

export const REFLECT_SYSTEM = `You improve one text component of a system that predicts how a specific person will answer a typed question
(multiple choice, yes/no, or a 5-point scale), given that person's profile and earlier answers. The system outputs a
probability for every option and is scored by log loss on the person's real answer, so both accuracy and calibration
matter: confident misses are expensive, and spreading probability when the evidence is weak is correct.

You will see cases from the current version: what the model saw, what it predicted, the true answer, and feedback
(including the person's own reason when they gave one). Diagnose what the component gets wrong in general, then write
an improved version.

Rules:
- It must work for any person. Never mention a specific person, place, employer, question, option or answer from the
  cases, and never copy their wording. Describe general strategy: how to weigh evidence, what to attend to, how to
  spread probability.
- Keep every placeholder in curly braces exactly as listed. Add no new ones.
- Stay within the word limit. It is a hard limit: longer text is rejected.
- Return the new text inside <component>...</component>, with nothing else inside the tags.`;

function distLine(inst: EvalInstance, rec: EvalRecord): string {
  const top = argmax(rec.dist);
  return inst.question.options
    .map((o) => `${o.label}: ${Math.round((rec.dist[o.key] ?? 0) * 100)}%${o.key === top ? ' (top)' : ''}`)
    .join(', ');
}

/** The reflective dataset (GEPA's `make_reflective_dataset`): Inputs, Generated Outputs and Feedback per case. */
export function reflectiveCases(instances: Map<string, EvalInstance>, recs: EvalRecord[]): string {
  return recs
    .map((r, n) => {
      const inst = instances.get(r.instanceId)!;
      const q = inst.question;
      return [
        `### Case ${n + 1} (${q.type})`,
        `Inputs:\n- question: ${q.prompt}\n- options: ${q.options.map((o) => o.label).join(' | ')}\n- state:\n${stateExcerpt(
          inst,
        )
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')}`,
        `Generated outputs: ${r.ok ? distLine(inst, r) : `failed (${r.error})`}${r.raw ? `\n- raw output: ${r.raw.slice(0, 400)}` : ''}`,
        `Correct answer: ${q.options.find((o) => o.key === r.answer)?.label ?? r.answer}`,
        `Feedback: ${r.feedback}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function reflectMessages(c: Candidate, id: ComponentId, cases: string) {
  const spec = COMPONENT_SPECS[id];
  const placeholders = [...spec.required, ...spec.optional];
  const others = (Object.keys(c.prompt.components) as ComponentId[])
    .filter((k) => k !== id && COMPONENT_SPECS[k].kinds.includes(c.kind))
    .map((k) => `[${k}]\n${c.prompt.components[k]}`)
    .join('\n\n');
  return [
    { role: 'system' as const, content: REFLECT_SYSTEM },
    {
      role: 'user' as const,
      content: [
        `COMPONENT: ${id}`,
        `ROLE: ${spec.role}`,
        `PREDICTOR: ${c.kind === 'jev' ? 'a decision model that reads the state and the question text and returns calibrated probabilities (it cannot follow long instructions, so wording matters more than length)' : 'an LLM returning JSON probabilities'}`,
        `PLACEHOLDERS (keep exactly): ${placeholders.length ? placeholders.map((p) => `{${p}}`).join(' ') : 'none'}`,
        `WORD LIMIT: ${spec.maxWords}`,
        '',
        `CURRENT TEXT:\n<<<\n${c.prompt.components[id]}\n>>>`,
        '',
        `THE OTHER COMPONENTS (for context; do not rewrite them):\n${others}`,
        '',
        `CASES:\n\n${cases}`,
      ].join('\n'),
    },
  ];
}

/** Extracts the component from the reflection model's reply. */
export function parseReflection(content: string): string | null {
  const m = content.match(/<component>([\s\S]*?)<\/component>/);
  const text = (m ? m[1]! : '').replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '').trim();
  return text || null;
}

/**
 * Asks the reflection model for a new version of one component. If the reply breaks a rule (`check` returns problems:
 * missing placeholders, too long, copied person text), it gets one repair turn naming the problems, since a rejected
 * reply otherwise wastes the whole iteration. Returns the text and its problems (empty when valid).
 */
export async function proposeComponent(
  gateway: Gateway,
  model: string,
  c: Candidate,
  id: ComponentId,
  cases: string,
  check: (text: string) => string[] = () => [],
): Promise<{ text: string | null; problems: string[]; costUsd: number; calls: number }> {
  const messages: ChatMessage[] = reflectMessages(c, id, cases);
  let costUsd = 0;
  let text: string | null = null;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Awaited<ReturnType<Gateway['chat']>>;
    try {
      res = await gateway.chat(
        { purpose: 'eval.reflect' },
        { model, messages, reasoningEffort: 'low', maxTokens: 6000 },
      );
    } catch (e) {
      // A failed repair turn must not lose the first reply's cost (the caller meters it against the spend cap).
      if (attempt === 0) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      return { text, problems: [...problems, `repair turn failed: ${msg.slice(0, 200)}`], costUsd, calls: 1 };
    }
    costUsd += res.usage.costUsd;
    text = parseReflection(res.content);
    problems = text ? check(text) : ['no <component> in the reply'];
    if (!problems.length) return { text, problems, costUsd, calls: attempt + 1 };
    messages.push(
      { role: 'assistant', content: res.content },
      {
        role: 'user',
        content: `That text can't be used: ${problems.join('; ')}. Fix exactly these problems (the word limit is ${COMPONENT_SPECS[id].maxWords}) and return the whole component again inside <component>...</component>.`,
      },
    );
  }
  return { text, problems, costUsd, calls: 2 };
}

// ---------------------------------------------------------------------------------------------------------------
// Diagnose: the same reflective dataset, analysed instead of rewritten (docs/OPTIMIZATION.md §5.5)
// ---------------------------------------------------------------------------------------------------------------

export const DIAGNOSE_SYSTEM = `You analyze where a predictor of individual people's answers goes wrong. You will see cases: what the predictor
saw, what it predicted, the true answer, and feedback. Write a short failure analysis in Markdown:

1. The 3–6 most important failure patterns, each with how many of the cases show it and which question types.
2. Whether misses come from the evidence (the answer was not predictable from the state) or from how the predictor
   used it (it was predictable and the predictor ignored or misread it).
3. Calibration: overconfident or underconfident, and where.
4. Concrete, general changes to the prompt or state rendering that would help, in order of expected impact.

Describe patterns only. Do not quote a person's reasons or answers verbatim and do not identify anyone.`;

export async function diagnose(
  gateway: Gateway,
  model: string,
  predictorId: string,
  instances: Map<string, EvalInstance>,
  recs: EvalRecord[],
): Promise<{ markdown: string; costUsd: number }> {
  const res = await gateway.chat(
    { purpose: 'eval.diagnose' },
    {
      model,
      messages: [
        { role: 'system', content: DIAGNOSE_SYSTEM },
        {
          role: 'user',
          content: `PREDICTOR: ${predictorId}\n\nCASES:\n\n${reflectiveCases(instances, recs)}`,
        },
      ],
      reasoningEffort: 'low',
      maxTokens: 6000,
    },
  );
  return { markdown: res.content.trim(), costUsd: res.usage.costUsd };
}

/** docs/prompts/optimize/{id}.md for the optimizer's prompts (checked by test/docs-sync.test.ts; `gen:docs` writes). */
export function toolingPromptDocs(): Record<string, string> {
  const doc = (id: string, title: string, system: string, input: string) =>
    `# ${id} — ${title}

> Generated from \`packages/eval/src/optimize/reflect.ts\`. Offline research tooling (ADR-0027), never a product
> prompt; a change means a new version ID.

## System

\`\`\`
${system}
\`\`\`

## Input

\`\`\`
${input}
\`\`\`
`;
  return {
    [`docs/prompts/optimize/${REFLECT_PROMPT_VERSION}.md`]: doc(
      REFLECT_PROMPT_VERSION,
      'Reflection (rewrite one component)',
      REFLECT_SYSTEM,
      'COMPONENT, ROLE, PREDICTOR, PLACEHOLDERS, WORD LIMIT, CURRENT TEXT, THE OTHER COMPONENTS, CASES (one person per call:\nInputs, Generated outputs, Correct answer, Feedback). One repair turn names any problems with the reply.',
    ),
    [`docs/prompts/optimize/${DIAGNOSE_PROMPT_VERSION}.md`]: doc(
      DIAGNOSE_PROMPT_VERSION,
      'Failure analysis',
      DIAGNOSE_SYSTEM,
      'PREDICTOR, CASES (one person per call: Inputs, Generated outputs, Correct answer, Feedback).',
    ),
  };
}

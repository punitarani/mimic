import {
  type DecisionAnswer,
  type DecisionQuestion,
  type Gateway,
  JEV_MODEL,
  LLM,
  type PersonState,
  parseJsonLoose,
  reasoningOf,
  renderStateText,
  resolvePredictPrompt,
  seededRng,
  shuffle,
  stateForProvider,
} from '@mimic/core';
import { z } from 'zod';
import { BudgetStop, type Meter } from '../optimize/evaluate';
import { stateOf, type TwinItem } from './data';
import { cosine, embedTexts, textOf } from './embeddings';
import type { Policy, PolicyContext, PolicyKnobs } from './policies';

/**
 * E10's choosers (docs/CHOOSER.md): who picks the next question. Jev, asked which candidate an interviewer should ask
 * (`jev-pick`); an LLM, given the person's answers and the candidates (`llm-pick`); an LLM that writes the question
 * itself (`llm-gen`), grounded to the person's nearest unasked recorded item so it has an answer; and Jev deciding
 * between the batch and a newly written question (`jev-gate`). A chooser sees the person's own answers and question
 * texts only, never a target (T) or another person (invariant 8), so each ports to generated questions. A chooser
 * never throws: on any failure it picks a seeded random candidate and logs why.
 */

export const CHOOSER_PROMPT_VERSIONS = {
  purpose: 'curves.purpose.v1',
  jevPick: 'curves.jev-pick.v1',
  jevRate: 'curves.jev-rate.v1',
  jevScore: 'curves.jev-score.v1',
  llmPick: 'curves.llm-pick.v1',
  llmGen: 'curves.llm-gen.v1',
} as const;

/** What Mimic predicts, as the product would say it (`aim=p`): no survey, block or target named. */
export const PURPOSE_V1 =
  'predict the choices they make in everyday life: spending and saving, risk and time, work and social situations, judgments under uncertainty, and opinions on public issues';

/** Words of a candidate's question kept when it is shown to a chooser (the long matrix stems are cut). */
const CANDIDATE_CHARS = 320;

export const JEV_PICK_INSTRUCTIONS = (purpose: string) =>
  `An interviewer is getting to know the person described in the state so that they can ${purpose}. They can ask one more question. Which question's answer would best help predict this person's other choices, given what the state already shows?`;

export const JEV_RATE_INSTRUCTIONS = (purpose: string, text: string) =>
  `An interviewer is getting to know the person described in the state so that they can ${purpose}. Would asking this person "${text}" best help predict their other choices, beyond what the state already shows?`;

export const JEV_SCORE_INSTRUCTIONS = (purpose: string, text: string) =>
  `An interviewer is getting to know the person described in the state so that they can ${purpose}. How much would asking this person "${text}" help predict their other choices, beyond what the state already shows?`;

export const JEV_SCORE_LEVELS = ['Not at all', 'A little', 'Somewhat', 'A lot', 'More than anything else'];

export const LLM_PICK_SYSTEM = (purpose: string) =>
  `You choose the next question in an interview. The interviewer is getting to know one person so that a model can ${purpose}. From the candidates, pick the one whose answer would best help predict this person's other choices, given what is already known about them. Answer with JSON: {"key": "<candidate key>"}.`;

export const LLM_GEN_SYSTEM = (purpose: string, n: number) =>
  `You write the next question in an interview. The interviewer is getting to know one person so that a model can ${purpose}. Write ${n === 1 ? 'one multiple-choice question' : `${n} different multiple-choice questions`} whose answer would best help predict this person's other choices, given what is already known about them. Give each question 2 to 7 short options. Answer with JSON: {"questions": [{"prompt": "...", "options": ["...", "..."]}]}.`;

export const NONE_KEY = 'none';
export const NONE_CRITERION = 'None of these: write a new question instead';

/** One chooser decision, for `choices.jsonl` and the report's choices section. */
export interface ChoiceNote {
  /** Item keys of the candidates in the order shown (after the seeded shuffle). */
  shown: string[];
  pick: string;
  how: 'jev' | 'llm' | 'gen' | 'fallback';
  /** The pick's position among the candidates shown (0-based); null for a generated question. */
  position: number | null;
  /** The chooser's probability or score for its pick, and the next best, where it gives them. */
  pTop?: number;
  pSecond?: number;
  /** jev-gate: Jev chose to write a new question (the "none" option won, or no candidate reached the threshold). */
  gated?: boolean;
  /** llm-gen: the question written and its cosine to the item it was grounded to. */
  generated?: string;
  similarity?: number;
  fallback?: string;
  /** Uncached calls only (a cache hit takes 0 ms). */
  latencyMs: number;
  costUsd: number;
}

export interface ChooserDeps {
  gateway: Gateway;
  meter: Meter;
  /** Where embeddings of generated questions are kept (`embedTexts`). */
  embedDir: string;
  seed: string;
}

const LLM_IDS: Record<PolicyKnobs['llm'], string> = {
  deepseek: LLM.deepseek,
  glm: LLM.glm,
  luna: LLM.luna,
  mimo: LLM.mimoFlash,
  qwen: LLM.qwenFlash,
};

/** The chooser's model and its measured reasoning settings and cap (`predict.v2`, ADR-0041). */
function llmOf(knobs: PolicyKnobs) {
  const model = LLM_IDS[knobs.llm];
  const h = resolvePredictPrompt('predict.v2', 'llm', model).harness;
  return { model, ...reasoningOf(h), maxTokens: h.maxTokens };
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A candidate as a chooser sees it: the question and its options, never its answer. */
export const candidateText = (it: Pick<TwinItem, 'prompt' | 'options'>) =>
  `${trunc(it.prompt, CANDIDATE_CHARS)} (options: ${it.options.map((o) => o.label).join(' / ')})`;

/** Neutral keys in a seeded order, so position and survey order say nothing. */
function presented(ctx: PolicyContext, items: readonly TwinItem[], seed: string, policy: string) {
  const order = shuffle(
    [...items],
    seededRng(`${seed}:keys:${policy}:${ctx.person.pid}:${ctx.asked.length}`),
  );
  return order.map((item, i) => ({ key: `q${String(i + 1).padStart(2, '0')}`, item }));
}

function purposeOf(ctx: PolicyContext, knobs: PolicyKnobs, seed: string): string {
  if (knobs.aim === 'none') return 'predict how they would answer other questions';
  if (knobs.aim === 'r') {
    const examples = shuffle(ctx.person.reference, seededRng(`${seed}:aim:${ctx.person.pid}`)).slice(0, 5);
    return `predict how they would answer questions like these: ${examples.map((e) => `"${trunc(e.prompt, 200)}"`).join('; ')}`;
  }
  return PURPOSE_V1;
}

/** The state a chooser sees: the sealed state, less the last `lag` answers (choosing while the person answers). */
function chooserState(ctx: PolicyContext, knobs: PolicyKnobs): PersonState {
  if (knobs.lag <= 0 || ctx.asked.length === 0) return ctx.state;
  return stateOf(ctx.person, ctx.asked.slice(0, Math.max(0, ctx.asked.length - knobs.lag)));
}

function fallback(
  ctx: PolicyContext,
  shown: Array<{ key: string; item: TwinItem }>,
  why: string,
  spent: { latencyMs: number; costUsd: number },
): TwinItem {
  const pick = shown[Math.floor(ctx.rng() * shown.length)]!;
  ctx.log?.({
    shown: shown.map((s) => s.item.key),
    pick: pick.item.key,
    how: 'fallback',
    position: shown.indexOf(pick),
    fallback: why,
    ...spent,
  });
  return pick.item;
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

interface Ranked {
  key: string;
  p: number;
}

/** Jev's reading of the candidates, best first: one request, in the form the knobs name. */
async function jevRank(
  ctx: PolicyContext,
  knobs: PolicyKnobs,
  deps: ChooserDeps,
  shown: Array<{ key: string; item: TwinItem }>,
  withNone: boolean,
): Promise<{ ranked: Ranked[]; latencyMs: number; costUsd: number }> {
  const purpose = purposeOf(ctx, knobs, deps.seed);
  const state =
    knobs.stateView === 'off'
      ? { interview: 'choosing the next question' }
      : stateForProvider(chooserState(ctx, knobs));
  const questions: Record<string, DecisionQuestion> = {};
  if (knobs.form === 'choice' || withNone) {
    const criteria: Record<string, string> = Object.fromEntries(
      shown.map((s) => [s.key, `Ask: ${candidateText(s.item)}`]),
    );
    if (withNone) criteria[NONE_KEY] = NONE_CRITERION;
    questions.pick = { type: 'choice', instructions: JEV_PICK_INSTRUCTIONS(purpose), criteria };
  } else if (knobs.form === 'noul') {
    for (const s of shown)
      questions[s.key] = {
        type: 'noul',
        instructions: JEV_RATE_INSTRUCTIONS(purpose, candidateText(s.item)),
        criteria: {
          true: 'Yes: the answer would tell a lot that the state does not already show',
          false: 'No: the answer would tell little that is new',
        },
      };
  } else {
    for (const s of shown)
      questions[s.key] = {
        type: 'score',
        instructions: JEV_SCORE_INSTRUCTIONS(purpose, candidateText(s.item)),
        criteria: JEV_SCORE_LEVELS,
      };
  }
  deps.meter.check();
  const res = await deps.gateway.decide(
    { purpose: 'eval.curves.choose' },
    { model: JEV_MODEL, state, questions },
  );
  deps.meter.usd += res.usage.costUsd;
  const ranked: Ranked[] = [];
  const pick = res.answers.pick;
  if (pick) {
    if (pick.type !== 'choice') throw new Error(`jev-pick: a ${pick.type} answer to a choice`);
    for (const [key, p] of Object.entries(pick.probabilities)) ranked.push({ key, p });
  } else
    for (const s of shown) {
      const a: DecisionAnswer | undefined = res.answers[s.key];
      if (!a) continue;
      ranked.push({ key: s.key, p: a.type === 'noul' ? a.p : a.type === 'score' ? a.score : Number.NaN });
    }
  if (!ranked.length) throw new Error('jev-pick: no answer');
  ranked.sort((a, b) => b.p - a.p || a.key.localeCompare(b.key));
  return { ranked, latencyMs: res.latencyMs, costUsd: res.usage.costUsd };
}

/** Jev picks from the batch. */
export function jevPickPolicy(name: string, knobs: PolicyKnobs, deps: ChooserDeps): Policy {
  return {
    name,
    usesPopulation: false,
    next: async (ctx) => {
      const shown = presented(ctx, ctx.remaining, deps.seed, name);
      if (shown.length === 1) return shown[0]!.item;
      let spent = { latencyMs: 0, costUsd: 0 };
      try {
        const r = await jevRank(ctx, knobs, deps, shown, false);
        spent = { latencyMs: r.latencyMs, costUsd: r.costUsd };
        const best = r.ranked.find((x) => shown.some((s) => s.key === x.key));
        const hit = best && shown.find((s) => s.key === best.key);
        if (!hit) return fallback(ctx, shown, 'no candidate key in the answer', spent);
        ctx.note?.(best.p);
        ctx.log?.({
          shown: shown.map((s) => s.item.key),
          pick: hit.item.key,
          how: 'jev',
          position: shown.indexOf(hit),
          pTop: best.p,
          ...(r.ranked[1] ? { pSecond: r.ranked[1].p } : {}),
          ...spent,
        });
        return hit.item;
      } catch (e) {
        if (isBudget(e)) throw e;
        return fallback(ctx, shown, errorOf(e), spent);
      }
    },
  };
}

const Pick = z.object({ key: z.string() });
const Generated = z.object({
  questions: z.array(z.object({ prompt: z.string().min(1), options: z.array(z.string()).min(2) })).min(1),
});

/** An LLM picks from the batch. */
export function llmPickPolicy(name: string, knobs: PolicyKnobs, deps: ChooserDeps): Policy {
  return {
    name,
    usesPopulation: false,
    next: async (ctx) => {
      const shown = presented(ctx, ctx.remaining, deps.seed, name);
      if (shown.length === 1) return shown[0]!.item;
      const purpose = purposeOf(ctx, knobs, deps.seed);
      const known =
        knobs.stateView === 'off' ? '(nothing)' : renderStateText(stateForProvider(chooserState(ctx, knobs)));
      let spent = { latencyMs: 0, costUsd: 0 };
      try {
        deps.meter.check();
        const res = await deps.gateway.chat(
          { purpose: 'eval.curves.choose' },
          {
            ...llmOf(knobs),
            messages: [
              { role: 'system', content: LLM_PICK_SYSTEM(purpose) },
              {
                role: 'user',
                content: `WHAT IS KNOWN ABOUT THE PERSON:\n${known}\n\nCANDIDATES:\n${shown.map((s) => `${s.key}: ${candidateText(s.item)}`).join('\n')}`,
              },
            ],
            jsonSchema: {
              name: 'pick',
              schema: {
                type: 'object',
                properties: { key: { type: 'string', enum: shown.map((s) => s.key) } },
                required: ['key'],
                additionalProperties: false,
              },
            },
          },
        );
        deps.meter.usd += res.usage.costUsd;
        spent = { latencyMs: res.latencyMs, costUsd: res.usage.costUsd };
        const parsed = Pick.safeParse(parseJsonLoose(res.content));
        const hit = parsed.success ? shown.find((s) => s.key === parsed.data.key.trim()) : undefined;
        if (!hit) return fallback(ctx, shown, parsed.success ? 'unknown key' : 'invalid JSON output', spent);
        ctx.log?.({
          shown: shown.map((s) => s.item.key),
          pick: hit.item.key,
          how: 'llm',
          position: shown.indexOf(hit),
          ...spent,
        });
        return hit.item;
      } catch (e) {
        if (isBudget(e)) throw e;
        return fallback(ctx, shown, errorOf(e), spent);
      }
    },
  };
}

/**
 * Writes `n` questions and grounds each to the nearest item still open (cosine of bge embeddings over `textOf`), so
 * the person's recorded answer stands in for theirs; distinct items, best match first.
 */
async function writeAndGround(
  ctx: PolicyContext,
  knobs: PolicyKnobs,
  deps: ChooserDeps,
  open: readonly TwinItem[],
): Promise<{
  grounded: Array<{ item: TwinItem; text: string; sim: number }>;
  latencyMs: number;
  costUsd: number;
}> {
  const purpose = purposeOf(ctx, knobs, deps.seed);
  const known =
    knobs.stateView === 'off' ? '(nothing)' : renderStateText(stateForProvider(chooserState(ctx, knobs)));
  const n = Math.max(1, Math.round(knobs.genN));
  deps.meter.check();
  const res = await deps.gateway.chat(
    { purpose: 'eval.curves.generate' },
    {
      ...llmOf(knobs),
      messages: [
        { role: 'system', content: LLM_GEN_SYSTEM(purpose, n) },
        { role: 'user', content: `WHAT IS KNOWN ABOUT THE PERSON:\n${known}` },
      ],
      jsonSchema: {
        name: 'questions',
        schema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                  options: { type: 'array', items: { type: 'string' } },
                },
                required: ['prompt', 'options'],
                additionalProperties: false,
              },
            },
          },
          required: ['questions'],
          additionalProperties: false,
        },
      },
    },
  );
  deps.meter.usd += res.usage.costUsd;
  const parsed = Generated.safeParse(parseJsonLoose(res.content));
  if (!parsed.success) throw new Error('invalid JSON output');
  const texts = parsed.data.questions
    .slice(0, n)
    .map((q) => `${q.prompt.trim()} — ${q.options.map((o) => o.trim()).join(' / ')}`);
  const vecs = await embedTexts(deps.gateway, texts, { dir: deps.embedDir, meter: deps.meter });
  const used = new Set<string>();
  const grounded: Array<{ item: TwinItem; text: string; sim: number }> = [];
  for (const text of texts) {
    const v = vecs.get(text);
    if (!v) continue;
    let best: TwinItem | undefined;
    let bestSim = Number.NEGATIVE_INFINITY;
    for (const it of open) {
      if (used.has(it.key)) continue;
      const w = ctx.vectors?.get(textOf(it));
      if (!w) continue;
      const s = cosine(v, w);
      if (s > bestSim + 1e-12) {
        bestSim = s;
        best = it;
      }
    }
    if (best) {
      used.add(best.key);
      grounded.push({ item: best, text, sim: bestSim });
    }
  }
  if (!grounded.length) throw new Error('nothing to ground to');
  return { grounded, latencyMs: res.latencyMs, costUsd: res.usage.costUsd };
}

/**
 * An LLM writes the question; it is grounded to the nearest open item. With n > 1 it writes several and Jev picks among
 * the grounded items (`jevRank`, the knobs' form).
 */
export function llmGenPolicy(name: string, knobs: PolicyKnobs, deps: ChooserDeps): Policy {
  return {
    name,
    usesPopulation: false,
    next: async (ctx) => {
      const open = ctx.eligible ?? ctx.remaining;
      const shownAll = presented(ctx, ctx.remaining, deps.seed, name);
      let spent = { latencyMs: 0, costUsd: 0 };
      try {
        const g = await writeAndGround(ctx, knobs, deps, open);
        spent = { latencyMs: g.latencyMs, costUsd: g.costUsd };
        let chosen = g.grounded[0]!;
        if (g.grounded.length > 1) {
          const shown = presented(
            ctx,
            g.grounded.map((x) => x.item),
            deps.seed,
            `${name}:gen`,
          );
          const r = await jevRank(ctx, { ...knobs, form: 'choice' }, deps, shown, false);
          spent = { latencyMs: spent.latencyMs + r.latencyMs, costUsd: spent.costUsd + r.costUsd };
          const top = r.ranked.find((x) => shown.some((s) => s.key === x.key));
          const item = top && shown.find((s) => s.key === top.key)?.item;
          chosen = g.grounded.find((x) => x.item === item) ?? chosen;
        }
        ctx.note?.(chosen.sim);
        ctx.log?.({
          shown: g.grounded.map((x) => x.item.key),
          pick: chosen.item.key,
          how: 'gen',
          position: null,
          generated: chosen.text,
          similarity: chosen.sim,
          ...spent,
        });
        return chosen.item;
      } catch (e) {
        if (isBudget(e)) throw e;
        return fallback(ctx, shownAll, errorOf(e), spent);
      }
    },
  };
}

/**
 * Jev decides: a candidate from the batch, or "none of these", which has an LLM write one (`llm-gen`, grounded over
 * everything still open). `thr` also sends a step to the writer when Jev's top candidate is below it.
 */
export function jevGatePolicy(name: string, knobs: PolicyKnobs, deps: ChooserDeps): Policy {
  const writer = llmGenPolicy(name, { ...knobs, genN: 1 }, deps);
  return {
    name,
    usesPopulation: false,
    next: async (ctx) => {
      const shown = presented(ctx, ctx.remaining, deps.seed, name);
      let spent = { latencyMs: 0, costUsd: 0 };
      let ranked: Ranked[];
      try {
        const r = await jevRank(ctx, { ...knobs, form: 'choice' }, deps, shown, true);
        spent = { latencyMs: r.latencyMs, costUsd: r.costUsd };
        ranked = r.ranked;
      } catch (e) {
        if (isBudget(e)) throw e;
        return fallback(ctx, shown, errorOf(e), spent);
      }
      const top = ranked[0]!;
      const bestCandidate = ranked.find((x) => x.key !== NONE_KEY && shown.some((s) => s.key === x.key));
      const gate = top.key === NONE_KEY || !bestCandidate || bestCandidate.p < knobs.gateThr;
      if (!gate && bestCandidate) {
        const hit = shown.find((s) => s.key === bestCandidate.key)!;
        ctx.note?.(bestCandidate.p);
        ctx.log?.({
          shown: shown.map((s) => s.item.key),
          pick: hit.item.key,
          how: 'jev',
          position: shown.indexOf(hit),
          pTop: bestCandidate.p,
          gated: false,
          ...spent,
        });
        return hit.item;
      }
      // The writer logs its own step; the gate's request is added to it.
      let wrote: Parameters<NonNullable<PolicyContext['log']>>[0] | undefined;
      const item = await writer.next({
        ...ctx,
        log: (e) => {
          wrote = e;
        },
      });
      if (wrote)
        ctx.log?.({
          ...wrote,
          gated: true,
          pTop: top.p,
          latencyMs: wrote.latencyMs + spent.latencyMs,
          costUsd: wrote.costUsd + spent.costUsd,
        });
      return item;
    },
  };
}

const isBudget = (e: unknown) => e instanceof BudgetStop;

/** docs/prompts/curves/{id}.md for the choosers' prompts (checked by test/docs-sync.test.ts; `gen:docs` writes). */
export function chooserPromptDocs(): Record<string, string> {
  const doc = (id: string, title: string, body: string) =>
    `# ${id} — ${title}

> Generated from \`packages/eval/src/curves/choosers.ts\`. E10 research tooling (docs/CHOOSER.md), not a product
> prompt; a change means a new version ID. \`{purpose}\` is \`${CHOOSER_PROMPT_VERSIONS.purpose}\` unless a policy's \`aim\` says
> otherwise; \`{text}\` is a candidate as shown (\`candidateText\`).

${body}
`;
  const v = CHOOSER_PROMPT_VERSIONS;
  return {
    [`docs/prompts/curves/${v.purpose}.md`]: doc(
      v.purpose,
      'What Mimic predicts (aim=p)',
      `\`\`\`\n${PURPOSE_V1}\n\`\`\`\n\n\`aim=r\`: \`predict how they would answer questions like these: "…"; "…"\` (five of the person's R questions, never an answer). \`aim=none\`: \`predict how they would answer other questions\`.`,
    ),
    [`docs/prompts/curves/${v.jevPick}.md`]: doc(
      v.jevPick,
      'Jev picks from the batch (form=choice; jev-gate adds a "none" criterion)',
      `## Instructions\n\n\`\`\`\n${JEV_PICK_INSTRUCTIONS('{purpose}')}\n\`\`\`\n\n## Criteria\n\nOne per candidate, under neutral keys \`q01…\` in a seeded order: \`Ask: {text}\`. \`jev-gate\` adds \`${NONE_KEY}\`: \`${NONE_CRITERION}\`.\n\n## State\n\nThe person's sealed state (\`state=on\`, less the last \`lag\` answers), or \`{"interview": "choosing the next question"}\` (\`state=off\`).`,
    ),
    [`docs/prompts/curves/${v.jevRate}.md`]: doc(
      v.jevRate,
      'Jev rates each candidate (form=noul)',
      `## Instructions (one question per candidate)\n\n\`\`\`\n${JEV_RATE_INSTRUCTIONS('{purpose}', '{text}')}\n\`\`\`\n\n## Criteria\n\n- true: \`Yes: the answer would tell a lot that the state does not already show\`\n- false: \`No: the answer would tell little that is new\``,
    ),
    [`docs/prompts/curves/${v.jevScore}.md`]: doc(
      v.jevScore,
      'Jev scores each candidate (form=score)',
      `## Instructions (one question per candidate)\n\n\`\`\`\n${JEV_SCORE_INSTRUCTIONS('{purpose}', '{text}')}\n\`\`\`\n\n## Criteria (0–4)\n\n${JEV_SCORE_LEVELS.map((l, i) => `${i}. ${l}`).join('\n')}`,
    ),
    [`docs/prompts/curves/${v.llmPick}.md`]: doc(
      v.llmPick,
      'An LLM picks from the batch',
      `## System\n\n\`\`\`\n${LLM_PICK_SYSTEM('{purpose}')}\n\`\`\`\n\n## User\n\n\`\`\`\nWHAT IS KNOWN ABOUT THE PERSON:\n{renderStateText of the sealed state, less the last lag answers; "(nothing)" with state=off}\n\nCANDIDATES:\nq01: {text}\n…\n\`\`\`\n\nJSON schema: \`{"key": <enum of the candidate keys>}\`. The \`llm\` knob's model (DeepSeek V4.1 Flash by default) at its measured \`predict.v2\` reasoning setting and cap (ADR-0041).`,
    ),
    [`docs/prompts/curves/${v.llmGen}.md`]: doc(
      v.llmGen,
      'An LLM writes the question',
      `## System\n\n\`\`\`\n${LLM_GEN_SYSTEM('{purpose}', 1)}\n\`\`\`\n\n(With \`n\` > 1: "Write {n} different multiple-choice questions".)\n\n## User\n\n\`\`\`\nWHAT IS KNOWN ABOUT THE PERSON:\n{renderStateText of the sealed state}\n\`\`\`\n\nEach question written is grounded to the open item whose \`textOf\` is nearest by cosine of bge-base embeddings, so the person's recorded answer stands in for theirs.`,
    ),
  };
}

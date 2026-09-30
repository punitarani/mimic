import {
  Category,
  createMimic,
  DEFAULT_SCOPE,
  type FidelityResult,
  LLM,
  MimicScope,
  type PublicQuestion,
  parseJsonLoose,
  type Reveal,
  serveNext,
  sha256Hex,
  submitAnswer,
  ulid,
  writeSnapshot,
} from '@mimic/core';
import { z } from 'zod';
import type { LocalEngine } from './local';

/** A scripted answer file for `mimic-eval session` (PLAN §14 M2). */
export const SessionScript = z.object({
  intake: z.object({
    name: z.string(),
    location: z.string(),
    occupation: z.string().optional(),
    employer: z.string().optional(),
  }),
  consentResearch: z.boolean().default(false),
  /** Categories to ask about (ADR-0040); every category when absent. */
  categories: z.array(Category).min(1).optional(),
  /** Sensitive areas consented, e.g. { politics: true } (ADR-0040). */
  consents: z.record(z.string(), z.boolean()).default({}),
  /** Special-category areas consented for research use. */
  researchConsents: z.record(z.string(), z.boolean()).default({}),
  /**
   * Special-category areas confirmed (ADR-0050). A script's consents are choices, so by default every consented
   * special area is confirmed; pass `{}` to script a person who left intake's pre-ticked boxes alone.
   */
  confirmed: z.record(z.string(), z.boolean()).optional(),
  seed: z.string().default('script'),
  /** Fallback for questions the script doesn't cover. `consistent` answers the same prompt the same way. */
  policy: z.enum(['consistent', 'first', 'last']).default('consistent'),
  /** Keyed by item key (e.g. `anchors.v1/risk_gamble`) or a case-insensitive prompt substring. */
  answers: z.record(z.string(), z.string()).default({}),
  whys: z.record(z.string(), z.string()).default({}),
});
export type SessionScript = z.infer<typeof SessionScript>;

export interface TurnLog {
  seq: number;
  kind: PublicQuestion['kind'];
  itemKey: string | null;
  prompt: string;
  answer: string;
  answerLabel: string;
  source: 'script' | 'policy' | 'simulated';
  reveal: Reveal | null;
  fidelity: FidelityResult | null;
}

function pickKey(q: PublicQuestion, value: string): string | null {
  if (q.options.some((o) => o.key === value)) return value;
  return q.options.find((o) => o.label.toLowerCase() === value.toLowerCase())?.key ?? null;
}

function scripted(
  script: SessionScript,
  q: PublicQuestion,
  itemKey: string | null,
): { key: string; source: TurnLog['source'] } {
  const entries = Object.entries(script.answers);
  const hit =
    (itemKey ? entries.find(([k]) => k === itemKey) : undefined) ??
    entries.find(([k]) => q.prompt.toLowerCase().includes(k.toLowerCase()));
  const key = hit ? pickKey(q, hit[1]) : null;
  if (key) return { key, source: 'script' };
  if (script.policy === 'first') return { key: q.options[0]!.key, source: 'policy' };
  if (script.policy === 'last') return { key: q.options.at(-1)!.key, source: 'policy' };
  const i = Number.parseInt(sha256Hex(`${script.seed}:${q.prompt}`).slice(0, 8), 16) % q.options.length;
  return { key: q.options[i]!.key, source: 'policy' };
}

/**
 * LLM-simulated user. Smoke tests only: simulated users are more cooperative and consistent than real people, so
 * metrics from them are never reported (PLAN §14 M2).
 */
async function simulated(engine: LocalEngine, persona: string, q: PublicQuestion): Promise<string | null> {
  const res = await engine.deps.gateway.chat(
    { purpose: 'simulate.user' },
    {
      model: LLM.deepseek,
      messages: [
        {
          role: 'system',
          content: `You are role-playing this person. Answer as they would.\n${persona}\nReturn JSON: {"key": string}.`,
        },
        { role: 'user', content: `${q.prompt}\n${q.options.map((o) => `${o.key}: ${o.label}`).join('\n')}` },
      ],
      jsonSchema: {
        name: 'answer',
        schema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
      },
      reasoningEffort: 'low',
      maxTokens: 400,
    },
  );
  const key = (parseJsonLoose(res.content) as { key?: string } | undefined)?.key;
  return key && q.options.some((o) => o.key === key) ? key : null;
}

export interface SessionOptions {
  turns: number;
  participantId?: string;
  /** A registered config to create the mimic under, instead of the default (see `configs.ts`). */
  configHash?: string;
  simulatePersona?: string;
  onTurn?: (t: TurnLog) => void;
}

/** Runs a full session end to end against the engine, running queued jobs inline between turns. */
export async function runSession(
  engine: LocalEngine,
  script: SessionScript,
  opts: SessionOptions,
): Promise<{ mimicId: string; turns: TurnLog[] }> {
  const { deps } = engine;
  const m = await createMimic(
    deps,
    {
      ...script.intake,
      attestSelf: true,
      consentSearch: false,
      consentResearch: script.consentResearch,
      scope: MimicScope.parse({
        categories: script.categories ?? DEFAULT_SCOPE.categories,
        consents: script.consents,
        researchConsents: script.researchConsents,
        confirmed: script.confirmed ?? script.consents,
      }),
    },
    // Scripted people are marked so reports can keep them apart from real ones (R10).
    opts.participantId ?? `script:${ulid()}`,
    opts.configHash ? { configHash: opts.configHash } : {},
  );
  await engine.drain();
  const { turns } = await continueSession(engine, m.id, script, opts);
  return { mimicId: m.id, turns };
}

/**
 * Answers up to `opts.turns` more questions for an existing mimic with the same script (for example after a scope
 * change), running queued jobs inline between turns, then writes one snapshot.
 */
export async function continueSession(
  engine: LocalEngine,
  mimicId: string,
  script: SessionScript,
  opts: Omit<SessionOptions, 'participantId' | 'configHash'>,
): Promise<{ turns: TurnLog[] }> {
  const { deps } = engine;
  const m = { id: mimicId };
  const turns: TurnLog[] = [];
  let waits = 0;
  while (turns.length < opts.turns) {
    const next = await serveNext(deps, m.id);
    if (next.status === 'waiting' && waits++ < 3) {
      await engine.drain();
      continue;
    }
    if (next.status !== 'question') break;
    await engine.drain();
    const q = next.question;
    const itemKey = (await deps.store.getQuestion(q.id))?.itemKey ?? null;
    let choice = scripted(script, q, itemKey);
    if (opts.simulatePersona && choice.source === 'policy') {
      const key = await simulated(engine, opts.simulatePersona, q).catch(() => null);
      if (key) choice = { key, source: 'simulated' };
    }
    const why = Object.entries(script.whys).find(
      ([k]) => k === itemKey || q.prompt.toLowerCase().includes(k.toLowerCase()),
    )?.[1];
    const res = await submitAnswer(deps, m.id, {
      questionId: q.id,
      value: choice.key,
      latencyMs: 1500,
      idempotencyKey: `cli-${m.id}-${q.seq}`,
      ...(why ? { why } : {}),
    });
    // Debounced snapshot jobs are skipped inline; one snapshot is written at the end (PLAN §9.8 step 5).
    await engine.drain((j) => j.type !== 'snapshot.write');
    const t: TurnLog = {
      seq: q.seq,
      kind: q.kind,
      itemKey,
      prompt: q.prompt,
      answer: choice.key,
      answerLabel: q.options.find((o) => o.key === choice.key)!.label,
      source: choice.source,
      reveal: res.reveal,
      fidelity: res.fidelity,
    };
    turns.push(t);
    opts.onTurn?.(t);
  }
  await writeSnapshot(deps, m.id);
  return { turns };
}

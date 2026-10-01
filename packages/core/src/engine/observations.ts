import { z } from 'zod';
import { specialAreasOfText } from '../scope';
import type { QuestionRecord } from '../store';
import type { SpecialArea } from '../types';
import { type EngineDeps, EngineError, requireMimic } from './deps';
import { DraftInput, type FeedbackOrigin, submitFeedback } from './playground';

/**
 * The observation ledger (ADR-0056): how any other agent updates a mimic. An agent that acts for the person sees
 * them decide; it may append those decisions here as typed observations, and nothing else. Mimic validates each
 * one, stores it as `kind = feedback` evidence with the agent named in its provenance, and re-derives traits,
 * insights and the portrait from the evidence as it always does (PLAN §3.3): no agent edits derived state, no
 * consolidation rewrites the record, and the person can see and undo what an agent wrote.
 *
 * Rules an observation must pass:
 * - the same shape as a taught answer (2–5 options, yes/no, or a 5-point scale), answered with one option key;
 * - no special-category content (politics, religion, sexuality, health): only direct, consented questions may
 *   populate those (ADR-0040), and an agent's observation is neither;
 * - an id unique per writer, so a re-sent batch changes nothing (idempotent per observation);
 * - a writer name of letters, digits, dots, dashes and slashes.
 */

export const OBSERVATIONS_SCHEMA = 'mimic-observations/1';
export const OBSERVATIONS_PROMPT_VERSION = 'observations.v1';
export const MAX_OBSERVATIONS_PER_BATCH = 200;

export const ObservationAuthority = z.enum(['stated', 'observed']);
export type ObservationAuthority = z.infer<typeof ObservationAuthority>;

export const Observation = z.object({
  /** Unique per writer; the idempotency key is `obs:<writer>:<id>`. */
  id: z.string().trim().min(1).max(100),
  /** When the person decided, integer milliseconds. */
  at: z.number().int().nonnegative(),
  type: z.enum(['choice', 'noul', 'score']),
  prompt: z.string().trim().min(5).max(300),
  options: z
    .array(z.object({ key: z.string().min(1).max(32), label: z.string().trim().min(1).max(160) }))
    .min(2)
    .max(5),
  answer: z.string().min(1).max(32),
  /** The person's own reason, in their words, when they gave one. */
  why: z.string().trim().max(1000).optional(),
  /** Where and when, for the predictor: "while booking a flight for work". */
  context: z.string().trim().max(400).optional(),
  /** `stated`: the person said so to the agent; `observed`: the agent saw them do it. */
  authority: ObservationAuthority.default('observed'),
});
export type Observation = z.infer<typeof Observation>;

export const ObservationBatch = z.object({
  schema: z.literal(OBSERVATIONS_SCHEMA),
  writer: z.object({
    /** The agent, e.g. `hermes-agent/0.4` or `openclaw`. */
    agent: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'letters, digits, dots, dashes and slashes'),
    note: z.string().trim().max(300).optional(),
  }),
  observations: z.array(Observation).min(1).max(MAX_OBSERVATIONS_PER_BATCH),
});
export type ObservationBatch = z.infer<typeof ObservationBatch>;

export interface ObservationOutcome {
  id: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  seq?: number;
}

export interface ImportObservationsResult {
  writer: string;
  accepted: number;
  duplicates: number;
  rejected: number;
  outcomes: ObservationOutcome[];
  /** False once the mimic's budget is spent: the answers are kept, but no model reads them (ADR-0032). */
  learns: boolean;
}

export const observationKey = (agent: string, id: string) => `obs:${agent}:${id}`;

/**
 * Special-category areas a decision can touch, as questions put them (the fact lexicon in `scope.ts` is written
 * for search results: "voted for", "church"; a question says "vote", "pray"). Deliberately broad: an agent's
 * observation that merely sounds like one of these areas is refused, and the person can answer a direct, consented
 * question about it in Mimic instead.
 */
const QUESTION_LEXICON: Array<{ area: SpecialArea; pattern: RegExp }> = [
  {
    area: 'politics',
    pattern:
      /\b(vot(e|es|ed|ing)|election|ballot|politic(s|al|ian)|left[- ]wing|right[- ]wing|progressive|conservative|liberal|socialis[mt]|immigration|abortion|gun control|government)\b/i,
  },
  {
    area: 'religion',
    pattern:
      /\b(pray(s|ed|ing|er)?|god|religio(n|us)|church|mosque|temple|faith|worship|bible|scripture|afterlife|atheis[mt])\b/i,
  },
  {
    area: 'health',
    pattern:
      /\b(diagnos(is|ed)|medication|medicine|doctor|illness|disease|symptom|therapy|therapist|mental health|pregnan\w*|disabilit(y|ies)|surgery|hospital|drinking|smok(e|es|ing)|drugs?)\b/i,
  },
  {
    area: 'sexuality',
    pattern:
      /\b(sex|sexual(ity)?|intimate|intimacy|orientation|dating|casual partner|one[- ]night stand|monogam\w*|polyamor\w*)\b/i,
  },
];

/** Every special-category area an observation's text touches, by either lexicon. */
export function observationAreas(text: string): SpecialArea[] {
  const out = new Set<SpecialArea>(specialAreasOfText(text));
  for (const { area, pattern } of QUESTION_LEXICON) if (pattern.test(text)) out.add(area);
  return [...out].sort();
}

/** Why an observation can't be stored, or null. */
export function observationProblem(o: Observation): string | null {
  const text = [o.prompt, ...o.options.map((x) => x.label), o.why ?? '', o.context ?? ''].join(' ');
  const areas = observationAreas(text);
  if (areas.length) return `touches ${areas.join(', ')}: only a direct, consented question may`;
  if (o.type === 'noul' && !(o.answer === 'yes' || o.answer === 'no'))
    return 'a yes/no observation answers yes or no';
  if (!o.options.some((x) => x.key === o.answer)) return 'the answer is not one of the options';
  return null;
}

function originFor(agent: string, o: Observation): FeedbackOrigin {
  return {
    generator: `observation:${agent}`,
    promptVersion: OBSERVATIONS_PROMPT_VERSION,
    quality: {
      observation: {
        id: o.id,
        at: o.at,
        authority: o.authority,
        ...(o.context ? { context: o.context } : {}),
      },
    },
  };
}

/**
 * Appends a batch of observations as feedback evidence. Each is validated on its own: one bad observation rejects
 * itself, never the batch. Accepted ones take seqs in batch order, so the record keeps the agent's order.
 */
export async function importObservations(
  deps: EngineDeps,
  mimicId: string,
  batch: ObservationBatch,
): Promise<ImportObservationsResult> {
  await requireMimic(deps, mimicId);
  const agent = batch.writer.agent;
  const outcomes: ObservationOutcome[] = [];
  let learns = true;
  const seen = new Set<string>();
  for (const o of batch.observations) {
    if (seen.has(o.id)) {
      outcomes.push({ id: o.id, status: 'rejected', reason: 'repeated id in the batch' });
      continue;
    }
    seen.add(o.id);
    const problem = observationProblem(o);
    if (problem) {
      outcomes.push({ id: o.id, status: 'rejected', reason: problem });
      continue;
    }
    const key = observationKey(agent, o.id);
    const existing = await deps.store.getAnswerByIdempotencyKey(key);
    if (existing) {
      outcomes.push({ id: o.id, status: 'duplicate', seq: existing.seq });
      continue;
    }
    // The context travels with the reason, where every state and portrait already shows it.
    const why = [o.why, o.context ? `Context: ${o.context}` : ''].filter(Boolean).join(' ').slice(0, 1000);
    try {
      const r = await submitFeedback(
        deps,
        mimicId,
        {
          question: DraftInput.omit({ rationale: true }).parse({
            type: o.type,
            prompt: o.prompt,
            options: o.options,
          }),
          answer: o.answer,
          ...(why ? { why } : {}),
          idempotencyKey: key,
        },
        originFor(agent, o),
      );
      learns = learns && r.learns;
      outcomes.push({ id: o.id, status: 'accepted', seq: r.question.seq });
    } catch (e) {
      if (e instanceof EngineError && e.code !== 'not_found')
        outcomes.push({ id: o.id, status: 'rejected', reason: e.message });
      else throw e;
    }
  }
  return {
    writer: agent,
    accepted: outcomes.filter((x) => x.status === 'accepted').length,
    duplicates: outcomes.filter((x) => x.status === 'duplicate').length,
    rejected: outcomes.filter((x) => x.status === 'rejected').length,
    outcomes,
    learns,
  };
}

export interface ObservationListItem {
  seq: number;
  agent: string;
  id: string;
  at: number;
  authority: ObservationAuthority;
  prompt: string;
  options: string[];
  answer: string;
  why: string | null;
  context: string | null;
  createdAt: number;
}

/** The observations agents appended, newest first: what the person can review (and undo via the record). */
export async function listObservations(deps: EngineDeps, mimicId: string): Promise<ObservationListItem[]> {
  const m = await requireMimic(deps, mimicId);
  const [questions, answers] = await Promise.all([
    deps.store.listQuestions(m.id, ['answered'], ['feedback']),
    deps.store.listAnswers(m.id),
  ]);
  const answerByQ = new Map(answers.map((a) => [a.questionId, a]));
  const out: ObservationListItem[] = [];
  for (const q of questions) {
    if (!q.provenance.generator.startsWith('observation:') || q.seq === null) continue;
    const a = answerByQ.get(q.id);
    if (!a) continue;
    const meta = observationMeta(q);
    out.push({
      seq: q.seq,
      agent: q.provenance.generator.slice('observation:'.length),
      id: meta.id,
      at: meta.at,
      authority: meta.authority,
      prompt: q.prompt,
      options: q.options.map((o) => o.label),
      answer: q.options.find((o) => o.key === a.value)?.label ?? a.value,
      why: a.why,
      context: meta.context,
      createdAt: q.createdAt,
    });
  }
  return out.sort((a, b) => b.seq - a.seq);
}

const StoredMeta = z.object({
  observation: z.object({
    id: z.string().catch(''),
    at: z.number().catch(0),
    authority: ObservationAuthority.catch('observed'),
    context: z.string().optional(),
  }),
});

function observationMeta(q: QuestionRecord): {
  id: string;
  at: number;
  authority: ObservationAuthority;
  context: string | null;
} {
  const r = StoredMeta.safeParse(q.quality);
  if (!r.success) return { id: '', at: q.createdAt, authority: 'observed', context: null };
  const o = r.data.observation;
  return { id: o.id, at: o.at, authority: o.authority, context: o.context ?? null };
}

import type { DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResponse } from './types';

/**
 * What a Decisions API model accepts beyond the common contract (ADR-0051). Jev takes any JSON state and all three
 * question types. Respan's span-01 is a behaviour scorer: it takes a string state (or a message conversation) and
 * only yes/no (`noul`) questions, and answers anything else with HTTP 400. Both limits were found by live calls on
 * 2026-09-30; the model page's generic example shows choice and score questions it does not accept.
 */
export interface DecisionModelLimits {
  /** The state must be a string: an object state is sent as its JSON text. */
  stringState: boolean;
  /** Only `noul` questions: `choice` and `score` are asked one option at a time and recomposed. */
  noulOnly: boolean;
  /** Most questions a request may ask, counted as asked (before any yes/no split); none when undocumented. */
  maxQuestions?: number;
}

const NONE: DecisionModelLimits = { stringState: false, noulOnly: false };
/** From the published schemas (2026-10-01, ADR-0068): clef takes 64 questions a request, Perplexity's decider 128. */
const LIMITS: ReadonlyArray<[prefix: string, limits: DecisionModelLimits]> = [
  ['respan/', { stringState: true, noulOnly: true }],
  ['cloudflare/', { stringState: false, noulOnly: false, maxQuestions: 64 }],
  ['perplexity/', { stringState: false, noulOnly: false, maxQuestions: 128 }],
];

export function decisionModelLimits(model: string): DecisionModelLimits {
  return LIMITS.find(([prefix]) => model.startsWith(prefix))?.[1] ?? NONE;
}

/** The request to send, and how to turn its response back into answers to the questions asked. */
export interface DecisionPlan {
  request: DecisionRequest;
  answer(res: DecisionResponse): DecisionResponse;
}

/** Key of option `i` of a decomposed question. Jev keys are `q_<ulid>`, so they never contain a dot. */
const partKey = (key: string, i: number) => `${key}.${i}`;

/**
 * The wording that turns one option of a choice or score question into a yes/no question for a `noulOnly` model. It
 * is part of what span-01 answers, so it is versioned like a prompt (CLAUDE.md, PLAN Appendix A): any edit means a
 * new `id`, and `span-decisions.request.json` (recorded from a live call) pins the text, so a changed template fails
 * the contract test until it is re-recorded. Each call's trace holds the exact text sent.
 */
export const NOUL_SPLIT = {
  id: 'noul-split.v1',
  choice: {
    instructions: '{instructions}\nOption: {option}\nWould the person choose this option?',
    true: '{option}',
    false: 'The person would choose a different option',
  },
  score: {
    instructions: '{instructions}\nAnswer: {option}\nWould the person give this answer?',
    true: "The person's answer would be: {option}",
    false: 'The person would give a different answer',
  },
} as const;

const fillSplit = (t: string, instructions: string, option: string) =>
  t.replace('{instructions}', () => instructions).replace(/\{option\}/g, () => option);

/** One yes/no question per option of a choice or score question (NOUL_SPLIT). */
function optionQuestions(q: Exclude<DecisionQuestion, { type: 'noul' }>): DecisionQuestion[] {
  const t = NOUL_SPLIT[q.type];
  const options = q.type === 'choice' ? Object.values(q.criteria) : q.criteria;
  return options.map((option) => ({
    type: 'noul',
    instructions: fillSplit(t.instructions, q.instructions, option),
    criteria: {
      true: fillSplit(t.true, q.instructions, option),
      false: fillSplit(t.false, q.instructions, option),
    },
  }));
}

/**
 * Probabilities of each option, from independent yes/no answers, normalized to sum to 1 (one-vs-rest). Uniform when
 * every option scored 0; null when any option is unanswered.
 */
function recompose(ps: Array<number | undefined>): number[] | null {
  if (ps.some((p) => p === undefined || !Number.isFinite(p))) return null;
  const clipped = ps.map((p) => Math.min(1, Math.max(0, p!)));
  const sum = clipped.reduce((a, b) => a + b, 0);
  return sum > 0 ? clipped.map((p) => p / sum) : clipped.map(() => 1 / clipped.length);
}

function combined(q: Exclude<DecisionQuestion, { type: 'noul' }>, probs: number[]): DecisionAnswer {
  const top = Math.max(...probs);
  const at = probs.indexOf(top);
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    return {
      type: 'choice',
      choice: keys[at]!,
      confidence: top,
      probabilities: Object.fromEntries(keys.map((k, i) => [k, probs[i]!])),
    };
  }
  // Score levels are keyed by index, as Jev keys them; the score is the expected level.
  return {
    type: 'score',
    score: probs.reduce((a, p, i) => a + p * i, 0),
    confidence: top,
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
  };
}

/**
 * The request a model can take, and the mapping back (ADR-0051). For a model without limits (Jev) the request is
 * the one asked and the response is returned untouched.
 */
export function planDecision(req: DecisionRequest): DecisionPlan {
  const limits = decisionModelLimits(req.model);
  const asked = Object.keys(req.questions).length;
  // Refused here rather than as the vendor's 400; the eval splits its batches by the same limit (`jevRequests`).
  if (limits.maxQuestions !== undefined && asked > limits.maxQuestions)
    throw new Error(`${req.model} takes at most ${limits.maxQuestions} questions a request (asked ${asked})`);
  if (!limits.stringState && !limits.noulOnly) return { request: req, answer: (res) => res };
  const state =
    limits.stringState && typeof req.state !== 'string' ? JSON.stringify(req.state ?? null) : req.state;
  if (!limits.noulOnly) return { request: { ...req, state }, answer: (res) => res };

  const questions: Record<string, DecisionQuestion> = {};
  const split = new Map<string, Exclude<DecisionQuestion, { type: 'noul' }>>();
  const add = (key: string, q: DecisionQuestion) => {
    if (Object.hasOwn(questions, key))
      throw new Error(`decision question key ${key} collides with an option key`);
    questions[key] = q;
  };
  for (const [key, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') add(key, q);
    else {
      split.set(key, q);
      for (const [i, part] of optionQuestions(q).entries()) add(partKey(key, i), part);
    }
  }
  return {
    request: { ...req, state, questions },
    answer(res) {
      const answers: Record<string, DecisionAnswer> = {};
      for (const key of Object.keys(req.questions)) {
        const parts = split.get(key);
        if (!parts) {
          const a = res.answers[key];
          if (a) answers[key] = a;
          continue;
        }
        const n = parts.type === 'choice' ? Object.keys(parts.criteria).length : parts.criteria.length;
        const probs = recompose(
          Array.from({ length: n }, (_, i) => {
            const a = res.answers[partKey(key, i)];
            return a?.type === 'noul' ? a.p : undefined;
          }),
        );
        if (probs) answers[key] = combined(parts, probs);
      }
      return { ...res, answers };
    },
  };
}

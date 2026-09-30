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
}

const NONE: DecisionModelLimits = { stringState: false, noulOnly: false };
const LIMITS: ReadonlyArray<[prefix: string, limits: DecisionModelLimits]> = [
  ['respan/', { stringState: true, noulOnly: true }],
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

/** One yes/no question per option of a choice or score question. */
function optionQuestions(q: Exclude<DecisionQuestion, { type: 'noul' }>): DecisionQuestion[] {
  if (q.type === 'choice')
    return Object.values(q.criteria).map((text) => ({
      type: 'noul',
      instructions: `${q.instructions}\nOption: ${text}\nWould the person choose this option?`,
      criteria: { true: text, false: 'The person would choose a different option' },
    }));
  return q.criteria.map((label) => ({
    type: 'noul',
    instructions: `${q.instructions}\nAnswer: ${label}\nWould the person give this answer?`,
    criteria: {
      true: `The person's answer would be: ${label}`,
      false: 'The person would give a different answer',
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

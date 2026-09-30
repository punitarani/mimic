import { fill, INCUMBENT_COMPONENTS, type PredictComponents } from './components';
import { normalizeDist, optionKeys } from './distribution';
import type { DecisionAnswer, DecisionQuestion, Distribution, Facet, Question } from './types';

/** PLAN §9.6 Jev templates, from the prompt components (incumbent: `jev-predict.v1`). */
export function predictionQuestion(
  q: Pick<Question, 'type' | 'prompt' | 'options'>,
  c: Pick<
    PredictComponents,
    'jev.instructions' | 'jev.choice' | 'jev.noul.true' | 'jev.noul.false'
  > = INCUMBENT_COMPONENTS,
): DecisionQuestion {
  const instructions = fill(c['jev.instructions'], { prompt: q.prompt });
  switch (q.type) {
    case 'choice':
      return {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(
          q.options.map((o) => [o.key, fill(c['jev.choice'], { label: o.label })]),
        ),
      };
    case 'noul':
      return {
        type: 'noul',
        instructions,
        criteria: { true: c['jev.noul.true'], false: c['jev.noul.false'] },
      };
    case 'score':
      return { type: 'score', instructions, criteria: q.options.map((o) => o.label) };
  }
}

/**
 * Maps a Jev answer onto our option keys (PLAN §5.1): noul → {yes, no}; choice → option keys; score → "0".."4".
 * The result is normalized and clipped so log loss stays finite.
 */
export function answerToDistribution(q: Pick<Question, 'type' | 'options'>, a: DecisionAnswer): Distribution {
  const keys = optionKeys(q);
  if (q.type === 'noul') {
    if (a.type !== 'noul') throw new Error(`Expected noul answer, got ${a.type}`);
    const p = clamp01(a.p);
    const yes = keys.includes('yes') ? 'yes' : keys[0]!;
    const no = keys.includes('no') ? 'no' : keys[1]!;
    return normalizeDist({ [yes]: p, [no]: 1 - p }, keys);
  }
  if (a.type !== q.type) throw new Error(`Expected ${q.type} answer, got ${a.type}`);
  if (q.type === 'score') {
    // Jev keys score levels by index; our score option keys are "0".."4" in the same order.
    const byIndex: Record<string, number> = {};
    keys.forEach((k, i) => {
      byIndex[k] = a.probabilities[String(i)] ?? 0;
    });
    return normalizeDist(byIndex, keys);
  }
  return normalizeDist(a.probabilities, keys);
}

export function confidenceOf(a: DecisionAnswer): number | undefined {
  if (a.type === 'noul') return Math.abs(a.p - 0.5) * 2;
  return a.confidence;
}

/** PLAN §9.8 / B.2: one score question per facet, 5 ordered pole labels. */
export function traitQuestion(f: Facet): DecisionQuestion {
  return {
    type: 'score',
    instructions: `Based only on the state, where does this person fall on ${f.name} (from "${f.low.toLowerCase()}" to "${f.high.toLowerCase()}")?`,
    criteria: [...f.labels],
  };
}

export const GATES = ['ambiguous', 'sensitive', 'leading', 'quick'] as const;
export type Gate = (typeof GATES)[number];

/** PLAN §9.4 / B.3: quality gates asked of one candidate. */
export function gateQuestions(): Record<Gate, DecisionQuestion> {
  return {
    ambiguous: {
      type: 'noul',
      instructions:
        'Could the same person reasonably give different answers depending on how they read this question?',
      criteria: {
        true: 'The wording allows more than one reasonable reading.',
        false: 'The wording has one clear reading.',
      },
    },
    sensitive: {
      type: 'noul',
      instructions:
        'Does this question touch on health, sexuality, religion, politics, or detailed personal finances?',
      criteria: {
        true: 'The question involves one of these sensitive topics.',
        false: 'The question avoids all of these topics.',
      },
    },
    leading: {
      type: 'noul',
      instructions: 'Is this question leading or loaded, nudging the person toward one answer?',
      criteria: {
        true: 'The wording or options favor one answer.',
        false: 'The wording and options are neutral and roughly equally attractive.',
      },
    },
    quick: {
      type: 'noul',
      instructions: 'Could almost anyone answer this question in about 10 seconds?',
      criteria: {
        true: 'It is quick and easy to answer.',
        false: 'It needs long thought, special knowledge, or more context.',
      },
    },
  };
}

/**
 * A candidate fails when the bad outcome is likely (PLAN §9.4). Thresholds were tuned on the hand-labeled set
 * `packages/eval/data/gates.labeled.v1.json` with `pnpm eval -- gates` (ADR-0015); stored with each question as
 * `quality.gatesVersion`.
 */
export const GATES_VERSION = 'gates.v2';
export const GATE_THRESHOLDS: Record<Gate, { failIf: 'above' | 'below'; p: number }> = {
  ambiguous: { failIf: 'above', p: 0.85 },
  sensitive: { failIf: 'above', p: 0.4 },
  leading: { failIf: 'above', p: 0.55 },
  quick: { failIf: 'below', p: 0.6 },
};

export function gateFailures(ps: Record<Gate, number>): Gate[] {
  return GATES.filter((g) => {
    const t = GATE_THRESHOLDS[g];
    return t.failIf === 'above' ? ps[g] > t.p : ps[g] < t.p;
  });
}

export function samePersonQuestion(): DecisionQuestion {
  return {
    type: 'noul',
    instructions: 'Is the profile in the state the same person as the one described in the intake?',
    criteria: {
      true: 'The profile matches the intake person.',
      false: 'The profile describes a different person.',
    },
  };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
}

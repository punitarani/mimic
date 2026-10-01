import { fill, INCUMBENT_COMPONENTS, type PredictComponents } from './components';
import { normalizeDist, optionKeys } from './distribution';
import {
  type DecisionAnswer,
  type DecisionQuestion,
  type Distribution,
  type Facet,
  type Question,
  SENSITIVE_AREAS,
  type SensitiveArea,
} from './types';

/** PLAN §9.6 Jev templates, from the prompt components (incumbent: `jev-predict.v1`). */
export function predictionQuestion(
  q: Pick<Question, 'type' | 'prompt' | 'options'>,
  c: Pick<
    PredictComponents,
    'jev.instructions' | 'jev.choice' | 'jev.noul.true' | 'jev.noul.false'
  > = INCUMBENT_COMPONENTS,
  scoreAs: 'score' | 'choice' = 'score',
): DecisionQuestion {
  const instructions = fill(c['jev.instructions'], { prompt: q.prompt });
  // A scale asked as unordered options (harness `scoreAs`): each label a criterion keyed by its option key.
  const type = q.type === 'score' && scoreAs === 'choice' ? 'choice' : q.type;
  switch (type) {
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
  // A scale asked as a choice comes back keyed by option keys, like any choice.
  if (q.type === 'score' && a.type === 'choice') return normalizeDist(a.probabilities, keys);
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

/** Every gate any set asks. gates.v2 asks the first four; gates.v3 adds `concrete` and `demeaning` (ADR-0042). */
export const GATES = ['ambiguous', 'sensitive', 'leading', 'quick', 'concrete', 'demeaning'] as const;
export type Gate = (typeof GATES)[number];

export interface GateThreshold {
  failIf: 'above' | 'below';
  p: number;
}

export interface GateSet {
  id: string;
  gates: readonly Gate[];
  thresholds: Partial<Record<Gate, GateThreshold>>;
}

/** How each sensitive area is named to Jev, in the order gates.v2 used. */
const AREA_WORDING: Array<[SensitiveArea, string]> = [
  ['health', 'health'],
  ['sexuality', 'sexuality'],
  ['religion', 'religion'],
  ['politics', 'politics'],
  ['money', 'detailed personal finances'],
];

/** gates.v3 names money more precisely, so everyday spending is not read as "finances". */
const AREA_WORDING_V3: Partial<Record<SensitiveArea, string>> = {
  money: 'detailed personal finances (income, savings, debt)',
};

function listAreas(areas: readonly SensitiveArea[], v3 = false): string {
  const words = AREA_WORDING.filter(([a]) => areas.includes(a)).map(([a, w]) =>
    v3 ? (AREA_WORDING_V3[a] ?? w) : w,
  );
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')}, or ${words.at(-1)}`;
}

function sensitiveQuestion(areas: readonly SensitiveArea[]): DecisionQuestion {
  return {
    type: 'noul',
    instructions: `Does this question touch on ${listAreas(areas)}?`,
    criteria: {
      true: 'The question involves one of these sensitive topics.',
      false: 'The question avoids all of these topics.',
    },
  };
}

/**
 * gates.v3's `sensitive` question (ADR-0042) asks about the answerer's own life: calibration showed the gates.v2
 * wording rejects a nurse's questions about caring for patients as "health".
 */
function sensitiveQuestionV3(areas: readonly SensitiveArea[]): DecisionQuestion {
  return {
    type: 'noul',
    instructions: `Does this question ask about the answerer's own ${listAreas(areas, true)}?`,
    criteria: {
      true: "It asks about one of these topics in the answerer's own life.",
      false:
        "It avoids these topics in the answerer's own life. Caring for patients or clients at work, and everyday spending choices, do not count.",
    },
  };
}

/**
 * gates.v3's `leading` question (ADR-0042) judges the wording: calibration showed the gates.v2 wording flags any
 * scenario with an admirable option (returning extra change, not cheating) while missing loaded phrasing.
 */
const LEADING_V3: DecisionQuestion = {
  type: 'noul',
  instructions:
    'Does the wording push the person toward one answer, for example by stating an opinion, praising or shaming an option, presuming something about them, or asking "wouldn\'t you agree"?',
  criteria: {
    true: 'The wording itself favours or presumes an answer.',
    false:
      'The wording is neutral. A situation where one option is more admirable is fine when it is described neutrally.',
  },
};

const BASE_QUESTIONS: Record<Exclude<Gate, 'sensitive'>, DecisionQuestion> = {
  ambiguous: {
    type: 'noul',
    instructions:
      'Could the same person reasonably give different answers depending on how they read this question?',
    criteria: {
      true: 'The wording allows more than one reasonable reading.',
      false: 'The wording has one clear reading.',
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
  concrete: {
    type: 'noul',
    instructions:
      'Does this question put the person in one specific, everyday situation and ask what they would do or choose there?',
    criteria: {
      true: 'It describes a specific situation or choice, and the options are actions or concrete choices.',
      false:
        'It asks the person to rate or describe themselves in general, or asks an abstract opinion with no situation.',
    },
  },
  demeaning: {
    type: 'noul',
    instructions:
      'Is this question disrespectful to the person answering: does it presume, judge, stereotype or shame their beliefs, identity, body, health, relationships or money, or leave out answers some people would give?',
    criteria: {
      true: 'The wording or options presume, judge, stereotype or shame, or miss part of the range.',
      false: 'It asks plainly and neutrally, with options that cover the range respectfully.',
    },
  },
};

/**
 * Quality-gate sets (PLAN §9.4, B.3). A candidate fails when the bad outcome is likely. gates.v2 thresholds were
 * tuned on a hand-labelled set with `pnpm eval -- gates` (ADR-0015). gates.v3 (ADR-0042) keeps those and adds
 * `concrete` (fails below) and `demeaning` (fails above), calibrated on `packages/eval/labeled/gates.v3.json`.
 * The set id is stored with each question as `quality.gatesVersion`.
 */
export const GATE_SETS: Record<string, GateSet> = {
  'gates.v2': {
    id: 'gates.v2',
    gates: ['ambiguous', 'sensitive', 'leading', 'quick'],
    thresholds: {
      ambiguous: { failIf: 'above', p: 0.85 },
      sensitive: { failIf: 'above', p: 0.4 },
      leading: { failIf: 'above', p: 0.55 },
      quick: { failIf: 'below', p: 0.6 },
    },
  },
  'gates.v3': {
    id: 'gates.v3',
    gates: GATES,
    // Chosen on packages/eval/labeled/gates.v3.json and checked on gates.v3.heldout.json (ADR-0042).
    thresholds: {
      ambiguous: { failIf: 'above', p: 0.9 },
      sensitive: { failIf: 'above', p: 0.3 },
      leading: { failIf: 'above', p: 0.4 },
      quick: { failIf: 'below', p: 0.6 },
      concrete: { failIf: 'below', p: 0.4 },
      demeaning: { failIf: 'above', p: 0.5 },
    },
  },
};

export const GATES_VERSION = 'gates.v2';
/** gates.v2 thresholds, kept under their old name. */
export const GATE_THRESHOLDS = GATE_SETS['gates.v2']!.thresholds as Record<
  'ambiguous' | 'sensitive' | 'leading' | 'quick',
  GateThreshold
>;

export function gateSet(version: string = GATES_VERSION): GateSet {
  const g = GATE_SETS[version];
  if (!g) throw new Error(`Unknown gate set: ${version}`);
  return g;
}

/**
 * The sensitive areas a draft must not touch: every area, less those of the sensitive facets it is tagged with.
 * Tags are already inside the person's scope (`validateDraft` rejects the rest), so a consented, correctly tagged
 * sensitive draft is checked only against the other areas, and an untagged draft against all five (ADR-0042).
 */
export function forbiddenAreas(
  facetIds: readonly string[],
  facets: ReadonlyArray<Pick<Facet, 'id' | 'sensitive'>>,
): SensitiveArea[] {
  const tagged = new Set(facetIds.flatMap((id) => facets.find((f) => f.id === id)?.sensitive ?? []));
  return SENSITIVE_AREAS.filter((a) => !tagged.has(a));
}

/**
 * The Jev questions of a gate set for one candidate. gates.v2 always asks about all five sensitive areas, word for
 * word as before. gates.v3 asks only about `forbidden` areas and skips the `sensitive` gate when there are none.
 */
export function gateQuestions(
  version: string = GATES_VERSION,
  forbidden: readonly SensitiveArea[] = AREA_WORDING.map(([a]) => a),
): Partial<Record<Gate, DecisionQuestion>> {
  const set = gateSet(version);
  const v2 = set.id === 'gates.v2';
  const areas = v2 ? AREA_WORDING.map(([a]) => a) : forbidden;
  const out: Partial<Record<Gate, DecisionQuestion>> = {};
  for (const g of set.gates) {
    if (g === 'sensitive') {
      if (areas.length) out.sensitive = v2 ? sensitiveQuestion(areas) : sensitiveQuestionV3(areas);
    } else if (g === 'leading' && !v2) out.leading = LEADING_V3;
    else out[g] = BASE_QUESTIONS[g];
  }
  return out;
}

/** Gates a candidate fails. Gates missing from `ps` (skipped, or not in the set) never fail. */
export function gateFailures(ps: Partial<Record<Gate, number>>, version: string = GATES_VERSION): Gate[] {
  const set = gateSet(version);
  return set.gates.filter((g) => {
    const t = set.thresholds[g];
    const p = ps[g];
    if (!t || p === undefined) return false;
    return t.failIf === 'above' ? p > t.p : p < t.p;
  });
}

/** The fail-closed probability of a gate Jev did not answer: the bad outcome. */
export function failClosed(g: Gate, version: string = GATES_VERSION): number {
  return gateSet(version).thresholds[g]?.failIf === 'below' ? 0 : 1;
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

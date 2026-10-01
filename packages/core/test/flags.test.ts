import { describe, expect, it } from 'vitest';
import {
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  checkFlags,
  DECISION_MODELS,
  type DecisionRequest,
  decisionModelLimits,
  FLAG_KEYS,
  FLAG_SPECS,
  flagCreateBody,
  type LiveFlag,
  PPLX_DECIDER_MODEL,
  parseSpendLimits,
  planDecision,
} from '../src';

/**
 * The `mimic` app as the Flags workflow saw it on 2026-09-30: variations named by their labels, values as the code
 * spells them, a $2 cap, plus the provider flags and `vector-backend`, which no code reads since ADR-0052. Since then,
 * `use-invite-code` as an on/off switch (ADR-0055).
 */
const live = (): LiveFlag[] => [
  {
    key: 'decisions-model',
    enabled: true,
    default_variation: 'Jev',
    variations: { Jev: 'jev', 'Span-01': 'span-01' },
    rules: [],
  },
  { key: 'budget-usd', enabled: true, default_variation: '2', variations: { '1': 1, '2': 2 }, rules: [] },
  {
    key: 'budget-session-share',
    enabled: true,
    default_variation: '80',
    variations: { '75': 0.75, '80': 0.8, '85': 0.85, '90': 0.9 },
    rules: [],
  },
  {
    key: 'use-invite-code',
    enabled: true,
    default_variation: 'on',
    variations: { on: true, off: false },
    rules: [],
  },
  ...['search-provider', 'enrich-provider', 'embeddings-provider', 'vector-backend'].map((key) => ({
    key,
    enabled: true,
    default_variation: 'v',
    variations: { v: 'x' },
    rules: [],
  })),
];

describe('flag registry (ADR-0051, ADR-0052)', () => {
  it('holds only runtime levers, each with a fallback and variations the code accepts', () => {
    expect(Object.values(FLAG_KEYS).sort()).toEqual([
      'budget-session-share',
      'budget-usd',
      'decisions-model',
      'use-invite-code',
    ]);
    for (const spec of Object.values(FLAG_SPECS)) {
      expect(spec.parse(spec.fallback)).not.toBeNull();
      for (const v of Object.values(spec.variations)) expect(spec.parse(v)).not.toBeNull();
    }
    expect(Object.keys(FLAG_SPECS.decisionsModel.variations)).toEqual(Object.keys(DECISION_MODELS));
    expect(FLAG_SPECS.decisionsModel.fallback).toBe('jev');
  });

  it('the app as it stands passes; the retired flags are only warnings, so they can go after the deploy', () => {
    const r = checkFlags(live());
    expect(r.problems).toEqual([]);
    // The flag is the source of truth for its value: a $2 cap is not a warning.
    expect(r.warnings).toEqual([
      'search-provider: in the app, but no code reads it',
      'enrich-provider: in the app, but no code reads it',
      'embeddings-provider: in the app, but no code reads it',
      'vector-backend: in the app, but no code reads it',
    ]);
  });

  it('fails on missing flags, unusable values that are served, and dangling variations', () => {
    const flags = live().filter((f) => f.key !== 'budget-usd');
    const model = flags.find((f) => f.key === 'decisions-model')!;
    model.variations.gpt = 'not a model';
    model.variations.other = 'also not a model';
    model.rules = [{ serve_variation: 'gpt' }];
    const share = flags.find((f) => f.key === 'budget-session-share')!;
    share.rules = [{ serve_variation: 'Ghost' }];
    share.default_variation = 'Nope';
    flags.push({ key: 'use-span-01', enabled: false, default_variation: 'off', variations: { off: 'off' } });
    const r = checkFlags(flags);
    expect(r.problems).toEqual([
      'decisions-model: variation "gpt" = "not a model" is not a value the code accepts',
      expect.stringMatching(/^budget-usd: missing \(create it as a number flag/),
      'budget-session-share: default variation "Nope" does not exist',
      'budget-session-share: a rule serves "Ghost", which does not exist',
    ]);
    expect(r.warnings).toContain(
      'decisions-model: variation "other" = "also not a model" is not a value the code accepts; serving it would fall back to "jev"',
    );
    expect(r.warnings).toContain('use-span-01: in the app, but no code reads it');
    expect(r.warnings).toContain('decisions-model: 1 targeting rule(s) active');
    // A share above 1 is not a share.
    expect(FLAG_SPECS.budgetSessionShare.parse(1.5)).toBeNull();
    expect(FLAG_SPECS.budgetSessionShare.parse('0.75')).toBe(0.75);
  });

  it('use-invite-code takes a boolean, or a string flag with on/off values (ADR-0055)', () => {
    const spec = FLAG_SPECS.useInviteCode;
    expect(spec.fallback).toBe(true);
    for (const v of [true, 'on', 'true', 'yes', 'enabled', '1', 1]) expect(spec.parse(v)).toBe(true);
    for (const v of [false, 'off', 'false', 'no', 'disabled', '0', 0]) expect(spec.parse(v)).toBe(false);
    for (const v of ['maybe', '', 2, null, undefined, {}]) expect(spec.parse(v)).toBeNull();
    const r = checkFlags([
      { key: spec.key, enabled: true, default_variation: 'x', variations: { x: 'sometimes', on: 'on' } },
    ]);
    expect(r.problems).toContain(
      'use-invite-code: variation "x" = "sometimes" is not a value the code accepts',
    );
  });

  it('the spend-cap flags accept exactly the values the Workers read from their vars (ADR-0035)', () => {
    const values = [
      '1',
      '0.75',
      ' 2 ',
      '1e3',
      '0',
      '-1',
      'abc',
      '$1',
      '1,00',
      'Infinity',
      '0.5',
      '1.01',
      '80%',
      2,
      0,
    ];
    for (const [name, spec] of [
      ['BUDGET_USD', FLAG_SPECS.budgetUsd],
      ['BUDGET_SESSION_SHARE', FLAG_SPECS.budgetSessionShare],
    ] as const) {
      expect(spec.setting).toBe(name);
      for (const value of values) {
        const flag = spec.parse(value) !== null;
        const runtime = parseSpendLimits({ [name]: value }).problems.length === 0;
        expect({ name, value, accepted: flag }).toEqual({ name, value, accepted: runtime });
      }
    }
  });

  it('create bodies start at the fallback, with the variations the code accepts', () => {
    expect(flagCreateBody(FLAG_SPECS.decisionsModel)).toMatchObject({
      key: 'decisions-model',
      enabled: true,
      default_variation: 'jev',
      variations: { jev: 'jev', 'span-01': 'span-01' },
      rules: [],
    });
    expect(flagCreateBody(FLAG_SPECS.budgetUsd)).toMatchObject({
      default_variation: 'standard',
      variations: { standard: 1 },
    });
    expect(flagCreateBody(FLAG_SPECS.useInviteCode)).toMatchObject({
      default_variation: 'on',
      variations: { on: true, off: false },
    });
    for (const spec of Object.values(FLAG_SPECS))
      expect(checkFlags([flagCreateBody(spec)], [spec]).problems).toEqual([]);
  });
});

describe('span-01 request plan (ADR-0051)', () => {
  const req = (model: string): DecisionRequest => ({
    model,
    state: { a: 1 },
    questions: {
      q_n: { type: 'noul', instructions: 'Yes?', criteria: { true: 'y', false: 'n' } },
      q_c: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } },
      q_s: { type: 'score', instructions: 'How much?', criteria: ['Low', 'Mid', 'High'] },
    },
  });
  const res = (answers: Record<string, number>) => ({
    modelSnapshot: 's',
    answers: Object.fromEntries(Object.entries(answers).map(([k, p]) => [k, { type: 'noul' as const, p }])),
    usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 },
    latencyMs: 1,
    raw: {},
  });

  it('limits Respan models to strings and yes/no, and clef and the decider to a question count (ADR-0068)', () => {
    expect(decisionModelLimits('typesafe/jev-1.13')).toEqual({ stringState: false, noulOnly: false });
    expect(decisionModelLimits('respan/span-01-20260925')).toEqual({ stringState: true, noulOnly: true });
    expect(decisionModelLimits(CLEF_MODEL)).toEqual({
      stringState: false,
      noulOnly: false,
      maxQuestions: 64,
    });
    expect(decisionModelLimits(CLEF_FLASH_MODEL).maxQuestions).toBe(64);
    expect(decisionModelLimits(PPLX_DECIDER_MODEL).maxQuestions).toBe(128);
  });

  it('passes a clef request through untouched, and refuses one over its question limit', () => {
    const ok = req(CLEF_MODEL);
    expect(planDecision(ok).request).toBe(ok);
    const questions = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `q_${i}`,
        { type: 'noul' as const, instructions: 'Yes?', criteria: { true: 'y', false: 'n' } },
      ]),
    );
    expect(() => planDecision({ ...ok, questions })).toThrow(/at most 64 questions a request \(asked 65\)/);
    expect(() => planDecision({ ...ok, model: 'typesafe/jev-1.13', questions })).not.toThrow();
  });

  it('sends a string state and one yes/no per option, and recomposes normalized distributions', () => {
    const plan = planDecision(req('respan/span-01'));
    expect(plan.request.state).toBe('{"a":1}');
    expect(Object.keys(plan.request.questions)).toEqual(['q_n', 'q_c.0', 'q_c.1', 'q_s.0', 'q_s.1', 'q_s.2']);
    expect(plan.request.questions['q_c.1']).toEqual({
      type: 'noul',
      instructions: 'Which?\nOption: B\nWould the person choose this option?',
      criteria: { true: 'B', false: 'The person would choose a different option' },
    });
    const out = plan.answer(
      res({ q_n: 0.3, 'q_c.0': 0.6, 'q_c.1': 0.2, 'q_s.0': 0, 'q_s.1': 0.5, 'q_s.2': 0.5 }),
    );
    expect(out.answers.q_n).toEqual({ type: 'noul', p: 0.3 });
    const c = out.answers.q_c!;
    if (c.type !== 'choice') throw new Error('not a choice');
    expect(c.choice).toBe('a');
    expect(c.probabilities.a).toBeCloseTo(0.75, 12);
    expect(c.probabilities.b).toBeCloseTo(0.25, 12);
    expect(c.confidence).toBeCloseTo(0.75, 12);
    expect(out.answers.q_s).toEqual({
      type: 'score',
      score: 1.5,
      confidence: 0.5,
      probabilities: { '0': 0, '1': 0.5, '2': 0.5 },
    });
    // A string state is sent as it is.
    expect(planDecision({ ...req('respan/span-01'), state: 'text' }).request.state).toBe('text');
  });

  it('all-zero options are uniform; a missing option leaves the question unanswered', () => {
    const plan = planDecision(req('respan/span-01'));
    const out = plan.answer(res({ q_n: 0.3, 'q_c.0': 0, 'q_c.1': 0, 'q_s.0': 0.1, 'q_s.1': 0.1 }));
    expect(out.answers.q_c).toMatchObject({ probabilities: { a: 0.5, b: 0.5 } });
    expect(out.answers.q_s).toBeUndefined();
  });

  it('a key that collides with an option key is refused before anything is sent', () => {
    const r = req('respan/span-01');
    r.questions['q_c.0'] = { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } };
    expect(() => planDecision(r)).toThrow(/collides/);
  });
});

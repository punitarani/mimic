import { describe, expect, it } from 'vitest';
import {
  checkFlags,
  DECISION_MODELS,
  type DecisionRequest,
  decisionModelLimits,
  FLAG_KEYS,
  FLAG_SPECS,
  flagCreateBody,
  type LiveFlag,
  planDecision,
} from '../src';

/** The five flags as the `mimic` app holds them, variations named by label as the dashboard does. */
const live = (): LiveFlag[] => [
  {
    key: 'decisions-model',
    enabled: true,
    default_variation: 'jev',
    variations: { jev: 'jev', 'span-01': 'span-01' },
    rules: [],
  },
  { key: 'budget-usd', enabled: true, default_variation: 'standard', variations: { standard: 1 }, rules: [] },
  {
    key: 'search-provider',
    enabled: true,
    default_variation: 'Exa',
    variations: { Exa: 'exa', Perplexity: 'perplexity' },
    rules: [],
  },
  { key: 'enrich-provider', enabled: true, default_variation: 'Exa', variations: { Exa: 'Exa' }, rules: [] },
  {
    key: 'embeddings-provider',
    enabled: true,
    default_variation: 'OpenRouter',
    variations: { OpenRouter: 'openrouter', 'Workers AI': 'workers-ai' },
    rules: [],
  },
];

describe('flag registry (ADR-0050)', () => {
  it('defines each flag once, with a fallback the code accepts and variations it accepts', () => {
    expect(Object.values(FLAG_KEYS).sort()).toEqual([
      'budget-usd',
      'decisions-model',
      'embeddings-provider',
      'enrich-provider',
      'search-provider',
    ]);
    for (const spec of Object.values(FLAG_SPECS)) {
      expect(spec.parse(spec.fallback)).not.toBeNull();
      for (const v of Object.values(spec.variations)) expect(spec.parse(v)).not.toBeNull();
    }
    expect(Object.keys(FLAG_SPECS.decisionsModel.variations)).toEqual(Object.keys(DECISION_MODELS));
    expect(FLAG_SPECS.decisionsModel.fallback).toBe('jev');
  });

  it('a well-formed app passes; a flag over a different setting is a warning, not a problem', () => {
    const r = checkFlags(live(), { EMBEDDINGS_PROVIDER: 'workers-ai', SEARCH_PROVIDER: 'exa' });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([
      'embeddings-provider: serves "openrouter" over EMBEDDINGS_PROVIDER="workers-ai"',
    ]);
  });

  it('names missing flags, unusable values, dangling variations, and flags nothing reads', () => {
    const flags = live().filter((f) => f.key !== 'budget-usd');
    flags[0]!.variations.gpt = 'not a model';
    flags[1]!.default_variation = 'Nope';
    flags[2]!.rules = [{ serve_variation: 'Ghost' }];
    flags.push({
      key: 'vector-backend',
      enabled: true,
      default_variation: 'x',
      variations: { x: 'x' },
      rules: [],
    });
    flags.push({ key: 'use-span-01', enabled: false, default_variation: 'off', variations: { off: 'off' } });
    const r = checkFlags(flags);
    expect(r.problems).toEqual([
      'decisions-model: variation "gpt" = "not a model" is not a value the code accepts',
      expect.stringMatching(/^budget-usd: missing \(create it as a number flag/),
      'search-provider: default variation "Nope" does not exist',
      'enrich-provider: a rule serves "Ghost", which does not exist',
    ]);
    expect(r.warnings).toContain('vector-backend: in the app, but no code reads it');
    expect(r.warnings).toContain('use-span-01: in the app, but no code reads it');
    expect(r.warnings).toContain('enrich-provider: 1 targeting rule(s) active');
  });

  it('create bodies start at the setting (or the fallback), with the variations the code accepts', () => {
    expect(flagCreateBody(FLAG_SPECS.decisionsModel)).toMatchObject({
      key: 'decisions-model',
      enabled: true,
      default_variation: 'jev',
      variations: { jev: 'jev', 'span-01': 'span-01' },
      rules: [],
    });
    expect(flagCreateBody(FLAG_SPECS.budgetUsd, '2.5')).toMatchObject({
      default_variation: '2.5',
      variations: { standard: 1, '2.5': 2.5 },
    });
    expect(flagCreateBody(FLAG_SPECS.embeddingsProvider, 'openrouter').default_variation).toBe('openrouter');
    for (const spec of Object.values(FLAG_SPECS))
      expect(checkFlags([flagCreateBody(spec)], {}, [spec]).problems).toEqual([]);
  });
});

describe('span-01 request plan (ADR-0050)', () => {
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

  it('only Respan models have limits', () => {
    expect(decisionModelLimits('typesafe/jev-1.13')).toEqual({ stringState: false, noulOnly: false });
    expect(decisionModelLimits('respan/span-01-20260925')).toEqual({ stringState: true, noulOnly: true });
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

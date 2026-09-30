import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  type BudgetLedger,
  type CallLog,
  CHALLENGER_PURPOSES,
  coerceFlag,
  DECISION_MODELS,
  DEFAULT_CONFIG,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionRequest,
  decisionChallenger,
  decisionModelOf,
  FLAG_KEYS,
  type FlagReader,
  Gateway,
  JEV_MODEL,
  jevKey,
  type LlmClient,
  type ModelCallRecord,
  makePredictor,
  NO_FLAGS,
  type PersonState,
  type Question,
  SPAN_MODEL,
  StaticFlags,
  unansweredQuestions,
} from '../src';

class MemLog implements CallLog {
  rows: ModelCallRecord[] = [];
  async write(r: ModelCallRecord) {
    this.rows.push(r);
  }
}

/** Answers every question like the Decisions API; `fail` lists models that throw, `partial` models that skip one. */
function decisions(opts: { fail?: string[]; partial?: string[] } = {}) {
  const seen: string[] = [];
  const provider: DecisionProvider = {
    provider: 'fake-decisions',
    async decide(req) {
      seen.push(req.model);
      if (opts.fail?.includes(req.model))
        throw new Error(`HTTP 404 from openrouter.ai: ${req.model} blocked`);
      const keys = Object.keys(req.questions);
      const answers: Record<string, DecisionAnswer> = {};
      for (const k of opts.partial?.includes(req.model) ? keys.slice(1) : keys) {
        const q = req.questions[k]!;
        answers[k] =
          q.type === 'noul'
            ? { type: 'noul', p: 0.7 }
            : q.type === 'choice'
              ? { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 } }
              : { type: 'score', score: 1, probabilities: { '0': 0.5, '1': 0.5 } };
      }
      return {
        modelSnapshot: `${req.model}-snap`,
        answers,
        usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.0001 },
        latencyMs: 5,
        raw: {},
      };
    },
  };
  return { provider, seen };
}

const llm: LlmClient = {
  provider: 'fake-llm',
  async chat() {
    throw new Error('unused');
  },
};

function gateway(
  flags: FlagReader | null,
  opts: { fail?: string[]; partial?: string[]; budget?: BudgetLedger } = {},
) {
  const log = new MemLog();
  const d = decisions(opts);
  let n = 0;
  const g = new Gateway({
    decisions: d.provider,
    ...(flags ? { decisionRouter: decisionChallenger(flags) } : {}),
    llm,
    log,
    ...(opts.budget ? { budget: opts.budget } : {}),
    clock: () => 1_790_000_000_000,
    newId: () => `id${++n}`,
  });
  return { g, log, seen: d.seen };
}

const ON = new StaticFlags({ [FLAG_KEYS.decisionsModel]: 'span-01' });

const req = (model = JEV_MODEL): DecisionRequest => ({
  model,
  state: { x: 1 },
  questions: {
    a: { type: 'noul', instructions: 'Yes?', criteria: { true: 'y', false: 'n' } },
    b: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } },
  },
});
const ctx = { purpose: 'predict.primary', mimicId: 'm1', configHash: 'c1' };

describe('the decisions-model flag (ADR-0051)', () => {
  it('flag at jev (or unset): identical to a gateway without a router', async () => {
    for (const flags of [null, NO_FLAGS, new StaticFlags({ [FLAG_KEYS.decisionsModel]: 'jev' })]) {
      const { g, log, seen } = gateway(flags);
      const res = await g.decide(ctx, req());
      expect(seen).toEqual([JEV_MODEL]);
      expect(res.modelSnapshot).toBe(`${JEV_MODEL}-snap`);
      expect(log.rows.map((r) => [r.model, r.ok, r.purpose])).toEqual([[JEV_MODEL, true, 'predict.primary']]);
    }
  });

  it('flag at span-01: span-01 answers, and its call is logged under its own model', async () => {
    const { g, log, seen } = gateway(ON);
    const res = await g.decide(ctx, req());
    expect(seen).toEqual([SPAN_MODEL]);
    expect(res.modelSnapshot).toBe(`${SPAN_MODEL}-snap`);
    expect(log.rows.map((r) => [r.model, r.ok])).toEqual([[SPAN_MODEL, true]]);
  });

  it('serves only registered, pinned models: labels work, unregistered model IDs leave Jev in place', async () => {
    expect(SPAN_MODEL).toBe('respan/span-01-20260925');
    expect(DECISION_MODELS).toEqual({ jev: JEV_MODEL, 'span-01': SPAN_MODEL });
    for (const [value, model] of [
      ['span-01', SPAN_MODEL],
      ['Span-01', SPAN_MODEL],
      [' span_01 ', SPAN_MODEL],
      ['respan/span-01-20260925', SPAN_MODEL],
      ['Jev', JEV_MODEL],
      // Not pinned in code: an unreviewed model, an unpinned alias, a Jev version bump.
      ['respan/span-01-lite', null],
      ['respan/span-01', null],
      ['typesafe/jev-1.14', null],
      ['not a model', null],
      ['', null],
    ] as const)
      expect({ value, model: decisionModelOf(value) }).toEqual({ value, model });
    const { g, seen } = gateway(new StaticFlags({ [FLAG_KEYS.decisionsModel]: 'respan/span-01' }));
    await g.decide(ctx, req());
    expect(seen).toEqual([JEV_MODEL]);
  });

  it('falls back to Jev when the challenger fails, logging both attempts', async () => {
    const { g, log, seen } = gateway(ON, { fail: [SPAN_MODEL] });
    const res = await g.decide(ctx, req());
    expect(seen).toEqual([SPAN_MODEL, JEV_MODEL]);
    expect(res.modelSnapshot).toBe(`${JEV_MODEL}-snap`);
    expect(log.rows.map((r) => [r.model, r.ok])).toEqual([
      [SPAN_MODEL, false],
      [JEV_MODEL, true],
    ]);
    expect(log.rows[0]!.error).toContain('blocked');
  });

  it('falls back to Jev when the challenger leaves a question unanswered', async () => {
    const { g, log, seen } = gateway(ON, { partial: [SPAN_MODEL] });
    const res = await g.decide(ctx, req());
    expect(seen).toEqual([SPAN_MODEL, JEV_MODEL]);
    expect(Object.keys(res.answers)).toEqual(['a', 'b']);
    expect(log.rows[0]!.error).toMatch(/left 1 of 2 questions unanswered \(a\)/);
  });

  it('a rejected challenger answer is still logged and charged at the cost the provider billed', async () => {
    const added: number[] = [];
    const budget: BudgetLedger = {
      get: async () => ({ spendUsd: 0, budgetUsd: 1 }),
      add: async (_m, usd) => void added.push(usd),
    };
    const { g, log } = gateway(ON, { partial: [SPAN_MODEL], budget });
    await g.decide(ctx, req());
    expect(log.rows.map((r) => [r.model, r.ok, r.costUsd, r.modelSnapshot])).toEqual([
      [SPAN_MODEL, false, 0.0001, `${SPAN_MODEL}-snap`],
      [JEV_MODEL, true, 0.0001, `${JEV_MODEL}-snap`],
    ]);
    expect(added).toEqual([0.0001, 0.0001]);
  });

  it('a Jev failure after a challenger failure is the caller’s error, as it is today', async () => {
    const { g } = gateway(ON, { fail: [SPAN_MODEL, JEV_MODEL] });
    await expect(g.decide(ctx, req())).rejects.toThrow(JEV_MODEL);
  });

  it('never spends past the budget guard on a fallback', async () => {
    const budget: BudgetLedger = { get: async () => ({ spendUsd: 2, budgetUsd: 1 }), add: async () => {} };
    const { g, seen } = gateway(ON, { budget });
    await expect(g.decide(ctx, req())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(seen).toEqual([]);
  });

  it('only reroutes the incumbent model, and only for the served purposes', async () => {
    const { g, seen } = gateway(ON);
    // A predictor that names its own decisions model keeps it: the model is part of its stored ID.
    await g.decide(ctx, req('respan/span-01-lite'));
    for (const purpose of ['pool.gate', 'traits.read', 'identity.rank', 'predict.backfill', 'eval.evaluate'])
      await g.decide({ ...ctx, purpose }, req());
    expect(seen).toEqual(['respan/span-01-lite', ...Array(5).fill(JEV_MODEL)]);
    for (const purpose of CHALLENGER_PURPOSES) await g.decide({ ...ctx, purpose }, req());
    expect(seen.slice(6)).toEqual(Array(CHALLENGER_PURPOSES.length).fill(SPAN_MODEL));
  });

  it('Flagship rules can narrow the purposes by the purpose attribute, never widen them', async () => {
    const { g, seen } = gateway(
      new StaticFlags({
        [FLAG_KEYS.decisionsModel]: (c) => (c.purpose === 'predict.baseline' ? 'jev' : 'span-01'),
      }),
    );
    await g.decide({ ...ctx, purpose: 'pool.gate' }, req());
    await g.decide({ ...ctx, purpose: 'predict.baseline' }, req());
    await g.decide(ctx, req());
    expect(seen).toEqual([JEV_MODEL, JEV_MODEL, SPAN_MODEL]);
  });

  it('evaluates the flag per mimic and purpose, so a rollout keeps each person on one model', async () => {
    const contexts: unknown[] = [];
    const rollout = new StaticFlags({
      [FLAG_KEYS.decisionsModel]: (c) => {
        contexts.push(c);
        return c.targetingKey === 'in' ? 'span-01' : 'jev';
      },
    });
    const { g, seen } = gateway(rollout);
    await g.decide({ ...ctx, mimicId: 'in' }, req());
    await g.decide({ ...ctx, mimicId: 'in', purpose: 'predict.baseline' }, req());
    await g.decide({ ...ctx, mimicId: 'out' }, req());
    expect(seen).toEqual([SPAN_MODEL, SPAN_MODEL, JEV_MODEL]);
    expect(contexts[1]).toEqual({ targetingKey: 'in', purpose: 'predict.baseline' });
  });

  it('a flag that cannot be read, or names no valid model, leaves Jev in place', async () => {
    const broken: FlagReader = { ...NO_FLAGS, string: async () => Promise.reject(new Error('flags down')) };
    const junk = new StaticFlags({ [FLAG_KEYS.decisionsModel]: 'not a model' });
    const wrongType = new StaticFlags({ [FLAG_KEYS.decisionsModel]: true });
    for (const flags of [broken, junk, wrongType]) {
      const { g, seen } = gateway(flags);
      await g.decide(ctx, req());
      expect(seen).toEqual([JEV_MODEL]);
    }
  });

  it('coerces flag values to the type the code reads', () => {
    expect(coerceFlag('2.5', 1)).toBe(2.5);
    expect(coerceFlag('abc', 1)).toBe(1);
    expect(coerceFlag('on', false)).toBe(true);
    expect(coerceFlag('Off', true)).toBe(false);
    expect(coerceFlag(3, 'x')).toBe('3');
    expect(coerceFlag({}, false)).toBe(false);
  });

  it('unansweredQuestions names missing and mistyped answers', () => {
    expect(
      unansweredQuestions(req(), { answers: { a: { type: 'choice', choice: 'x', probabilities: {} } } }),
    ).toEqual(['a', 'b']);
  });
});

describe('call sites are unchanged (ADR-0051)', () => {
  const question: Question = {
    id: 'q1',
    mimicId: 'm1',
    seq: 3,
    kind: 'adaptive',
    type: 'choice',
    domain: 'casual',
    prompt: 'Pick one',
    options: [
      { key: 'a', label: 'Tea' },
      { key: 'b', label: 'Coffee' },
    ],
    facetIds: [],
    provenance: { generator: 'x', configHash: 'h', promptVersion: 'p' },
  };
  const state: PersonState = {
    identity: { name: 'P', location: 'L', facts: [] },
    traits: [],
    insights: [],
    evidence: [],
    meta: { evidenceSeqMax: 2, stateHash: 'h', builder: 'full.v1', tokens: 1 },
  };

  it('the production primary predicts through span-01 with the flag on, and through Jev with it off', async () => {
    const primary = DEFAULT_CONFIG.predictor.primary;
    const off = gateway(null);
    const on = gateway(ON);
    const failing = gateway(ON, { fail: [SPAN_MODEL] });
    const [a] = await makePredictor(off.g, primary, ctx).predict(state, [question]);
    const [b] = await makePredictor(on.g, primary, ctx).predict(state, [question]);
    const [c] = await makePredictor(failing.g, primary, ctx).predict(state, [question]);
    expect([a!.ok, b!.ok, c!.ok]).toEqual([true, true, true]);
    expect(a!.modelSnapshot).toBe(`${JEV_MODEL}-snap`);
    expect(b!.modelSnapshot).toBe(`${SPAN_MODEL}-snap`);
    expect(c!.modelSnapshot).toBe(`${JEV_MODEL}-snap`);
    // span-01 answered the choice as one yes/no per option (0.7 each), recomposed to an even split; Jev's own
    // answer was 0.8/0.2. The same prompt and calibration apply to whichever model answered.
    expect(b!.dist.a).toBeCloseTo(0.5, 6);
    expect(a!.dist.a).toBeGreaterThan(0.5);
    expect(c!.dist).toEqual(a!.dist);
    expect(on.log.rows[0]!.purpose).toBe('predict.primary');
    expect(jevKey(question)).toBe('q_q1');
  });
});

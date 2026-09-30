import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  type BudgetLedger,
  type CallLog,
  DEFAULT_CONFIG,
  type DecisionProvider,
  Gateway,
  type LlmClient,
  type ModelCallRecord,
  type ModelCallTrace,
  parseSpendLimits,
  redact,
  spendCaps,
  traceKey,
} from '../src';

class MemLog implements CallLog {
  rows: ModelCallRecord[] = [];
  traces: ModelCallTrace[] = [];
  async write(r: ModelCallRecord, t: ModelCallTrace) {
    this.rows.push(r);
    this.traces.push(t);
  }
}

class MemBudget implements BudgetLedger {
  constructor(
    public spend: number,
    public budget: number,
  ) {}
  async get() {
    return { spendUsd: this.spend, budgetUsd: this.budget };
  }
  async add(_id: string, usd: number) {
    this.spend += usd;
  }
}

const decisions = (cost = 0.001, fail = false): DecisionProvider => ({
  provider: 'fake-decisions',
  async decide() {
    if (fail) throw new Error('boom');
    return {
      modelSnapshot: 'jev-snap',
      answers: {},
      usage: { inputTokens: 10, outputTokens: 1, costUsd: cost },
      latencyMs: 5,
      raw: { ok: true },
    };
  },
});
const llm: LlmClient = {
  provider: 'fake-llm',
  async chat() {
    return {
      content: '{}',
      modelSnapshot: 'm@p',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      latencyMs: 1,
      raw: {},
    };
  },
};

function gateway(opts: { budget?: BudgetLedger; fail?: boolean } = {}) {
  const log = new MemLog();
  let n = 0;
  const g = new Gateway({
    decisions: decisions(0.001, opts.fail),
    llm,
    log,
    ...(opts.budget ? { budget: opts.budget } : {}),
    clock: () => 1_790_000_000_000,
    newId: () => `id${++n}`,
  });
  return { g, log };
}

const req = { model: 'typesafe/jev-1.13', state: { x: 1 }, questions: {} };

describe('withModelCall (PLAN §3.5)', () => {
  it('writes a model_calls row and a trace for every successful call', async () => {
    const { g, log } = gateway();
    await g.decide({ purpose: 'predict.primary', mimicId: 'm1', configHash: 'c1' }, req);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({
      purpose: 'predict.primary',
      provider: 'fake-decisions',
      model: 'typesafe/jev-1.13',
      modelSnapshot: 'jev-snap',
      inputTokens: 10,
      outputTokens: 1,
      costUsd: 0.001,
      ok: true,
      error: null,
      configHash: 'c1',
      mimicId: 'm1',
      r2TraceKey: traceKey('id1', 1_790_000_000_000),
    });
    expect(log.rows[0]!.r2TraceKey).toMatch(/^traces\/\d{4}-\d{2}-\d{2}\/id1\.json$/);
    expect(log.traces[0]).toMatchObject({ request: req, response: { ok: true } });
  });

  it('logs failures with ok = false and rethrows', async () => {
    const { g, log } = gateway({ fail: true });
    await expect(g.decide({ purpose: 'x' }, req)).rejects.toThrow('boom');
    expect(log.rows[0]).toMatchObject({ ok: false, error: 'boom', costUsd: 0 });
    expect(log.traces[0]!.error).toBe('boom');
  });

  it('redacts credentials from traces', () => {
    expect(
      redact({ authorization: 'Bearer abc', nested: { apiKey: 'x', text: 'use sk-or-v1-deadbeef please' } }),
    ).toEqual({
      authorization: '[redacted]',
      nested: { apiKey: '[redacted]', text: 'use [redacted] please' },
    });
  });
});

describe('budget guard', () => {
  it('blocks calls once spend reaches the cap, without calling the provider', async () => {
    const budget = new MemBudget(0.5, 0.5);
    const { g, log } = gateway({ budget });
    await expect(g.decide({ purpose: 'x', mimicId: 'm1' }, req)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(log.rows).toHaveLength(0);
  });

  it('charges each call to the mimic and stops at the cap', async () => {
    const budget = new MemBudget(0.498, 0.5);
    const { g } = gateway({ budget });
    await g.decide({ purpose: 'x', mimicId: 'm1' }, req);
    await g.decide({ purpose: 'x', mimicId: 'm1' }, req);
    expect(budget.spend).toBeCloseTo(0.5, 10);
    await expect(g.decide({ purpose: 'x', mimicId: 'm1' }, req)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('does not guard calls that belong to no mimic', async () => {
    const budget = new MemBudget(1, 0.5);
    const { g } = gateway({ budget });
    await expect(g.decide({ purpose: 'x' }, req)).resolves.toBeDefined();
  });
});

describe('spend caps (ADR-0034)', () => {
  it("keeps 20% of the config's budget for the mimic page by default", () => {
    expect(spendCaps(DEFAULT_CONFIG)).toEqual({ totalUsd: 0.5, sessionUsd: 0.4 });
  });

  it('lets the deploy settings override the total and the session share', () => {
    const caps = spendCaps(
      DEFAULT_CONFIG,
      parseSpendLimits({ BUDGET_USD: '0.75', BUDGET_SESSION_SHARE: '0.8' }),
    );
    expect(caps.totalUsd).toBe(0.75);
    expect(caps.sessionUsd).toBeCloseTo(0.6, 10);
    expect(spendCaps(DEFAULT_CONFIG, { sessionShare: 1 })).toEqual({ totalUsd: 0.5, sessionUsd: 0.5 });
  });

  it('ignores unset or invalid values, so the defaults apply', () => {
    expect(parseSpendLimits({})).toEqual({});
    expect(parseSpendLimits({ BUDGET_USD: ' ', BUDGET_SESSION_SHARE: '' })).toEqual({});
    expect(parseSpendLimits({ BUDGET_USD: '-1', BUDGET_SESSION_SHARE: '1.5' })).toEqual({});
    expect(parseSpendLimits({ BUDGET_USD: 'abc', BUDGET_SESSION_SHARE: '0' })).toEqual({});
    expect(parseSpendLimits({ BUDGET_USD: ' 2 ', BUDGET_SESSION_SHARE: '0.5' })).toEqual({
      budgetUsd: 2,
      sessionShare: 0.5,
    });
  });
});

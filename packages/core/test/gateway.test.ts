import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  type BudgetLedger,
  type CallLog,
  DEFAULT_BUDGET_USD,
  DEFAULT_CONFIG,
  type DecisionProvider,
  Gateway,
  type LlmClient,
  type ModelCallRecord,
  type ModelCallTrace,
  parseSpendLimits,
  redact,
  SPEND_SCOPES,
  spendCaps,
  spendScope,
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

  it('logs the vendor that serves each model when the provider routes by model (ADR-0068)', async () => {
    const log = new MemLog();
    const routed: DecisionProvider = {
      ...decisions(),
      provider: 'decisions',
      providerFor: (model) =>
        model.startsWith('cloudflare/') ? 'workers-ai-decisions' : 'openrouter-decisions',
    };
    const g = new Gateway({ decisions: routed, llm, log, clock: () => 1, newId: () => 'id' });
    await g.decide({ purpose: 'eval.models' }, { ...req, model: 'cloudflare/clef' });
    await g.decide({ purpose: 'eval.models' }, req);
    expect(log.rows.map((r) => [r.provider, r.model])).toEqual([
      ['workers-ai-decisions', 'cloudflare/clef'],
      ['openrouter-decisions', 'typesafe/jev-1.13'],
    ]);
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

describe('spend caps (ADR-0035)', () => {
  it('gives the standard budget $1 and keeps 20% of it for the mimic page by default', () => {
    const caps = spendCaps(DEFAULT_CONFIG);
    expect(caps.totalUsd).toBe(DEFAULT_BUDGET_USD);
    expect(caps.sessionUsd).toBeCloseTo(0.8, 10);
  });

  it('lets the deploy settings override the standard total and the session share', () => {
    const { limits } = parseSpendLimits({ BUDGET_USD: '1.5', BUDGET_SESSION_SHARE: '0.5' });
    expect(spendCaps(DEFAULT_CONFIG, limits)).toEqual({ totalUsd: 1.5, sessionUsd: 0.75 });
    expect(spendCaps(DEFAULT_CONFIG, { sessionShare: 1 })).toEqual({ totalUsd: 1, sessionUsd: 1 });
  });

  it("keeps a config's own budget when it names one other than the standard", () => {
    const arm = { ...DEFAULT_CONFIG, session: { target: 60, budgetUsd: 1.5 } };
    const caps = spendCaps(arm, { budgetUsd: 3 });
    expect(caps.totalUsd).toBe(1.5);
    expect(caps.sessionUsd).toBeCloseTo(1.2, 10);
  });

  it('reads strings or JSON numbers, and names invalid values instead of dropping them silently', () => {
    expect(parseSpendLimits({})).toEqual({ limits: {}, problems: [] });
    expect(parseSpendLimits({ BUDGET_USD: ' ', BUDGET_SESSION_SHARE: '' })).toEqual({
      limits: {},
      problems: [],
    });
    expect(parseSpendLimits({ BUDGET_USD: 2, BUDGET_SESSION_SHARE: ' 0.5 ' }).limits).toEqual({
      budgetUsd: 2,
      sessionShare: 0.5,
    });
    const bad = parseSpendLimits({ BUDGET_USD: '$1', BUDGET_SESSION_SHARE: 1.5 });
    expect(bad.limits).toEqual({});
    expect(bad.problems).toEqual([
      'BUDGET_USD is not valid; using the default',
      'BUDGET_SESSION_SHARE is not valid; using the default',
    ]);
  });
});

describe('spend scopes (ADR-0035)', () => {
  class CapBudget implements BudgetLedger {
    constructor(public spend: number) {}
    async get() {
      return { spendUsd: this.spend, budgetUsd: 0.75, sessionUsd: 0.6 };
    }
    async add(_: string, usd: number) {
      this.spend += usd;
    }
  }

  it("holds session work to the session's share and the page and serves to the whole cap", async () => {
    const { g } = gateway({ budget: new CapBudget(0.65) });
    for (const purpose of ['predict.shadow', 'pool.generate', 'hypotheses', 'not.listed'])
      await expect(g.decide({ purpose, mimicId: 'm1' }, req)).rejects.toBeInstanceOf(BudgetExceededError);
    for (const purpose of ['playground.predict', 'soul.draft', 'traits.read', 'predict.primary'])
      await expect(g.decide({ purpose, mimicId: 'm1' }, req)).resolves.toBeDefined();
    const { g: spent } = gateway({ budget: new CapBudget(0.75) });
    await expect(spent.decide({ purpose: 'playground.predict', mimicId: 'm1' }, req)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('classifies every purpose the engine logs a call under', () => {
    const dir = join(__dirname, '../src/engine');
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts')))
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/ctxFor\(\s*\w+,\s*'([^']+)'/g))
        used.add(m[1]!);
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((p) => !(p in SPEND_SCOPES))).toEqual([]);
    expect(spendScope('not.listed')).toBe('session');
  });
});

describe('enrichment logging (PLAN §3.5, ADR-0034)', () => {
  it('logs each provider call an enricher makes as its own row, failures included', async () => {
    const log = new MemLog();
    let n = 0;
    const g = new Gateway({
      decisions: decisions(),
      llm,
      log,
      enricher: {
        provider: 'exa',
        async enrich(_subject, run) {
          const page = await run('exa:contents', { urls: ['u'] }, async () => ({
            costUsd: 0.001,
            latencyMs: 3,
            raw: {},
          }));
          await run('exa:summary', { urls: ['u'] }, async () => {
            throw new Error('summary did not match the schema');
          }).catch(() => null);
          return { facts: [], costUsd: page.costUsd, latencyMs: 5, raw: {} };
        },
      },
      clock: () => 1_790_000_000_000,
      newId: () => `id${++n}`,
    });
    await g.enrich({ purpose: 'identity.enrich', mimicId: 'M' }, { name: 'A', location: 'B', url: 'u' });
    expect(log.rows.map((r) => [r.provider, r.model, r.ok, r.costUsd])).toEqual([
      ['exa', 'exa:contents', true, 0.001],
      ['exa', 'exa:summary', false, 0],
    ]);
    expect(log.rows[1]!.error).toContain('schema');
  });
});

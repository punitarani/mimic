import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEF_MODEL,
  type DecisionProvider,
  type DecisionRequest,
  Gateway,
  GLIDE_MODEL,
  JEV_MODEL,
  PPLX_DECIDER_MODEL,
  RejectedResponseError,
  scorePrediction,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDecisions, FakeLlm } from '../src/fakes';
import { openLocalEngine } from '../src/local';
import {
  afterCanary,
  analyzeModels,
  armCandidates,
  canary,
  canaryHint,
  DEFAULT_PREDICTORS,
  decideModels,
  MODELS_RULE,
  MODELS_VIEWS,
  type ModelsReport,
  modelArms,
  modelsCmd,
  OPT_IN_PREDICTORS,
  type OpStats,
  planChunks,
  runChunk,
  SERVED,
  TWIN,
} from '../src/models';
import { loadData } from '../src/optimize/commands';
import {
  type EvalRecord,
  jevRequests,
  looTemperatures,
  Meter,
  rescaled,
  resolveCandidate,
} from '../src/optimize/evaluate';
import type { EvalInstance } from '../src/optimize/instances';
import { renderReport } from '../src/report';
import { runSession, SessionScript } from '../src/session';
import { E8_SETTINGS, TUNE_SETTINGS } from '../src/tuning';
import { importTwin } from '../src/twin';

const JEV = `decision:${JEV_MODEL}`;
const CLEF = `decision:${CLEF_MODEL}`;
const PPLX = `decision:${PPLX_DECIDER_MODEL}`;
const GLIDE = `decision:${GLIDE_MODEL}`;

/** A scored choice prediction: `p` on the option the person picked. */
function rec(id: string, person: string, o: Partial<EvalRecord> & { p?: number } = {}): EvalRecord {
  const p = o.p ?? 0.6;
  const dist = { a: p, b: 1 - p };
  const s = scorePrediction('choice', dist, 'a');
  return {
    candidate: 'c',
    predictorId: 'p',
    instanceId: id,
    mimicId: person,
    split: 'test',
    type: 'choice',
    stateHash: `s:${id}`,
    evidenceSeqMax: 1,
    stateTokens: 1,
    modelSnapshot: 'snap',
    ok: true,
    error: null,
    transient: false,
    dist,
    answer: 'a',
    ...s,
    confidence: Math.max(p, 1 - p),
    baselineItemAcc: null,
    value: -s.logLoss,
    costUsd: 0.00001,
    latencyMs: 300,
    feedback: '',
    ...o,
  };
}

/**
 * `n` records over `people` people, the probability on the answer varying by instance; `better(i)` lowers instance
 * i's log loss by that much (the rule reads only log loss and item accuracy).
 */
function cohort(prefix: string, people: number, n: number, better: (i: number) => number = () => 0) {
  return Array.from({ length: n }, (_, i) => {
    const r = rec(`${prefix}${i}`, `${prefix}m${i % people}`, { p: 0.35 + (0.3 * ((i * 7) % 10)) / 10 });
    return { ...r, logLoss: r.logLoss - better(i) };
  });
}

const ops = (o: Partial<OpStats> = {}): OpStats => ({
  predictions: 400,
  errors: 0,
  errorRate: 0,
  answeredRequests: 100,
  p50LatencyMs: 300,
  p95LatencyMs: 600,
  costPerRequestUsd: 0.0001,
  ...o,
});

/** The rule's input with the reference and one challenger whose probabilities are shifted by `served` and `twin`. */
function input(
  served: (i: number) => number,
  twin: (i: number) => number,
  o: { k?: number; people?: number } = {},
) {
  const ref = { served: cohort('s', o.people ?? 8, 400), twin: cohort('t', 40, 800) };
  return {
    reference: JEV,
    challengers: [CLEF],
    k: o.k ?? MODELS_RULE.twinK,
    served: new Map([
      [JEV, ref.served],
      [CLEF, cohort('s', o.people ?? 8, 400, served)],
    ]),
    twin: new Map([
      [JEV, ref.twin],
      [CLEF, cohort('t', 40, 800, twin)],
    ]),
    ops: { [JEV]: ops(), [CLEF]: ops() } as Record<string, OpStats>,
  };
}

describe('MODELS_RULE (E8, docs/MODELS.md §5)', () => {
  it('calls a challenger better when it lowers served log loss for sure and Twin on average, and recommends it', () => {
    const v = decideModels(
      input(
        () => 0.05,
        () => 0.02,
      ),
    );
    expect(v.challengers[0]).toMatchObject({ outcome: 'better', recommend: true });
    expect(v.recommendation).toBe(CLEF);
  });

  it('calls it worse when either interval lies above 0', () => {
    expect(
      decideModels(
        input(
          () => -0.05,
          () => 0,
        ),
      ).challengers[0]!.outcome,
    ).toBe('worse');
    expect(
      decideModels(
        input(
          () => 0.05,
          () => -0.05,
        ),
      ).challengers[0]!.outcome,
    ).toBe('worse');
  });

  it('calls it level when the served interval straddles 0, or Twin gets worse on average', () => {
    expect(
      decideModels(
        input(
          (i) => (i % 2 ? 0.05 : -0.05),
          () => 0,
        ),
      ).challengers[0]!.outcome,
    ).toBe('level');
    // On Twin, half the people a little better and half a little more worse: worse on average, not for sure.
    const twinWorse = decideModels(
      input(
        () => 0.05,
        (i) => ((i % 40) % 2 ? 0.02 : -0.025),
      ),
    ).challengers[0]!;
    expect(twinWorse.outcome).toBe('level');
    expect(twinWorse.checks.find((c) => c.name === 'Twin log loss')?.pass).toBe(false);
  });

  it('is insufficient with too few served people or Twin away from k = 30', () => {
    expect(
      decideModels(
        input(
          () => 0.05,
          () => 0.02,
          { people: 4 },
        ),
      ).challengers[0]!.outcome,
    ).toBe('insufficient');
    const v = decideModels(
      input(
        () => 0.05,
        () => 0.02,
        { k: 8 },
      ),
    );
    expect(v.challengers[0]!.outcome).toBe('insufficient');
    expect(v.recommendation).toBeNull();
  });

  it('holds accuracy: a better log loss that loses more than a point is level', () => {
    const x = input(
      () => 0.05,
      () => 0.02,
    );
    x.served.set(
      CLEF,
      x.served.get(CLEF)!.map((r) => ({ ...r, itemAcc: r.itemAcc - 0.05 })),
    );
    expect(decideModels(x).challengers[0]!.outcome).toBe('level');
  });

  it("doesn't recommend a better model that is too slow or fails too often, and never gates on cost", () => {
    const slow = input(
      () => 0.05,
      () => 0.02,
    );
    slow.ops[CLEF] = ops({ p95LatencyMs: 1200, costPerRequestUsd: 0.01 });
    const v = decideModels(slow);
    expect(v.challengers[0]).toMatchObject({ outcome: 'better', recommend: false });
    expect(v.challengers[0]!.operational.find((c) => c.name === 'latency')?.pass).toBe(false);
    expect(v.challengers[0]!.operational.find((c) => c.name === 'cost')?.pass).toBeNull();
    expect(v.recommendation).toBeNull();
    const flaky = input(
      () => 0.05,
      () => 0.02,
    );
    flaky.ops[CLEF] = ops({ errorRate: 0.03 });
    expect(decideModels(flaky).challengers[0]!.recommend).toBe(false);
    const pricey = input(
      () => 0.05,
      () => 0.02,
    );
    pricey.ops[CLEF] = ops({ costPerRequestUsd: 1 });
    expect(decideModels(pricey).recommendation).toBe(CLEF);
  });

  it('recommends the better challenger with the lower served log loss', () => {
    const x = input(
      () => 0.03,
      () => 0.02,
    );
    x.challengers.push(PPLX);
    x.served.set(
      PPLX,
      cohort('s', 8, 400, () => 0.08),
    );
    x.twin.set(
      PPLX,
      cohort('t', 40, 800, () => 0.02),
    );
    x.ops[PPLX] = ops();
    const v = decideModels(x);
    expect(v.challengers.map((c) => c.outcome)).toEqual(['better', 'better']);
    expect(v.recommendation).toBe(PPLX);
  });
});

describe('calibration, leaving each person out', () => {
  it("fits each person's temperature on everyone else", () => {
    // A is always right at 0.9 (wants a sharper scale); B and C are right half the time at 0.9 (want a softer one).
    const recs = [
      ...Array.from({ length: 20 }, (_, i) => rec(`a${i}`, 'A', { p: 0.9 })),
      ...Array.from({ length: 20 }, (_, i) => rec(`b${i}`, 'B', { p: i % 2 ? 0.9 : 0.1 })),
      ...Array.from({ length: 20 }, (_, i) => rec(`c${i}`, 'C', { p: i % 2 ? 0.9 : 0.1 })),
    ];
    const fit = looTemperatures(recs);
    expect(fit.byPerson.get('A')!).toBeGreaterThan(4);
    expect(fit.byPerson.get('B')!).toBeLessThan(fit.byPerson.get('A')!);
    expect(fit.all).toBeGreaterThan(1);
    // One person alone has no one else to fit on.
    expect(looTemperatures(recs.slice(0, 20)).byPerson.get('A')).toBe(1);
  });

  it('rescores at a temperature, and leaves failures and T = 1 alone', () => {
    const r = rec('x', 'A', { p: 0.9 });
    expect(rescaled(r, 1)).toBe(r);
    const soft = rescaled(r, 4);
    expect(soft.dist.a).toBeLessThan(0.9);
    expect(soft.logLoss).toBeGreaterThan(r.logLoss);
    expect(soft.top1).toBe(r.top1);
    const failed = { ...r, ok: false };
    expect(rescaled(failed, 4)).toBe(failed);
  });
});

describe('arms and chunks', () => {
  it('takes decision predictors that share a prompt version, the first as the reference', () => {
    expect(modelArms(DEFAULT_PREDICTORS.join(','))).toEqual(DEFAULT_PREDICTORS);
    expect(DEFAULT_PREDICTORS[0]).toBe(JEV);
    expect(modelArms(`jev:${JEV_MODEL},${CLEF}`)).toEqual([JEV, CLEF]);
    expect(() => modelArms(JEV)).toThrow(/at least two/);
    expect(() => modelArms(`${JEV},${JEV}`)).toThrow(/repeats/);
    expect(() => modelArms(`${JEV},llm:deepseek/deepseek-v4.1-flash`)).toThrow(/decision predictors only/);
    expect(() => modelArms(`${JEV}@jev-predict.v2,${CLEF}`)).toThrow(/one prompt version/);
  });

  it('leaves out models whose canary failed only when asked, and never the reference', () => {
    const result = (predictor: string, ok: boolean) => ({
      predictor,
      label: predictor,
      ok,
      error: ok ? null : 'HTTP 401',
      modelSnapshot: null,
      latencyMs: null,
      costUsd: null,
    });
    const all = [JEV, CLEF, PPLX];
    const clefDown = [result(JEV, true), result(CLEF, false), result(PPLX, true)];
    expect(
      afterCanary(
        all,
        all.map((p) => result(p, true)),
        false,
      ),
    ).toEqual(all);
    expect(() => afterCanary(all, clefDown, false)).toThrow(/canary failed for .*HTTP 401/);
    expect(afterCanary(all, clefDown, true)).toEqual([JEV, PPLX]);
    expect(() =>
      afterCanary(all, [result(JEV, false), result(CLEF, true), result(PPLX, true)], true),
    ).toThrow();
    expect(() => afterCanary([JEV, CLEF], clefDown.slice(0, 2), true)).toThrow();
  });

  it('names the fix for the failures a first run meets', () => {
    expect(canaryHint(CLEF_MODEL, 'HTTP 400 from api.cloudflare.com: needs CLOUDFLARE_ACCOUNT_ID')).toMatch(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    expect(canaryHint(CLEF_MODEL, 'HTTP 401 from api.cloudflare.com: Authentication error')).toMatch(
      /Workers AI · Read/,
    );
    expect(canaryHint(PPLX_DECIDER_MODEL, 'HTTP 401 from api.perplexity.ai')).toMatch(/PERPLEXITY_API_KEY/);
    expect(canaryHint('respan/span-01', 'HTTP 404: No allowed providers')).toMatch(/OpenRouter/);
  });

  it('plans chunks of people, served first, keeping the loaded order', () => {
    const inst = (mimicId: string, n: number) => ({ id: `${mimicId}:${n}`, mimicId }) as EvalInstance;
    const served = ['s1', 's1', 's2', 's3'].map((m, i) => inst(m, i));
    const twin = ['t1', 't2', 't2', 't3'].map((m, i) => inst(m, i));
    expect(planChunks(served, twin, 2).map((c) => [c.dataset, c.people, c.instances.length])).toEqual([
      [SERVED, ['s1', 's2'], 3],
      [SERVED, ['s3'], 1],
      [TWIN, ['t1', 't2'], 3],
      [TWIN, ['t3'], 1],
    ]);
  });
});

describe('canary and report consistency', () => {
  it('keeps what a rejected canary response cost and said', async () => {
    const usage = { inputTokens: 300, outputTokens: 3, costUsd: 0.00007 };
    const decisions: DecisionProvider = {
      provider: 'fake',
      decide: () =>
        Promise.reject(
          new RejectedResponseError('cloudflare/clef: answered as other', {
            usage,
            modelSnapshot: '@cf/cloudflare/clef',
            latencyMs: 210,
            raw: { result: 'raw body' },
          }),
        ),
    };
    const g = new Gateway({
      decisions,
      llm: new FakeLlm(),
      log: { write: async () => {} },
      clock: () => 1,
      newId: () => 'id',
    });
    const { results, recorded } = await canary(g, [CLEF]);
    expect(results[0]).toMatchObject({
      ok: false,
      costUsd: 0.00007,
      latencyMs: 210,
      modelSnapshot: '@cf/cloudflare/clef',
    });
    expect(recorded[0]).toMatchObject({ response: { result: 'raw body' } });
  });

  it('shows one interval per comparison in the verdict, the table and the matrix', () => {
    const served = { ref: cohort('s', 8, 400), c: cohort('s', 8, 400, (i) => (i % 2 ? 0.06 : -0.02)) };
    const arm = (predictor: string, records: EvalRecord[]) => ({
      dataset: SERVED,
      predictor,
      view: 'full' as const,
      setting: 'full',
      records,
      requests: records.map((x) => [x.instanceId]),
    });
    const r = analyzeModels([arm(JEV, served.ref), arm(CLEF, served.c)], {
      reference: JEV,
      predictors: [JEV, CLEF],
      views: ['full'],
      k: 30,
      population: 'real',
      maxQuestionsPerRequest: 20,
      costUsd: 0,
      stopReason: null,
      offline: true,
      canary: [],
    });
    const [low, high] = r.deltas[0]!.calibrated.logLoss.byQuestion;
    const cell = r.pairwise.find((x) => x.row === CLEF && x.col === JEV)!;
    expect([cell.low, cell.high]).toEqual([low, high]);
    const check = r.verdict.challengers[0]!.checks.find((x) => x.name === 'served log loss')!;
    const sgn = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;
    expect(check.detail).toContain(`[${sgn(low)}, ${sgn(high)}]`);
  });
});

describe('runs on the Twin sample, offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimic-e8-'));
  const twin = join(dir, 'twin.sqlite');
  const served = join(dir, 'served.sqlite');
  let instances: EvalInstance[] = [];
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeAll(async () => {
    const t = await openLocalEngine({ db: twin, providers: 'offline' });
    await importTwin(t.deps, { path: join(__dirname, '../fixtures/twin2k500.sample.jsonl') });
    t.close();
    instances = (await loadData(twin, { split: 'all', k: 8, seed: 'e8', maxTargets: 5 })).instances;
    const engine = await openLocalEngine({ db: served, providers: 'offline', seed: 'e8-cohort' });
    for (let i = 0; i < 3; i++) {
      const script = SessionScript.parse({
        intake: {
          name: `Person ${i}`,
          location: 'Porto, PT',
          occupation: 'Teacher',
          employer: 'Escola Norte',
        },
        consentResearch: true,
        policy: 'first',
        seed: `e8-${i}`,
      });
      await runSession(engine, script, { turns: 12 });
    }
    engine.close();
  }, 120_000);

  /** Fake answers at $1 a request, so a cap bites. */
  const paidGateway = () => {
    const fake = new FakeDecisions();
    const decisions: DecisionProvider = {
      provider: 'fake',
      decide: async (req) => {
        const res = await fake.decide(req);
        return { ...res, usage: { ...res.usage, costUsd: 1 } };
      },
    };
    return new Gateway({
      decisions,
      llm: new FakeLlm(),
      log: { write: async () => {} },
      clock: () => 1,
      newId: () => 'id',
    });
  };

  it('asks every model the same requests, and drops a chunk the cap cuts for every model', async () => {
    const cands = armCandidates([JEV, CLEF], E8_SETTINGS);
    const chunk = planChunks([], instances, 100)[0]!;
    const res = await runChunk(chunk, cands, E8_SETTINGS, {
      gateway: paidGateway(),
      meter: new Meter(1000),
      cache: new Map(),
      concurrency: 2,
      maxQuestions: 64,
    });
    if (!('arms' in res)) throw new Error('stopped');
    expect(res.arms.map((a) => `${a.predictor}|${a.view}`)).toEqual([
      `${JEV}|full`,
      `${JEV}|context`,
      `${CLEF}|full`,
      `${CLEF}|context`,
    ]);
    const ids = (p: string, v: string) =>
      res.arms.find((a) => a.predictor === p && a.view === v)!.records.map((r) => r.instanceId);
    expect(ids(CLEF, 'full')).toEqual(ids(JEV, 'full'));
    expect(ids(JEV, 'context')).toEqual(ids(JEV, 'full'));
    expect(ids(JEV, 'full')).toEqual(chunk.instances.map((i) => i.id));
    const reqs = (p: string) => res.arms.find((a) => a.predictor === p && a.view === 'full')!.requests;
    expect(reqs(CLEF)).toEqual(reqs(JEV));

    const stopped = await runChunk(chunk, cands, E8_SETTINGS, {
      gateway: paidGateway(),
      meter: new Meter(0.5),
      cache: new Map(),
      concurrency: 1,
      maxQuestions: 64,
    });
    expect('stop' in stopped).toBe(true);
  });

  it('asks each E8b setting its own way, and asks an identical state once', async () => {
    const chunk = planChunks([], instances, 100)[0]!;
    const run = async (keys: string[]) => {
      const sent: DecisionRequest[] = [];
      const fake = new FakeDecisions();
      const gateway = new Gateway({
        decisions: {
          provider: 'fake',
          decide: async (req) => {
            sent.push(req);
            const res = await fake.decide(req);
            return { ...res, usage: { ...res.usage, costUsd: 0.001 } };
          },
        },
        llm: new FakeLlm(),
        log: { write: async () => {} },
        clock: () => 1,
        newId: () => 'id',
      });
      const settings = TUNE_SETTINGS.filter((s) => keys.includes(s.key));
      const res = await runChunk(chunk, armCandidates([JEV], settings), settings, {
        gateway,
        meter: new Meter(1000),
        cache: new Map(),
        concurrency: 1,
        maxQuestions: 64,
      });
      if (!('arms' in res)) throw new Error('stopped');
      return { arms: res.arms, sent };
    };

    const all = await run(TUNE_SETTINGS.map((s) => s.key));
    expect(all.arms.map((a) => a.setting)).toEqual(TUNE_SETTINGS.map((s) => s.key));
    for (const a of all.arms)
      expect(a.records.map((r) => r.instanceId)).toEqual(chunk.instances.map((i) => i.id));
    // Twin people have no traits or insights: `answers` is `full` and `derived` is `context`, asked once.
    const arm = (k: string) => all.arms.find((a) => a.setting === k)!;
    for (const [dup, of] of [
      ['answers', 'full'],
      ['derived', 'context'],
      ['answers+choice', 'full+choice'],
    ] as const) {
      expect(arm(dup).requests).toEqual([]);
      expect(arm(dup).records.every((r) => r.costUsd === 0)).toBe(true);
      expect(arm(dup).records.map((r) => r.dist)).toEqual(arm(of).records.map((r) => r.dist));
    }

    const questions = (rs: DecisionRequest[]) => rs.flatMap((r) => Object.values(r.questions));
    const full = (await run(['full'])).sent;
    const choice = (await run(['full+choice'])).sent;
    const text = (await run(['full+text'])).sent;
    const plain = (await run(['full+plain'])).sent;
    expect(questions(full).some((q) => q.type === 'score')).toBe(true);
    expect(questions(choice).some((q) => q.type === 'score')).toBe(false);
    expect(questions(choice)).toHaveLength(questions(full).length);
    expect(full.every((r) => typeof r.state === 'object')).toBe(true);
    expect(text.every((r) => typeof r.state === 'string')).toBe(true);
    const choices = (rs: DecisionRequest[]) =>
      questions(rs).flatMap((q) => (q.type === 'choice' ? Object.values(q.criteria) : []));
    expect(choices(full).every((c) => String(c).startsWith('The person would choose'))).toBe(true);
    expect(choices(plain).some((c) => String(c).startsWith('The person would choose'))).toBe(false);
    expect(questions(plain).every((q) => q.instructions.startsWith('How would this person answer'))).toBe(
      true,
    );
  });

  it("splits requests at clef's 64 questions, and at the common limit for every model", () => {
    const one = instances[0]!;
    const many = Array.from({ length: 70 }, (_, i) => ({ ...one, id: `${one.id}#${i}` }));
    const sizes = (p: string, max?: number) =>
      jevRequests(resolveCandidate({ predictor: p }), many, max).map((g) => g.length);
    expect(sizes(CLEF)).toEqual([64, 6]);
    expect(sizes(JEV)).toEqual([70]);
    expect(sizes(JEV, 64)).toEqual([64, 6]);
  });

  const runOnce = async (args: string[]): Promise<{ report: ModelsReport; md: string }> => {
    await modelsCmd([
      '--data',
      `${served},${twin}`,
      '--k',
      '8',
      '--max-targets',
      '5',
      '--offline',
      '--out',
      join(dir, `run-${Math.random().toString(36).slice(2)}`),
      ...args,
    ]);
    const engine = await openLocalEngine({ db: served, providers: 'offline' });
    const runs = await engine.deps.store.listEvalRuns();
    engine.close();
    const run = runs
      .filter((r) => (r.spec as { kind?: string }).kind === 'models')
      .sort((a, b) => b.createdAt - a.createdAt)[0]!;
    const md = readFileSync(join('data/reports', run.id, 'report.md'), 'utf8');
    rmSync(join('data/reports', run.id), { recursive: true, force: true });
    expect(renderReport(run).trimEnd()).toBe(md.trimEnd());
    return { report: (run.metrics as { report: ModelsReport }).report, md };
  };

  it('runs all five models end to end, reproducibly, and keeps scripted people out unless asked', async () => {
    const a = await runOnce(['--population', 'all']);
    const r = a.report;
    expect(r.offline).toBe(true);
    expect(r.predictors).toEqual(DEFAULT_PREDICTORS);
    expect(r.canary.every((c) => c.ok)).toBe(true);
    expect(r.datasets.map((d) => d.key)).toEqual([SERVED, TWIN]);
    expect(r.maxQuestionsPerRequest).toBe(20);
    // Served states are per question, so served requests carry one question each, in both views.
    for (const x of r.rows.filter((x) => x.dataset === SERVED && x.view === 'full'))
      expect(x.requests?.requests).toBe(x.n);
    // Every arm of a dataset scored the same instances.
    for (const d of r.datasets)
      expect(new Set(r.rows.filter((x) => x.dataset === d.key).map((x) => x.n))).toEqual(
        new Set([d.instances]),
      );
    expect(r.rows).toHaveLength(DEFAULT_PREDICTORS.length * MODELS_VIEWS.length * 2);
    expect(r.deltas).toHaveLength((DEFAULT_PREDICTORS.length - 1) * 2);
    expect(r.production.map((p) => p.t)).toEqual([4, 4]);
    expect(Object.keys(r.rates).sort()).toEqual([
      'cloudflare/clef',
      'cloudflare/clef-flash',
      PPLX_DECIDER_MODEL,
    ]);
    expect(r.verdict.challengers.every((c) => c.outcome === 'insufficient')).toBe(true);
    expect(a.md).toContain('Offline run with fake providers');
    expect(a.md).toContain('## Verdict: insufficient data; keep Jev');
    expect(a.md).toContain('## Canary');
    expect(a.md).toContain('### Pairwise');
    expect(a.md).toContain('## Prices');

    const b = await runOnce(['--population', 'all']);
    expect(b.report.rows.map((x) => [x.predictor, x.view, x.cal.logLoss])).toEqual(
      r.rows.map((x) => [x.predictor, x.view, x.cal.logLoss]),
    );

    // By default only real people's served answers count: this cohort is scripted.
    const real = await runOnce([]);
    expect(real.report.datasets.map((d) => d.key)).toEqual([TWIN]);
  }, 240_000);

  it('runs GLiDE only when named (ADR-0070)', async () => {
    expect(DEFAULT_PREDICTORS).not.toContain(GLIDE);
    expect(OPT_IN_PREDICTORS).toEqual([GLIDE]);
    const { report: r } = await runOnce(['--population', 'all', '--predictors', `${JEV},${GLIDE}`]);
    expect(r.predictors).toEqual([JEV, GLIDE]);
    expect(r.canary.map((c) => [c.label, c.ok])).toEqual([
      ['Jev', true],
      ['GLiDE', true],
    ]);
    expect(Object.keys(r.rates)).toEqual([GLIDE_MODEL]);
  }, 240_000);

  it('tunes every model on its own, and keeps E8 as run beside it (E8b)', async () => {
    const { report: r, md } = await runOnce([
      '--population',
      'all',
      '--tune',
      '--predictors',
      `${JEV},${CLEF}`,
    ]);
    // E8's own tables read only E8's settings.
    expect(r.rows).toHaveLength(2 * MODELS_VIEWS.length * 2);
    const t = r.tuning!;
    expect(t.settings).toEqual(TUNE_SETTINGS);
    expect(t.models.map((m) => `${m.dataset}|${m.predictor}`)).toEqual([
      `${SERVED}|${JEV}`,
      `${SERVED}|${CLEF}`,
      `${TWIN}|${JEV}`,
      `${TWIN}|${CLEF}`,
    ]);
    for (const m of t.models) {
      expect(TUNE_SETTINGS.map((s) => s.key)).toContain(m.chosen.setting);
      expect(m.scores).toHaveLength(TUNE_SETTINGS.length * 2);
      expect(m.agree).toBeLessThanOrEqual(m.people);
    }
    expect(t.deltas.map((d) => d.predictor)).toEqual([CLEF, CLEF]);
    expect(t.production.map((p) => p.t)).toEqual([4, 4]);
    expect(typeof t.productionBetter).toBe('boolean');
    // One challenger: the family-wise tail is the rule's own 5%.
    expect(t.familyWise.map((x) => [x.predictor, x.tail])).toEqual([[CLEF, 0.05]]);
    expect(t.verdict.challengers.map((c) => c.outcome)).toEqual(['insufficient']);
    expect(md).toContain('## E8 verdict, every model asked as E8 asked it');
    expect(md).toContain('## E8b: each model at its best');
    expect(md).toContain('### E8b verdict: insufficient data; keep Jev');
    expect(md).toContain('### Every setting, served');
    expect(md).toContain('Family-wise served intervals');
  }, 240_000);
});

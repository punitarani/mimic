import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DecisionProvider,
  type DecisionRequest,
  Gateway,
  type PersonState,
  scorePrediction,
} from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  analyzeCurves,
  aulcRecords,
  CURVES_RULE,
  type CurveRecord,
  calibrateCells,
  firstReach,
} from '../src/curves/analyze';
import { buildPolicies, runCurves, targetInstances, walk } from '../src/curves/command';
import { halfOf, loadPeople, mimicIdOf, roleOf, stateAfter, type TwinPerson } from '../src/curves/data';
import { JevOracle, POLICY_DEFAULTS, POLICY_NAMES } from '../src/curves/policies';
import { PersonaPosterior, Population, staticSequence } from '../src/curves/population';
import { CachingGateway } from '../src/decision-cache';
import { FakeDecisions, FakeLlm } from '../src/fakes';
import { openLocalEngine } from '../src/local';
import { type EvalRecord, Meter, predictorFor, resolveCandidate } from '../src/optimize/evaluate';
import { loadInstances } from '../src/optimize/instances';
import { renderReport } from '../src/report';
import { importTwin } from '../src/twin';

// ---------------------------------------------------------------------------------------------------------------
// A synthetic wave_split file: four pool blocks, wave 4 items (one planted duplicate of a pool question), retests.
// ---------------------------------------------------------------------------------------------------------------

const mc = (qid: string, text: string, options: string[], pos: number) => ({
  QuestionID: qid,
  QuestionText: text,
  QuestionType: 'MC',
  Options: options,
  Settings: { Selector: 'SAVR' },
  Answers: { SelectedByPosition: pos, SelectedText: options[pos - 1] },
});
const matrix = (qid: string, text: string, rows: string[], cols: string[], pos: number[]) => ({
  QuestionID: qid,
  QuestionText: text,
  QuestionType: 'Matrix',
  Rows: rows,
  Columns: cols,
  Answers: { SelectedByPosition: pos },
});
const block = (name: string, questions: unknown[]) => ({
  ElementType: 'Block',
  BlockName: `${name} `,
  Questions: questions,
});
const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

/** A person whose answers follow one latent trait `z` in {0, 1}, so items carry information about each other. */
function line(pid: number, flip = false) {
  const z = pid % 2;
  const pick = (a: number, b: number) => (z ? a : b);
  const persona = [
    block('Demographics', [
      mc(
        'QID11',
        'In general, would you describe your political views as',
        ['Liberal', 'Moderate', 'Conservative'],
        pick(1, 3),
      ),
      mc('QID12', 'Do you own a car?', ['Yes', 'No'], 1 + (pid % 3 === 0 ? 1 : 0)),
    ]),
    block('Personality', [
      matrix(
        'QID25',
        'How well does this describe you?',
        ['I am talkative', 'I worry a lot', 'I am original'],
        LIKERT,
        [pick(5, 1), 2, pick(4, 2)],
      ),
    ]),
    block('Cognitive tests', [mc('QID40', 'Which comes next: 2, 4, 8, …?', ['10', '16', '12'], 2)]),
    block('Economic preferences', [
      mc(
        'QID50',
        'Would you take a 50% chance of $10 over $4 for sure?',
        ['Take the chance', 'Take the $4'],
        pick(1, 2),
      ),
      // A planted duplicate of a wave 4 question: it must never enter the pool.
      mc('QID51', 'Would you buy this jacket for $40?', ['Yes', 'No'], pick(1, 2)),
    ]),
  ];
  const w4 = (retest: boolean) => [
    block('Product Preferences - Pricing', [
      mc('QID9_1', `Would you buy brand ${pid % 5} for $3?`, ['Yes', 'No'], pick(1, 2)),
      mc('QID9_2', 'Would you buy store brand cereal for $2?', ['Yes', 'No'], pick(2, 1)),
    ]),
    block('Absolute vs. relative - jacket', [
      mc(
        'QID184',
        'Would you buy this jacket for $40?',
        ['Yes', 'No'],
        pick(1, 2) === 1 ? (flip ? 2 : 1) : 2,
      ),
    ]),
    block('False consensus', [
      matrix('QID287', 'Do you support these policies?', ['Policy A', 'Policy B'], LIKERT, [
        retest ? pick(4, 2) : pick(5, 1),
        3,
      ]),
    ]),
  ];
  return {
    pid,
    wave1_3_persona_json: JSON.stringify(persona),
    wave4_Q_wave4_A: JSON.stringify(w4(false)),
    wave4_Q_wave1_3_A: JSON.stringify(w4(true)),
  };
}

function fixture(n = 60, transform: (l: ReturnType<typeof line>) => unknown = (l) => l): string {
  const dir = mkdtempSync(join(tmpdir(), 'e9-'));
  const path = join(dir, 'wave_split.jsonl');
  writeFileSync(
    path,
    `${Array.from({ length: n }, (_, i) => JSON.stringify(transform(line(i + 1)))).join('\n')}\n`,
  );
  return path;
}

/** A gateway over fakes that records every request it is asked. */
function recordingGateway(costUsd = 0) {
  const fake = new FakeDecisions();
  const seen: DecisionRequest[] = [];
  const decisions: DecisionProvider = {
    provider: 'fake',
    decide: async (req) => {
      seen.push(req);
      const res = await fake.decide(req);
      return { ...res, usage: { ...res.usage, costUsd } };
    },
  };
  const gateway = new Gateway({
    decisions,
    llm: new FakeLlm(),
    log: { write: async () => {} },
    clock: () => 1,
    newId: () => 'id',
  });
  return { gateway, seen };
}

const jevFor = (gateway: Gateway, meter = new Meter()) =>
  new JevOracle(
    predictorFor(gateway, resolveCandidate({ predictor: 'decision:typesafe/jev-1.13' }), 'test'),
    meter,
  );

describe('E9 data: people, halves and the pool (docs/CURVES.md §3)', () => {
  it('assigns roles and halves by hash, never by file order', () => {
    expect(roleOf('17')).toBe(roleOf('17'));
    const roles = Array.from({ length: 400 }, (_, i) => roleOf(String(i)));
    const share = (r: string) => roles.filter((x) => x === r).length / roles.length;
    expect(share('train')).toBeGreaterThan(0.4);
    expect(share('dev')).toBeGreaterThan(0.2);
    expect(share('test')).toBeGreaterThan(0.12);
    expect(halfOf('QID9_1')).toBe(halfOf('QID9_1'));
  });

  it('never lets a wave 4 question into the pool, and keeps R and T apart', async () => {
    const { people, audit } = await loadPeople(fixture());
    expect(audit.excludedBySignature).toBe(people.length); // QID51, once per person
    for (const p of people) {
      const pool = new Set(p.pool.map((i) => i.key));
      const poolQids = new Set(p.pool.map((i) => i.qid));
      const held = [...p.reference, ...p.targets];
      expect(held.every((h) => !pool.has(h.key) && !poolQids.has(h.qid))).toBe(true);
      expect(p.pool.some((i) => i.qid === 'QID51')).toBe(false);
      const r = new Set(p.reference.map((i) => i.qid));
      expect(p.targets.every((t) => !r.has(t.qid))).toBe(true);
      // A matrix's rows stay in one half.
      expect(
        new Set(held.filter((h) => h.qid === 'QID287').map((h) => halfOf(h.qid))).size,
      ).toBeLessThanOrEqual(1);
      expect(p.pool.map((i) => i.block)).toContain('Personality');
      expect(p.retest.size).toBeGreaterThan(0);
    }
  });

  it('seals each state at k and builds the state E6 and E8 sent for the same survey answers', async () => {
    const path = fixture(8);
    const { people } = await loadPeople(path);
    const p = people[0]!;
    for (const k of [0, 1, 3]) {
      const s = stateAfter(p.pid, p.pool.slice(0, k));
      expect(s.evidence).toHaveLength(k);
      expect(s.meta.evidenceSeqMax).toBe(k);
      expect(s.evidence.map((e) => e.q)).toEqual(p.pool.slice(0, k).map((i) => i.prompt));
    }
    // The importer's path: the same person's first 3 survey answers.
    const engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'e9' });
    try {
      await importTwin(engine.deps, { path });
      const inst = await loadInstances(engine.deps, {
        k: 3,
        split: 'all',
        seed: 's',
        maxTargetsPerPerson: 100,
      });
      const theirs = inst.filter((i) => i.mode === 'heldout').map((i) => i.state.meta.stateHash);
      const ours = people.map((q) => stateAfter(q.pid, q.pool.slice(0, 3)).meta.stateHash);
      // The planted duplicate sits after the first three answers, so every person's first three match.
      for (const h of ours) expect(theirs).toContain(h);
    } finally {
      engine.close();
    }
  });
});

describe('E9 population: the persona posterior (docs/CURVES.md §4)', () => {
  it('computes expected information in closed form, as brute-force enumeration does', async () => {
    const { people } = await loadPeople(fixture(40));
    const train = people.filter((p) => p.role === 'train');
    const pop = new Population(train, { eps: 0.2, scaleSigma: 0.6 });
    const post = new PersonaPosterior(pop);
    post.observe('twin2k/w13/QID12', 0);
    const w = post.weights();
    const c = pop.item('twin2k/w13/QID50')!;
    const r = pop.item('twin2k/w13/QID25/1')!;
    // Enumerate the joint of (candidate answer, reference answer) over train people.
    const joint = new Float64Array(c.k * r.k);
    for (let j = 0; j < pop.n; j++) {
      for (let v = 0; v < c.k; v++)
        for (let u = 0; u < r.k; u++) {
          const ec = c.codes[j]! < 0 ? 1 / c.k : c.emission[c.codes[j]! * c.k + v]!;
          const er = r.codes[j]! < 0 ? 1 / r.k : r.emission[r.codes[j]! * r.k + u]!;
          joint[v * r.k + u]! += w[j]! * ec * er;
        }
    }
    let mi = 0;
    for (let v = 0; v < c.k; v++)
      for (let u = 0; u < r.k; u++) {
        const pv = Array.from({ length: r.k }, (_, x) => joint[v * r.k + x]!).reduce((a, b) => a + b, 0);
        const pu = Array.from({ length: c.k }, (_, x) => joint[x * r.k + u]!).reduce((a, b) => a + b, 0);
        const x = joint[v * r.k + u]!;
        if (x > 0) mi += x * Math.log(x / (pv * pu));
      }
    expect(post.eig('twin2k/w13/QID50', ['twin2k/w13/QID25/1'], w)).toBeCloseTo(mi, 10);
    expect(mi).toBeGreaterThan(0.05); // both follow the trait
    // An item everyone answers alike carries nothing.
    expect(post.eig('twin2k/w13/QID40', ['twin2k/w13/QID25/1'], w)).toBeCloseTo(0, 10);
  });

  it('builds the static questionnaire from train people only, most informative first', async () => {
    const { people } = await loadPeople(fixture(40));
    const train = people.filter((p) => p.role === 'train');
    const pop = new Population(train);
    const refs = [...new Set(train.flatMap((p) => p.reference.map((r) => r.key)))];
    const seq = staticSequence(pop, train, refs, { steps: 3, probes: 10, seed: 's' });
    expect(seq).toHaveLength(3);
    expect(new Set(seq).size).toBe(3);
    // The constant item is never first.
    expect(seq[0]).not.toBe('twin2k/w13/QID40');
  });
});

describe('E9 policies: what they may read (docs/CURVES.md §4)', () => {
  const run = async (people: TwinPerson[], train: TwinPerson[], name: string, seed = 's') => {
    const { gateway, seen } = recordingGateway();
    const pop = new Population(train);
    const refs = [...new Set(train.flatMap((p) => p.reference.map((r) => r.key)))];
    const seq = staticSequence(pop, train, refs, { steps: 4, probes: 5, seed });
    const [policy] = buildPolicies(
      [name],
      { ...POLICY_DEFAULTS, entropyShortlist: 6, lookaheadShortlist: 2 },
      seed,
      seq,
    );
    const jev = jevFor(gateway);
    const asked = [];
    for (const p of people) asked.push((await walk(p, policy!, 4, { jev, pop, seed })).map((i) => i.key));
    return { asked, seen };
  };

  it('never asks or shows a target, and no answer to R or T changes what is asked', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role !== 'train').slice(0, 3);
    const train = all.filter((p) => p.role === 'train');
    // The same people with every R and T answer flipped.
    const flipped = dev.map((p) => ({
      ...p,
      reference: p.reference.map((r) => ({ ...r, answer: r.options[r.options.length - 1]!.key })),
      targets: p.targets.map((t) => ({ ...t, answer: t.options[t.options.length - 1]!.key })),
    }));
    for (const name of POLICY_NAMES) {
      const a = await run(dev, train, name);
      const b = await run(flipped, train, name);
      expect(b.asked, name).toEqual(a.asked);
      const targetPrompts = new Set(dev.flatMap((p) => p.targets.map((t) => t.prompt)));
      for (const req of a.seen) {
        const state = req.state as PersonState;
        expect(
          state.evidence.every((e) => !targetPrompts.has(e.q)),
          name,
        ).toBe(true);
        const asked = Object.values(req.questions).map((q) => q.instructions);
        expect(
          asked.every((q) => ![...targetPrompts].some((t) => q.includes(t))),
          name,
        ).toBe(true);
      }
      for (const keys of a.asked) {
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.every((k) => k.startsWith('twin2k/w13/'))).toBe(true);
      }
    }
  });

  it('is deterministic for a seed, and random policies move with it', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role !== 'train').slice(0, 3);
    const train = all.filter((p) => p.role === 'train');
    expect((await run(dev, train, 'random', 'a')).asked).toEqual(
      (await run(dev, train, 'random', 'a')).asked,
    );
    expect((await run(dev, train, 'random', 'a')).asked).not.toEqual(
      (await run(dev, train, 'random', 'b')).asked,
    );
    expect((await run(dev, train, 'order')).asked[0]).toEqual(dev[0]!.pool.slice(0, 4).map((i) => i.key));
  });
});

describe('E9 request cache (ADR-0071)', () => {
  it('answers a repeated request from disk at no cost, and never keeps a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e9-cache-'));
    let calls = 0;
    let fail = false;
    const fake = new FakeDecisions();
    const decisions: DecisionProvider = {
      provider: 'fake',
      decide: async (req) => {
        calls++;
        if (fail) throw new Error('boom');
        const res = await fake.decide(req);
        return { ...res, usage: { ...res.usage, costUsd: 0.5 } };
      },
    };
    const deps = {
      decisions,
      llm: new FakeLlm(),
      log: { write: async () => {} },
      clock: () => 1,
      newId: () => 'id',
    };
    const g = new CachingGateway(deps, { dir });
    const req: DecisionRequest = {
      model: 'typesafe/jev-1.13',
      state: { identity: { name: 'P' }, evidence: [] },
      questions: { q_a: { type: 'noul', instructions: 'Yes?', criteria: { true: 'Yes', false: 'No' } } },
    };
    const first = await g.decide({ purpose: 't' }, req);
    expect(first.usage.costUsd).toBe(0.5);
    // Key order doesn't matter: the key is the canonical JSON.
    const second = await g.decide(
      { purpose: 't' },
      { questions: req.questions, state: req.state, model: req.model },
    );
    expect(second.answers).toEqual(first.answers);
    expect(second.usage.costUsd).toBe(0);
    expect(calls).toBe(1);
    expect(g.stats).toMatchObject({ hits: 1, misses: 1, savedUsd: 0.5 });
    // A torn file is a miss, then rewritten.
    const sub = readdirSync(dir)[0]!;
    const file = readdirSync(join(dir, sub))[0]!;
    writeFileSync(join(dir, sub, file), '{"torn":');
    await g.decide({ purpose: 't' }, req);
    expect(calls).toBe(2);
    // A failure is thrown and not kept.
    fail = true;
    const other = { ...req, state: { identity: { name: 'Q' }, evidence: [] } };
    await expect(g.decide({ purpose: 't' }, other)).rejects.toThrow('boom');
    fail = false;
    await g.decide({ purpose: 't' }, other);
    expect(calls).toBe(4);
  });
});

describe('E9 analysis (docs/CURVES.md §5)', () => {
  const rec = (person: string, k: number, key: string, p: number, correct: boolean): EvalRecord => {
    const dist = { a: p, b: 1 - p };
    const answer = correct ? 'a' : 'b';
    const s = scorePrediction('choice', dist, answer);
    return {
      candidate: 'c',
      predictorId: 'p',
      instanceId: `${person}|${k}|${key}`,
      mimicId: person,
      split: 'dev',
      type: 'choice',
      stateHash: `${person}${k}`,
      evidenceSeqMax: k,
      stateTokens: 1,
      modelSnapshot: 'snap',
      ok: true,
      error: null,
      transient: false,
      dist,
      answer,
      ...s,
      confidence: Math.max(p, 1 - p),
      baselineItemAcc: null,
      value: -s.logLoss,
      costUsd: 0,
      latencyMs: 1,
      feedback: '',
    };
  };

  it('calibrates each (policy, k) cell on its own', () => {
    const people = ['m0', 'm1', 'm2', 'm3'];
    const records: CurveRecord[] = [];
    for (const m of people)
      for (let i = 0; i < 20; i++) {
        // `over` says 0.95 and is right 60% of the time; `under` says 0.55 and is right 90% of the time.
        records.push({ policy: 'over', k: 10, block: 'x', rec: rec(m, 10, `t${i}`, 0.95, i % 10 < 6) });
        records.push({ policy: 'under', k: 10, block: 'x', rec: rec(m, 10, `t${i}`, 0.55, i % 10 < 9) });
      }
    const { t } = calibrateCells(records);
    expect(t.get('over|10')!).toBeGreaterThan(1);
    expect(t.get('under|10')!).toBeLessThan(1);
  });

  it('averages each target over the AULC checkpoints, and finds where a curve reaches a level', () => {
    const records: CurveRecord[] = [3, 6].flatMap((k) =>
      ['m0', 'm1'].map((m) => ({
        policy: 'p',
        k,
        block: 'x',
        rec: rec(m, k, 't', k === 3 ? 0.6 : 0.8, true),
      })),
    );
    const a = aulcRecords(records, 'p', [3, 6]);
    expect(a).toHaveLength(2);
    expect(a[0]!.logLoss).toBeCloseTo((-Math.log(0.6) - Math.log(0.8)) / 2, 10);
    expect(
      firstReach(
        [
          [0, 0.5],
          [10, 0.6],
          [20, 0.7],
        ],
        0.65,
      ),
    ).toBeCloseTo(15, 10);
    expect(
      firstReach(
        [
          [0, 0.5],
          [10, 0.6],
        ],
        0.9,
      ),
    ).toBeNull();
    expect(
      firstReach(
        [
          [3, 0.8],
          [6, 0.9],
        ],
        0.5,
      ),
    ).toBe(3);
  });

  it('runs end to end offline, pairs every policy on the same people, and renders', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role === 'dev').slice(0, 4);
    const train = all.filter((p) => p.role === 'train');
    const { gateway } = recordingGateway();
    const checkpoints = [0, 1, 3];
    const res = await runCurves(
      { gateway, meter: new Meter() },
      {
        people: dev,
        train,
        policies: [...POLICY_NAMES],
        checkpoints,
        knobs: { ...POLICY_DEFAULTS, entropyShortlist: 6, lookaheadShortlist: 2, staticProbes: 5 },
        seed: 's',
        concurrency: 2,
        chunkPeople: 2,
      },
    );
    const targets = dev.reduce((a, p) => a + p.targets.length, 0);
    expect(res.records).toHaveLength(POLICY_NAMES.length * checkpoints.length * targets);
    // k = 0 is the same state for everyone and every policy.
    const zero = res.records.filter((r) => r.k === 0);
    expect(new Set(zero.map((r) => r.rec.stateHash)).size).toBe(1);
    const report = analyzeCurves({
      role: 'dev',
      records: res.records,
      policies: [...POLICY_NAMES],
      checkpoints,
      consistency: new Map(dev.map((p) => [mimicIdOf(p.pid), 0.8])),
      costs: res.costs,
      trajectories: new Map(
        [...res.trajectories].map(([k, m]) => [k, new Map([...m].map(([p, xs]) => [p, xs]))]),
      ),
      audit: {},
      costUsd: 0,
      cache: { hits: 0, misses: 0, savedUsd: 0 },
      stopReason: null,
      knobs: {},
      offline: true,
      seed: 's',
    });
    expect(report.verdicts.every((v) => v.outcome === 'insufficient')).toBe(true); // 4 people < 30
    expect(report.points.filter((p) => p.k === 3)).toHaveLength(POLICY_NAMES.length);
    const md = renderReport({
      id: 'r',
      name: 'E9 test',
      spec: { kind: 'curves', seed: 's' },
      datasetHash: 'd',
      status: 'done',
      metrics: { report },
      r2ReportKey: null,
      createdAt: 0,
    });
    expect(md).toContain('Verdict against `random`');
    expect(md).toContain('Learning curves');
    expect(md).toContain('Offline fakes: not a result');
    expect(CURVES_RULE.reference).toBe('random');
  }, 60_000);

  it('drops a chunk the cap cuts for every policy, and resumes from the cache for free', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role === 'dev').slice(0, 4);
    const { gateway } = recordingGateway(0.01);
    const dir = mkdtempSync(join(tmpdir(), 'e9-stop-'));
    const cached = new CachingGateway(gateway.deps, { dir });
    const opts = {
      people: dev,
      train: [],
      policies: ['order', 'random'],
      checkpoints: [0, 2],
      knobs: POLICY_DEFAULTS,
      seed: 's',
      concurrency: 1,
      chunkPeople: 2,
    };
    const stopped = await runCurves({ gateway: cached, meter: new Meter(0.02) }, opts);
    expect(stopped.stopReason).toBeTruthy();
    // Whatever was kept is whole: every policy on the same people.
    const by = (p: string) =>
      new Set(stopped.records.filter((r) => r.policy === p).map((r) => r.rec.mimicId));
    expect([...by('order')]).toEqual([...by('random')]);
    // Once everything has been asked, a rerun costs nothing.
    const meter = new Meter();
    await runCurves({ gateway: cached, meter: new Meter() }, opts);
    await runCurves({ gateway: cached, meter }, opts);
    expect(meter.usd).toBe(0);
  });

  it('scores the targets from the sealed state at k, with the person’s retest beside each', async () => {
    const { people } = await loadPeople(fixture(10));
    const p = people[0]!;
    const inst = targetInstances(p, p.pool, 2);
    expect(inst).toHaveLength(p.targets.length);
    expect(inst.every((i) => i.state.evidence.length === 2)).toBe(true);
    expect(inst.every((i) => i.id.startsWith(`${mimicIdOf(p.pid)}|2|`))).toBe(true);
    expect(inst.some((i) => i.repeatAgreement !== null)).toBe(true);
  });
});

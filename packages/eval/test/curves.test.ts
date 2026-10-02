import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HashEmbedder } from '@mimic/adapters';
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
  interpolate,
  stoppingRows,
} from '../src/curves/analyze';
import { ClassPosterior, classKeys, fitClasses } from '../src/curves/classes';
import {
  buildPolicies,
  populationReader,
  runCurves,
  splitSpecs,
  targetInstances,
  walk,
} from '../src/curves/command';
import {
  halfOf,
  loadPeople,
  mimicIdOf,
  roleOf,
  stateAfter,
  stateOf,
  type TwinPerson,
  withGiven,
  withoutItems,
} from '../src/curves/data';
import { embedTexts, textOf } from '../src/curves/embeddings';
import {
  anchorOrder,
  JevOracle,
  POLICY_DEFAULTS,
  POLICY_NAMES,
  parsePolicySpec,
  referenceSample,
  TWIN_ANCHORS,
} from '../src/curves/policies';
import { identityGain, PersonaPosterior, Population, staticSequence } from '../src/curves/population';
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
    embedder: new HashEmbedder(),
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

  it('computes information about the person (ref=id) as enumeration over train people does', async () => {
    const { people } = await loadPeople(fixture(40));
    const train = people.filter((p) => p.role === 'train');
    const pop = new Population(train, { eps: 0.2, scaleSigma: 0.6 });
    const post = new PersonaPosterior(pop, undefined, 0.5);
    post.observe('twin2k/w13/QID11', 0);
    const w = post.weights();
    for (const key of ['twin2k/w13/QID50', 'twin2k/w13/QID25/1', 'twin2k/w13/QID40']) {
      const c = pop.item(key)!;
      // I(A; J) = Σ_j w_j Σ_a E_j(a) log(E_j(a) / p(a)).
      const row = (j: number) =>
        Array.from({ length: c.k }, (_, v) =>
          c.codes[j]! < 0 ? 1 / c.k : c.emission[c.codes[j]! * c.k + v]!,
        );
      const p = new Array<number>(c.k).fill(0);
      for (let j = 0; j < pop.n; j++)
        row(j).forEach((x, v) => {
          p[v]! += w[j]! * x;
        });
      let mi = 0;
      for (let j = 0; j < pop.n; j++)
        row(j).forEach((x, v) => {
          if (w[j]! > 0 && x > 0) mi += w[j]! * x * Math.log(x / p[v]!);
        });
      expect(identityGain(post, pop, key, w)).toBeCloseTo(mi, 10);
    }
    // Everyone answers the sequence item alike: it says nothing about who they are.
    expect(identityGain(post, pop, 'twin2k/w13/QID40', w)).toBeLessThan(0.02);
    expect(parsePolicySpec('pop-eig[ref=id]').knobs.reference).toBe('id');
    expect(() => referenceSample(people[0]!, { ...POLICY_DEFAULTS, reference: 'id' }, 's')).toThrow(/ref=id/);
  });

  it('fits latent classes that recover the planted trait, with closed forms equal to enumeration', async () => {
    const { people } = await loadPeople(fixture(60));
    const train = people.filter((p) => p.role === 'train');
    const pop = new Population(train);
    const keys = classKeys(train);
    expect(keys.some((k) => train[0]!.targets.some((t) => t.key === k))).toBe(false);
    const one = fitClasses(pop, keys, { k: 1, seed: 's' });
    const two = fitClasses(pop, keys, { k: 2, seed: 's' });
    expect(two.logLik).toBeGreaterThan(one.logLik + 0.5);
    expect(fitClasses(pop, keys, { k: 2, seed: 's' })).toEqual(two);
    // One answer on the trait moves the other trait items, as the planted latent does.
    const post = new ClassPosterior(two);
    const before = post.predictive('twin2k/w13/QID50')!;
    post.observe('twin2k/w13/QID11', 0);
    const after = post.predictive('twin2k/w13/QID50')!;
    expect(Math.abs(after[0]! - before[0]!)).toBeGreaterThan(0.3);
    // Closed forms against enumeration over classes.
    const w = post.weights();
    const ci = two.keys.indexOf('twin2k/w13/QID25/1');
    const ri = two.keys.indexOf('twin2k/w13/QID50');
    const kc = two.options[ci]!;
    const kr = two.options[ri]!;
    const joint = Array.from({ length: kc }, (_, v) =>
      Array.from({ length: kr }, (_, u) =>
        w.reduce((a, wc, c) => a + wc * two.theta[c]![ci]![v]! * two.theta[c]![ri]![u]!, 0),
      ),
    );
    let mi = 0;
    for (const row of joint) {
      row.forEach((x, u) => {
        const pv = row.reduce((a, b) => a + b, 0);
        const pu = joint.reduce((a, r) => a + r[u]!, 0);
        if (x > 0) mi += x * Math.log(x / (pv * pu));
      });
    }
    expect(post.eig('twin2k/w13/QID25/1', ['twin2k/w13/QID50'], w)).toBeCloseTo(mi, 10);
    const pc = post.predictive('twin2k/w13/QID25/1', w)!;
    let id = 0;
    w.forEach((wc, c) => {
      two.theta[c]![ci]!.forEach((x, v) => {
        if (x > 0) id += wc * x * Math.log(x / pc[v]!);
      });
    });
    expect(post.identity('twin2k/w13/QID25/1', w)).toBeCloseTo(id, 10);
    expect(parsePolicySpec('pop-eig[cls=16]').knobs.classes).toBe(16);
    expect(() => buildPolicies(['random[cls=2]'], POLICY_DEFAULTS, 's', null, () => two)).toThrow(/cls/);
  });

  it('tempers the likelihood: below 1 the weights spread over more train people', async () => {
    const { people } = await loadPeople(fixture(60));
    const train = people.filter((p) => p.role === 'train');
    const pop = new Population(train);
    const spread = (beta: number) => {
      const post = new PersonaPosterior(pop, undefined, beta);
      for (const key of ['twin2k/w13/QID11', 'twin2k/w13/QID50', 'twin2k/w13/QID25/1']) post.observe(key, 0);
      const w = post.weights();
      return -[...w].reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0);
    };
    expect(spread(0.3)).toBeGreaterThan(spread(1));
    expect(parsePolicySpec('pop-eig[beta=0.3]').knobs.beta).toBe(0.3);
    const [p] = buildPolicies(['pop-eig[beta=0.3]'], POLICY_DEFAULTS, 's', null);
    expect(p!.beta).toBe(0.3);
  });

  it('asks the pool question closest in meaning to the reference first, then avoids repeating itself', async () => {
    const all = (await loadPeople(fixture(20))).people;
    const p = all[0]!;
    const { gateway } = recordingGateway();
    const vectors = await embedTexts(gateway, [...p.pool, ...p.reference].map(textOf), {
      dir: mkdtempSync(join(tmpdir(), 'e9-emb-')),
      meter: new Meter(),
    });
    // The fixture plants a pool question that repeats a reference one word for word before it is dropped; here a
    // reference question is copied into the pool to check the policy finds its twin.
    const twin = { ...p.reference[0]!, key: 'twin2k/w13/QIDX', qid: 'QIDX', block: 'Economic preferences' };
    const person = { ...p, pool: [...p.pool, twin] };
    const all2 = await embedTexts(gateway, [textOf(twin)], {
      dir: mkdtempSync(join(tmpdir(), 'e9-emb-')),
      meter: new Meter(),
    });
    const vs = new Map([...vectors, ...all2]);
    const [policy] = buildPolicies(['sem-ref'], POLICY_DEFAULTS, 's', null);
    const asked = await walk(person, policy!, 2, { jev: jevFor(gateway), pop: null, seed: 's', vectors: vs });
    expect(asked[0]!.key).toBe('twin2k/w13/QIDX');
    expect(asked[1]!.key).not.toBe(asked[0]!.key);
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

describe('E9 given answers: what Mimic knows before the first question (docs/CURVES.md §4)', () => {
  it('moves a block out of the pool into every state and the posterior, never into k', async () => {
    const { people } = await loadPeople(fixture(40));
    const given = withGiven(people, 'Demographics,-QID12');
    const p = given.find((x) => x.role === 'dev')!;
    expect(p.given.map((i) => i.qid)).toEqual(['QID11']);
    expect(p.pool.some((i) => i.block === 'Demographics' && i.qid === 'QID11')).toBe(false);
    expect(p.pool.some((i) => i.qid === 'QID12')).toBe(true);
    // At k = 0 the state already holds the given answer, as its first piece of evidence.
    const at0 = stateOf(p, []);
    expect(JSON.stringify(at0)).toContain(p.given[0]!.prompt);
    expect(stateOf(p, [p.pool[0]!])).toEqual(stateAfter(p.pid, [...p.given, p.pool[0]!]));
    // The posterior and the reader condition on it: the same walk reads the targets differently.
    const train = given.filter((x) => x.role === 'train');
    const pop = new Population(train);
    const bare = { ...p, given: [] };
    const [policy] = buildPolicies(['pop-eig'], POLICY_DEFAULTS, 's', null);
    const { gateway } = recordingGateway();
    const asked = await walk(p, policy!, 2, { jev: jevFor(gateway), pop, seed: 's' });
    expect(asked.every((i) => p.pool.includes(i))).toBe(true);
    const withIt = populationReader(pop, p, asked, [0], 'pop-eig', 0.5);
    const without = populationReader(pop, bare, asked, [0], 'pop-eig', 0.5);
    expect(withIt.map((r) => r.rec.instanceId)).toEqual(without.map((r) => r.rec.instanceId));
    expect(withIt.map((r) => r.rec.logLoss)).not.toEqual(without.map((r) => r.rec.logLoss));
    // Train people keep the given items in the population statistics.
    expect(pop.has(p.given[0]!.key)).toBe(true);
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
      (k) => fitClasses(pop, classKeys(train), { k, seed }),
    );
    const jev = jevFor(gateway);
    const vectors = await embedTexts(
      gateway,
      people.flatMap((p) => [...p.pool, ...p.reference].map(textOf)),
      {
        dir: mkdtempSync(join(tmpdir(), 'e9-emb-')),
        meter: new Meter(),
      },
    );
    const asked = [];
    for (const p of people)
      asked.push((await walk(p, policy!, 4, { jev, pop, seed, vectors })).map((i) => i.key));
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
    for (const name of [...POLICY_NAMES, 'pop-eig[cls=2]', 'anchors-pop-eig[ref=id]']) {
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

  it('stops each person where the policy’s score drops, and compares with a fixed length of the same mean', () => {
    const at = (m: string, k: number, acc: number): CurveRecord => ({
      policy: 'p',
      k,
      block: 'x',
      rec: { ...rec(m, k, 't', 0.6, true), itemAcc: acc },
    });
    // a plateaus after 3 answers, b keeps learning to 6.
    const records = [
      at('a', 0, 0.5),
      at('a', 3, 0.6),
      at('a', 6, 0.6),
      at('b', 0, 0.5),
      at('b', 3, 0.6),
      at('b', 6, 0.8),
    ];
    const scores = new Map([
      ['a', [1, 1, 1, 0.1, 0.1, 0.1]],
      ['b', [1, 1, 1, 1, 1, 1]],
    ]);
    const rows = stoppingRows(records, scores, 'p', [0, 3, 6]);
    const row = rows.find((r) => r.tau > 0.1 && r.tau <= 1)!;
    expect(row.meanQuestions).toBeCloseTo(4.5, 10);
    expect(row.accAtStop).toBeCloseTo(0.7, 10);
    expect(row.accFixed).toBeCloseTo(0.65, 10); // the mean curve, 0.6 at 3 and 0.7 at 6
    expect(
      interpolate(
        [
          [0, 0],
          [10, 1],
        ],
        25,
      ),
    ).toBe(1);
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
    expect(res.reader).toHaveLength(res.records.length);
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

  it('reads the targets from the train people who answered alike, without Jev', async () => {
    const all = (await loadPeople(fixture(60))).people;
    const train = all.filter((p) => p.role === 'train');
    const dev = all.filter((p) => p.role !== 'train');
    const pop = new Population(train);
    const recs = dev.flatMap((p) => populationReader(pop, p, p.pool, [0, 5], 'order'));
    expect(recs).toHaveLength(dev.reduce((a, p) => a + 2 * p.targets.length, 0));
    for (const r of recs) expect(Object.values(r.rec.dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // The fixture's answers follow one trait, so five answers make the trait-driven targets easier to read.
    const acc = (k: number) => {
      const xs = recs
        .filter((r) => r.k === k && r.block === 'Product Preferences - Pricing')
        .map((r) => r.rec.itemAcc);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(acc(5)).toBeGreaterThan(acc(0));
  });

  it('stops at an outage and drops the chunk, instead of scoring failures as uniform', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role === 'dev').slice(0, 4);
    const fake = new FakeDecisions();
    let calls = 0;
    const decisions: DecisionProvider = {
      provider: 'fake',
      decide: async (req) => {
        // The budget runs out after the first chunk's requests.
        if (++calls > 6) throw new Error('HTTP 403: Workspace daily budget exceeded');
        return fake.decide(req);
      },
    };
    const gateway = new Gateway({
      decisions,
      llm: new FakeLlm(),
      log: { write: async () => {} },
      clock: () => 1,
      newId: () => 'id',
    });
    const res = await runCurves(
      { gateway, meter: new Meter() },
      {
        people: dev,
        train: [],
        policies: ['order', 'random'],
        checkpoints: [0, 2],
        knobs: POLICY_DEFAULTS,
        seed: 's',
        concurrency: 1,
        chunkPeople: 2,
      },
    );
    expect(res.stopReason).toMatch(/^outage/);
    expect(res.records.every((r) => r.rec.ok)).toBe(true);
    const people = new Set(res.records.map((r) => r.rec.mimicId));
    expect(people.size).toBeLessThan(dev.length);
  });

  it('scores with the population reader alone under --no-jev, with no model calls', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role === 'dev').slice(0, 3);
    const train = all.filter((p) => p.role === 'train');
    const { gateway, seen } = recordingGateway();
    const res = await runCurves(
      { gateway, meter: new Meter() },
      {
        people: dev,
        train,
        policies: ['random', 'pop-eig'],
        checkpoints: [0, 2],
        knobs: POLICY_DEFAULTS,
        seed: 's',
        concurrency: 1,
        chunkPeople: 3,
        noJev: true,
      },
    );
    expect(seen).toHaveLength(0);
    expect(res.records.length).toBeGreaterThan(0);
    expect(res.records.every((r) => r.rec.modelSnapshot === 'population')).toBe(true);
    expect(res.stopReason).toBeNull();
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

describe('E9 policy specs: variants and opening blocks (docs/CURVES.md §7)', () => {
  it('parses a spec, its knobs and its opening block, and refuses anything else', () => {
    expect(parsePolicySpec('jev-eig')).toMatchObject({ base: 'jev-eig', open: 0, knobs: {} });
    expect(parsePolicySpec('open10-pop-eig[ref=pool,tsel=1,short=8]')).toMatchObject({
      base: 'pop-eig',
      open: 10,
      knobs: { reference: 'pool', tSel: 1, lookaheadShortlist: 8 },
    });
    expect(parsePolicySpec('anchors-random')).toMatchObject({ base: 'random', open: 8, opening: 'anchors' });
    expect(parsePolicySpec('anchors4-pop-eig')).toMatchObject({
      base: 'pop-eig',
      open: 4,
      opening: 'anchors',
    });
    expect(() => parsePolicySpec('open-pop-eig')).toThrow(/unknown policy/);
    expect(() => parsePolicySpec('greedy')).toThrow(/unknown policy/);
    expect(() => parsePolicySpec('jev-eig[depth=2]')).toThrow(/unknown knob/);
    expect(() => parsePolicySpec('jev-eig[ref=T]')).toThrow(/R, pool or id/);
    expect(splitSpecs('random,jev-eig[ref=pool,tsel=1], open5-pop-eig')).toEqual([
      'random',
      'jev-eig[ref=pool,tsel=1]',
      'open5-pop-eig',
    ]);
  });

  it('opens with production’s anchors in a per-person order, skipping any the pool lacks, then hands over', async () => {
    const p = (await loadPeople(fixture(20))).people[0]!;
    // Plant three of the anchors' Twin counterparts in the pool (the fixture has none).
    const planted = TWIN_ANCHORS.slice(0, 3).map((key, i) => ({ ...p.pool[0]!, key, qid: `A${i}` }));
    const person = { ...p, pool: [...p.pool, ...planted] };
    const [policy] = buildPolicies(['anchors-order'], POLICY_DEFAULTS, 's', null);
    const { gateway } = recordingGateway();
    const asked = await walk(person, policy!, 5, { jev: jevFor(gateway), pop: null, seed: 's' });
    const order = anchorOrder('s')(p.pid).filter((k) => planted.some((x) => x.key === k));
    expect(asked.slice(0, 3).map((i) => i.key)).toEqual(order);
    // Then survey order, from the top.
    expect(asked[3]!.key).toBe(person.pool[0]!.key);
    // Another person sees another order.
    const orders = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((pid) => anchorOrder('s')(pid).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('drops items from the pool by block or QID, keeping what a minus sign names', async () => {
    const { people } = await loadPeople(fixture(10));
    const dropped = withoutItems(people, 'QID11,Economic preferences,-QID50');
    for (const p of dropped) {
      expect(p.pool.some((i) => i.qid === 'QID11')).toBe(false);
      expect(p.pool.some((i) => i.qid === 'QID50')).toBe(true);
      expect(p.pool.some((i) => i.block === 'Economic preferences' && i.qid !== 'QID50')).toBe(false);
      expect(p.given).toEqual([]);
    }
  });

  it('opens with the static questionnaire, then hands over, and records each step’s score', async () => {
    const all = (await loadPeople(fixture(40))).people;
    const dev = all.filter((p) => p.role !== 'train').slice(0, 2);
    const train = all.filter((p) => p.role === 'train');
    const pop = new Population(train);
    const refs = [...new Set(train.flatMap((p) => p.reference.map((r) => r.key)))];
    const seq = staticSequence(pop, train, refs, { steps: 4, probes: 5, seed: 's' });
    const [opened, eig] = buildPolicies(['open2-pop-eig', 'pop-eig'], POLICY_DEFAULTS, 's', seq);
    expect(opened!.name).toBe('open2-pop-eig');
    const { gateway } = recordingGateway();
    const jev = jevFor(gateway);
    for (const p of dev) {
      const scores: Array<number | null> = [];
      const asked = await walk(p, opened!, 4, { jev, pop, seed: 's', scores });
      expect(asked.slice(0, 2).map((i) => i.key)).toEqual(seq.slice(0, 2));
      // The opening steps carry no score; the persona posterior's steps do.
      expect(scores.slice(0, 2)).toEqual([null, null]);
      expect(scores.slice(2).every((x) => typeof x === 'number' && x >= 0)).toBe(true);
      const plain: Array<number | null> = [];
      await walk(p, eig!, 2, { jev, pop, seed: 's', scores: plain });
      expect(plain.every((x) => typeof x === 'number')).toBe(true);
    }
  });
});

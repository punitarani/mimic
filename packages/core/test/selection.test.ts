import { describe, expect, it } from 'vitest';
import {
  type BeliefAnswer,
  buildBelief,
  buildState,
  burdenOf,
  computeItemStats,
  EXPOSURE_MIN_ADAPTIVE,
  hypothesisPosterior,
  type ItemStatRecord,
  ONTOLOGY_V1,
  type PersonState,
  type PredictionResult,
  type Predictor,
  populationScore,
  type Question,
  type ScoredItemRow,
  type SelectContext,
  VOI_SELECTOR,
  VoiSelector,
  weightedMutualInformation,
} from '../src';

const facets = ONTOLOGY_V1;
const mix = { core: 0.1, casual: 0.45, professional: 0.45 };

function q(id: string, facetIds: string[], over: Partial<Question> = {}): Question {
  return {
    id,
    mimicId: 'm',
    seq: null,
    kind: 'adaptive',
    type: 'choice',
    domain: 'casual',
    prompt: `Question ${id} about a choice you would make on a normal day?`,
    options: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ],
    facetIds,
    provenance: { generator: 'test', configHash: 'c', promptVersion: 'gen.v2' },
    ...over,
  };
}

const state = (): PersonState =>
  buildState(
    {
      mimicId: 'm',
      identity: { displayName: 'Pat', location: 'Lisbon, PT' },
      facts: [],
      evidence: [],
      traits: [],
      insights: [],
    },
    { beforeSeq: 1, budgetTokens: 8000, strategy: 'raw', retrievalK: 12, recentN: 6 },
  );

/**
 * A predictor whose distribution for a question depends on the hypothesis in the state: hypotheses containing
 * "bold" favour option a on `q_split`, others favour b; every hypothesis agrees on the rest.
 */
function fakePredictor(byId: Record<string, number>): Predictor {
  return {
    id: 'jev:fake',
    async predict(s: PersonState, qs: Question[]): Promise<PredictionResult[]> {
      return qs.map((x) => {
        let pA = byId[x.id] ?? 0.5;
        if (x.id === 'q_split' && s.hypothesis) pA = s.hypothesis.includes('bold') ? 0.9 : 0.1;
        return { dist: { a: pA, b: 1 - pA }, costUsd: 0, latencyMs: 1, modelSnapshot: 'fake', ok: true };
      });
    },
  };
}

function ctx(over: Partial<SelectContext> = {}): SelectContext {
  return {
    pool: [],
    state: state(),
    primary: fakePredictor({}),
    coverage: () => 0,
    redundancy: () => 0,
    rng: () => 0,
    sessionTarget: 30,
    ...over,
  };
}

function answer(seq: number, over: Partial<BeliefAnswer> = {}): BeliefAnswer {
  return {
    seq,
    kind: 'adaptive',
    type: 'choice',
    domain: 'casual',
    facetIds: ['risk_tolerance'],
    answer: 'a',
    latencyMs: 3000,
    ...over,
  };
}

describe('hypothesis posterior (docs/SELECTION.md §6)', () => {
  it('is uniform without observations and refutes hypotheses that gave the answers low probability', () => {
    expect(hypothesisPosterior([], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const w = hypothesisPosterior(
      [
        { index: 0, pAnswer: 0.9 },
        { index: 1, pAnswer: 0.1 },
        { index: 2, pAnswer: 0.5 },
        { index: 0, pAnswer: 0.8 },
        { index: 1, pAnswer: 0.2 },
        { index: 2, pAnswer: 0.5 },
        { index: 7, pAnswer: 1 }, // unknown index: ignored
      ],
      3,
    );
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(w[0]).toBeGreaterThan(w[2]!);
    expect(w[2]).toBeGreaterThan(w[1]!);
    expect(w[0]! / w[1]!).toBeCloseTo((0.9 * 0.8) / (0.1 * 0.2), 9);
    // Floored likelihoods keep a hypothesis alive after one impossible answer.
    expect(hypothesisPosterior([{ index: 0, pAnswer: 0 }], 2)[0]).toBeGreaterThan(0);
  });

  it('weighted mutual information is zero when hypotheses agree or when disagreeing ones have no weight', () => {
    const keys = ['a', 'b'];
    const same = [
      { a: 0.7, b: 0.3 },
      { a: 0.7, b: 0.3 },
    ];
    expect(weightedMutualInformation(same, [0.5, 0.5], keys)).toBeCloseTo(0, 12);
    const differ = [
      { a: 0.9, b: 0.1 },
      { a: 0.1, b: 0.9 },
    ];
    expect(weightedMutualInformation(differ, [0.5, 0.5], keys)).toBeGreaterThan(0.3);
    expect(weightedMutualInformation(differ, [1, 0], keys)).toBeCloseTo(0, 12);
    expect(weightedMutualInformation(differ, [0.5, 0.5], keys)).toBeGreaterThan(
      weightedMutualInformation(differ, [0.9, 0.1], keys),
    );
  });
});

describe('burden (docs/SELECTION.md §4)', () => {
  it('grows with prompt length, session fatigue and streaks of the same type or domain', () => {
    const short = q('s', [], { prompt: 'Coffee or tea?' });
    const long = q('l', [], { prompt: Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ') });
    const early = buildBelief({ facets, answers: [], traits: [], insights: [], repeats: [], domainMix: mix });
    expect(burdenOf(short, early, 30)).toBeLessThan(burdenOf(long, early, 30));
    const late = buildBelief({
      facets,
      answers: Array.from({ length: 30 }, (_, i) => answer(i + 1, { type: 'noul', domain: 'professional' })),
      traits: [],
      insights: [],
      repeats: [],
      domainMix: mix,
    });
    expect(burdenOf(long, late, 30)).toBeGreaterThan(burdenOf(long, early, 30));
    const streaky = q('t', [], { type: 'noul', domain: 'professional', prompt: 'Yes?' });
    const fresh = q('f', [], { type: 'score', domain: 'casual', prompt: 'Yes?' });
    expect(burdenOf(streaky, late, 30)).toBeGreaterThan(burdenOf(fresh, late, 30));
    expect(burdenOf(long, late, 30)).toBeLessThanOrEqual(1);
    expect(burdenOf(short, undefined, 30)).toBeGreaterThanOrEqual(0);
  });
});

describe('VoiSelector', () => {
  const selector = new VoiSelector({ ...VOI_SELECTOR, piPopulation: 0, nuBurden: 0, muRedundancy: 0 });

  it('without hypotheses or belief, prefers the candidate the primary is least sure about', async () => {
    const pool = [q('sure', ['humor']), q('unsure', ['patience'])];
    const sel = await selector.select(ctx({ pool, primary: fakePredictor({ sure: 0.95, unsure: 0.5 }) }));
    expect(sel.question.id).toBe('unsure');
    expect(sel.primary.dist.a).toBeCloseTo(0.5, 12);
    expect(sel.diagnostics).toMatchObject({ poolSize: 2, eligible: 2, k: 0 });
    expect(sel.diagnostics.info).toBeCloseTo(1, 12);
    expect(sel.hypothesisPreds).toBeUndefined();
  });

  it('with hypotheses, picks the question plausible readings of the person disagree on and reports their predictions', async () => {
    const pool = [q('q_split', ['risk_tolerance']), q('q_noisy', ['patience'])];
    const sel = await selector.select(
      ctx({
        pool,
        // The sealed primary is unsure about both; only the hypotheses tell them apart.
        primary: fakePredictor({ q_split: 0.5, q_noisy: 0.5 }),
        hypotheses: ['A bold reading', 'A cautious reading', 'Another bold reading'],
      }),
    );
    expect(sel.question.id).toBe('q_split');
    expect(sel.diagnostics.k).toBe(3);
    expect(sel.diagnostics.info).toBeGreaterThan(0.3);
    expect(sel.hypothesisPreds).toHaveLength(3);
    for (const h of sel.hypothesisPreds!) {
      expect(h.stateHash).not.toBe(sel.primary);
      expect(h.stateHash).toHaveLength(64);
    }
    expect(sel.hypothesisPreds![0]!.result.dist.a).toBeCloseTo(0.9, 12);
    expect(sel.hypothesisPreds![1]!.result.dist.a).toBeCloseTo(0.1, 12);
    // The sealed primary is the plain-state prediction, never a hypothesis one.
    expect(sel.primary.dist.a).toBeCloseTo(0.5, 12);
  });

  it('posterior weights that refute the disagreeing reading remove its information', async () => {
    const pool = [q('q_split', ['risk_tolerance']), q('q_other', ['patience'])];
    const run = (hypothesisWeights: number[]) =>
      selector.select(
        ctx({
          pool,
          primary: fakePredictor({ q_split: 0.7, q_other: 0.5 }),
          hypotheses: ['bold', 'cautious'],
          hypothesisWeights,
        }),
      );
    const open = await run([0.5, 0.5]);
    const settled = await run([0.999, 0.001]);
    expect(open.question.id).toBe('q_split');
    expect(open.diagnostics.info).toBeGreaterThan(0.3);
    expect(settled.diagnostics.info).toBeLessThan(0.05);
    // A question every remaining reading agrees on carries no epistemic value, even at p = ½ (BALD).
    expect(settled.diagnostics.score).toBeLessThan(open.diagnostics.score! - 0.25);
  });

  it('applies exposure control once enough adaptive questions were answered', async () => {
    const answers = Array.from({ length: EXPOSURE_MIN_ADAPTIVE }, (_, i) =>
      answer(i + 1, { facetIds: ['risk_tolerance'] }),
    );
    const belief = buildBelief({ facets, answers, traits: [], insights: [], repeats: [], domainMix: mix });
    expect(belief.facets.risk_tolerance!.exposure).toBe(1);
    const pool = [q('over', ['risk_tolerance']), q('fresh', ['patience'])];
    const primary = fakePredictor({ over: 0.5, fresh: 0.9 }); // the over-exposed one is more uncertain
    const sel = await selector.select(ctx({ pool, primary, belief }));
    expect(sel.question.id).toBe('fresh');
    expect(sel.diagnostics.eligible).toBe(1);
    // With every candidate over the cap, the cap is ignored rather than stalling the session.
    const all = await selector.select(
      ctx({ pool: [pool[0]!, q('over2', ['risk_tolerance'])], primary, belief }),
    );
    expect(all.diagnostics.eligible).toBe(2);
  });

  it('adds the gap, conflict, weakness and population terms from the belief state', async () => {
    const answers = [
      ...[1, 2, 3, 4].map((s) => answer(s, { facetIds: ['humor'], itemAcc: 0 })),
      ...[5, 6, 7, 8].map((s) => answer(s, { facetIds: ['patience'], itemAcc: 1 })),
    ];
    const belief = buildBelief({ facets, answers, traits: [], insights: [], repeats: [], domainMix: mix });
    const pool = [q('weak', ['humor']), q('strong', ['patience'])];
    const primary = fakePredictor({ weak: 0.5, strong: 0.5 });
    const weakFirst = await selector.select(ctx({ pool, primary, belief }));
    expect(weakFirst.question.id).toBe('weak');
    expect(weakFirst.diagnostics.weakness).toBeGreaterThan(0.5);
    // A strong population prior on the other candidate can outweigh it.
    const popSelector = new VoiSelector({ ...VOI_SELECTOR, piPopulation: 2, nuBurden: 0, muRedundancy: 0 });
    const popFirst = await popSelector.select(
      ctx({ pool, primary, belief, population: (x) => (x.id === 'strong' ? 1 : 0) }),
    );
    expect(popFirst.question.id).toBe('strong');
    expect(popFirst.diagnostics.population).toBeCloseTo(0.5, 12);
    // Neutral (unknown) population contributes nothing.
    const neutral = await popSelector.select(ctx({ pool, primary, belief, population: () => null }));
    expect(neutral.diagnostics.population).toBe(0);
  });

  it('falls back to a random pick when every primary prediction failed', async () => {
    const failing: Predictor = {
      id: 'jev:fail',
      async predict(_s, qs) {
        return qs.map(() => ({
          dist: {},
          costUsd: 0,
          latencyMs: 1,
          modelSnapshot: 'x',
          ok: false,
          error: 'x',
        }));
      },
    };
    const sel = await selector.select(ctx({ pool: [q('a', []), q('b', [])], primary: failing }));
    expect(sel.diagnostics.failed).toBe(1);
    expect(sel.primary.ok).toBe(false);
  });
});

describe('population item statistics (docs/SELECTION.md §7)', () => {
  const row = (over: Partial<ScoredItemRow>): ScoredItemRow => ({
    mimicId: 'p1',
    itemKey: 'anchors.v1/risk_gamble',
    facetIds: ['risk_tolerance'],
    domain: 'core',
    type: 'choice',
    answer: 'a',
    nOptions: 2,
    primaryItemAcc: 1,
    primaryLogLoss: 0.1,
    baselineItemAcc: 1,
    latencyMs: 2000,
    ...over,
  });

  it('aggregates by item key and by archetype, with no per-person data', () => {
    const rows = [
      row({ mimicId: 'p1', answer: 'a' }),
      row({ mimicId: 'p2', answer: 'b', baselineItemAcc: 0, primaryItemAcc: 0, primaryLogLoss: 2 }),
      row({ mimicId: 'p3', answer: 'a', baselineItemAcc: 0 }),
      row({ mimicId: 'p1', itemKey: null, domain: 'casual' }),
    ];
    const stats = computeItemStats(rows, 5);
    const item = stats.find((s) => s.key === 'item:anchors.v1/risk_gamble')!;
    expect(item.kind).toBe('item');
    expect(item.nPeople).toBe(3);
    expect(item.nAnswers).toBe(3);
    expect(item.answerEntropy).toBeGreaterThan(0.9); // 2 a, 1 b out of 2 options
    expect(item.baselineError).toBeCloseTo(2 / 3, 12);
    expect(item.primaryError).toBeCloseTo(1 / 3, 12);
    expect(item.lift).toBeCloseTo(1 / 3, 12);
    const arch = stats.find((s) => s.key === 'arch:risk_tolerance|core|choice')!;
    expect(arch.kind).toBe('archetype');
    expect(arch.answerEntropy).toBeNull();
    expect(arch.nAnswers).toBe(3);
    expect(stats.find((s) => s.key === 'arch:risk_tolerance|casual|choice')!.nPeople).toBe(1);
    expect(JSON.stringify(stats)).not.toContain('p1');
    // An item everyone answers the same way carries no information about individuals.
    const same = computeItemStats([row({ mimicId: 'p1' }), row({ mimicId: 'p2' })], 5);
    expect(same[0]!.answerEntropy).toBeCloseTo(0, 12);
  });

  it('shrinks toward neutral and is null below the minimum number of people', () => {
    const stat = (over: Partial<ItemStatRecord>): ItemStatRecord => ({
      key: 'item:k',
      kind: 'item',
      nPeople: 10,
      nAnswers: 10,
      answerEntropy: 1,
      baselineError: 1,
      primaryError: 0.5,
      surprise: 0.5,
      lift: 0,
      meanLatencyMs: 1000,
      updatedAt: 0,
      ...over,
    });
    const stats = new Map<string, ItemStatRecord>([
      ['item:k', stat({})],
      [
        'arch:humor|casual|noul',
        stat({
          key: 'arch:humor|casual|noul',
          kind: 'archetype',
          nAnswers: 40,
          surprise: 0,
          baselineError: 0,
        }),
      ],
    ]);
    const item = populationScore({ itemKey: 'k', facetIds: [], domain: 'core', type: 'choice' }, stats)!;
    expect(item).toBeCloseTo((10 * 1 + 20 * 0.5) / 30, 12); // shrunk toward ½ with prior weight 20
    expect(
      populationScore({ itemKey: 'k', facetIds: [], domain: 'core', type: 'choice' }, stats, {
        minPeople: 11,
      }),
    ).toBeNull();
    const arch = populationScore({ facetIds: ['humor'], domain: 'casual', type: 'noul' }, stats)!;
    expect(arch).toBeCloseTo((40 * 0 + 20 * 0.5) / 60, 12);
    expect(populationScore({ facetIds: ['humor'], domain: 'core', type: 'noul' }, stats)).toBeNull();
    expect(populationScore({ facetIds: ['nope'], domain: 'casual', type: 'noul' }, new Map())).toBeNull();
  });
});

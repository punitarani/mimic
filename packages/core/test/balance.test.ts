import { describe, expect, it } from 'vitest';
import {
  type BeliefAnswer,
  type BeliefInput,
  buildBelief,
  buildState,
  categoryQuota,
  categoryTargets,
  DEFAULT_SCOPE,
  deadlinePressed,
  facetAllowed,
  GROUP_TARGET,
  type MimicScope,
  ONTOLOGY_V2,
  type PersonState,
  type PredictionResult,
  type Predictor,
  type Question,
  rampOpen,
  type SelectContext,
  sweeps,
  touchesSensitive,
  VOI_SELECTOR,
  VOI_SELECTOR_V8,
  VoiSelector,
} from '../src';

/** Category balance, the trust ramp and the sensitive sweep (ADR-0044). */

const ALL: MimicScope = {
  ...DEFAULT_SCOPE,
  consents: { politics: true, religion: true, sexuality: true, health: true, money: true },
  confirmed: { politics: true, religion: true, sexuality: true, health: true },
};
const scoped = (scope: MimicScope) => ONTOLOGY_V2.filter((f) => facetAllowed(scope, f));
const RAMP = VOI_SELECTOR_V8.trustRamp!;
const mix = { core: 0.15, casual: 0.55, professional: 0.3 };

function answer(seq: number, facetIds: string[], over: Partial<BeliefAnswer> = {}): BeliefAnswer {
  return {
    seq,
    kind: 'adaptive',
    type: 'choice',
    domain: 'casual',
    facetIds,
    answer: 'a',
    latencyMs: 3000,
    ...over,
  };
}

function belief(answers: BeliefAnswer[], over: Partial<BeliefInput> = {}) {
  return buildBelief({
    facets: scoped(ALL),
    answers,
    traits: [],
    insights: [],
    repeats: [],
    domainMix: mix,
    ...over,
  });
}

/** `n` answers on psychology facets, as the anchors mostly are. */
const psychology = (n: number) =>
  Array.from({ length: n }, (_, i) => answer(i + 1, [['openness', 'patience', 'extraversion'][i % 3]!]));

function q(id: string, facetIds: string[], over: Partial<Question> = {}): Question {
  return {
    id,
    mimicId: 'm',
    seq: null,
    kind: 'adaptive',
    type: 'choice',
    domain: 'casual',
    prompt: `Your neighbour asks a favour (${id}). What do you do?`,
    options: [
      { key: 'a', label: 'Help' },
      { key: 'b', label: 'Decline' },
    ],
    facetIds,
    provenance: { generator: 'test', configHash: 'c', promptVersion: 'gen.v3' },
    ...over,
  };
}

const flat: Predictor = {
  id: 'jev:flat',
  async predict(_s: PersonState, qs: Question[]): Promise<PredictionResult[]> {
    return qs.map(() => ({
      dist: { a: 0.5, b: 0.5 },
      costUsd: 0,
      latencyMs: 1,
      modelSnapshot: 'x',
      ok: true,
    }));
  },
};

function ctx(pool: Question[], b: ReturnType<typeof belief>): SelectContext {
  return {
    pool,
    state: buildState(
      {
        mimicId: 'm',
        identity: { displayName: 'Pat', location: 'Lisbon, PT' },
        facts: [],
        evidence: [],
        traits: [],
        insights: [],
      },
      { beforeSeq: 1, budgetTokens: 8000, strategy: 'raw', retrievalK: 12, recentN: 6 },
    ),
    primary: flat,
    coverage: () => 0,
    redundancy: () => 0,
    rng: () => 0,
    sessionTarget: 30,
    belief: b,
  };
}

describe('category and group beliefs (ADR-0044)', () => {
  it('shares split a question over its categories and exist only for categories in scope', () => {
    const b = belief([
      answer(1, ['openness']),
      answer(2, ['care_harm', 'social_energy']),
      answer(3, ['leadership_drive']),
      answer(4, ['patience']),
    ]);
    expect(b.categories.psychology!.share).toBeCloseTo(0.5, 12);
    expect(b.categories.values!.share).toBeCloseTo(0.125, 12);
    expect(b.categories.life!.share).toBeCloseTo(0.125, 12);
    expect(b.categories.work!.share).toBeCloseTo(0.25, 12);
    expect(b.categories.psychology!.target).toBe(0.25);
    expect(b.categories.psychology!.shortfall).toBe(0);
    expect(b.categories.values!.shortfall).toBeCloseTo(0.5, 12);
    const noWork = buildBelief({
      facets: scoped({ ...DEFAULT_SCOPE, categories: ['psychology', 'values', 'life'] }),
      answers: [answer(1, ['openness'])],
      traits: [],
      insights: [],
      repeats: [],
      domainMix: mix,
    });
    expect(noWork.categories.work).toBeUndefined();
    expect(noWork.categories.psychology!.target).toBeCloseTo(1 / 3, 12);
  });

  it('a group is untouched until a question reaches it and covered after GROUP_TARGET', () => {
    const b = belief([answer(1, ['care_harm']), answer(2, ['openness']), answer(3, ['extraversion'])]);
    expect(b.groups['Values and morality']!.gap).toBeCloseTo(1 - 1 / GROUP_TARGET, 12);
    expect(b.groups.Personality!.gap).toBe(0);
    expect(b.groups.Money!.gap).toBe(1);
    expect(b.facets.financial_security!.sensitive).toBe('money');
    expect(b.facets.care_harm!.category).toBe('values');
  });
});

describe('category quota and targets (ADR-0044)', () => {
  it('the quota sums to n and favours the categories furthest behind', () => {
    const b = belief(psychology(8));
    for (const n of [1, 5, 8, 12]) {
      const quota = categoryQuota(b, n);
      expect(Object.values(quota).reduce((a, x) => a + x, 0)).toBe(n);
    }
    const q12 = categoryQuota(b, 12);
    expect(q12.psychology).toBeLessThan(q12.values!);
    expect(Object.keys(q12).sort()).toEqual(['life', 'psychology', 'values', 'work']);
  });

  it('never targets a sensitive facet before the ramp opens, counting the anchors still waiting', () => {
    const early = belief(psychology(2));
    const none = categoryTargets(early, scoped(ALL), 8, { ramp: RAMP });
    expect(none.some((t) => ONTOLOGY_V2.find((f) => f.id === t.id)!.sensitive)).toBe(false);
    expect(rampOpen(early, RAMP)).toBe(false);
    // Eight anchors still to come: by the time this batch is served the ramp is open and the sweep has begun.
    const ahead = categoryTargets(early, scoped(ALL), 8, { ramp: RAMP, lookahead: 8 });
    expect(ahead.some((t) => t.reason === 'sweep')).toBe(true);
  });

  it('reaches every untouched group, sweeps sensitive facets by area, and leaves room for the quota', () => {
    const b = belief(psychology(10));
    const targets = categoryTargets(b, scoped(ALL), 8, { ramp: RAMP });
    expect(targets).toHaveLength(8);
    const facet = (id: string) => ONTOLOGY_V2.find((f) => f.id === id)!;
    // Eight groups are untouched (the answers are all Personality and Decisions); six get one target each and a
    // quarter of the targets is left to the category quota.
    const untouched = new Set(
      ONTOLOGY_V2.map((f) => f.group).filter((g) => g !== 'Personality' && g !== 'Decisions'),
    );
    expect(untouched.size).toBe(8);
    const firstSix = targets.slice(0, 6).map((t) => facet(t.id).group);
    expect(new Set(firstSix).size).toBe(6);
    for (const g of firstSix) expect(untouched.has(g)).toBe(true);
    const swept = targets.filter((t) => t.reason === 'sweep');
    expect(swept.length).toBeGreaterThan(0);
    for (const t of swept) expect(facet(t.id).sensitive).toBeTruthy();
    // Sensitive facets already pooled are not swept again.
    const pooledAll = belief(psychology(10), {
      pooled: ONTOLOGY_V2.filter((f) => f.sensitive).map((f) => ({ facetIds: [f.id] })),
    });
    expect(categoryTargets(pooledAll, scoped(ALL), 8, { ramp: RAMP }).some((t) => t.reason === 'sweep')).toBe(
      false,
    );
  });

  it('never targets a category the person turned off', () => {
    const scope: MimicScope = {
      ...ALL,
      categories: ['psychology', 'values', 'life'],
      consents: { politics: true },
      confirmed: { politics: true },
    };
    const facets = scoped(scope);
    const b = buildBelief({
      facets,
      answers: psychology(10),
      traits: [],
      insights: [],
      repeats: [],
      domainMix: mix,
    });
    const targets = categoryTargets(b, facets, 8, { ramp: RAMP });
    for (const t of targets) expect(ONTOLOGY_V2.find((f) => f.id === t.id)!.category).not.toBe('work');
    expect(Object.keys(categoryQuota(b, 12))).not.toContain('work');
  });
});

describe('the balanced, ramped voi selector (ADR-0044)', () => {
  it('without balance or ramp, scores exactly as v4 and reports no new parts', () => {
    const b = belief(psychology(10));
    const v4 = new VoiSelector(VOI_SELECTOR);
    const pool = [q('x', ['care_harm']), q('y', ['openness'])];
    const c = ctx(pool, b);
    const flatPred = { dist: { a: 0.5, b: 0.5 }, costUsd: 0, latencyMs: 1, modelSnapshot: 'x', ok: true };
    const parts = v4.parts(c, pool[0]!, flatPred, [], [], false);
    expect(parts.category).toBeUndefined();
    expect(parts.group).toBeUndefined();
    expect(parts.sweep).toBeUndefined();
    const facetGap = 1;
    const domainGap = b.domains.casual.shortfall;
    expect(parts.gap).toBeCloseTo(0.5 * facetGap + 0.5 * domainGap, 12);
  });

  it('balance pulls toward the category and group furthest behind', async () => {
    const b = belief(psychology(10));
    const v8 = new VoiSelector({ ...VOI_SELECTOR_V8, trustRamp: undefined, piPopulation: 0, nuBurden: 0 });
    const pool = [q('psych', ['self_control']), q('values', ['care_harm'])];
    const sel = await v8.select(ctx(pool, b));
    expect(sel.question.id).toBe('values');
    expect(sel.diagnostics.category).toBeCloseTo(1, 12);
    expect(sel.diagnostics.group).toBe(1);
  });

  it('skips a candidate whose categories are over the cap while another is not', () => {
    const b = belief(psychology(10));
    const v8 = new VoiSelector(VOI_SELECTOR_V8);
    const pool = [q('psych', ['self_control']), q('work', ['leadership_drive'])];
    expect(v8.eligible(ctx(pool, b))).toEqual([false, true]);
    // Unless every candidate is over the cap.
    expect(v8.eligible(ctx([q('p1', ['self_control']), q('p2', ['growth_mindset'])], b))).toEqual([
      true,
      true,
    ]);
  });

  it('while a category is far behind its even share, a candidate in it goes first', () => {
    // Psychology 4, values 3, life 3, work 0 of 10: work is at 0% of its 25%.
    const b = belief([
      ...psychology(4),
      ...[5, 6, 7].map((s) => answer(s, ['care_harm'])),
      ...[8, 9, 10].map((s) => answer(s, ['social_energy'])),
    ]);
    expect(b.categories.work!.shortfall).toBe(1);
    const v8 = new VoiSelector(VOI_SELECTOR_V8);
    expect(
      v8.eligible(ctx([q('values', ['fairness_cheating']), q('work', ['leadership_drive'])], b)),
    ).toEqual([false, true]);
    // Without a work candidate, nothing is held back.
    expect(v8.eligible(ctx([q('values', ['fairness_cheating']), q('life', ['forgiveness'])], b))).toEqual([
      true,
      true,
    ]);
  });

  it('holds sensitive candidates back before the ramp opens, even when they are all there is', async () => {
    const early = belief(psychology(RAMP.minAnswered - 1));
    const v8 = new VoiSelector(VOI_SELECTOR_V8);
    const sensitive = q('pol', ['political_leaning']);
    expect(touchesSensitive(early, sensitive)).toBe(true);
    expect(v8.eligible(ctx([sensitive, q('ok', ['care_harm'])], early))).toEqual([false, true]);
    const sel = await v8.select(ctx([sensitive, q('ok', ['care_harm'])], early));
    expect(sel.question.id).toBe('ok');
    const open = belief(psychology(RAMP.minAnswered));
    expect(v8.eligible(ctx([sensitive, q('ok', ['care_harm'])], open))).toEqual([true, true]);
  });

  it('the cap and the floor choose among what the ramp allows, never narrowing to held-back candidates only', async () => {
    // One anchor and four adaptive answers, all psychology: the cap and the floor are on, the ramp is still closed.
    const b = belief([
      answer(1, ['openness'], { kind: 'anchor' }),
      ...psychology(4).map((a) => ({ ...a, seq: a.seq + 1 })),
    ]);
    expect(b.person.nAdaptive).toBe(4);
    expect(rampOpen(b, RAMP)).toBe(false);
    const v8 = new VoiSelector(VOI_SELECTOR_V8);
    // The only candidate outside psychology is sensitive: held back, so the psychology one stays eligible.
    const pool = [q('pol', ['political_leaning']), q('psych', ['self_control'])];
    expect(v8.eligible(ctx(pool, b))).toEqual([false, true]);
    const sel = await v8.select(ctx(pool, b));
    expect(sel.question.id).toBe('psych');
    expect(sel.diagnostics.failed).toBeUndefined();
  });

  it('from sweepFrom, prefers a consented sensitive facet not yet asked about', async () => {
    const b = belief(psychology(RAMP.sweepFrom));
    const v8 = new VoiSelector({ ...VOI_SELECTOR_V8, balance: undefined, piPopulation: 0, nuBurden: 0 });
    const pool = [q('plain', ['care_harm']), q('sweep', ['religiosity'])];
    expect(sweeps(b, RAMP, pool[1]!)).toBe(true);
    const sel = await v8.select(ctx(pool, b));
    expect(sel.question.id).toBe('sweep');
    expect(sel.diagnostics.sweep).toBe(1);
    // Once asked, it no longer sweeps.
    const asked = belief([...psychology(RAMP.sweepFrom), answer(RAMP.sweepFrom + 1, ['religiosity'])]);
    expect(sweeps(asked, RAMP, pool[1]!)).toBe(false);
    // Before sweepFrom, no bonus.
    expect(sweeps(belief(psychology(RAMP.sweepFrom - 1)), RAMP, pool[1]!)).toBe(false);
  });

  it('coverage deadlines: information chooses until the questions left would not fit what is still uncovered', () => {
    expect(deadlinePressed(5, 16, 20)).toBe(true); // five groups, five questions left (16..20)
    expect(deadlinePressed(4, 16, 20)).toBe(false);
    expect(deadlinePressed(0, 20, 20)).toBe(false);
    expect(deadlinePressed(3, 31, 30)).toBe(false); // past the deadline nothing is forced
    // Repeat probes take a slot every eight questions, so the deadline presses one question earlier.
    expect(deadlinePressed(7, 23, 30)).toBe(false);
    expect(deadlinePressed(7, 23, 30, 8)).toBe(true);
  });

  it('when the group deadline presses, only candidates reaching an untouched group are eligible', () => {
    // Ten answers spread evenly over the four categories but only four groups: six groups are untouched.
    const spread = ['openness', 'care_harm', 'social_energy', 'leadership_drive'];
    const b = belief(Array.from({ length: 10 }, (_, i) => answer(i + 1, [spread[i % 4]!])));
    const v8 = new VoiSelector(VOI_SELECTOR_V8);
    const pool = [q('touched', ['fairness_cheating']), q('fresh', ['growth_mindset'])];
    // Question 12: nine questions left to 20 for six groups; nothing forced.
    expect(v8.eligible({ ...ctx(pool, b), seq: 12 })).toEqual([true, true]);
    // Question 16: five questions left for six groups.
    expect(v8.eligible({ ...ctx(pool, b), seq: 16 })).toEqual([false, true]);
  });

  it('when the sweep deadline presses, only unswept consented sensitive candidates are eligible, never before the ramp', () => {
    const v8 = new VoiSelector({ ...VOI_SELECTOR_V8, balance: undefined });
    const pool = [q('plain', ['care_harm']), q('sweep', ['religiosity'])];
    const b = belief(psychology(RAMP.sweepFrom));
    expect(v8.eligible({ ...ctx(pool, b), seq: 15 })).toEqual([true, true]);
    expect(v8.eligible({ ...ctx(pool, b), seq: 25 })).toEqual([false, true]); // 11 unswept, 6 questions left
    const early = belief(psychology(RAMP.minAnswered - 1));
    expect(v8.eligible({ ...ctx(pool, early), seq: 29 })).toEqual([true, false]);
  });
});

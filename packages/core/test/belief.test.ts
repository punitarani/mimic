import { describe, expect, it } from 'vitest';
import {
  type BeliefAnswer,
  type BeliefInput,
  buildBelief,
  domainQuota,
  isSpeeding,
  isStraightlining,
  medianOf,
  NEED_WEIGHTS,
  ONTOLOGY_V1,
  paceOf,
  targetFacets,
} from '../src';

const facets = ONTOLOGY_V1.filter((f) =>
  ['risk_tolerance', 'patience', 'trust', 'humor', 'planning'].includes(f.id),
);
const mix = { core: 0.1, casual: 0.45, professional: 0.45 };

function answer(seq: number, over: Partial<BeliefAnswer> = {}): BeliefAnswer {
  return {
    seq,
    kind: seq <= 3 ? 'anchor' : 'adaptive',
    type: 'choice',
    domain: 'casual',
    facetIds: ['risk_tolerance'],
    answer: 'a',
    latencyMs: 3000,
    ...over,
  };
}

function input(over: Partial<BeliefInput> = {}): BeliefInput {
  return { facets, answers: [], traits: [], insights: [], repeats: [], domainMix: mix, ...over };
}

describe('belief state (docs/SELECTION.md §3)', () => {
  it('starts fully uncertain, unexplored and neutral on weakness', () => {
    const b = buildBelief(input());
    const f = b.facets.risk_tolerance!;
    expect(f.uncertainty).toBe(1);
    expect(f.coverage).toBe(0);
    expect(f.conflict).toBe(0);
    expect(f.weakness).toBeCloseTo(0.5, 12); // the prior with no scored questions
    expect(f.reason).toBe('unexplored');
    expect(f.need).toBeCloseTo(NEED_WEIGHTS.uncertainty + NEED_WEIGHTS.weakness * 0.5 + NEED_WEIGHTS.gap, 12);
    expect(b.person.medianLatencyMs).toBeNull();
    expect(b.domains.casual.shortfall).toBe(1);
  });

  it('uncertainty falls with a confident, concentrated trait read', () => {
    const b = buildBelief(
      input({
        traits: [
          {
            facetId: 'risk_tolerance',
            method: 'jev',
            seqUpTo: 5,
            mean: 0.75,
            dist: { '0': 0.01, '1': 0.02, '2': 0.07, '3': 0.85, '4': 0.05 },
            confidence: 0.8,
            nEvidence: 4,
          },
        ],
      }),
    );
    const f = b.facets.risk_tolerance!;
    expect(f.uncertainty).toBeLessThan(0.35);
    expect(f.label).toBe('Leans toward risk');
    expect(f.certainty).toBe(0.8);
    expect(b.facets.patience!.uncertainty).toBe(1);
  });

  it('conflict rises when the Jev and psychometric reads disagree, insights are superseded, or repeats flip', () => {
    const base = { seqUpTo: 3, dist: {}, confidence: 0.5, nEvidence: 1 };
    const b = buildBelief(
      input({
        answers: [answer(1), answer(2), answer(3)],
        traits: [
          { facetId: 'risk_tolerance', method: 'jev', mean: 0.2, ...base },
          { facetId: 'risk_tolerance', method: 'psychometric', mean: 0.9, ...base },
          { facetId: 'patience', method: 'jev', mean: 0.5, ...base },
          { facetId: 'patience', method: 'psychometric', mean: 0.55, ...base },
        ],
        insights: [
          { facetIds: ['trust'], status: 'superseded' },
          { facetIds: ['trust'], status: 'active' },
        ],
        repeats: [{ facetIds: ['humor'], agreement: 0 }],
      }),
    );
    expect(b.facets.risk_tolerance!.conflict).toBe(1);
    expect(b.facets.risk_tolerance!.reason).toBe('conflicted');
    expect(b.facets.patience!.conflict).toBeCloseTo(0.075, 6);
    expect(b.facets.trust!.conflict).toBe(0.5);
    expect(b.facets.humor!.conflict).toBe(1);
    expect(b.facets.planning!.conflict).toBe(0);
  });

  it('torn answers (over twice the median latency) add to conflict', () => {
    const answers = [
      answer(1, { latencyMs: 2000 }),
      answer(2, { latencyMs: 2000 }),
      answer(3, { latencyMs: 2000 }),
      answer(4, { latencyMs: 9000, facetIds: ['patience'] }),
      answer(5, { latencyMs: 9000, facetIds: ['patience'] }),
    ];
    const b = buildBelief(input({ answers }));
    expect(b.person.medianLatencyMs).toBe(2000);
    expect(b.facets.patience!.conflict).toBeCloseTo(0.5, 12);
    expect(b.facets.risk_tolerance!.conflict).toBe(0);
  });

  it('weakness follows the sealed primary’s recent errors on the facet, shrunk toward the overall error', () => {
    const answers = [
      ...[1, 2, 3, 4].map((s) => answer(s, { facetIds: ['risk_tolerance'], itemAcc: 0 })),
      ...[5, 6, 7, 8].map((s) => answer(s, { facetIds: ['patience'], itemAcc: 1 })),
    ];
    // Confident reads on both, so uncertainty is low and the error signal decides the reason.
    const read = (facetId: string) => ({
      facetId,
      method: 'jev' as const,
      seqUpTo: 8,
      mean: 0.5,
      dist: { '0': 0.01, '1': 0.02, '2': 0.9, '3': 0.05, '4': 0.02 },
      confidence: 0.9,
      nEvidence: 4,
    });
    const b = buildBelief(input({ answers, traits: [read('risk_tolerance'), read('patience')] }));
    expect(b.person.error).toBeCloseTo(0.5, 12);
    expect(b.facets.risk_tolerance!.weakness).toBeCloseTo((4 + 2 * 0.5) / 6, 12);
    expect(b.facets.patience!.weakness).toBeCloseTo((0 + 2 * 0.5) / 6, 12);
    expect(b.facets.risk_tolerance!.reason).toBe('weak');
    expect(b.facets.patience!.reason).toBe('uncertain');
    expect(b.facets.trust!.weakness).toBeCloseTo(0.5, 12); // no data: the prior
  });

  it('tracks coverage, exposure and domain shares', () => {
    const answers = [
      answer(1, { kind: 'anchor', domain: 'core' }),
      answer(2, { kind: 'anchor', domain: 'core', facetIds: ['patience'] }),
      answer(3, { kind: 'anchor', domain: 'core', facetIds: ['trust'] }),
      answer(4, { domain: 'casual' }),
      answer(5, { domain: 'casual' }),
      answer(6, { domain: 'professional', facetIds: ['patience'] }),
      answer(7, { domain: 'professional', facetIds: ['patience', 'risk_tolerance'] }),
    ];
    const b = buildBelief(
      input({
        answers,
        served: [{ type: 'noul', domain: 'casual', facetIds: ['humor'] }],
        pooled: [{ facetIds: ['planning'] }],
      }),
    );
    expect(b.facets.risk_tolerance!.coverage).toBe(1);
    expect(b.facets.risk_tolerance!.n).toBe(4);
    expect(b.facets.risk_tolerance!.exposure).toBeCloseTo(3 / 4, 12);
    expect(b.facets.humor!.coverage).toBeCloseTo(1 / 3, 12); // served counts toward coverage
    expect(b.facets.planning!.coverage).toBeCloseTo(1 / 3, 12); // pooled counts toward coverage only
    expect(b.facets.planning!.exposure).toBe(0);
    expect(b.person.nAdaptive).toBe(4);
    expect(b.domains.casual.share).toBeCloseTo(3 / 5, 12); // 2 answered + 1 served of 5 adaptive
    expect(b.domains.core.share).toBe(0);
    expect(b.domains.core.shortfall).toBe(1);
    expect(b.domains.professional.shortfall).toBeCloseTo((0.45 - 0.4) / 0.45, 12);
    expect(b.recent.types).toEqual(['choice', 'choice', 'noul']);
    expect(b.recent.domains).toEqual(['professional', 'professional', 'casual']);
  });

  it('detects speeding and straightlining', () => {
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(paceOf(500, 3000)).toBe('quick');
    expect(paceOf(9000, 3000)).toBe('slow');
    expect(paceOf(3000, 3000)).toBe('even');
    expect(paceOf(100, null)).toBe('even');
    expect(isSpeeding(500, 3000)).toBe(true);
    expect(isSpeeding(2500, 10000)).toBe(false); // slow in absolute terms
    const answers = [
      ...[1, 2, 3, 4, 5].map((s) => answer(s, { type: 'score', answer: '4', latencyMs: 3000 })),
      answer(6, { latencyMs: 400 }),
    ];
    const b = buildBelief(input({ answers }));
    expect(b.person.speedingRate).toBeCloseTo(1 / 6, 12);
    expect(b.person.straightlining).toBe(true);
    expect(isStraightlining([{ type: 'score', answer: '1' }])).toBe(false);
  });

  it('is deterministic', () => {
    const answers = [answer(1), answer(2, { itemAcc: 0.5 }), answer(3, { latencyMs: 9000 })];
    expect(buildBelief(input({ answers }))).toEqual(buildBelief(input({ answers })));
  });
});

describe('generator targets (docs/SELECTION.md §5)', () => {
  it('targets the facets with the highest need and skips over-exposed ones', () => {
    const answers = [
      ...[1, 2, 3, 4, 5, 6].map((s) => answer(s, { facetIds: ['risk_tolerance'], itemAcc: 1 })),
      answer(7, { facetIds: ['patience'], itemAcc: 0 }),
    ];
    const b = buildBelief(input({ answers }));
    const t = targetFacets(b, facets, 3, 0.35);
    expect(t.map((x) => x.id)).not.toContain('risk_tolerance'); // exposure 3/4 > cap
    expect(t).toHaveLength(3);
    expect(t[0]!.need).toBeGreaterThanOrEqual(t[1]!.need);
    // The facet the mimic just got wrong outranks the unexplored ones; the rest are unexplored, in id order.
    expect(t[0]).toMatchObject({ id: 'patience', reason: 'uncertain' });
    expect(t.slice(1).map((x) => x.id)).toEqual(['humor', 'planning']);
    expect(t[1]).toMatchObject({ reason: 'unexplored', label: null, certainty: null });
    expect(targetFacets(b, facets, 5).map((x) => x.id)).toContain('risk_tolerance');
  });

  it('tilts the domain quota toward weak domains and always sums to n', () => {
    const answers = [
      ...[1, 2, 3, 4].map((s) => answer(s, { domain: 'professional', itemAcc: 0 })),
      ...[5, 6, 7, 8].map((s) => answer(s, { domain: 'casual', itemAcc: 1 })),
    ];
    const b = buildBelief(input({ answers }));
    const q = domainQuota(b, mix, 12);
    expect(q.core + q.casual + q.professional).toBe(12);
    expect(q.professional).toBeGreaterThan(q.casual);
    const flat = domainQuota(buildBelief(input()), mix, 12);
    expect(flat.core + flat.casual + flat.professional).toBe(12);
    expect(Math.abs(flat.casual - flat.professional)).toBeLessThanOrEqual(1); // rounding residual
  });
});

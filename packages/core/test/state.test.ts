import { describe, expect, it } from 'vitest';
import {
  type BuildOptions,
  buildState,
  type EvidenceItem,
  estimateTokens,
  type MimicData,
  pickRepeat,
  RELEVANT_K,
  SECTION_BUDGETS,
  STATE_VIEWS,
  surpriseOf,
  toStateEvidence,
  validateDraft,
  viewState,
} from '../src';

const opts = (over: Partial<BuildOptions> = {}): BuildOptions => ({
  beforeSeq: Number.MAX_SAFE_INTEGER,
  budgetTokens: 8000,
  strategy: 'full',
  retrievalK: 12,
  recentN: 6,
  ...over,
});

function item(seq: number, over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    seq,
    questionId: `q${seq}`,
    kind: seq <= 10 ? 'anchor' : 'adaptive',
    type: 'choice',
    prompt: `Question number ${seq} about weekend plans and coffee preferences?`,
    options: [
      { key: 'a', label: `Option A for ${seq}` },
      { key: 'b', label: `Option B for ${seq}` },
    ],
    answer: seq % 2 ? 'a' : 'b',
    why: null,
    facetIds: ['risk_tolerance'],
    ...over,
  };
}

function mimic(n: number, over: Partial<MimicData> = {}): MimicData {
  return {
    mimicId: 'm1',
    identity: { displayName: 'Pat Doe', location: 'Lisbon, PT', occupation: 'Nurse', employer: null },
    facts: [
      { predicate: 'worksAt', object: 'City Hospital', userState: 'active' },
      { predicate: 'livesIn', object: 'Secret Place', userState: 'removed' },
    ],
    evidence: Array.from({ length: n }, (_, i) => item(i + 1)),
    traits: [
      {
        facetId: 'risk_tolerance',
        method: 'jev',
        seqUpTo: 5,
        mean: 0.7,
        dist: {},
        confidence: 0.4,
        nEvidence: 2,
      },
      {
        facetId: 'risk_tolerance',
        method: 'jev',
        seqUpTo: 9,
        mean: 0.9,
        dist: {},
        confidence: 0.5,
        nEvidence: 3,
      },
    ],
    insights: [
      { id: 'i1', seqUpTo: 5, text: 'Chose A early', facetIds: [], evidenceSeqs: [1, 3], confidence: 0.6 },
      { id: 'i2', seqUpTo: 12, text: 'Later insight', facetIds: [], evidenceSeqs: [11], confidence: 0.6 },
      { id: 'i3', seqUpTo: 4, text: 'Uncited', facetIds: [], evidenceSeqs: [], confidence: 0.9 },
    ],
    ...over,
  };
}

describe('sealing (PLAN §3.1): the state for question t never contains answer t', () => {
  it('excludes evidence, traits and insights at or after beforeSeq', () => {
    for (const t of [1, 2, 6, 10, 11, 12, 30]) {
      const s = buildState(mimic(40), opts({ beforeSeq: t }));
      expect(s.evidence.every((e) => e.seq < t)).toBe(true);
      expect(s.meta.evidenceSeqMax).toBeLessThan(t);
      for (const i of s.insights ?? []) expect(i.evidence.every((x) => x < t)).toBe(true);
      expect(JSON.stringify(s)).not.toContain(`Question number ${t} `);
    }
  });

  it('uses the latest trait estimate that was sealed before t', () => {
    expect(buildState(mimic(20), opts({ beforeSeq: 7 })).traits).toEqual([
      { facet: 'risk_tolerance', mean: 0.7, confidence: 0.4 },
    ]);
    expect(buildState(mimic(20), opts({ beforeSeq: 10 })).traits?.[0]?.mean).toBe(0.9);
    expect(buildState(mimic(20), opts({ beforeSeq: 5 })).traits).toBeUndefined();
  });

  it('drops insights without citations and insights citing unsealed answers', () => {
    const s = buildState(mimic(20), opts({ beforeSeq: 12 }));
    expect(s.insights?.map((i) => i.text)).toEqual(['Chose A early']);
  });

  it('never includes repeat or playground evidence', () => {
    const m = mimic(3);
    m.evidence.push(item(4, { kind: 'repeat' }), item(5, { kind: 'playground' }));
    expect(buildState(m, opts()).evidence.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('includes feedback the person answered themselves, sealed like any answer (ADR-0032)', () => {
    const m = mimic(3);
    m.evidence.push(item(4, { kind: 'feedback' }), item(5, { kind: 'playground' }));
    expect(buildState(m, opts()).evidence.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(buildState(m, opts({ beforeSeq: 4 })).evidence.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('context-only states carry identity and nothing learned', () => {
    const s = buildState(mimic(20), opts({ contextOnly: true }));
    expect(s.evidence).toEqual([]);
    expect(s.traits).toBeUndefined();
    expect(s.insights).toBeUndefined();
    expect(s.meta.evidenceSeqMax).toBe(0);
    expect(s.identity).toMatchObject({
      name: 'Pat Doe',
      occupation: 'Nurse',
      facts: ['worksAt: City Hospital'],
    });
  });
});

describe('state builder (PLAN §9.9)', () => {
  it('never lets removed facts into any state', () => {
    for (const strategy of ['raw', 'structured', 'summary', 'full'] as const) {
      expect(JSON.stringify(buildState(mimic(5), opts({ strategy })))).not.toContain('Secret Place');
    }
    expect(JSON.stringify(buildState(mimic(5), opts({ contextOnly: true })))).not.toContain('Secret Place');
  });

  it('includes every answered item while it fits', () => {
    expect(buildState(mimic(30), opts()).evidence).toHaveLength(30);
  });

  it('enforces the token budget once evidence outgrows it', () => {
    const m = mimic(200);
    const s = buildState(m, opts({ budgetTokens: 2000 }));
    expect(s.meta.tokens).toBeLessThanOrEqual(2000);
    const seqs = s.evidence.map((e) => e.seq);
    // the most recent answers are kept, then retrieval, then anchors, within budget
    expect(seqs).toContain(200);
    expect(seqs).toContain(195);
    expect(seqs.length).toBeLessThan(200);
  });

  it('keeps anchors and recent answers when retrieval is on and the budget allows', () => {
    const s = buildState(mimic(120), opts({ budgetTokens: 4000, retrievalK: 4, recentN: 3 }));
    const seqs = s.evidence.map((e) => e.seq);
    for (const a of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(seqs).toContain(a);
    for (const r of [118, 119, 120]) expect(seqs).toContain(r);
    expect(seqs.length).toBe(10 + 3 + 4);
  });

  it('caps the identity section and truncates each why to 200 characters', () => {
    const facts = Array.from({ length: 300 }, (_, i) => ({
      predicate: 'hasSkill',
      object: `Skill number ${i}`,
      userState: 'active' as const,
    }));
    const m = mimic(2, { facts });
    m.evidence[0]!.why = 'x'.repeat(500);
    const s = buildState(m, opts());
    expect(estimateTokens(s.identity)).toBeLessThanOrEqual(SECTION_BUDGETS.identity);
    expect(s.evidence[0]!.why).toHaveLength(200);
  });

  it('builds the strategy ablations', () => {
    const at = { beforeSeq: 20 };
    const raw = buildState(mimic(20), opts({ ...at, strategy: 'raw' }));
    expect(raw).not.toHaveProperty('traits');
    expect(raw).not.toHaveProperty('insights');
    expect(buildState(mimic(20), opts({ ...at, strategy: 'structured' })).evidence).toEqual([]);
    expect(buildState(mimic(20), opts({ ...at, strategy: 'summary' })).insights).toBeDefined();
    const full = buildState(mimic(20), opts({ ...at, strategy: 'full' }));
    expect(full.traits && full.insights && full.evidence.length).toBeTruthy();
  });

  it('is deterministic: same inputs, same stateHash', () => {
    const a = buildState(mimic(15), opts({ beforeSeq: 10 }));
    const b = buildState(mimic(15), opts({ beforeSeq: 10 }));
    expect(a.meta.stateHash).toBe(b.meta.stateHash);
    expect(buildState(mimic(15), opts({ beforeSeq: 11 })).meta.stateHash).not.toBe(a.meta.stateHash);
  });

  it('shows answers by label, not key', () => {
    expect(buildState(mimic(1), opts()).evidence[0]).toMatchObject({
      answer: 'Option A for 1',
      options: ['Option A for 1', 'Option B for 1'],
    });
  });

  it('marks decisive and torn answers with latency hints, from the median over the sealed evidence', () => {
    const m = mimic(12);
    for (const e of m.evidence) e.latencyMs = 3000;
    m.evidence[1]!.latencyMs = 500; // quick
    m.evidence[2]!.latencyMs = 9000; // slow
    m.evidence[11]!.latencyMs = 100; // seq 12: quick, but only when sealed in
    const s = buildState(m, opts({ latencyHints: true, beforeSeq: 12 }));
    expect(s.meta.builder).toBe('full.v2');
    expect(s.evidence[0]!.pace).toBeUndefined();
    expect(s.evidence[1]!.pace).toBe('quick');
    expect(s.evidence[2]!.pace).toBe('slow');
    expect(s.evidence.map((e) => e.seq)).not.toContain(12);
    const plain = buildState(m, opts({ beforeSeq: 12 }));
    expect(plain.meta.builder).toBe('full.v1');
    expect(plain.evidence.every((e) => e.pace === undefined)).toBe(true);
    expect(plain.meta.stateHash).not.toBe(s.meta.stateHash);
    // The hints are deterministic and need at least three timed answers.
    expect(buildState(m, opts({ latencyHints: true, beforeSeq: 12 })).meta.stateHash).toBe(s.meta.stateHash);
    const few = mimic(2);
    few.evidence[0]!.latencyMs = 100;
    few.evidence[1]!.latencyMs = 9000;
    expect(buildState(few, opts({ latencyHints: true })).evidence.every((e) => e.pace === undefined)).toBe(
      true,
    );
    expect(buildState(m, opts({ latencyHints: true, contextOnly: true })).meta.builder).toBe('context.v1');
  });

  it('`xs.map(toStateEvidence)` never injects a median (the index is not a latency)', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(i + 1, { latencyMs: 3000 }));
    // The compiler rejects `items.map(toStateEvidence)` now; the runtime guard covers untyped callers.
    const mapped = items.map((e, i) => toStateEvidence(e, i as unknown as { medianLatencyMs: number }));
    expect(mapped.every((e) => e.pace === undefined)).toBe(true);
    expect(
      items.map((e) => toStateEvidence(e, { medianLatencyMs: 3000 })).every((e) => e.pace === undefined),
    ).toBe(true);
    expect(toStateEvidence(item(1, { latencyMs: 100 }), { medianLatencyMs: 3000 }).pace).toBe('quick');
    // The budget is costed as rendered: with hints on, pace marks count toward it.
    const m = mimic(200);
    for (const e of m.evidence) e.latencyMs = e.seq % 2 ? 100 : 30000;
    const s = buildState(m, opts({ budgetTokens: 2000, latencyHints: true }));
    expect(s.meta.tokens).toBeLessThanOrEqual(2000);
    expect(s.evidence.some((e) => e.pace !== undefined)).toBe(true);
  });
});

describe('repeat schedule (PLAN §9.5)', () => {
  const served = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      questionId: `q${i + 1}`,
      seq: i + 1,
      kind: (i < 10 ? 'anchor' : 'adaptive') as 'anchor' | 'adaptive',
      answered: true,
    }));
  const rng = () => 0;

  it('waits for `every` adaptive questions', () => {
    expect(pickRepeat(served(17), { every: 8, minGap: 6 }, rng)).toBeNull();
    expect(pickRepeat(served(18), { every: 8, minGap: 6 }, rng)).toBe('q1');
  });

  it('respects the minimum gap and never repeats twice', () => {
    const s = [
      ...served(18),
      { questionId: 'r1', seq: 19, kind: 'repeat' as const, repeatOf: 'q1', answered: true },
    ];
    expect(pickRepeat(s, { every: 8, minGap: 6 }, rng)).toBeNull();
    const later = [
      ...s,
      ...Array.from({ length: 8 }, (_, i) => ({
        questionId: `x${i}`,
        seq: 20 + i,
        kind: 'adaptive' as const,
        answered: true,
      })),
    ];
    const pick = pickRepeat(later, { every: 8, minGap: 6 }, rng);
    expect(pick).toBe('q2');
  });

  it('counts the gap in session questions, not seqs (ADR-0032)', () => {
    // Seqs jump where the person taught on the mimic page; only q1 is 18 session questions back.
    const s = served(18).map((x, i) => (i >= 13 ? { ...x, seq: x.seq + 100 } : x));
    expect(pickRepeat(s, { every: 8, minGap: 18 }, () => 0.99)).toBe('q1');
  });
});

describe('generator schema gate (PLAN §9.4)', () => {
  const known = new Set(['risk_tolerance']);
  const base = {
    domain: 'casual',
    prompt: 'Would you rather hike or read on a Sunday?',
    facetIds: ['risk_tolerance'],
  };

  it('normalizes keys by type', () => {
    const c = validateDraft(
      {
        ...base,
        type: 'choice',
        options: [
          { key: 'x', label: 'Hike' },
          { key: 'y', label: 'Read' },
        ],
      },
      known,
    );
    expect(c).toMatchObject({ options: [{ key: 'a' }, { key: 'b' }] });
    const n = validateDraft(
      {
        ...base,
        type: 'noul',
        options: [
          { key: 'true', label: 'Sure' },
          { key: 'false', label: 'Nope' },
        ],
      },
      known,
    );
    expect(n).toMatchObject({
      options: [
        { key: 'yes', label: 'Yes' },
        { key: 'no', label: 'No' },
      ],
    });
    const s = validateDraft(
      { ...base, type: 'score', options: ['1', '2', '3', '4', '5'].map((l) => ({ key: l, label: `L${l}` })) },
      known,
    );
    expect(s).toMatchObject({
      options: [{ key: '0' }, { key: '1' }, { key: '2' }, { key: '3' }, { key: '4' }],
    });
  });

  it('rejects bad option counts, hedges, unknown facets and duplicates', () => {
    expect(validateDraft({ ...base, type: 'score', options: [{ key: 'a', label: 'x' }] }, known)).toEqual({
      error: 'score needs 5 options',
    });
    expect(validateDraft({ ...base, type: 'choice', options: [{ key: 'a', label: 'x' }] }, known)).toEqual({
      error: 'choice needs 2–5 options',
    });
    expect(
      validateDraft(
        {
          ...base,
          type: 'choice',
          options: [
            { key: 'a', label: 'Hike' },
            { key: 'b', label: 'It depends' },
          ],
        },
        known,
      ),
    ).toEqual({ error: 'hedge option' });
    expect(validateDraft({ ...base, facetIds: ['nope'], type: 'noul', options: [] }, known)).toEqual({
      error: 'no known facet',
    });
    expect(
      validateDraft(
        {
          ...base,
          type: 'choice',
          options: [
            { key: 'a', label: 'Hike' },
            { key: 'b', label: 'hike' },
          ],
        },
        known,
      ),
    ).toEqual({ error: 'duplicate options' });
    expect(validateDraft({ type: 'nope' }, known)).toEqual({ error: 'schema' });
  });
});

describe('evidence policies and the card state (ADR-0056)', () => {
  const signalled = (n: number) => {
    const m = mimic(n);
    for (const e of m.evidence) {
      // Surprise rises with seq modulo 7, novelty falls with it, so the two policies pick different answers.
      e.surprise = (e.seq % 7) / 7;
      e.novelty = 1 - (e.seq % 7) / 7;
    }
    return m;
  };

  it('keeps every answer while it fits, whatever the policy', () => {
    for (const evidencePolicy of ['recent', 'similar', 'surprise', 'novelty'] as const) {
      const s = buildState(signalled(20), opts({ evidencePolicy }));
      expect(s.evidence).toHaveLength(20);
      expect(s.meta.builder).toBe(`full.v1.${evidencePolicy}`);
    }
    expect(buildState(signalled(20), opts({ evidencePolicy: 'mixed' })).meta.builder).toBe('full.v1');
  });

  it('ranks by the policy once over the cap, and renders in seq order', () => {
    const m = signalled(30);
    const recent = buildState(m, opts({ evidencePolicy: 'recent', maxEvidence: 5 }));
    expect(recent.evidence.map((e) => e.seq)).toEqual([26, 27, 28, 29, 30]);
    const surprise = buildState(m, opts({ evidencePolicy: 'surprise', maxEvidence: 5 }));
    // seq % 7 = 6 → 6, 13, 20, 27, then the most recent with seq % 7 = 5.
    expect(surprise.evidence.map((e) => e.seq)).toEqual([6, 13, 20, 26, 27]);
    const novelty = buildState(m, opts({ evidencePolicy: 'novelty', maxEvidence: 5 }));
    // seq % 7 = 0 → 7, 14, 21, 28, then the most recent with seq % 7 = 1 (29).
    expect(novelty.evidence.map((e) => e.seq)).toEqual([7, 14, 21, 28, 29]);
    m.evidence[16]!.prompt = 'Would you bring an umbrella to a picnic under grey skies?';
    const similar = buildState(
      m,
      opts({
        evidencePolicy: 'similar',
        maxEvidence: 2,
        forQuestions: [
          {
            id: 't',
            mimicId: 'm1',
            seq: null,
            kind: 'adaptive',
            type: 'choice',
            domain: 'casual',
            prompt: 'Do you pack an umbrella for a picnic when the skies look grey?',
            options: [],
            facetIds: [],
            provenance: { generator: 'x', configHash: 'x', promptVersion: 'x' },
          },
        ],
      }),
    );
    // The lexically closest answer first, then recency breaks the ties among the rest.
    expect(similar.evidence.map((e) => e.seq)).toEqual([17, 30]);
  });

  it('answers without the signal rank last, by recency, so the ranking is total', () => {
    const m = mimic(10);
    m.evidence[2]!.surprise = 0.9;
    m.evidence[6]!.surprise = 0.4;
    const s = buildState(m, opts({ evidencePolicy: 'surprise', maxEvidence: 4 }));
    expect(s.evidence.map((e) => e.seq)).toEqual([3, 7, 9, 10]);
  });

  it('holds the budget and the cap together, and seals like any other state', () => {
    const m = signalled(200);
    const s = buildState(m, opts({ evidencePolicy: 'surprise', maxEvidence: 40, budgetTokens: 1500 }));
    expect(s.evidence.length).toBeLessThanOrEqual(40);
    expect(s.meta.tokens).toBeLessThanOrEqual(1500);
    for (const t of [3, 50, 120]) {
      const sealed = buildState(m, opts({ evidencePolicy: 'surprise', maxEvidence: 8, beforeSeq: t }));
      expect(sealed.evidence.every((e) => e.seq < t)).toBe(true);
      expect(sealed.meta.evidenceSeqMax).toBeLessThan(t);
    }
    const cap = buildState(m, opts({ maxEvidence: 7 }));
    expect(cap.evidence).toHaveLength(7);
    expect(cap.meta.builder).toBe('full.v1');
  });

  it('builds the card: identity, traits and the capped answers, no insights', () => {
    const m = signalled(30);
    const card = buildState(m, opts({ strategy: 'card', evidencePolicy: 'surprise', maxEvidence: 6 }));
    expect(card.traits).toBeDefined();
    expect(card.insights).toBeUndefined();
    expect(card.evidence).toHaveLength(6);
    expect(card.meta.builder).toBe('card.v1.surprise');
    expect(JSON.stringify(card)).not.toContain('Secret Place');
    const again = buildState(m, opts({ strategy: 'card', evidencePolicy: 'surprise', maxEvidence: 6 }));
    expect(again.meta.stateHash).toBe(card.meta.stateHash);
    expect(buildState(m, opts({ strategy: 'card', contextOnly: true })).meta.builder).toBe('context.v1');
  });

  it('surpriseOf normalises a log loss by the number of options and stays in [0, 1]', () => {
    expect(surpriseOf(0, 2)).toBe(0);
    expect(surpriseOf(Math.log(2), 2)).toBeCloseTo(1);
    expect(surpriseOf(Math.log(5), 5)).toBeCloseTo(1);
    expect(surpriseOf(10, 5)).toBe(1);
    expect(surpriseOf(-1, 1)).toBe(0);
  });
});

describe('state views (E6, docs/EVIDENCE.md)', () => {
  const sealed = buildState(mimic(20), opts({ beforeSeq: 15 }));

  it('every view is a subset of the sealed state, so sealing holds', () => {
    const q = { prompt: 'Question about weekend plans' };
    for (const view of STATE_VIEWS) {
      const v = viewState(sealed, view, q);
      const seqs = new Set(sealed.evidence.map((e) => e.seq));
      for (const e of v.evidence) expect(seqs.has(e.seq)).toBe(true);
      expect(v.meta.evidenceSeqMax).toBeLessThanOrEqual(sealed.meta.evidenceSeqMax);
      expect(v.meta.evidenceSeqMax).toBeLessThan(15);
      expect(v.meta.tokens).toBeLessThanOrEqual(sealed.meta.tokens);
      expect(v.identity).toEqual(sealed.identity);
    }
  });

  it('full is the state itself', () => {
    expect(viewState(sealed, 'full')).toBe(sealed);
  });

  it('context is exactly the context-only baseline state', () => {
    const baseline = buildState(mimic(20), opts({ beforeSeq: 15, contextOnly: true }));
    const v = viewState(sealed, 'context');
    expect(v).toEqual(baseline);
    expect(v.meta.stateHash).toBe(baseline.meta.stateHash);
  });

  it('answers drops derived data and keeps every answer; derived does the opposite', () => {
    expect(sealed.traits?.length).toBeGreaterThan(0);
    expect(sealed.insights?.length).toBeGreaterThan(0);
    const a = viewState(sealed, 'answers');
    expect(a.traits).toBeUndefined();
    expect(a.insights).toBeUndefined();
    expect(a.evidence).toEqual(sealed.evidence);
    expect(a.meta.evidenceSeqMax).toBe(14);
    expect(a.meta.builder).toBe('full.v1>answers');
    const d = viewState(sealed, 'derived');
    expect(d.evidence).toEqual([]);
    expect(d.traits).toEqual(sealed.traits);
    expect(d.insights).toEqual(sealed.insights);
    expect(d.meta.evidenceSeqMax).toBe(sealed.meta.evidenceSeqMax);
  });

  it('relevant keeps the RELEVANT_K most similar answers in seq order, ties to the latest', () => {
    const data = mimic(20, {
      evidence: Array.from({ length: 14 }, (_, i) =>
        item(i + 1, {
          prompt: i === 2 ? 'Do you take risks when investing money?' : `Unrelated topic ${i + 1}`,
        }),
      ),
    });
    const s = buildState(data, opts({ beforeSeq: 15 }));
    const v = viewState(s, 'relevant', { prompt: 'Would you risk money investing in a startup?' });
    expect(v.evidence).toHaveLength(RELEVANT_K);
    expect(v.evidence.map((e) => e.seq)).toContain(3);
    // The rest tie at zero similarity, so the latest answers fill the remaining places.
    expect(v.evidence.map((e) => e.seq)).toEqual([3, 8, 9, 10, 11, 12, 13, 14]);
    expect(v.traits).toBeUndefined();
    expect(() => viewState(s, 'relevant')).toThrow(/needs the question/);
  });

  it('is deterministic', () => {
    const q = { prompt: 'weekend plans' };
    for (const view of STATE_VIEWS)
      expect(viewState(sealed, view, q).meta.stateHash).toBe(viewState(sealed, view, q).meta.stateHash);
  });
});

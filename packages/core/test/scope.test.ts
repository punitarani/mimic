import { describe, expect, it } from 'vitest';
import {
  AREA_INFO,
  blockedFacetIds,
  CATEGORIES,
  CATEGORY_INFO,
  citedSeqs,
  DEFAULT_SCOPE,
  type Facet,
  facetAllowed,
  factHidden,
  insightHidden,
  MimicScope,
  normalizeScope,
  ONTOLOGY_V1,
  questionAllowed,
  SENSITIVE_AREAS,
  scopedFacets,
  scopeShrank,
  scopeView,
  specialAreaOfFact,
  specialFacetIds,
  stripSpecialText,
  validateDraft,
} from '../src';

const facet = (id: string, category: Facet['category'], sensitive?: Facet['sensitive']): Facet => ({
  id,
  group: 'G',
  name: id,
  low: 'low',
  high: 'high',
  labels: ['a', 'b', 'c', 'd', 'e'],
  category,
  ...(sensitive ? { sensitive } : {}),
});

const FACETS = [
  facet('openness', 'psychology'),
  facet('care_harm', 'values'),
  facet('political_leaning', 'values', 'politics'),
  facet('religiosity', 'values', 'religion'),
  facet('trust', 'life'),
  facet('health_vigilance', 'life', 'health'),
  facet('autonomy', 'work'),
  facet('financial_security', 'work', 'money'),
];

const scope = (over: Partial<MimicScope> = {}): MimicScope => ({ ...DEFAULT_SCOPE, ...over });

describe('scope model (ADR-0036)', () => {
  it('allows a facet only when its category is selected and, if sensitive, its area is consented', () => {
    const all = scope();
    expect(facetAllowed(all, facet('x', 'psychology'))).toBe(true);
    expect(facetAllowed(all, facet('x', 'values', 'politics'))).toBe(false);
    const consented = scope({ consents: { politics: true } });
    expect(facetAllowed(consented, facet('x', 'values', 'politics'))).toBe(true);
    expect(facetAllowed(consented, facet('x', 'values', 'religion'))).toBe(false);
    const noValues = scope({ categories: ['psychology', 'life', 'work'], consents: { politics: true } });
    expect(facetAllowed(noValues, facet('x', 'values', 'politics'))).toBe(false);
    expect(facetAllowed(noValues, facet('x', 'values'))).toBe(false);
    expect(scopedFacets(consented, FACETS).map((f) => f.id)).toEqual([
      'openness',
      'care_harm',
      'political_leaning',
      'trust',
      'autonomy',
    ]);
    expect([...blockedFacetIds(consented, FACETS)].sort()).toEqual([
      'financial_security',
      'health_vigilance',
      'religiosity',
    ]);
  });

  it('normalises: canonical category order, true flags only, no consent for a deselected category', () => {
    const n = normalizeScope(
      {
        categories: ['work', 'psychology', 'work'],
        consents: { politics: true, money: true, health: false },
        researchConsents: { politics: true },
      },
      true,
    );
    expect(n).toEqual({
      categories: ['psychology', 'work'],
      consents: { money: true },
      researchConsents: {},
    });
    // Research consent needs the area's consent and research consent overall.
    const withResearch = { categories: [...CATEGORIES], consents: { health: true, religion: true } };
    expect(
      normalizeScope({ ...withResearch, researchConsents: { health: true, politics: true } }, true)
        .researchConsents,
    ).toEqual({ health: true });
    expect(
      normalizeScope({ ...withResearch, researchConsents: { health: true } }, false).researchConsents,
    ).toEqual({});
    expect(() => normalizeScope({ categories: [], consents: {}, researchConsents: {} }, false)).toThrow();
    expect(MimicScope.safeParse({ categories: [] }).success).toBe(false);
    expect(MimicScope.parse({ categories: ['life'] })).toEqual({
      categories: ['life'],
      consents: {},
      researchConsents: {},
    });
  });

  it('shrinks only when a category or a sensitive consent is removed', () => {
    const base = scope({ consents: { health: true } });
    expect(scopeShrank(base, scope())).toBe(true);
    expect(scopeShrank(base, { ...base, categories: ['psychology', 'values', 'work'] })).toBe(true);
    expect(scopeShrank(scope(), base)).toBe(false);
    expect(scopeShrank(base, { ...base, researchConsents: { health: true } })).toBe(false);
    expect(scopeShrank(base, base)).toBe(false);
  });

  it('hides mixed questions, their answers, insights and reflection facts; maps sensitive facets to direct questions', () => {
    const s = scope({ categories: ['psychology', 'values', 'life'], consents: { politics: true } });
    const qs = [
      { id: 'q1', seq: 1, facetIds: ['openness'] },
      { id: 'q2', seq: 2, facetIds: ['openness', 'autonomy'] }, // mixed: hidden
      { id: 'q3', seq: 3, facetIds: ['political_leaning'] },
      { id: 'q4', seq: null, facetIds: ['political_leaning'] }, // pooled: no seq
      { id: 'q5', seq: 5, facetIds: ['twin2k/unmapped'] }, // unknown facet ids are not blocked
      { id: 'q6', seq: 6, facetIds: ['health_vigilance'] },
    ];
    const v = scopeView(s, FACETS, qs);
    expect([...v.hiddenQuestionIds].sort()).toEqual(['q2', 'q6']);
    expect([...v.hiddenSeqs].sort()).toEqual([2, 6]);
    expect([...(v.sensitiveSeqs.get('political_leaning') ?? [])]).toEqual([3]);
    expect(v.sensitiveSeqs.has('health_vigilance')).toBe(false);
    expect(questionAllowed({ facetIds: ['openness'] }, v.blocked)).toBe(true);
    expect(questionAllowed({ facetIds: ['autonomy'] }, v.blocked)).toBe(false);
    expect(citedSeqs({ source: 'reflection', sourceRef: 'answers:1,2' })).toEqual([1, 2]);
    expect(citedSeqs({ source: 'search', sourceRef: 'answers:2' })).toEqual([]);
    expect(factHidden(v, { source: 'reflection', sourceRef: 'answers:1,2' })).toBe(true);
    expect(factHidden(v, { source: 'reflection', sourceRef: 'answers:1,3' })).toBe(false);
    expect(factHidden(v, { source: 'search', sourceRef: null })).toBe(false);
    expect(insightHidden(v, { facetIds: ['openness'], evidenceSeqs: [1] })).toBe(false);
    expect(insightHidden(v, { facetIds: ['openness'], evidenceSeqs: [1, 6] })).toBe(true);
    expect(insightHidden(v, { facetIds: ['autonomy'], evidenceSeqs: [1] })).toBe(true);
    expect([...specialFacetIds('religion', FACETS)]).toEqual(['religiosity']);
  });

  it('rejects a generated draft tagging a blocked facet instead of dropping the tag', () => {
    const draft = {
      type: 'noul',
      domain: 'casual',
      prompt: 'Would you skip a party to finish a side project?',
      options: [],
      facetIds: ['openness', 'autonomy'],
    };
    const known = new Set(['openness']);
    expect(validateDraft(draft, known)).toMatchObject({ facetIds: ['openness'] }); // unknown tags are still dropped
    expect(validateDraft(draft, known, new Set(['autonomy']))).toEqual({ error: 'out of scope' });
  });

  it('puts every v1 facet in a category (life and work stay separable) and has copy for every category and area', () => {
    const byCat = new Map<string, number>();
    for (const f of ONTOLOGY_V1) byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);
    expect([...byCat.keys()].sort()).toEqual(['life', 'psychology', 'values', 'work']);
    expect(ONTOLOGY_V1.find((f) => f.id === 'spending_style')?.category).toBe('work');
    expect(ONTOLOGY_V1.some((f) => f.sensitive)).toBe(false);
    for (const c of CATEGORIES) expect(CATEGORY_INFO[c].description.length).toBeGreaterThan(10);
    for (const a of SENSITIVE_AREAS) {
      expect(CATEGORY_INFO[AREA_INFO[a].category].areas).toContain(a);
      expect(AREA_INFO[a].why.length).toBeGreaterThan(10);
    }
    expect(AREA_INFO.money.special).toBe(false);
  });
});

describe('special-category facts from search are never stored (ADR-0036)', () => {
  it('recognises religion, politics, health and sexuality in personal facts', () => {
    expect(specialAreaOfFact({ predicate: 'hasInterest', object: 'Baptist church choir' })).toBe('religion');
    expect(specialAreaOfFact({ predicate: 'hasInterest', object: 'Sunday mass' })).toBe('religion');
    expect(
      specialAreaOfFact({ predicate: 'created', object: 'Campaign volunteer for the Green Party' }),
    ).toBe('politics');
    expect(specialAreaOfFact({ predicate: 'hasInterest', object: 'Type 1 diabetes advocacy' })).toBe(
      'health',
    );
    expect(specialAreaOfFact({ predicate: 'headline', object: 'Cancer survivor and runner' })).toBe('health');
    expect(specialAreaOfFact({ predicate: 'hasInterest', object: 'LGBTQ+ employee network lead' })).toBe(
      'sexuality',
    );
  });

  it('keeps ordinary facts and professional health facts', () => {
    expect(specialAreaOfFact({ predicate: 'hasInterest', object: 'Trail running' })).toBeNull();
    expect(specialAreaOfFact({ predicate: 'educatedAt', object: 'Temple University' })).toBeNull();
    expect(specialAreaOfFact({ predicate: 'worksAt', object: 'Mental Health Foundation' })).toBeNull();
    expect(specialAreaOfFact({ predicate: 'jobTitle', object: 'Oncology nurse' })).toBeNull();
    expect(
      specialAreaOfFact({ predicate: 'hasSkill', object: 'Democratic decision-making in teams' }),
    ).toBeNull();
    // Employment at a church or a party does reveal the area.
    expect(specialAreaOfFact({ predicate: 'worksAt', object: 'First Baptist Church' })).toBe('religion');
  });

  it('strips revealing sentences from free text', () => {
    expect(
      stripSpecialText(
        'Product designer in Lisbon. Volunteers at her parish on weekends. Loves trail running.',
      ),
    ).toBe('Product designer in Lisbon. Loves trail running.');
  });
});

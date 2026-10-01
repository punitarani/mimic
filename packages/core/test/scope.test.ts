import { describe, expect, it } from 'vitest';
import {
  AREA_INFO,
  blockedFacetIds,
  CATEGORIES,
  CATEGORY_INFO,
  DEFAULT_SCOPE,
  type Facet,
  facetAllowed,
  factCitedSeqs,
  factHidden,
  insightHidden,
  MimicScope,
  newlyDeclined,
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
  unconfirmedAreas,
  validateDraft,
  withResearchUse,
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

describe('scope model (ADR-0040)', () => {
  it('allows a facet only when its category is selected and, if sensitive, its area is consented', () => {
    const all = scope();
    expect(facetAllowed(all, facet('x', 'psychology'))).toBe(true);
    expect(facetAllowed(all, facet('x', 'values', 'politics'))).toBe(false);
    const consented = scope({ consents: { politics: true }, confirmed: { politics: true } });
    expect(facetAllowed(consented, facet('x', 'values', 'politics'))).toBe(true);
    expect(facetAllowed(consented, facet('x', 'values', 'religion'))).toBe(false);
    const noValues = scope({
      categories: ['psychology', 'life', 'work'],
      consents: { politics: true },
      confirmed: { politics: true },
    });
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

  it('research consent covers the special areas turned on, and never widens one already consented (ADR-0065)', () => {
    const intake = withResearchUse(scope({ consents: { politics: true, health: true, money: true } }), null);
    expect(normalizeScope(intake, true).researchConsents).toEqual({ politics: true, health: true });
    expect(normalizeScope(intake, false).researchConsents).toEqual({});
    // An area consented before keeps what was sent with it; one turned on now joins research use.
    const before = scope({ consents: { politics: true, health: true }, researchConsents: { health: true } });
    const saved = withResearchUse({ ...before, consents: { ...before.consents, religion: true } }, before);
    expect(normalizeScope(saved, true).researchConsents).toEqual({ health: true, religion: true });
    expect(withResearchUse(before, before)).toEqual(before);
    // An area already consented keeps what is stored, whatever the request sends: no widening, and a draft that
    // turned it off and on again (clearing its research use) doesn't narrow it.
    const sent = { ...before, researchConsents: { politics: true } };
    expect(withResearchUse(sent, before).researchConsents).toEqual({ health: true });
    // Withdrawing an area withdraws its research use, as before.
    const withdrawn = withResearchUse({ ...before, consents: { politics: true } }, before);
    expect(normalizeScope(withdrawn, true).researchConsents).toEqual({});
  });

  it('asks about a special-category area only once it is confirmed; money needs its consent alone (ADR-0050)', () => {
    const preTicked = scope({ consents: { politics: true, money: true } });
    expect(facetAllowed(preTicked, facet('x', 'values', 'politics'))).toBe(false);
    expect(facetAllowed(preTicked, facet('y', 'work', 'money'))).toBe(true);
    expect(unconfirmedAreas(preTicked)).toEqual(['politics']);
    const confirmed = { ...preTicked, confirmed: { politics: true } };
    expect(facetAllowed(confirmed, facet('x', 'values', 'politics'))).toBe(true);
    expect(unconfirmedAreas(confirmed)).toEqual([]);
    // A confirmation without the consent is dropped; declined facets are blocked and de-duplicated.
    expect(
      normalizeScope({ ...preTicked, consents: { money: true }, confirmed: { politics: true } }, false),
    ).toEqual({ categories: [...CATEGORIES], consents: { money: true }, researchConsents: {} });
    const declined = normalizeScope(
      { ...confirmed, declined: ['political_leaning', 'political_leaning'] },
      false,
    );
    expect(declined.declined).toEqual(['political_leaning']);
    expect(facetAllowed(declined, facet('political_leaning', 'values', 'politics'))).toBe(false);
    expect(facetAllowed(declined, facet('political_engagement', 'values', 'politics'))).toBe(true);
    // Removing a confirmation narrows; declining is reported separately.
    expect(scopeShrank(confirmed, preTicked)).toBe(true);
    expect(scopeShrank(preTicked, confirmed)).toBe(false);
    expect(scopeShrank(confirmed, declined)).toBe(false);
    expect(newlyDeclined(confirmed, declined)).toEqual(['political_leaning']);
    expect(newlyDeclined(declined, confirmed)).toEqual([]);
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
    const s = scope({
      categories: ['psychology', 'values', 'life'],
      consents: { politics: true },
      confirmed: { politics: true },
    });
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
    expect(factCitedSeqs({ source: 'reflection', sourceRef: 'answers:1,2' })).toEqual([1, 2]);
    expect(factCitedSeqs({ source: 'search', sourceRef: 'answers:2' })).toEqual([]);
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

describe('special-category facts from search are never stored (ADR-0040)', () => {
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

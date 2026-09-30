import { describe, expect, it } from 'vitest';
import {
  allOntologyFacets,
  DEFAULT_SCOPE,
  type EngineDeps,
  guardHypothesisText,
  guardInsight,
  type ItemStatRecord,
  type MimicRecord,
  type MimicScope,
  reflectionFactAllowed,
  researchAllowed,
  runStatsRefresh,
  type ScoredItemSource,
  scopeView,
  stripSpecialAreas,
} from '../src';

const facets = [...allOntologyFacets().values()];
const withReligion: MimicScope = { ...DEFAULT_SCOPE, consents: { religion: true, money: true } };
// Seq 3 asked about religiosity directly; seq 5 about trust; seq 7 was never answered.
const view = scopeView(withReligion, facets, [
  { id: 'q3', seq: 3, facetIds: ['religiosity'] },
  { id: 'q5', seq: 5, facetIds: ['trust'] },
  { id: 'q9', seq: null, facetIds: ['spirituality'] },
]);

describe('direct evidence only (ADR-0043)', () => {
  it('keeps a sensitive tag only with a direct citation, and drops inferred sensitive statements', () => {
    expect(
      guardInsight(view, {
        text: 'Trusts neighbours.',
        facetIds: ['religiosity', 'trust'],
        evidenceSeqs: [5],
      }),
    ).toMatchObject({ facetIds: ['trust'] });
    expect(
      guardInsight(view, { text: 'Sounds deeply religious.', facetIds: ['religiosity'], evidenceSeqs: [5] }),
    ).toBeNull();
    expect(
      guardInsight(view, {
        text: 'Sounds deeply religious.',
        facetIds: ['religiosity', 'trust'],
        evidenceSeqs: [3, 5],
      }),
    ).toMatchObject({ facetIds: ['religiosity', 'trust'] });
    // Politics was never consented: its facets are blocked, and a political statement never has direct evidence.
    expect(
      guardInsight(view, { text: 'Leans left.', facetIds: ['political_leaning'], evidenceSeqs: [5] }),
    ).toMatchObject({ facetIds: [] });
    expect(guardInsight(view, { text: 'A Green Party voter.', facetIds: [], evidenceSeqs: [3] })).toBeNull();
  });

  it('keeps a revealing reflection fact only when it cites a direct answer in its area', () => {
    const fact = (object: string, evidenceSeqs: number[]) => ({
      predicate: 'hasInterest',
      object,
      evidenceSeqs,
    });
    expect(reflectionFactAllowed(view, fact('Sunday mass', [5]))).toBe(false);
    expect(reflectionFactAllowed(view, fact('Sunday mass', [3]))).toBe(true);
    expect(reflectionFactAllowed(view, fact('Trail running', [5]))).toBe(true);
  });

  it('strips guesses from hypotheses until a direct answer exists by then', () => {
    const text = 'Leans bold. Probably goes to church every Sunday.';
    expect(guardHypothesisText(view, text, 2)).toBe('Leans bold.');
    expect(guardHypothesisText(view, text, 3)).toBe(text);
    expect(guardHypothesisText(view, 'Probably in therapy.', 9)).toBe('');
  });

  it('allows research use of a special area only with research consent; money follows plain research consent', () => {
    const byId = allOntologyFacets();
    expect(researchAllowed(withReligion, ['religiosity'], byId)).toBe(false);
    expect(
      researchAllowed({ ...withReligion, researchConsents: { religion: true } }, ['religiosity'], byId),
    ).toBe(true);
    expect(researchAllowed(withReligion, ['financial_security'], byId)).toBe(true);
    expect(researchAllowed({ ...withReligion, categories: ['psychology'] }, ['trust'], byId)).toBe(false);
    expect(researchAllowed(withReligion, ['occ_unknown'], byId)).toBe(true);
    expect(stripSpecialAreas('Loves hiking. Sings in the church choir.', new Set())).toBe('Loves hiking.');
    expect(stripSpecialAreas('Loves hiking. Sings in the church choir.', new Set(['religion']))).toBe(
      'Loves hiking. Sings in the church choir.',
    );
  });
});

describe('item statistics and research consent (ADR-0043)', () => {
  async function refresh(scope: MimicScope): Promise<ItemStatRecord[]> {
    const people = Array.from({ length: 6 }, (_, i) => `m${i}`);
    const sources: ScoredItemSource[] = people.flatMap((mimicId, i) =>
      [['religiosity'], ['trust']].map((facetIds, j) => ({
        mimicId,
        questionId: `${mimicId}-q${j}`,
        role: 'primary' as const,
        fallback: false,
        itemAcc: 0.5,
        logLoss: 0.7,
        question: {
          kind: 'adaptive' as const,
          type: 'choice' as const,
          domain: 'casual' as const,
          facetIds,
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
        },
        answer: { value: i % 2 ? 'a' : 'b', latencyMs: 1000 },
      })),
    );
    let written: ItemStatRecord[] = [];
    const deps = {
      clock: () => 1,
      store: {
        listScoredForStats: async () => sources,
        listMimics: async () => people.map((id) => ({ id, scope, consentResearch: true }) as MimicRecord),
        replaceItemStats: async (recs: ItemStatRecord[]) => {
          written = recs;
        },
      },
    } as unknown as EngineDeps;
    await runStatsRefresh(deps);
    return written;
  }

  it('counts a special-category facet only from people who consented to its research use', async () => {
    const keys = (rs: ItemStatRecord[]) => rs.map((r) => r.key);
    const without = keys(await refresh(withReligion));
    expect(without.some((k) => k.includes('religiosity'))).toBe(false);
    expect(without.some((k) => k.includes('trust'))).toBe(true);
    const withResearch = keys(await refresh({ ...withReligion, researchConsents: { religion: true } }));
    expect(withResearch.some((k) => k.includes('religiosity'))).toBe(true);
  });
});

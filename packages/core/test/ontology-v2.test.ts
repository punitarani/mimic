import { describe, expect, it } from 'vitest';
import {
  AREA_INFO,
  CATEGORIES,
  failClosed,
  forbiddenAreas,
  GATE_SETS,
  GATE_THRESHOLDS,
  GROUP_CATEGORY_V2,
  gateFailures,
  gateQuestions,
  getFacetGroups,
  getOntology,
  getReserveSet,
  NEW_IN_V2,
  ONTOLOGY_V1,
  ONTOLOGY_V2,
  RESERVE_V1,
  RESERVE_V2,
  RESERVE_V2_NEW,
  reserveSetId,
  SENSITIVE_AREAS,
  validateDraft,
} from '../src';

const byId = new Map(ONTOLOGY_V2.map((f) => [f.id, f]));

describe('ontology v2 (ADR-0042)', () => {
  it('keeps every v1 facet word for word, only regrouped', () => {
    for (const f1 of ONTOLOGY_V1) {
      const f2 = byId.get(f1.id)!;
      expect(f2, f1.id).toBeDefined();
      expect({ ...f2, group: f1.group, source: undefined }).toEqual({ ...f1, source: undefined });
      expect(f2.category).toBe(f1.category); // a facet keeps its category across versions (ADR-0040)
    }
    expect(byId.get('spending_style')!.group).toBe('Money');
  });

  it('adds at least 12 facets, each with two poles, five labels, a category from its group and a research anchor', () => {
    expect(NEW_IN_V2.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ONTOLOGY_V2.map((f) => f.id)).size).toBe(ONTOLOGY_V2.length);
    expect(ONTOLOGY_V2.length).toBe(ONTOLOGY_V1.length + NEW_IN_V2.length);
    for (const f of ONTOLOGY_V2) {
      expect(f.id).toMatch(/^[a-z][a-z_]+$/);
      expect(f.labels).toHaveLength(5);
      expect(new Set(f.labels).size, f.id).toBe(5);
      expect(f.low.length).toBeGreaterThan(3);
      expect(f.high.length).toBeGreaterThan(3);
      expect(f.category).toBe(GROUP_CATEGORY_V2[f.group as keyof typeof GROUP_CATEGORY_V2]);
      expect(f.source?.length ?? 0, f.id).toBeGreaterThan(8);
      expect(f.source, f.id).toMatch(/\d{4}/); // cites a year
    }
    expect(getFacetGroups('v2')).toEqual(Object.keys(GROUP_CATEGORY_V2));
    expect(getOntology('v2')).toBe(ONTOLOGY_V2);
  });

  it('covers the areas the plan named, in every category', () => {
    const ids = new Set(NEW_IN_V2.map((f) => f.id));
    for (const id of [
      'care_harm',
      'fairness_cheating',
      'loyalty_betrayal',
      'authority_subversion',
      'attachment_anxiety',
      'attachment_avoidance',
      'emotion_regulation',
      'reward_sensitivity',
      'self_control',
      'honesty_humility',
      'norm_compliance',
      'mental_accounting',
      'social_comparison',
      'just_world',
      'locus_of_control',
    ])
      expect(ids.has(id), id).toBe(true);
    for (const c of CATEGORIES) {
      const plain = NEW_IN_V2.filter((f) => f.category === c && !f.sensitive);
      expect(plain.length, c).toBeGreaterThanOrEqual(2);
    }
  });

  it('puts each sensitive facet inside the category that holds its area, and covers all five areas', () => {
    const sensitive = ONTOLOGY_V2.filter((f) => f.sensitive);
    expect(sensitive.every((f) => NEW_IN_V2.includes(f))).toBe(true);
    for (const f of sensitive) expect(f.category, f.id).toBe(AREA_INFO[f.sensitive!].category);
    for (const a of SENSITIVE_AREAS)
      expect(sensitive.filter((f) => f.sensitive === a).length, a).toBeGreaterThanOrEqual(2);
  });
});

describe('reserve.v2 (ADR-0042)', () => {
  const known = new Set(ONTOLOGY_V2.map((f) => f.id));

  it('keeps reserve.v1 and its keys, and old configs keep reading reserve.v1', () => {
    expect(RESERVE_V2.slice(0, RESERVE_V1.length)).toEqual(RESERVE_V1);
    expect(getReserveSet('reserve.v2')).toBe(RESERVE_V2);
    expect(reserveSetId({})).toBe('reserve.v1');
    expect(reserveSetId({ reserve: { setId: 'reserve.v2' } })).toBe('reserve.v2');
    expect(() => getReserveSet('reserve.v9')).toThrow();
  });

  it('has at least two items for every new facet, each a valid question on known facets', () => {
    expect(new Set(RESERVE_V2.map((r) => r.itemKey)).size).toBe(RESERVE_V2.length);
    for (const f of NEW_IN_V2)
      expect(RESERVE_V2_NEW.filter((r) => r.facetIds.includes(f.id)).length, f.id).toBeGreaterThanOrEqual(2);
    for (const r of RESERVE_V2) {
      const v = validateDraft(
        { ...r, options: r.options.map((o) => ({ key: o.key, label: o.label })) },
        known,
      );
      expect(v, r.itemKey).not.toHaveProperty('error');
      if ('error' in v) continue;
      expect(v.options, r.itemKey).toEqual(r.options);
      expect(v.facetIds).toEqual(r.facetIds);
    }
  });

  it('asks sensitive items on their own facet only, and never uses self-rating forms', () => {
    for (const r of RESERVE_V2_NEW) {
      const sens = r.facetIds.map((id) => byId.get(id)!).filter((f) => f.sensitive);
      if (sens.length) expect(r.facetIds, r.itemKey).toHaveLength(1);
      expect(r.prompt).not.toMatch(/describe you|how much do you agree|rate yourself|consider yourself/i);
      expect(r.options.map((o) => o.label).join(' ')).not.toMatch(/prefer not to say/i);
    }
  });
});

describe('gates.v3 (ADR-0042)', () => {
  it('leaves gates.v2 exactly as it was', () => {
    const v2 = gateQuestions();
    expect(Object.keys(v2)).toEqual(['ambiguous', 'sensitive', 'leading', 'quick']);
    expect(v2.sensitive!.instructions).toBe(
      'Does this question touch on health, sexuality, religion, politics, or detailed personal finances?',
    );
    // gates.v2 always asks about every area, whatever a draft is tagged with.
    expect(gateQuestions('gates.v2', [])).toEqual(v2);
    expect(GATE_THRESHOLDS).toEqual({
      ambiguous: { failIf: 'above', p: 0.85 },
      sensitive: { failIf: 'above', p: 0.4 },
      leading: { failIf: 'above', p: 0.55 },
      quick: { failIf: 'below', p: 0.6 },
    });
    expect(gateFailures({ ambiguous: 0.2, sensitive: 0.2, leading: 0.2, quick: 0.9, concrete: 0 })).toEqual(
      [],
    );
  });

  it('asks a draft only about the sensitive areas it is not tagged with', () => {
    const all = ONTOLOGY_V2;
    expect(forbiddenAreas(['trust'], all)).toEqual([...SENSITIVE_AREAS]);
    expect(forbiddenAreas(['political_leaning', 'political_engagement'], all)).toEqual([
      'religion',
      'sexuality',
      'health',
      'money',
    ]);
    const q = gateQuestions('gates.v3', forbiddenAreas(['religiosity'], all));
    expect(Object.keys(q).sort()).toEqual(
      ['ambiguous', 'concrete', 'demeaning', 'leading', 'quick', 'sensitive'].sort(),
    );
    expect(q.sensitive!.instructions).toBe(
      "Does this question ask about the answerer's own health, sexuality, politics, or detailed personal finances (income, savings, debt)?",
    );
    expect(gateQuestions('gates.v3', ['money']).sensitive!.instructions).toBe(
      "Does this question ask about the answerer's own detailed personal finances (income, savings, debt)?",
    );
    // gates.v3 judges leading wording, not whether one option is more admirable.
    expect(q.leading!.instructions).toMatch(/^Does the wording push the person toward one answer/);
    expect(gateQuestions().leading!.instructions).toBe(
      'Is this question leading or loaded, nudging the person toward one answer?',
    );
    expect(gateQuestions('gates.v3', []).sensitive).toBeUndefined();
  });

  it('fails a self-rating on concrete and loaded wording on demeaning; unasked gates never fail', () => {
    const ok = { ambiguous: 0.1, sensitive: 0.1, leading: 0.1, quick: 0.9, concrete: 0.9, demeaning: 0.05 };
    expect(gateFailures(ok, 'gates.v3')).toEqual([]);
    expect(gateFailures({ ...ok, concrete: 0.2 }, 'gates.v3')).toEqual(['concrete']);
    expect(gateFailures({ ...ok, demeaning: 0.9 }, 'gates.v3')).toEqual(['demeaning']);
    const { sensitive: _, ...skipped } = ok;
    expect(gateFailures(skipped, 'gates.v3')).toEqual([]);
    expect(failClosed('concrete', 'gates.v3')).toBe(0);
    expect(failClosed('demeaning', 'gates.v3')).toBe(1);
    expect(failClosed('quick')).toBe(0);
    expect(Object.keys(GATE_SETS)).toEqual(['gates.v2', 'gates.v3']);
    expect(() => gateQuestions('gates.v9')).toThrow();
  });
});

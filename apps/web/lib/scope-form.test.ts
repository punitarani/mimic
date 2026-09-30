import { DEFAULT_SCOPE, type MimicScope, normalizeScope } from '@mimic/core/scope';
import { describe, expect, it } from 'vitest';
import { canSave, narrows, notAsked, sameScope, setCategory, setConsent, setResearch } from './scope-form';

const all: MimicScope = {
  categories: ['psychology', 'values', 'life', 'work'],
  consents: { politics: true, health: true, money: true },
  researchConsents: { politics: true, health: true },
};

describe('scope form (ADR-0043)', () => {
  it('turning a category off forgets its sensitive consents and their research use; on again asks again', () => {
    const off = setCategory(all, 'values', false);
    expect(off.categories).toEqual(['psychology', 'life', 'work']);
    expect(off.consents).toEqual({ health: true, money: true });
    expect(off.researchConsents).toEqual({ health: true });
    const back = setCategory(off, 'values', true);
    expect(back.categories).toEqual(['psychology', 'values', 'life', 'work']);
    expect(back.consents.politics).toBeUndefined();
  });

  it('withdrawing a consent withdraws its research use; research needs the consent', () => {
    expect(setConsent(all, 'health', false).researchConsents).toEqual({ politics: true });
    expect(setResearch(DEFAULT_SCOPE, 'religion', true).researchConsents).toEqual({});
    expect(
      setResearch(setConsent(DEFAULT_SCOPE, 'religion', true), 'religion', true).researchConsents,
    ).toEqual({
      religion: true,
    });
  });

  it('keeps one category, names what is off, and knows when a change narrows', () => {
    let s: MimicScope = DEFAULT_SCOPE;
    for (const c of ['values', 'life', 'work'] as const) s = setCategory(s, c, false);
    expect(s.categories).toEqual(['psychology']);
    expect(canSave(s)).toBe(true);
    expect(canSave(setCategory(s, 'psychology', false))).toBe(false);
    expect(notAsked(s)).toEqual(['values', 'life', 'work']);
    expect(narrows(DEFAULT_SCOPE, s)).toBe(true);
    expect(narrows(s, DEFAULT_SCOPE)).toBe(false);
    expect(narrows(all, setConsent(all, 'money', false))).toBe(true);
    expect(narrows(all, setResearch(all, 'health', false))).toBe(false);
  });

  it('matches what the server stores', () => {
    const drafted = setResearch(
      setConsent(setCategory(all, 'work', false), 'religion', true),
      'religion',
      true,
    );
    expect(sameScope(drafted, normalizeScope(drafted, true))).toBe(true);
    expect(sameScope(all, setConsent(all, 'money', false))).toBe(false);
  });
});

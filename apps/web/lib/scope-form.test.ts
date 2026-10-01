import {
  DEFAULT_SCOPE,
  INTAKE_SCOPE,
  type MimicScope,
  normalizeScope,
  SENSITIVE_AREAS,
  withResearchUse,
} from '@mimic/core/scope';
import { describe, expect, it } from 'vitest';
import {
  allowDeclined,
  canSave,
  confirmArea,
  narrows,
  notAsked,
  sameScope,
  setCategory,
  setConsent,
  unconfirmed,
} from './scope-form';

const all: MimicScope = {
  categories: ['psychology', 'values', 'life', 'work'],
  consents: { politics: true, health: true, money: true },
  researchConsents: { politics: true, health: true },
};

describe('scope form (ADR-0043)', () => {
  it('intake starts with every topic and sensitive area on, and research use off (ADR-0049)', () => {
    expect(INTAKE_SCOPE.categories).toEqual(['psychology', 'values', 'life', 'work']);
    for (const a of SENSITIVE_AREAS) expect(INTAKE_SCOPE.consents[a]).toBe(true);
    expect(INTAKE_SCOPE.researchConsents).toEqual({});
    expect(sameScope(normalizeScope(INTAKE_SCOPE, true), INTAKE_SCOPE)).toBe(true);
  });

  it('turning a category off forgets its sensitive consents and their research use; on again asks again', () => {
    const off = setCategory(all, 'values', false);
    expect(off.categories).toEqual(['psychology', 'life', 'work']);
    expect(off.consents).toEqual({ health: true, money: true });
    expect(off.researchConsents).toEqual({ health: true });
    const back = setCategory(off, 'values', true);
    expect(back.categories).toEqual(['psychology', 'values', 'life', 'work']);
    expect(back.consents.politics).toBeUndefined();
  });

  it('withdrawing a consent withdraws its research use; turning one on leaves research use to the server', () => {
    expect(setConsent(all, 'health', false).researchConsents).toEqual({ politics: true });
    expect(setConsent(DEFAULT_SCOPE, 'religion', true).researchConsents).toEqual({});
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
    expect(narrows(all, { ...all, researchConsents: { politics: true } })).toBe(false);
  });

  it('matches what the server stores', () => {
    const drafted = setConsent(setCategory(all, 'work', false), 'religion', true);
    expect(sameScope(drafted, normalizeScope(drafted, true))).toBe(true);
    expect(sameScope(all, setConsent(all, 'money', false))).toBe(false);
    // The server gives research use to the area turned on (ADR-0067) and keeps it on the ones already consented.
    expect(normalizeScope(withResearchUse(drafted, all), true).researchConsents).toEqual({
      politics: true,
      religion: true,
      health: true,
    });
  });

  it('an area turned off and on again before saving keeps its research use (ADR-0067)', () => {
    const toggled = setConsent(setConsent(all, 'health', false), 'health', true);
    expect(toggled.researchConsents).toEqual({ politics: true });
    expect(normalizeScope(withResearchUse(toggled, all), true).researchConsents).toEqual(
      all.researchConsents,
    );
    const recategorized = setConsent(
      setCategory(setCategory(all, 'life', false), 'life', true),
      'health',
      true,
    );
    expect(normalizeScope(withResearchUse(recategorized, all), true).researchConsents).toEqual(
      all.researchConsents,
    );
  });

  it("ticking a special-category area confirms it; leaving intake's pre-ticked box does not (ADR-0050)", () => {
    expect(unconfirmed(INTAKE_SCOPE)).toEqual(['politics', 'religion', 'sexuality', 'health']);
    // Off and on again at intake is a choice.
    const chosen = setConsent(setConsent(INTAKE_SCOPE, 'religion', false), 'religion', true);
    expect(chosen.confirmed).toEqual({ religion: true });
    expect(unconfirmed(chosen)).toEqual(['politics', 'sexuality', 'health']);
    // Money isn't special-category: its consent alone is enough, and it never needs confirming.
    expect(setConsent(DEFAULT_SCOPE, 'money', true).confirmed).toEqual({});
    // The session check: "Ask me" confirms, "Don't ask" withdraws the consent and its research use.
    const asked = confirmArea(INTAKE_SCOPE, 'politics', true);
    expect(asked.confirmed).toEqual({ politics: true });
    const refused = confirmArea({ ...INTAKE_SCOPE, researchConsents: { health: true } }, 'health', false);
    expect(refused.consents.health).toBeUndefined();
    expect(refused.researchConsents).toEqual({});
    // Turning a category off forgets its confirmations; removing one narrows.
    expect(setCategory(asked, 'values', false).confirmed).toEqual({});
    expect(narrows(asked, INTAKE_SCOPE)).toBe(true);
    expect(sameScope(asked, normalizeScope(asked, false))).toBe(true);
    expect(sameScope(asked, INTAKE_SCOPE)).toBe(false);
  });

  it('asks about a declined facet again, one at a time or all at once (ADR-0050)', () => {
    const declined: MimicScope = { ...all, declined: ['political_leaning', 'body_image'] };
    expect(allowDeclined(declined, 'body_image').declined).toEqual(['political_leaning']);
    expect(allowDeclined(declined).declined).toEqual([]);
    expect(sameScope(declined, allowDeclined(declined, 'body_image'))).toBe(false);
  });
});

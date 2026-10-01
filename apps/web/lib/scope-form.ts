import {
  CATEGORIES,
  CATEGORY_INFO,
  type Category,
  isSpecialArea,
  type MimicScope,
  type SensitiveArea,
  type SpecialArea,
  unconfirmedAreas,
} from '@mimic/core/scope';

/**
 * Form state for "What to ask about" (ADR-0040, ADR-0043), shared by intake and the session's Topics and consent
 * dialog. Pure, so the rules are tested without a browser: turning a category off forgets its sensitive consents
 * (turning it back on asks again), and withdrawing a consent withdraws its research use. Ticking a special-category
 * area is an affirmative choice, so it also confirms it; a box left at intake's pre-ticked default is not (ADR-0050).
 * Research use isn't chosen here: the server gives it to the areas turned on under research consent (ADR-0065).
 */
export function setCategory(scope: MimicScope, c: Category, on: boolean): MimicScope {
  const categories = CATEGORIES.filter((x) => (x === c ? on : scope.categories.includes(x)));
  if (on) return { ...scope, categories };
  const consents = { ...scope.consents };
  const researchConsents = { ...scope.researchConsents };
  const confirmed = { ...scope.confirmed };
  for (const a of CATEGORY_INFO[c].areas) {
    delete consents[a];
    if (a !== 'money') {
      delete researchConsents[a];
      delete confirmed[a];
    }
  }
  return { ...scope, categories, consents, researchConsents, confirmed };
}

export function setConsent(scope: MimicScope, a: SensitiveArea, on: boolean): MimicScope {
  const consents = { ...scope.consents };
  const researchConsents = { ...scope.researchConsents };
  const confirmed = { ...scope.confirmed };
  if (on) {
    consents[a] = true;
    if (isSpecialArea(a)) confirmed[a] = true;
  } else {
    delete consents[a];
    if (a !== 'money') {
      delete researchConsents[a];
      delete confirmed[a];
    }
  }
  return { ...scope, consents, researchConsents, confirmed };
}

/**
 * The session's answer for an area left pre-ticked (ADR-0050): "Ask me" confirms it, "Don't ask" withdraws its
 * consent (and research use).
 */
export function confirmArea(scope: MimicScope, a: SpecialArea, ask: boolean): MimicScope {
  if (!ask) return setConsent(scope, a, false);
  return { ...scope, confirmed: { ...scope.confirmed, [a]: true } };
}

/** Consented special-category areas the person hasn't chosen yet. */
export const unconfirmed = unconfirmedAreas;

/** Asks about declined facets again ("Prefer not to say" undone): one facet, or all when none is named. */
export function allowDeclined(scope: MimicScope, facetId?: string): MimicScope {
  const declined = facetId ? (scope.declined ?? []).filter((f) => f !== facetId) : [];
  return { ...scope, declined };
}

/** At least one category stays selected. */
export function canSave(scope: MimicScope): boolean {
  return scope.categories.length > 0;
}

/** Categories the person turned off, in canonical order. */
export function notAsked(scope: MimicScope): Category[] {
  return CATEGORIES.filter((c) => !scope.categories.includes(c));
}

/** Same scope, flag for flag (both assumed normalised: canonical order, true flags only). */
export function sameScope(a: MimicScope, b: MimicScope): boolean {
  const flags = (r: Record<string, boolean | undefined>) =>
    Object.entries(r)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
      .join(',');
  const list = (xs: string[] | undefined) => [...(xs ?? [])].sort().join(',');
  return (
    a.categories.join(',') === b.categories.join(',') &&
    flags(a.consents) === flags(b.consents) &&
    flags(a.researchConsents) === flags(b.researchConsents) &&
    flags(a.confirmed ?? {}) === flags(b.confirmed ?? {}) &&
    list(a.declined) === list(b.declined)
  );
}

/** True when saving `next` over `prev` narrows it: something already learned will be hidden. */
export function narrows(prev: MimicScope, next: MimicScope): boolean {
  return (
    prev.categories.some((c) => !next.categories.includes(c)) ||
    Object.keys(prev.consents).some(
      (a) => prev.consents[a as SensitiveArea] && !next.consents[a as SensitiveArea],
    ) ||
    Object.keys(prev.confirmed ?? {}).some(
      (a) => prev.confirmed?.[a as SpecialArea] && !next.confirmed?.[a as SpecialArea],
    )
  );
}

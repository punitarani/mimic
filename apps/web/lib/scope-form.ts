import {
  CATEGORIES,
  CATEGORY_INFO,
  type Category,
  type MimicScope,
  type SensitiveArea,
  type SpecialArea,
} from '@mimic/core/scope';

/**
 * Form state for "What to ask about" (ADR-0040, ADR-0043), shared by intake and the session's Topics and consent
 * dialog. Pure, so the rules are tested without a browser: turning a category off forgets its sensitive consents
 * (turning it back on asks again), and withdrawing a consent withdraws its research use.
 */
export function setCategory(scope: MimicScope, c: Category, on: boolean): MimicScope {
  const categories = CATEGORIES.filter((x) => (x === c ? on : scope.categories.includes(x)));
  if (on) return { ...scope, categories };
  const consents = { ...scope.consents };
  const researchConsents = { ...scope.researchConsents };
  for (const a of CATEGORY_INFO[c].areas) {
    delete consents[a];
    if (a !== 'money') delete researchConsents[a];
  }
  return { categories, consents, researchConsents };
}

export function setConsent(scope: MimicScope, a: SensitiveArea, on: boolean): MimicScope {
  const consents = { ...scope.consents };
  const researchConsents = { ...scope.researchConsents };
  if (on) consents[a] = true;
  else {
    delete consents[a];
    if (a !== 'money') delete researchConsents[a];
  }
  return { ...scope, consents, researchConsents };
}

export function setResearch(scope: MimicScope, a: SpecialArea, on: boolean): MimicScope {
  const researchConsents = { ...scope.researchConsents };
  if (on && scope.consents[a]) researchConsents[a] = true;
  else delete researchConsents[a];
  return { ...scope, researchConsents };
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
  return (
    a.categories.join(',') === b.categories.join(',') &&
    flags(a.consents) === flags(b.consents) &&
    flags(a.researchConsents) === flags(b.researchConsents)
  );
}

/** True when saving `next` over `prev` narrows it: something already learned will be hidden. */
export function narrows(prev: MimicScope, next: MimicScope): boolean {
  return (
    prev.categories.some((c) => !next.categories.includes(c)) ||
    Object.keys(prev.consents).some(
      (a) => prev.consents[a as SensitiveArea] && !next.consents[a as SensitiveArea],
    )
  );
}

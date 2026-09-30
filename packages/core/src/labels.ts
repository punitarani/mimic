/**
 * Display labels shared by the web app and SOUL.md (ADR-0037). Client-safe: no imports, so client components can
 * use it through `@mimic/core/labels` without bundling the engine.
 */

export const PREDICATE_LABELS: Record<string, string> = {
  headline: 'Headline',
  jobTitle: 'Role',
  worksAt: 'Works at',
  workedAt: 'Worked at',
  educatedAt: 'Studied at',
  hasSkill: 'Skill',
  created: 'Project or writing',
  hasInterest: 'Interest',
  livesIn: 'Location',
  knowsAbout: 'Knows about',
};

/** "worksAt" → "Works at"; unknown predicates are split from camelCase. */
export function predicateLabel(predicate: string): string {
  const known = PREDICATE_LABELS[predicate];
  if (known) return known;
  const words = predicate.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type CertaintyTier = 'low' | 'medium' | 'high';

/** Tiers for a trait read's certainty (Jev confidence), as shown in the model panel and in SOUL.md. */
export function certaintyTier(confidence: number): CertaintyTier {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.4) return 'medium';
  return 'low';
}

/** The facet's reading at `mean` (0–1), from its five labels, lowercased: "leans toward the familiar". */
export function facetReading(labels: readonly string[], mean: number): string {
  const label = labels[Math.max(0, Math.min(4, Math.round(mean * 4)))] ?? '';
  return label.charAt(0).toLowerCase() + label.slice(1);
}

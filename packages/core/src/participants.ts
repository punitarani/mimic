/**
 * Who a participant is (ADR-0044, ADR-0045): a real person, a scripted session (`pnpm eval -- session`, cohorts, the
 * test suites) or an imported panel (Twin-2K-500). Only real people's numbers are results; scripted and imported
 * people test the machinery and are never reported as people.
 */
export const POPULATIONS = ['real', 'scripted', 'twin2k'] as const;
export type Population = (typeof POPULATIONS)[number];

/**
 * Participant-ID prefixes that mark people who are not real users. Exports keep the prefix when they pseudonymise the
 * ID (`scrubExport`), so a scripted session in an exported file is never reported as a real person.
 */
export const NOT_REAL_PREFIXES = ['script:', 'twin2k:'] as const;

export function populationOf(participantId: string): Population {
  if (participantId.startsWith('script:')) return 'scripted';
  if (participantId.startsWith('twin2k:')) return 'twin2k';
  return 'real';
}

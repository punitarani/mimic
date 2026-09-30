/**
 * Invite links. `/new?invite=CODE` fills the invite code in and locks the field; `/?invite=CODE` carries the code
 * through the landing page's button (PLAN §11, ADR-0025). The code is only ever checked server-side.
 */

export const INVITE_PARAM = 'invite';

/** The invite code carried by a query value, or null when the link has none. Trims and ignores blanks. */
export function inviteFromQuery(value: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const code = raw?.trim() ?? '';
  return code ? code : null;
}

/** Where "Build your mimic" goes: `/new`, carrying the invite code when the person arrived with one. */
export function newMimicHref(invite: string | null): string {
  if (!invite) return '/new';
  const q = new URLSearchParams({ [INVITE_PARAM]: invite });
  return `/new?${q}`;
}

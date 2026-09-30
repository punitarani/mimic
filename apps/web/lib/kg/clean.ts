/**
 * Label cleanup for the map (ADR-0046). Stored KG labels are raw fact objects, so one label can hold a role and a
 * company ("Slash — Software Engineer"), a list ("Technologies: Azure, Docker"), dates, aliases or a phrase that
 * isn't an entity at all. These helpers turn a label into the entities it names, and give each a dedupe key.
 */

/** Lowercase, no accents or punctuation (bar `+` and `#`, for C++ and C#), single spaces. */
export function normKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

const ORG_SUFFIX = / (inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag)$/;

export function orgKey(s: string): string {
  return normKey(s).replace(ORG_SUFFIX, '').trim();
}

/** A place's key is its first part, without "Greater … Area": "San Francisco, CA" = "San Francisco Bay Area". */
export function placeKey(s: string): string {
  const first = s.split(',')[0] ?? s;
  return normKey(first)
    .replace(/^greater /, '')
    .replace(/ (bay area|metropolitan area|metro area|area|metro)$/, '')
    .trim();
}

/** The parts of a place label: "San Francisco, California." → ["San Francisco", "California"]. */
export function placeParts(s: string): string[] {
  return tidy(s)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Collapses spaces and drops trailing punctuation, dangling brackets and ellipses. */
export function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*\([^)]*$/, '')
    .replace(/(\.\.\.|…)$/, '')
    .replace(/[\s.,;:|·•-]+$/, '')
    .replace(/^[\s,;:|·•-]+/, '')
    .trim();
}

const DATE = /\b(?:19|20)\d{2}\b|\b(?:present|current|now)\b/i;

/**
 * Splits off parenthesized asides. Dates are dropped; anything else is kept as an alias:
 * "Handshake (Handshake AI)" → { text: "Handshake", aliases: ["Handshake AI"] }.
 */
export function stripAsides(s: string): { text: string; aliases: string[] } {
  const aliases: string[] = [];
  const text = s.replace(/\s*\(([^)]*)\)/g, (_, inner: string) => {
    const v = inner.trim();
    if (v && !DATE.test(v)) aliases.push(v);
    return ' ';
  });
  // Trailing dates outside brackets: "NOCO — Engineer, 2019–2021".
  const noDates = text.replace(
    /[,\s]+(?:(?:19|20)\d{2}|present)(?:\s*[–-]\s*(?:(?:19|20)\d{2}|present|now))?\s*$/i,
    '',
  );
  return { text: tidy(noDates), aliases };
}

const ROLE_WORD =
  /\b(engineer(?:ing)?|developer|dev|founder|co-?founder|cto|ceo|coo|cfo|cpo|vp|president|director|manager|lead|head|intern|scientist|researcher|designer|analyst|architect|consultant|specialist|associate|officer|partner|owner|student|teacher|professor|lecturer|fellow|assistant|advisor|adviser|contractor|freelancer?|staff|principal|senior|junior|swe|sde|chair|editor|writer|nurse|doctor|physician|attorney|lawyer|technician|coordinator|administrator|recruiter|product manager|pm)\b/i;

export function isRoleLike(s: string): boolean {
  return ROLE_WORD.test(s);
}

const SCHOOL =
  /\b(university|college|school|institute|academy|polytechnic|conservatory|universidad|universit[eé]|hochschule)\b/i;

export function isSchoolLike(s: string): boolean {
  return SCHOOL.test(s);
}

/** "Co-Founder & CTO" → ["Co-Founder", "CTO"]; a role that isn't a list of roles stays whole. */
export function splitRoles(role: string): string[] {
  const parts = role
    .split(/\s*(?:,|&|\/|\band\b)\s*/i)
    .map(tidy)
    .filter(Boolean);
  if (parts.length > 1 && parts.every((p) => isRoleLike(p) && words(p) <= 4)) return parts;
  return [role];
}

export interface WorkParts {
  org?: string;
  roles: string[];
  aliases: string[];
}

/**
 * A work label as the company and roles it names. `hint` says which the label is when it names only one: stored
 * `Organization` labels are companies, `Occupation` labels are roles. Handles "Role at Company", "Company — Role",
 * "Role — Company" and headlines ("Engineer at Handshake | ex-Slash": only the first segment is read).
 */
export function parseWork(label: string, hint: 'org' | 'role'): WorkParts {
  const { text, aliases } = stripAsides(label);
  const first = tidy(text.split(/\s+[|·•]\s+/)[0] ?? text);
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(first);
  if (at && (hint === 'role' || isRoleLike(at[1]!))) {
    return { org: tidy(at[2]!), roles: splitRoles(tidy(at[1]!)), aliases };
  }
  const dash = /^(.+?)(?:\s+[—–-]\s+|\s*—\s*)(.+)$/.exec(first);
  if (dash) {
    const a = tidy(dash[1]!);
    const b = tidy(dash[2]!);
    const aRole = isRoleLike(a);
    const bRole = isRoleLike(b);
    const roleFirst = aRole && !bRole ? true : bRole && !aRole ? false : hint === 'role';
    const [role, org] = roleFirst ? [a, b] : [b, a];
    return { org, roles: splitRoles(role), aliases };
  }
  return hint === 'org' ? { org: first, roles: [], aliases } : { roles: splitRoles(first), aliases };
}

/**
 * A list label as its items: "Programming languages: Python, TypeScript" → subtype "Programming languages" and two
 * items. Without a "Label:" prefix, a comma list splits only when every item is short, so a phrase with a comma in
 * it stays whole.
 */
export function splitList(label: string): { subtype?: string; items: string[] } {
  const clean = tidy(label);
  const prefixed = /^([A-Za-z][\w &/-]{1,40}):\s*(.+)$/.exec(clean);
  const body = prefixed ? prefixed[2]! : clean;
  const parts = body
    .split(/\s*[,;•·]\s*/)
    .map((p) =>
      tidy(p)
        .replace(/^(?:and|or)\s+/i, '')
        .replace(/\s+(?:etc|and more)$/i, ''),
    )
    .filter((p) => p && !/^(?:etc|and more|more)$/i.test(p));
  const split = parts.length > 1 && (prefixed || parts.every((p) => words(p) <= 3));
  const out: { subtype?: string; items: string[] } = { items: split ? parts : [prefixed ? body : clean] };
  if (prefixed) out.subtype = tidy(prefixed[1]!);
  return out;
}

const LEADING_VERB = /^(?:uses?|using|likes?|enjoys?|loves?|prefers?|into)\s+/i;
const VAGUE =
  /\b(?:self-described|involving|various|general(?:ly)?|broad|overall|balanced|stuff|things?|something|anything|kind of|sort of|misc(?:ellaneous)?|etc)\b/i;
const DANGLING = /\b(?:a|an|the|and|or|of|for|with|over|to|in|on|at|by|from|about|as|than)$/i;
const STATEMENT = /^(?:is|are|was|has|have|does|did|job|role|someone|person|tends?)\b/i;

/** Longest entity label, in words. Longer labels are sentences about the person, not things in their life. */
export const MAX_WORDS = 6;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** A skill or interest as an entity name: no leading verb ("uses automated testing" → "automated testing"). */
export function entityLabel(s: string): string {
  return tidy(tidy(s).replace(LEADING_VERB, ''));
}

/**
 * True for fragments that don't name a thing: too long, hedged ("self-described balanced or"), cut off mid-phrase
 * ("broad platform role over"), or a statement ("job involving complex tech").
 */
export function isVague(s: string): boolean {
  const t = tidy(s);
  if (t.length < 2 || !/[a-z]/i.test(t)) return true;
  if (words(t) > MAX_WORDS) return true;
  return VAGUE.test(t) || DANGLING.test(t) || STATEMENT.test(t);
}

/** Sentence case for lowercase phrases, leaving names and acronyms ("iOS", "PyTorch", "npm") alone. */
export function sentenceCase(s: string): string {
  const [first = '', ...rest] = s.split(' ');
  if (!rest.length || !/^[a-z][a-z-]{2,}$/.test(first)) return s;
  return [first[0]!.toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** Shortens a label to `max` characters at a word boundary, with an ellipsis. */
export function truncate(s: string, max = 22): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  // Back up to the last whole word, unless the cut already ends one.
  const space = s[max - 1] === ' ' ? -1 : cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

/** Content words of a label, for comparing roles: "Senior Software Engineer" → {senior, software, engineer}. */
export function tokens(s: string): Set<string> {
  return new Set(
    normKey(s)
      .split(' ')
      .filter((w) => w.length > 1 && !/^(?:and|of|the|for|at|in|on|a|an)$/.test(w)),
  );
}

import { z } from 'zod';
import { sha256Hex } from './hash';
import { specialAreasOfText } from './scope';
import type { SpecialArea } from './types';

/**
 * Footprint (ADR-0061): a person's own digital record, from exports they request themselves (an X archive, a
 * LinkedIn data export, a Reddit data request, GitHub, or notes they paste), turned into plain documents. Pure
 * functions on strings, so the browser can parse an archive without uploading it and the server only ever sees
 * what the person chose to send. Nothing here infers anything: documents become evidence only by way of questions
 * the person answers (`engine/footprint.ts`).
 *
 * Hygiene rules every parser applies through `clean()`:
 * - only the person's own words: other people's posts, replies quoted inline, direct messages and likes are never
 *   read, and @handles are replaced so a document never names another person;
 * - no URLs, emails or phone numbers;
 * - a document that touches a special-category area (politics, religion, sexuality, health) is dropped whole,
 *   because footprints may never populate a sensitive facet (ADR-0040) and a sentence about one is enough for a
 *   model to infer it (Staab et al., ICLR 2024).
 */

export const FOOTPRINT_SOURCES = ['x', 'linkedin', 'reddit', 'github', 'text'] as const;
export type FootprintSource = (typeof FOOTPRINT_SOURCES)[number];

export const FootprintDoc = z.object({
  /** Content hash, stable across parses of the same export. */
  id: z.string().min(1).max(64),
  source: z.enum(FOOTPRINT_SOURCES),
  kind: z.enum(['post', 'comment', 'profile', 'position', 'education', 'skills', 'repo', 'note']),
  /** When it was written, integer milliseconds (within Date's range); null when the export says nothing. */
  at: z.number().int().min(-8.64e15).max(8.64e15).nullable(),
  text: z.string().min(1).max(4000),
  /** Where it sat, for the person's own review: a subreddit, a repository, a company. */
  where: z.string().max(200).optional(),
});
export type FootprintDoc = z.infer<typeof FootprintDoc>;

export interface ParseReport {
  docs: FootprintDoc[];
  /** What the hygiene rules removed, by reason. */
  dropped: { empty: number; notOwn: number; sensitive: number; duplicate: number };
}

const MAX_TEXT = 4000;
const MIN_TEXT = 12;

/** Handles, URLs, emails and phone numbers, removed or replaced before anything is stored. */
export function scrubIdentifiers(text: string): string {
  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/(?<![\w/])@[A-Za-z0-9_]{2,}/g, '@someone')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Special-category areas a document touches (the fact lexicon plus the words a post would use). */
const SENSITIVE_WORDS: Array<{ area: SpecialArea; pattern: RegExp }> = [
  {
    area: 'politics',
    pattern:
      /\b(vot(e|es|ed|ing)|election|ballot|politic(s|al|ian)|left[- ]wing|right[- ]wing|socialis[mt]|immigration|abortion|gun control|parliament|congress|senat(e|or)|prime minister|president(ial)?)\b/i,
  },
  {
    area: 'religion',
    pattern:
      /\b(pray(s|ed|ing|er)?|god|allah|religio(n|us)|church|mosque|temple|synagogue|faith|worship|bible|quran|scripture|atheis[mt])\b/i,
  },
  {
    area: 'health',
    pattern:
      /\b(diagnos(is|ed)|medication|meds|doctor|illness|disease|symptom|therapy|therapist|mental health|pregnan\w*|disabilit(y|ies)|surgery|hospital|depress(ed|ion)|anxiety|sober|hangover|drunk|weed|smok(e|es|ing))\b/i,
  },
  {
    area: 'sexuality',
    pattern:
      /\b(sex|sexual(ity)?|intimate|intimacy|orientation|dating|hookup|one[- ]night stand|monogam\w*|polyamor\w*|girlfriend|boyfriend)\b/i,
  },
];

export function sensitiveAreasOf(text: string): SpecialArea[] {
  const out = new Set<SpecialArea>(specialAreasOfText(text));
  for (const { area, pattern } of SENSITIVE_WORDS) if (pattern.test(text)) out.add(area);
  return [...out].sort();
}

/** The person's own text only: quoted replies and forwarded lines are cut; a retweet or share of others is not own. */
export function ownWordsOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(>|RT\b|\|)/.test(l))
    .join('\n')
    .trim();
}

interface RawDoc {
  source: FootprintSource;
  kind: FootprintDoc['kind'];
  at: number | null;
  text: string;
  where?: string;
  /** False for content that is not the person's (a retweet, a share of someone else's post). */
  own?: boolean;
}

/** Applies the hygiene rules and builds the documents; the report says what was dropped and why. */
export function clean(raws: RawDoc[]): ParseReport {
  const dropped = { empty: 0, notOwn: 0, sensitive: 0, duplicate: 0 };
  const seen = new Set<string>();
  const docs: FootprintDoc[] = [];
  for (const r of raws) {
    if (r.own === false) {
      dropped.notOwn++;
      continue;
    }
    const text = scrubIdentifiers(ownWordsOnly(r.text)).slice(0, MAX_TEXT);
    if (text.length < MIN_TEXT) {
      dropped.empty++;
      continue;
    }
    if (sensitiveAreasOf(text).length) {
      dropped.sensitive++;
      continue;
    }
    const norm = text.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(norm)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(norm);
    docs.push({
      id: sha256Hex(`${r.source}|${r.kind}|${norm}`).slice(0, 24),
      source: r.source,
      kind: r.kind,
      at: r.at,
      text,
      ...(r.where ? { where: r.where.slice(0, 200) } : {}),
    });
  }
  return { docs, dropped };
}

const toMs = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

// X / Twitter archive: data/tweets.js is `window.YTD.tweets.part0 = [ { tweet: {...} }, ... ]`

const XTweet = z.object({
  tweet: z.object({
    id_str: z.string().optional(),
    full_text: z.string(),
    created_at: z.string().optional(),
    in_reply_to_status_id_str: z.string().optional(),
    retweeted: z.boolean().optional(),
  }),
});

/** Strips the `window.YTD.<name>.part0 = ` prefix an archive file carries and parses the JSON array. */
export function parseYtd(js: string): unknown[] {
  const i = js.indexOf('=');
  const body = i >= 0 && /^\s*window\.YTD\./.test(js) ? js.slice(i + 1) : js;
  const parsed = JSON.parse(body.trim()) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

/** The person's own tweets. Retweets are someone else's words; replies keep only the person's side. */
export function parseXArchive(tweetsJs: string, opts: { replies?: boolean } = {}): ParseReport {
  const raws: RawDoc[] = [];
  for (const item of parseYtd(tweetsJs)) {
    const r = XTweet.safeParse(item);
    if (!r.success) continue;
    const t = r.data.tweet;
    const retweet = t.retweeted === true || /^RT @/i.test(t.full_text);
    if (!retweet && t.in_reply_to_status_id_str && !opts.replies) continue;
    raws.push({
      source: 'x',
      kind: t.in_reply_to_status_id_str ? 'comment' : 'post',
      at: toMs(t.created_at),
      text: t.full_text,
      own: !retweet,
    });
  }
  return clean(raws);
}

// CSV (LinkedIn and Reddit exports)

/** A small RFC 4180 reader: quoted fields, doubled quotes, CRLF. Returns rows of strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Rows as objects keyed by a header row, header names trimmed and lowercased. */
export function csvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export interface LinkedInExport {
  /** Profile.csv: First Name, Last Name, Headline, Summary, Industry, ... */
  profile?: string;
  /** Positions.csv: Company Name, Title, Description, Location, Started On, Finished On */
  positions?: string;
  /** Education.csv: School Name, Degree Name, Notes, Start Date, End Date */
  education?: string;
  /** Skills.csv: Name */
  skills?: string;
  /** Shares.csv: Date, ShareLink, ShareCommentary, SharedUrl, MediaUrl, Visibility */
  shares?: string;
}

/** The person's LinkedIn data export (Settings → Get a copy of your data). Names are never read. */
export function parseLinkedIn(files: LinkedInExport): ParseReport {
  const raws: RawDoc[] = [];
  for (const p of files.profile ? csvRecords(files.profile) : []) {
    const text = [p.headline, p.summary].filter(Boolean).join('\n');
    if (text)
      raws.push({ source: 'linkedin', kind: 'profile', at: null, text, where: p.industry || undefined });
  }
  for (const r of files.positions ? csvRecords(files.positions) : []) {
    const span = [r['started on'], r['finished on'] || 'now'].filter(Boolean).join(' – ');
    const head = [r.title, r['company name'] ? `at ${r['company name']}` : ''].filter(Boolean).join(' ');
    const text = [head && `${head}${span ? ` (${span})` : ''}`, r.description].filter(Boolean).join('\n');
    if (text)
      raws.push({
        source: 'linkedin',
        kind: 'position',
        at: toMs(r['started on']),
        text,
        where: r['company name'] || undefined,
      });
  }
  for (const e of files.education ? csvRecords(files.education) : []) {
    const text = [[e['degree name'], e['school name']].filter(Boolean).join(', '), e.notes]
      .filter(Boolean)
      .join('\n');
    if (text)
      raws.push({
        source: 'linkedin',
        kind: 'education',
        at: toMs(e['start date']),
        text,
        where: e['school name'] || undefined,
      });
  }
  const skills = files.skills
    ? csvRecords(files.skills)
        .map((s) => s.name)
        .filter(Boolean)
    : [];
  if (skills.length)
    raws.push({ source: 'linkedin', kind: 'skills', at: null, text: `Skills: ${skills.join(', ')}` });
  for (const s of files.shares ? csvRecords(files.shares) : []) {
    // A share with no commentary is someone else's content: it is counted and dropped as empty.
    raws.push({ source: 'linkedin', kind: 'post', at: toMs(s.date), text: s.sharecommentary ?? '' });
  }
  return clean(raws);
}

export interface RedditExport {
  /** posts.csv: id, permalink, date, ip, subreddit, gildings, title, url, body */
  posts?: string;
  /** comments.csv: id, permalink, date, ip, subreddit, gildings, link, parent, body */
  comments?: string;
}

/** The person's Reddit data request. Posts and comments only; votes, saved items and chats are not read. */
export function parseReddit(files: RedditExport): ParseReport {
  const raws: RawDoc[] = [];
  for (const p of files.posts ? csvRecords(files.posts) : []) {
    const text = [p.title, p.body].filter(Boolean).join('\n');
    if (text)
      raws.push({ source: 'reddit', kind: 'post', at: toMs(p.date), text, where: p.subreddit || undefined });
  }
  for (const c of files.comments ? csvRecords(files.comments) : []) {
    if (c.body)
      raws.push({
        source: 'reddit',
        kind: 'comment',
        at: toMs(c.date),
        text: c.body,
        where: c.subreddit || undefined,
      });
  }
  return clean(raws);
}

const GitHubRepo = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  fork: z.boolean().optional(),
  stargazers_count: z.number().optional(),
  pushed_at: z.string().optional(),
  created_at: z.string().optional(),
});

export interface GitHubExport {
  /** GET /user: bio, company, blog, ... */
  user?: { bio?: string | null };
  /** GET /user/repos */
  repos?: unknown[];
}

/** The person's own public repositories and bio (forks are other people's work). */
export function parseGitHub(data: GitHubExport): ParseReport {
  const raws: RawDoc[] = [];
  if (data.user?.bio) raws.push({ source: 'github', kind: 'profile', at: null, text: data.user.bio });
  for (const item of data.repos ?? []) {
    const r = GitHubRepo.safeParse(item);
    if (!r.success) continue;
    const repo = r.data;
    const parts = [
      `Repository ${repo.name}${repo.language ? ` (${repo.language})` : ''}${repo.stargazers_count ? `, ${repo.stargazers_count} stars` : ''}`,
      repo.description ?? '',
      repo.topics?.length ? `Topics: ${repo.topics.join(', ')}` : '',
    ].filter(Boolean);
    raws.push({
      source: 'github',
      kind: 'repo',
      at: toMs(repo.pushed_at ?? repo.created_at),
      text: parts.join('\n'),
      where: repo.name,
      own: repo.fork !== true,
    });
  }
  return clean(raws);
}

/** Free text the person pastes (notes, a bio, journal lines): one document per paragraph. */
export function parseText(text: string, source: FootprintSource = 'text'): ParseReport {
  return clean(
    text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ source, kind: 'note' as const, at: null, text: p })),
  );
}

/** Rough tokens of a document set (four characters each). */
export const footprintTokens = (docs: FootprintDoc[]) =>
  docs.reduce((a, d) => a + Math.ceil(d.text.length / 4), 0);

/**
 * The most recent documents that fit a token budget (recency first: a footprint ages, and recent words predict
 * better than old ones; Marengo et al. 2025). Undated documents count as oldest.
 */
export function selectDocs(docs: FootprintDoc[], budgetTokens: number): FootprintDoc[] {
  const ordered = [...docs].sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
  const out: FootprintDoc[] = [];
  let used = 0;
  for (const d of ordered) {
    const t = Math.ceil(d.text.length / 4);
    if (used + t > budgetTokens) continue;
    used += t;
    out.push(d);
  }
  return out;
}

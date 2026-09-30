import type { Distribution, PublicQuestion, UiSnapshot } from '@mimic/core';
import { certaintyTier, facetReading } from '@mimic/core/labels';
import { hostLabel } from '@mimic/core/links';
import type { IdentityView } from './api';

/** View helpers for the session v2 design: readings, certainty tiers, fact rows and "What changed". */

export type Facet = UiSnapshot['facets'][number];
export type Certainty = 'high' | 'medium' | 'low' | 'none';

export const pct = (x: number) => Math.round(x * 100);

/** Expected position (1–5) of a distribution over the ordered keys. */
export function expectedPoint(keys: string[], dist: Record<string, number>): number {
  const tot = keys.reduce((a, k) => a + (dist[k] ?? 0), 0) || 1;
  return keys.reduce((a, k, i) => a + (dist[k] ?? 0) * (i + 1), 0) / tot;
}

export interface Verdict {
  tone: 'moss' | 'slate' | 'rust';
  /** One word for compact places: Matched, Close or Missed. */
  word: 'Matched' | 'Close' | 'Missed';
  text: string;
}

/**
 * How the person's answer compares with the mimic's guess: matched, close (a scale within one step of the expected
 * point) or missed. Shared by the session reveal and the mimic page.
 */
export function verdictOf(
  q: Pick<PublicQuestion, 'type' | 'options'>,
  guess: { optionKey: string; label: string; p: number; dist: Distribution },
  picked: string,
): Verdict {
  const p = pct(guess.p);
  const match = guess.optionKey === picked;
  if (q.type === 'score') {
    const keys = q.options.map((o) => o.key);
    const exp = Math.round(expectedPoint(keys, guess.dist));
    const mine = keys.indexOf(picked) + 1;
    if (match)
      return { tone: 'moss', word: 'Matched', text: `Matched. Your mimic guessed ${mine} too (${p}%).` };
    if (Math.abs(mine - exp) <= 1)
      return { tone: 'slate', word: 'Close', text: `Close. Your mimic expected about ${exp}.` };
    return { tone: 'rust', word: 'Missed', text: `Missed. Your mimic expected about ${exp}.` };
  }
  if (match) return { tone: 'moss', word: 'Matched', text: `Matched. Your mimic guessed this too (${p}%).` };
  return { tone: 'rust', word: 'Missed', text: `Missed. Your mimic guessed “${guess.label}” (${p}%).` };
}

export function sentence(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Jev's confidence in the trait read, shown as a tier (never as accuracy; PLAN §9.10). */
export function certaintyOf(f: Facet): Certainty {
  if (f.mean === null || f.certainty === null) return 'none';
  return certaintyTier(f.certainty);
}

/** The facet's current reading, e.g. "leans toward the familiar". */
export function readingOf(f: Facet): string {
  if (f.mean === null) return 'Not enough answers yet.';
  return facetReading(f.labels, f.mean);
}

/** Width of the certainty band on the 0–1 track: narrow when certain. */
export function bandOf(f: Facet): number {
  if (f.certainty === null) return 1;
  return Math.max(0.1, Math.min(0.9, 1 - f.certainty));
}

const PREDICATE: Record<string, (o: string) => string> = {
  headline: (o) => o,
  jobTitle: (o) => o,
  worksAt: (o) => `Works at ${o}`,
  workedAt: (o) => `Previously at ${o}`,
  educatedAt: (o) => `Studied at ${o}`,
  hasSkill: (o) => `Skilled in ${o}`,
  created: (o) => o,
  hasInterest: (o) => `Interested in ${o}`,
  livesIn: (o) => `Lives in ${o}`,
  knowsAbout: (o) => `Knows about ${o}`,
};

export type Fact = IdentityView['facts'][number];

export interface FactRow {
  id: string;
  text: string;
  source: string;
  url: string | null;
  removed: boolean;
}

export function factRows(facts: Fact[]): { profile: FactRow[]; told: FactRow[] } {
  const row = (f: Fact): FactRow => ({
    id: f.id,
    text: sentence((PREDICATE[f.predicate] ?? ((o: string) => o))(f.object)),
    source:
      f.source === 'search'
        ? f.sourceUrl
          ? hostLabel(f.sourceUrl)
          : 'Public profile'
        : f.source === 'intake'
          ? 'You, at sign-up'
          : 'From your answers',
    url: f.source === 'search' ? f.sourceUrl : null,
    removed: f.userState === 'removed',
  });
  return {
    profile: facts.filter((f) => f.source === 'search').map(row),
    told: facts.filter((f) => f.source !== 'search').map(row),
  };
}

/** Anchor/adaptive seq most recently answered, from the facets it touched. */
export function lastAnsweredSeq(s: UiSnapshot): number | null {
  let max: number | null = null;
  for (const f of s.facets) for (const seq of f.supporting) if (max === null || seq > max) max = seq;
  return max;
}

export interface Change {
  /** The answer the change follows, e.g. “Fix it yourself”. */
  after: string;
  rows: Array<{ k: string; v: string }>;
  /** Facets whose estimate moved: id → previous position. */
  moved: Map<string, number>;
  newInsights: Set<string>;
}

/**
 * "What changed" after an answer: the score, facets that moved or got more certain, and new insights. Learning
 * runs in the background, so this is recomputed as fresher snapshots arrive.
 */
export function whatChanged(
  before: UiSnapshot,
  after: UiSnapshot,
  answer: { label: string; match: boolean | null },
): Change {
  const rows: Change['rows'] = [];
  const b = before.fidelity;
  const a = after.fidelity;
  const scored = after.progress.answered >= after.progress.basics;
  if (scored && a && b && after.history.length > before.history.length) {
    const from = pct(b.fidelity);
    const to = pct(a.fidelity);
    const d = to - from;
    const why = answer.match === null ? 'after your answer' : answer.match ? 'after a match' : 'after a miss';
    const pts = `${Math.abs(d)} point${Math.abs(d) === 1 ? '' : 's'}`;
    rows.push({
      k: 'Score',
      v: d === 0 ? `${to}%. No change ${why}.` : `${from}% → ${to}%. ${d > 0 ? 'Up' : 'Down'} ${pts} ${why}.`,
    });
  }
  const prev = new Map(before.facets.map((f) => [f.id, f]));
  const moved = new Map<string, number>();
  const facetRows: Change['rows'] = [];
  for (const f of after.facets) {
    const p = prev.get(f.id);
    if (!p || f.mean === null) continue;
    if (p.mean !== null && Math.abs(f.mean - p.mean) >= 0.02) {
      moved.set(f.id, p.mean);
      facetRows.push({
        k: sentence(f.name),
        v: `Moved toward ${lowerFirst(f.mean > p.mean ? f.high : f.low)}`,
      });
    } else if (p.mean === null) {
      facetRows.push({ k: sentence(f.name), v: `First read: ${readingOf(f)}` });
    } else if ((f.certainty ?? 0) - (p.certainty ?? 0) >= 0.05) {
      facetRows.push({ k: sentence(f.name), v: `More certain: ${readingOf(f)}` });
    }
  }
  rows.push(...facetRows.slice(0, 2));
  const had = new Set(before.insights.map((i) => i.id));
  const fresh = after.insights.filter((i) => !had.has(i.id));
  if (fresh[0]) rows.push({ k: 'New insight', v: fresh[0].text });
  return { after: `After “${answer.label}”`, rows, moved, newInsights: new Set(fresh.map((i) => i.id)) };
}

/** Answer text for an evidence chip, cut to about 24 characters. */
export function chipText(s: string): string {
  return s.length > 24 ? `${s.slice(0, 22).trimEnd()}…` : s;
}

/** After a reload there is no in-page baseline: the score change since the previous answer, from the history. */
export function changeFromHistory(s: UiSnapshot): Change | null {
  const h = s.history;
  if (s.progress.answered < s.progress.basics || h.length < 2) return null;
  const from = pct(h[h.length - 2]!.fidelity);
  const to = pct(h[h.length - 1]!.fidelity);
  const d = to - from;
  const pts = `${Math.abs(d)} point${Math.abs(d) === 1 ? '' : 's'}`;
  return {
    after: 'After your last answer',
    rows: [
      {
        k: 'Score',
        v: d === 0 ? `${to}%. No change.` : `${from}% → ${to}%. ${d > 0 ? 'Up' : 'Down'} ${pts}.`,
      },
    ],
    moved: new Map(),
    newInsights: new Set(),
  };
}

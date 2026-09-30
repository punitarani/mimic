import { z } from 'zod/mini';
import { norm } from './norm.mjs';

export { norm };

/**
 * Suggestions for the location and occupation fields on `/new` (ADR-0030). The datasets are static files built by
 * `scripts/autocomplete/gen.mjs`. Each is fetched the first time its field is focused, then searched in memory.
 * Suggestions only complete the text field: people can still type a place or title that isn't listed.
 */

export type Suggestion = {
  /** What goes into the field, e.g. "Cambridge, Massachusetts, United States". */
  value: string;
  /** The kind shown beside it: "City", "State", "Country"; empty for job titles. */
  detail: string;
};

export type Finder = (query: string, limit?: number) => Suggestion[];

const aliases = z.array(z.string());
export const PlacesFile = z.object({
  version: z.literal(1),
  sources: z.array(z.string()),
  // [name, iso2, iso3, population, aliases]
  countries: z.array(z.tuple([z.string(), z.string(), z.string(), z.number(), aliases])),
  // [name, countryIndex, type, code, population, abbreviations?]
  regions: z.array(
    z.tuple([z.string(), z.number(), z.string(), z.string(), z.number(), z.optional(aliases)]),
  ),
  // [name, countryIndex, regionIndex or -1, population, aliases?]
  cities: z.array(z.tuple([z.string(), z.number(), z.number(), z.number(), z.optional(aliases)])),
});
export type PlacesFile = z.infer<typeof PlacesFile>;

export const OccupationsFile = z.object({
  version: z.literal(1),
  sources: z.array(z.string()),
  // [title, 1 if O*NET's My Next Move shows it (the more common titles)]
  titles: z.array(z.tuple([z.string(), z.union([z.literal(0), z.literal(1)])])),
});
export type OccupationsFile = z.infer<typeof OccupationsFile>;

type Entry = {
  value: string;
  detail: string;
  /** Normalized name, then aliases: a whole match ranks higher, a prefix matches. */
  names: string[];
  /** Normalized abbreviations ("tx", "nsw"): match only in full, without the whole-name boost. */
  abbr: string[];
  /** Words of the name, for words in any order ("engineer software"). */
  words: string[];
  /** Words of the region and country, for "paris, france" or "cambridge ma". Shared arrays, not copied. */
  context: string[][];
  rank: number;
  /** Whether a whole-name match multiplies the rank (not for states: "new york" means the city). */
  boost: boolean;
};

/** A query, normalized and split once rather than for every entry. */
type Query = {
  q: string;
  word: string;
  tokens: string[];
  /** For "cambridge ma": each way to split the words into a name part and a region or country part. */
  splits: Array<{ head: string; word: string; rest: string[] }>;
};

function prepare(query: string): Query | null {
  const q = norm(query);
  if (!q) return null;
  const tokens = q.split(' ').slice(0, 8);
  const splits = [];
  for (let k = tokens.length - 1; k >= 1; k--) {
    const head = tokens.slice(0, k).join(' ');
    splits.push({ head, word: ` ${head}`, rest: tokens.slice(k) });
  }
  return { q, word: ` ${q}`, tokens, splits };
}

/** A whole-name match counts this many times a prefix: "Paris" beats "Parisis", "georgia" the country first. */
const EXACT = 3;

/**
 * Scores an entry: tier 0 the start of a name or alias (or a whole abbreviation), 1 the start of a word inside the
 * name, 2 a name followed by its region or country, or all words in any order. null is no match.
 */
function score(e: Entry, p: Query): { tier: number; rank: number } | null {
  let tier = 3;
  let rank = e.rank;
  for (const n of e.names) {
    if (n === p.q) return { tier: 0, rank: e.boost ? e.rank * EXACT : e.rank };
    if (n.startsWith(p.q)) tier = 0;
    else if (tier > 1 && n.includes(p.word)) tier = 1;
  }
  if (tier > 0 && e.abbr.includes(p.q)) {
    tier = 0;
    rank = e.rank;
  }
  if (tier < 3) return { tier, rank };
  if (p.tokens.length < 2) return null;
  for (const s of p.splits) {
    if (!e.context.length) break;
    if (!e.names.some((n) => n.startsWith(s.head) || n.includes(s.word))) continue;
    if (s.rest.every((t) => e.context.some((ws) => ws.some((w) => w.startsWith(t)))))
      return { tier: 2, rank };
  }
  if (p.tokens.every((t) => e.words.some((w) => w.startsWith(t)))) return { tier: 2, rank };
  return null;
}

function finder(entries: Entry[]): Finder {
  // Every match starts a word of a name or abbreviation with the query's first word, so only entries with a word
  // starting with its first one or two letters need scoring.
  const index = new Map<string, Entry[]>();
  for (const e of entries) {
    const keys = new Set<string>();
    for (const n of [...e.names, ...e.abbr])
      for (const w of n.split(' ')) {
        if (!w) continue;
        keys.add(w.slice(0, 1));
        if (w.length > 1) keys.add(w.slice(0, 2));
      }
    for (const k of keys) {
      const list = index.get(k);
      if (list) list.push(e);
      else index.set(k, [e]);
    }
  }
  return (query, limit = 8) => {
    const p = prepare(query);
    if (!p) return [];
    const hits: Array<{ e: Entry; tier: number; rank: number }> = [];
    for (const e of index.get(p.tokens[0]!.slice(0, 2)) ?? []) {
      const s = score(e, p);
      if (s) hits.push({ e, ...s });
    }
    hits.sort((a, b) => a.tier - b.tier || b.rank - a.rank);
    return hits.slice(0, limit).map(({ e }) => ({ value: e.value, detail: e.detail }));
  };
}

/** Subdivision types as shown, except those that would read as another kind of place. */
function regionKind(type: string): string {
  if (!type) return 'Region';
  if (type === 'country') return 'Nation'; // England, Scotland…
  return type[0]!.toUpperCase() + type.slice(1);
}

/** A state's population is its cities', so it ranks below a city of the same size. */
const REGION_WEIGHT = 0.4;
const CITYLIKE = /\b(city|town|village)\b/;

export function placeFinder(data: PlacesFile): Finder {
  // Entries that read the same after normalizing are one suggestion: "Tokyo, Japan" is a city and a prefecture,
  // "İstanbul" and "Istanbul" are one place. The city's spelling and kind win.
  const byKey = new Map<string, Entry & { city: boolean }>();
  /** `key` is norm(value), built from parts already normalized. */
  const add = (key: string, e: Entry & { city: boolean }) => {
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
      return;
    }
    const base = prev.city !== e.city ? (e.city ? e : prev) : prev.rank >= e.rank ? prev : e;
    byKey.set(key, {
      ...base,
      names: [...new Set([...base.names, ...prev.names, ...e.names])],
      abbr: [...new Set([...prev.abbr, ...e.abbr])],
      rank: Math.max(prev.rank, e.rank),
    });
  };
  const words = (...xs: string[]) => xs.flatMap((x) => norm(x).split(' ')).filter(Boolean);

  const countries = data.countries.map(([name, iso2, iso3, pop, alts]) => {
    const n = norm(name);
    add(n, {
      value: name,
      detail: 'Country',
      names: [n, ...alts.map(norm)],
      abbr: [],
      words: n.split(' '),
      context: [],
      rank: pop,
      boost: true,
      city: false,
    });
    // Codes are context only ("paris fr"): as names, "ma" or "to" would put Morocco or Tonga first.
    return { name, n, words: [...words(name, ...alts), norm(iso2), norm(iso3)] };
  });

  const cityN = data.cities.map(([name]) => norm(name));
  const cityNames = new Set(data.cities.map(([, ci], i) => `${ci}:${cityN[i]}`));
  const regions = data.regions.map(([name, ci, type, code, pop, abbr = []]) => {
    const country = countries[ci];
    if (!country) throw new Error(`Place data: region ${name} has no country ${ci}`);
    const n = norm(name);
    // A subdivision that is a city ("Kyiv", type city) is offered as the city.
    const skip = n === country.n || (CITYLIKE.test(type) && cityNames.has(`${ci}:${n}`));
    if (!skip) {
      add(`${n} ${country.n}`, {
        value: `${name}, ${country.name}`,
        detail: regionKind(type),
        names: [n],
        abbr: abbr.map(norm),
        words: n.split(' '),
        context: [country.words],
        rank: pop * REGION_WEIGHT,
        boost: false,
        city: false,
      });
    }
    return { name, n, words: [...n.split(' '), ...(code ? [norm(code)] : [])] };
  });

  data.cities.forEach(([name, ci, ri, pop, alts = []], i) => {
    const country = countries[ci];
    if (!country) throw new Error(`Place data: city ${name} has no country ${ci}`);
    const region = ri >= 0 ? regions[ri] : undefined;
    if (ri >= 0 && !region) throw new Error(`Place data: city ${name} has no region ${ri}`);
    const n = cityN[i]!;
    // "Lisbon, Lisbon, Portugal" and "Copenhagen, Denmark, Denmark" read better without the region.
    const showRegion = region && region.n !== n && region.n !== country.n;
    add(showRegion ? `${n} ${region.n} ${country.n}` : `${n} ${country.n}`, {
      value: [name, showRegion ? region.name : null, country.name].filter(Boolean).join(', '),
      detail: 'City',
      names: [n, ...alts.map(norm)],
      abbr: [],
      words: n.split(' '),
      context: region ? [region.words, country.words] : [country.words],
      rank: pop,
      boost: true,
      city: true,
    });
  });
  return finder([...byKey.values()]);
}

export function occupationFinder(data: OccupationsFile): Finder {
  return finder(
    data.titles.map(([title, shown]) => {
      const n = norm(title);
      return {
        value: title,
        detail: '',
        names: [n],
        abbr: [],
        words: n.split(' '),
        context: [],
        boost: true,
        // Common titles first, then shorter ones: "Nurse" before "Nurse Anesthetist Educator". Positive, so the
        // whole-name boost raises it.
        rank: (shown + 1) * 1000 - title.length,
      };
    }),
  );
}

/**
 * Fetches, validates and indexes a dataset once. A failure is logged and forgotten, so the next focus tries again;
 * meanwhile the field is a plain input.
 */
function loader<T>(
  url: string,
  parse: (json: unknown) => T,
  build: (data: T) => Finder,
): () => Promise<Finder> {
  let pending: Promise<Finder> | null = null;
  return () => {
    pending ??= fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.json() as Promise<unknown>;
      })
      .then((json) => build(parse(json)))
      .catch((err: unknown) => {
        pending = null;
        console.warn('Autocomplete unavailable:', err);
        throw err;
      });
    return pending;
  };
}

export const loadPlaces = loader('/autocomplete/places.v1.json', (j) => PlacesFile.parse(j), placeFinder);
export const loadOccupations = loader(
  '/autocomplete/occupations.v1.json',
  (j) => OccupationsFile.parse(j),
  occupationFinder,
);

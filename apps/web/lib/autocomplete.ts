import { z } from 'zod';

/**
 * Client-side suggestions for the location and occupation fields on `/new` (ADR-0026). The datasets are static
 * files built by `scripts/gen-autocomplete.mjs`, fetched once on first use and searched in memory. Suggestions only
 * complete the text field: people can still type a place or title that isn't listed.
 */

export type Suggestion = {
  /** What goes into the field, e.g. "Cambridge, Massachusetts, United States". */
  value: string;
  /** Short kind shown beside it: "City", "State", "Country", a job title's empty string. */
  detail: string;
};

export type Finder = (query: string, limit?: number) => Suggestion[];

const PlacesFile = z.object({
  version: z.literal(1),
  sources: z.array(z.string()),
  // [name, iso2, iso3, population, aliases]
  countries: z.array(z.tuple([z.string(), z.string(), z.string(), z.number(), z.array(z.string())])),
  // [name, countryIndex, type, code, population]
  regions: z.array(z.tuple([z.string(), z.number().int(), z.string(), z.string(), z.number()])),
  // [name, countryIndex, regionIndex or -1, population]
  cities: z.array(z.tuple([z.string(), z.number().int(), z.number().int(), z.number()])),
});
export type PlacesFile = z.infer<typeof PlacesFile>;

const OccupationsFile = z.object({
  version: z.literal(1),
  sources: z.array(z.string()),
  // [title, shown in O*NET's My Next Move: 1 for the more common titles]
  titles: z.array(z.tuple([z.string(), z.union([z.literal(0), z.literal(1)])])),
});
export type OccupationsFile = z.infer<typeof OccupationsFile>;

/** Lower case, no diacritics or punctuation: "São Paulo" and "sao paulo" match. */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type Entry = {
  value: string;
  detail: string;
  /** Normalized name, and alternative names that also match from the start. */
  names: string[];
  /** Normalized words of the region and country, for "Paris, France" or "Cambridge MA". */
  context: string[];
  rank: number;
};

/**
 * Match tiers, best first: 0 the whole name (from four letters, so "san" still reaches San Francisco before San,
 * Mali), 1 the start of a name or alias, 2 the start of a word inside the name, 3 a name followed by its region or
 * country. Within a tier, larger places come first.
 */
function tier(e: Entry, q: string, tokens: string[]): number {
  const word = ` ${q}`;
  let best = 4;
  for (const n of e.names) {
    if (n === q && q.length >= 4) return 0;
    if (n.startsWith(q)) best = 1;
    else if (best > 2 && n.includes(word)) best = 2;
  }
  if (best < 4 || tokens.length < 2) return best;
  for (let k = tokens.length - 1; k >= 1; k--) {
    const head = tokens.slice(0, k).join(' ');
    if (!e.names.some((n) => n.startsWith(head) || n.includes(` ${head}`))) continue;
    if (tokens.slice(k).every((t) => e.context.some((c) => c.startsWith(t)))) return 3;
  }
  return 4;
}

function finder(entries: Entry[]): Finder {
  return (query, limit = 8) => {
    const q = norm(query);
    if (!q) return [];
    const tokens = q.split(' ');
    const hits: Array<{ e: Entry; t: number }> = [];
    for (const e of entries) {
      const t = tier(e, q, tokens);
      if (t < 4) hits.push({ e, t });
    }
    hits.sort((a, b) => a.t - b.t || b.e.rank - a.e.rank);
    return hits.slice(0, limit).map(({ e }) => ({ value: e.value, detail: e.detail }));
  };
}

function sentence(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** csc subdivision types, shown as-is except where they would read as a different kind of place. */
function regionKind(type: string): string {
  if (!type || type === 'country') return 'Region'; // England, Scotland…
  return sentence(type);
}

export function placeFinder(data: PlacesFile): Finder {
  const byValue = new Map<string, Entry>();
  // Entries that read the same are one suggestion ("Tokyo, Japan" is a city and a prefecture); call it a city.
  const add = (e: Entry) => {
    const prev = byValue.get(e.value);
    if (!prev) byValue.set(e.value, e);
    else
      byValue.set(e.value, {
        ...(prev.rank < e.rank ? e : prev),
        detail: [prev.detail, e.detail].includes('City') ? 'City' : prev.detail,
        rank: Math.max(prev.rank, e.rank),
      });
  };
  const words = (...xs: string[]) => xs.flatMap((x) => norm(x).split(' ')).filter(Boolean);
  const countries = data.countries.map(([name, iso2, iso3, pop, aliases]) => {
    const e: Entry = {
      value: name,
      detail: 'Country',
      names: [norm(name), ...aliases.map(norm)],
      context: [],
      rank: pop,
    };
    // Codes match only when typed in full ("uk", "usa"), so short prefixes still reach real names.
    const codes = [iso2, iso3].map(norm);
    add(e);
    return { name, e, codes, words: [...words(name, ...aliases), ...codes] };
  });
  const regions = data.regions.map(([name, ci, type, code, pop]) => {
    const country = countries[ci];
    if (!country) throw new Error(`Place data: region ${name} has no country ${ci}`);
    const code_ = code ? norm(code) : '';
    if (norm(name) !== norm(country.name)) {
      add({
        value: `${name}, ${country.name}`,
        detail: regionKind(type),
        names: [norm(name)],
        context: country.words,
        rank: pop,
      });
    }
    return { name, words: [...words(name), ...(code_ ? [code_] : [])] };
  });
  for (const [name, ci, ri, pop] of data.cities) {
    const country = countries[ci];
    if (!country) throw new Error(`Place data: city ${name} has no country ${ci}`);
    const region = ri >= 0 ? regions[ri] : undefined;
    if (ri >= 0 && !region) throw new Error(`Place data: city ${name} has no region ${ri}`);
    const n = norm(name);
    // "Lisbon, Lisbon, Portugal" and "Singapore, Central Singapore, Singapore" read better without the region.
    const showRegion = region && norm(region.name) !== n && n !== norm(country.name);
    add({
      value: [name, showRegion ? region.name : null, country.name].filter(Boolean).join(', '),
      detail: 'City',
      names: [n],
      context: [...(region?.words ?? []), ...country.words],
      rank: pop,
    });
  }
  const entries = [...byValue.values()];
  // Country codes: whole-word matches only, checked before the name search.
  const byCode = new Map<string, Entry>();
  for (const c of countries) for (const code of c.codes) byCode.set(code, c.e);
  const find = finder(entries);
  return (query, limit = 8) => {
    const code = byCode.get(norm(query));
    const hits = find(query, limit);
    if (!code || hits.some((h) => h.value === code.value)) return hits;
    return [{ value: code.value, detail: code.detail }, ...hits].slice(0, limit);
  };
}

export function occupationFinder(data: OccupationsFile): Finder {
  const entries: Entry[] = data.titles.map(([title, shown]) => ({
    value: title,
    detail: '',
    names: [norm(title)],
    context: [],
    // Common titles first, then shorter ones: "Nurse" before "Nurse Anesthetist Educator".
    rank: shown * 1000 - title.length,
  }));
  const find = finder(entries);
  return (query, limit = 8) => {
    const hits = find(query, limit);
    if (hits.length >= limit) return hits;
    // Words in any order: "engineer software" finds "Software Engineer".
    const tokens = norm(query).split(' ').filter(Boolean);
    if (tokens.length < 2) return hits;
    const seen = new Set(hits.map((h) => h.value));
    const more = entries
      .filter((e) => !seen.has(e.value))
      .filter((e) => {
        const ws = e.names[0]!.split(' ');
        return tokens.every((t) => ws.some((w) => w.startsWith(t)));
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit - hits.length)
      .map((e) => ({ value: e.value, detail: e.detail }));
    return [...hits, ...more];
  };
}

function loader<T>(url: string, schema: z.ZodType<T>, build: (data: T) => Finder): () => Promise<Finder> {
  let pending: Promise<Finder> | null = null;
  return () => {
    pending ??= fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.json();
      })
      .then((json) => build(schema.parse(json)))
      .catch((err: unknown) => {
        pending = null; // try again on the next focus
        throw err;
      });
    return pending;
  };
}

export const loadPlaces = loader('/autocomplete/places.v1.json', PlacesFile, placeFinder);
export const loadOccupations = loader('/autocomplete/occupations.v1.json', OccupationsFile, occupationFinder);

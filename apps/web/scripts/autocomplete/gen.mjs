#!/usr/bin/env node
/**
 * Builds the static autocomplete datasets for the `/new` form (ADR-0030):
 *
 *   public/autocomplete/places.v1.json       countries, states/provinces and cities
 *   public/autocomplete/occupations.v1.json  job titles
 *   lib/autocomplete-sources.json            the attribution `/credits` shows
 *
 * Sources:
 *   - Countries and subdivisions: @countrystatecity/countries (dr5hn, ODbL-1.0).
 *   - Cities: all-the-cities (GeoNames cities with population >= 1000, CC BY 4.0). Each city takes its state from the
 *     nearest same-named @countrystatecity city, so city and state names agree with the subdivision list.
 *   - Job titles: O*NET "Sample of Reported Titles" (USDOL/ETA, CC BY 4.0), plus a short supplement of titles O*NET
 *     does not list (student, founder, retired…). O*NET is not on npm: download the text file from
 *     https://www.onetcenter.org/database.html#individual-files and pass it with --onet. Without --onet the existing
 *     occupations file is kept.
 *
 * Usage: pnpm --filter @mimic/web gen:autocomplete [--onet "path/to/Sample of Reported Titles.txt" --onet-release 30.3]
 *
 * This directory is its own package, outside the pnpm workspace: the script installs its ~80 MB of source data on
 * demand, so CI and deploys never download it. The output is deterministic (sorted, no timestamps) and committed;
 * bump the file version when the format changes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { norm } from '../../lib/norm.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', '..');
const OUT = join(WEB, 'public', 'autocomplete');
const SOURCES = join(WEB, 'lib', 'autocomplete-sources.json');

/** Cities below this population are left out, except national and first-level capitals. */
const MIN_CITY_POP = 15_000;
/** GeoNames "section of populated place" (boroughs, districts) only when this large, e.g. Brooklyn. */
const MIN_SECTION_POP = 100_000;
const SKIP_FEATURES = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
const CAPITALS = new Set(['PPLC', 'PPLA']);
/** The server's limit on intake text fields (IntakeInput in packages/core/src/engine/identity.ts). */
const MAX_FIELD = 120;

/**
 * Countries whose GeoNames admin1 codes equal these subdivision codes. Only these subdivisions are kept: "Cambridge,
 * England" reads better than the county or borough the nearest-city match would give.
 */
const ADMIN1_BY_CODE = { GB: new Set(['ENG', 'SCT', 'WLS', 'NIR']) };
/**
 * Subdivisions that are also listed as countries. Those whose code is the other country's ISO code and whose name
 * starts with its name (Hong Kong SAR, Macau SAR, Puerto Rico…) are found automatically; these are the rest.
 */
const DROP_REGIONS = new Set(['CN:Taiwan', 'RS:Kosovo', 'RS:Kosovo-Metohija']);
/** Countries whose subdivision codes are everyday abbreviations: "tx", "ny", "on", "nsw". */
const ABBREVIATED = new Set(['US', 'CA', 'AU']);

/** Display names that read better than the database's, with the original kept as an alias. */
const COUNTRY_NAMES = {
  HK: 'Hong Kong',
  MO: 'Macau',
  PS: 'Palestine',
  VA: 'Vatican City',
};
/** Common alternative names people type. */
const COUNTRY_ALIASES = {
  US: ['USA', 'United States of America', 'America'],
  GB: ['UK', 'Great Britain', 'Britain'],
  AE: ['UAE'],
  KR: ['Korea'],
  CZ: ['Czechia'],
  NL: ['Holland'],
  CI: ["Côte d'Ivoire"],
  MM: ['Burma'],
  TR: ['Türkiye'],
  CV: ['Cabo Verde'],
  CD: ['DRC', 'DR Congo'],
};
/** By GeoNames ID: display names without commas, and names people type that GeoNames lacks. */
const CITY_NAMES = { 4140963: 'Washington' }; // "Washington, D.C." would read as city, region
const CITY_ALIASES = {
  4140963: ['Washington DC', 'DC'],
  5128581: ['NYC', 'New York'],
  5391959: ['SF', 'San Fran'],
  5368361: ['LA'],
  1277333: ['Bangalore'],
  703448: ['Kiev'],
  1275339: ['Bombay'],
  1264527: ['Madras'],
  1275004: ['Calcutta'],
  1566083: ['Saigon', 'HCMC'],
  1816670: ['Peking'],
};

function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/**
 * A 0.5° grid of points per country, for lookups within ~50 km. Longitude cells narrow towards the poles, so the
 * lookup widens with latitude, and columns wrap at the antimeridian.
 */
function grid(points) {
  const COLS = 720;
  const col = (lng) => ((Math.floor(lng * 2) % COLS) + COLS) % COLS;
  const cells = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.lat * 2)}:${col(p.lng)}`;
    const cell = cells.get(k);
    if (cell) cell.push(p);
    else cells.set(k, [p]);
  }
  return (lat, lng) => {
    const out = [];
    const r = Math.floor(lat * 2);
    const c = col(lng);
    const span = Math.min(COLS / 2, Math.ceil(1 / Math.max(Math.cos((lat * Math.PI) / 180), 0.05)));
    for (let i = -1; i <= 1; i++)
      for (let j = -span; j <= span; j++)
        for (const p of cells.get(`${r + i}:${(((c + j) % COLS) + COLS) % COLS}`) ?? []) out.push(p);
    return out;
  };
}

function places() {
  const root = join(dirname(require.resolve('@countrystatecity/countries')), 'data');
  const readJson = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

  const countriesRaw = readJson('countries.json').sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const countryIdx = new Map(countriesRaw.map((c, i) => [c.iso2, i]));
  const countryName = (iso2) => norm(COUNTRY_NAMES[iso2] ?? countriesRaw[countryIdx.get(iso2)]?.name ?? '');
  const duplicatesCountry = (s) =>
    DROP_REGIONS.has(`${s.country_code}:${s.name}`) ||
    (s.iso2 !== s.country_code &&
      countryIdx.has(s.iso2) &&
      countryName(s.iso2) !== '' &&
      norm(s.name).startsWith(countryName(s.iso2)));

  const regions = []; // { name, country, type, code, pop, aliases }
  const regionById = new Map();
  const cscCities = new Map(); // iso2 -> grid of { n, lat, lng, region }
  for (const dir of readdirSync(root).sort()) {
    if (!existsSync(join(root, dir, 'states.json'))) continue;
    const states = readJson(dir, 'states.json').sort(
      (a, b) => a.name.localeCompare(b.name, 'en') || a.id - b.id,
    );
    for (const s of states) {
      const country = countryIdx.get(s.country_code);
      if (country === undefined || duplicatesCountry(s)) continue;
      const only = ADMIN1_BY_CODE[s.country_code];
      if (only && !only.has(s.iso2)) continue;
      const code = /^[A-Z]{2,3}$/.test(s.iso2 ?? '') ? s.iso2 : '';
      regionById.set(s.id, regions.length);
      regions.push({
        name: s.name.trim(),
        country,
        type: s.type ?? '',
        code,
        pop: 0,
        aliases: code && ABBREVIATED.has(s.country_code) ? [code] : [],
      });
    }
    const pts = [];
    for (const sub of readdirSync(join(root, dir)).sort()) {
      const f = join(root, dir, sub, 'cities.json');
      if (!existsSync(f)) continue;
      for (const c of JSON.parse(readFileSync(f, 'utf8'))) {
        const region = regionById.get(c.state_id);
        if (region === undefined) continue;
        pts.push({ n: norm(c.name), lat: Number(c.latitude), lng: Number(c.longitude), region });
      }
    }
    if (states[0]) cscCities.set(states[0].country_code, grid(pts));
  }

  // Resolve each GeoNames city's region from the nearest matching @countrystatecity city, and learn a GeoNames
  // admin1 -> region mapping from the confident matches for cities that have no nearby match. Ties go to the lower
  // region index, so the result doesn't depend on file order.
  const geo = require('all-the-cities')
    .filter((c) => !SKIP_FEATURES.has(c.featureCode))
    .sort((a, b) => a.cityId - b.cityId);
  const votes = new Map(); // `${iso2}:${adminCode}` -> Map(region -> count)
  const byCode = new Map(regions.map((r, i) => [`${countriesRaw[r.country].iso2}:${r.code}`, i]));
  const closer = (d, region, bestD, best) => d < bestD || (d === bestD && region < best);
  const resolved = geo.map((c) => {
    if (ADMIN1_BY_CODE[c.country]) return byCode.get(`${c.country}:${c.adminCode}`) ?? -1;
    const near = cscCities.get(c.country);
    if (!near) return -1;
    const at = { lat: c.loc.coordinates[1], lng: c.loc.coordinates[0] };
    const n = norm(c.name);
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    let closest = -1;
    let closestD = Number.POSITIVE_INFINITY;
    for (const p of near(at.lat, at.lng)) {
      const d = km(at, p);
      if (p.n === n && d < 40 && closer(d, p.region, bestD, best)) {
        best = p.region;
        bestD = d;
      }
      if (closer(d, p.region, closestD, closest)) {
        closest = p.region;
        closestD = d;
      }
    }
    if (best >= 0) {
      const k = `${c.country}:${c.adminCode}`;
      const v = votes.get(k) ?? new Map();
      v.set(best, (v.get(best) ?? 0) + 1);
      votes.set(k, v);
      return best;
    }
    return closestD < 15 ? closest : null; // null: decide from the admin1 vote below
  });
  const byAdmin = new Map();
  for (const [k, v] of votes) {
    const total = [...v.values()].reduce((a, b) => a + b, 0);
    const [region, count] = [...v.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (count >= 3 && count / total >= 0.8) byAdmin.set(k, region);
  }

  const countries = countriesRaw.map((c) => {
    const name = (COUNTRY_NAMES[c.iso2] ?? c.name).trim();
    const aliases = [...(COUNTRY_ALIASES[c.iso2] ?? []), c.name, c.native ?? ''].filter(
      (a, i, xs) => a && norm(a) !== norm(name) && /[a-z]/i.test(a) && xs.indexOf(a) === i,
    );
    return [name, c.iso2, c.iso3, c.population ?? 0, aliases];
  });
  const countryNames = countries.map(([name, , , , aliases]) => new Set([name, ...aliases].map(norm)));

  const cities = new Map(); // label key -> city; dedupes GeoNames entries that would read the same
  geo.forEach((c, i) => {
    const country = countryIdx.get(c.country);
    if (country === undefined) return;
    const region = resolved[i] ?? byAdmin.get(`${c.country}:${c.adminCode}`) ?? -1;
    // Sections (boroughs) are inside a city that is already counted.
    if (region >= 0 && c.featureCode !== 'PPLX') regions[region].pop += c.population;
    const keep =
      CAPITALS.has(c.featureCode) ||
      c.population >= (c.featureCode === 'PPLX' ? MIN_SECTION_POP : MIN_CITY_POP);
    const name = (CITY_NAMES[c.cityId] ?? c.name).trim();
    // City-states (Singapore, Hong Kong, Monaco) are the country entry.
    if (!keep || countryNames[country].has(norm(name))) return;
    const key = `${norm(name)}|${region}|${country}`;
    const prev = cities.get(key);
    if (!prev || prev.pop < c.population)
      cities.set(key, { name, country, region, pop: c.population, aliases: CITY_ALIASES[c.cityId] ?? [] });
  });

  const cityRows = [...cities.values()]
    .sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'en'))
    .map((c) =>
      c.aliases.length
        ? [c.name, c.country, c.region, c.pop, c.aliases]
        : [c.name, c.country, c.region, c.pop],
    );
  const regionRows = regions.map((r) => {
    const row = [r.name, r.country, r.type, r.code, r.pop];
    return r.aliases.length ? [...row, r.aliases] : row;
  });

  return {
    version: 1,
    sources: [
      'Countries and subdivisions from the Countries States Cities Database by dr5hn, under the ODbL 1.0.',
      'Cities from GeoNames (geonames.org), under CC BY 4.0.',
    ],
    countries,
    regions: regionRows,
    cities: cityRows,
  };
}

/** Titles O*NET's reported-title sample lacks but people often give as their occupation. */
const EXTRA_TITLES = [
  'AI Researcher',
  'Artist',
  'Co-Founder',
  'Consultant',
  'Content Creator',
  'Data Scientist',
  'Entrepreneur',
  'Founder',
  'Freelancer',
  'Graduate Student',
  'Homemaker',
  'Investor',
  'Machine Learning Engineer',
  'Management Consultant',
  'PhD Student',
  'Postdoctoral Researcher',
  'Product Designer',
  'Research Scientist',
  'Researcher',
  'Retired',
  'Self-Employed',
  'Small Business Owner',
  'Stay-at-Home Parent',
  'Student',
  'Unemployed',
  'UX Designer',
  'Venture Capitalist',
  'Writer',
];

function occupations(onetPath, release) {
  const titles = new Map(); // lower-cased title -> [title, shown]
  const lines = readFileSync(onetPath, 'utf8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    // Tab-separated: O*NET-SOC code, reported title, shown in My Next Move (Y/N).
    const m = line.match(/^\d\d-\d{4}\.\d\d\s+(.+?)\s+([YN])\s*$/);
    if (!m) continue;
    const title = m[1].trim();
    if (title.length > MAX_FIELD) continue; // the server would reject it
    const key = title.toLowerCase();
    const shown = m[2] === 'Y' ? 1 : 0;
    const prev = titles.get(key);
    if (!prev || prev[1] < shown) titles.set(key, [title, shown]);
  }
  if (titles.size < 1000)
    throw new Error(`Parsed only ${titles.size} titles from ${onetPath}; is it the right file?`);
  for (const t of EXTRA_TITLES) if (!titles.has(t.toLowerCase())) titles.set(t.toLowerCase(), [t, 1]);
  return {
    version: 1,
    sources: [
      `Job titles include information from the O*NET ${release} Database by the U.S. Department of Labor, ` +
        'Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license, with titles added. ' +
        'USDOL/ETA has not approved, endorsed, or tested these modifications. O*NET® is a trademark of USDOL/ETA.',
    ],
    titles: [...titles.values()].sort((a, b) => a[0].localeCompare(b[0], 'en')),
  };
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(data)}\n`;
  writeFileSync(path, body);
  console.log(`${path.slice(WEB.length + 1)}: ${(body.length / 1024).toFixed(0)} KiB`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm forwards the separator
    options: { onet: { type: 'string' }, 'onet-release': { type: 'string', default: '30.3' } },
  });
  const p = places();
  write(join(OUT, 'places.v1.json'), p);
  console.log(`  ${p.countries.length} countries, ${p.regions.length} regions, ${p.cities.length} cities`);
  let o;
  if (values.onet) {
    o = occupations(values.onet, values['onet-release']);
    write(join(OUT, 'occupations.v1.json'), o);
    console.log(`  ${o.titles.length} titles`);
  } else {
    o = JSON.parse(readFileSync(join(OUT, 'occupations.v1.json'), 'utf8'));
    console.log('occupations.v1.json: kept (pass --onet to rebuild)');
  }
  // The attribution `/credits` renders, from the same strings as the data files.
  writeFileSync(SOURCES, `${JSON.stringify({ places: p.sources, occupations: o.sources }, null, 2)}\n`);
}

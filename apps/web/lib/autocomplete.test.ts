import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Finder,
  norm,
  OccupationsFile,
  occupationFinder,
  PlacesFile,
  placeFinder,
} from './autocomplete';
import sources from './autocomplete-sources.json';

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '..', 'public', 'autocomplete', name), 'utf8'));

const values = (find: Finder, q: string, n = 8) => find(q, n).map((s) => s.value);

describe('norm', () => {
  it('drops case, accents and punctuation', () => {
    expect(norm('São Paulo')).toBe('sao paulo');
    expect(norm('  Zürich,  CH ')).toBe('zurich ch');
    expect(norm('İstanbul')).toBe('istanbul');
  });

  it('folds letters NFD does not decompose', () => {
    expect(['Łódź', 'Wrocław', 'Diyarbakır', 'Tromsø', 'Gießen', 'Đà Nẵng'].map(norm)).toEqual([
      'lodz',
      'wroclaw',
      'diyarbakir',
      'tromso',
      'giessen',
      'da nang',
    ]);
  });
});

describe('placeFinder (fixture)', () => {
  const find = placeFinder({
    version: 1,
    sources: [],
    countries: [
      ['Portugal', 'PT', 'PRT', 10_000_000, []],
      ['United States', 'US', 'USA', 340_000_000, ['USA', 'America']],
      ['Morocco', 'MA', 'MAR', 37_000_000, []],
    ],
    regions: [
      ['Lisbon', 0, 'district', '', 2_000_000],
      ['Massachusetts', 1, 'state', 'MA', 7_000_000, ['MA']],
      ['Maine', 1, 'state', 'ME', 1_400_000, ['ME']],
      ['Portugal', 0, 'region', '', 1_000],
    ],
    cities: [
      ['Lisbon', 0, 0, 517_000],
      ['Cambridge', 1, 1, 110_000],
      ['Portland', 1, 2, 66_000],
      ['Lisbon', 1, 2, 9_000],
      ['New York City', 1, -1, 8_000_000, ['NYC', 'New York']],
    ],
  });

  it('offers cities, states and countries, with their kind', () => {
    expect(find('portugal')).toEqual([{ value: 'Portugal', detail: 'Country' }]);
    expect(find('massa')).toEqual([{ value: 'Massachusetts, United States', detail: 'State' }]);
    expect(find('cam')).toEqual([{ value: 'Cambridge, Massachusetts, United States', detail: 'City' }]);
  });

  it('never lets a country code outrank names that start with the query', () => {
    expect(values(find, 'ma')).toEqual(['Massachusetts, United States', 'Maine, United States']);
    expect(values(find, 'mor')).toEqual(['Morocco']);
    expect(values(find, 'pt')).toEqual([]);
  });

  it('matches state abbreviations and aliases in full', () => {
    expect(values(find, 'me')).toEqual(['Maine, United States']);
    expect(values(find, 'usa')).toEqual(['United States']);
    expect(values(find, 'nyc')).toEqual(['New York City, United States']);
  });

  it('ranks whole names, then bigger places', () => {
    expect(values(find, 'port')).toEqual(['Portugal', 'Portland, Maine, United States']);
    expect(values(find, 'lisbon')).toEqual(['Lisbon, Portugal', 'Lisbon, Maine, United States']);
  });

  it('leaves out a region that repeats the city or the country', () => {
    expect(values(find, 'lisbon', 1)).toEqual(['Lisbon, Portugal']);
    expect(values(find, 'portugal')).toEqual(['Portugal']);
  });

  it('narrows by region or country after the name', () => {
    expect(values(find, 'lisbon, maine')).toEqual(['Lisbon, Maine, United States']);
    expect(values(find, 'lisbon me')).toEqual(['Lisbon, Maine, United States']);
    expect(values(find, 'cambridge usa')).toEqual(['Cambridge, Massachusetts, United States']);
    expect(values(find, 'lisbon pt')).toEqual(['Lisbon, Portugal']);
  });

  it('returns nothing for an empty query or no match', () => {
    expect(find('  ')).toEqual([]);
    expect(find('xyzzy')).toEqual([]);
  });
});

describe('placeFinder (generated data)', () => {
  const data = PlacesFile.parse(read('places.v1.json'));
  const find = placeFinder(data);

  it.each([
    ['palo alto', 'Palo Alto, California, United States'],
    ['cambridge ma', 'Cambridge, Massachusetts, United States'],
    ['london', 'London, England, United Kingdom'],
    ['london, uk', 'London, England, United Kingdom'],
    ['sao paulo', 'São Paulo, Brazil'],
    ['california', 'California, United States'],
    ['bavaria', 'Bavaria, Germany'],
    ['germany', 'Germany'],
    ['uk', 'United Kingdom'],
    ['new york', 'New York City, New York, United States'],
    ['nyc', 'New York City, New York, United States'],
    ['tx', 'Texas, United States'],
    ['bangalore', 'Bengaluru, Karnataka, India'],
    ['lodz', 'Łódź, Poland'],
    ['wroclaw', 'Wrocław, Lower Silesia, Poland'],
    ['diyarbakir', 'Diyarbakır, Turkey'],
    ['georgia', 'Georgia'],
  ])('%s → %s', (q, top) => {
    expect(find(q)[0]?.value).toBe(top);
  });

  it('puts real names ahead of countries whose code is the query', () => {
    expect(values(find, 'to', 3)).toContain('Tokyo, Japan');
    expect(find('ch')[0]?.value).not.toBe('Switzerland');
    expect(find('va')[0]?.value).not.toBe('Vatican City');
  });

  it('labels each kind', () => {
    expect(find('texas')[0]).toEqual({ value: 'Texas, United States', detail: 'State' });
    expect(find('ontario')[0]).toEqual({ value: 'Ontario, Canada', detail: 'Province' });
    expect(find('japan')[0]).toEqual({ value: 'Japan', detail: 'Country' });
    expect(find('tokyo')[0]).toEqual({ value: 'Tokyo, Japan', detail: 'City' });
    expect(find('scotland')[0]).toEqual({ value: 'Scotland, United Kingdom', detail: 'Nation' });
  });

  it('lists places once, and a country only as a country', () => {
    expect(values(find, 'hong kong')).toEqual(['Hong Kong']);
    expect(values(find, 'singapore')).not.toContain('Singapore, Singapore');
    expect(values(find, 'istanbul').filter((v) => norm(v) === 'istanbul turkey')).toHaveLength(1);
    expect(values(find, 'kosovo')).not.toContain('Kosovo-Metohija, Serbia');
    expect(values(find, 'london', 20)).not.toContain('London, United Kingdom');
    expect(values(find, 'copenhagen')[0]).toBe('Copenhagen, Denmark');
  });

  it('fits every suggestion in the server limit', () => {
    for (const q of ['a', 'e', 'o', 'san', 'new'])
      for (const s of find(q, 50)) expect(s.value.length).toBeLessThan(120);
  });

  it('matches the attribution /credits shows', () => {
    expect(data.sources).toEqual(sources.places);
  });
});

describe('occupationFinder', () => {
  const data = OccupationsFile.parse(read('occupations.v1.json'));
  const find = occupationFinder(data);

  it('finds titles by prefix, word or any word order', () => {
    expect(values(find, 'software eng')).toContain('Software Engineer');
    expect(values(find, 'engineer software')).toContain('Software Engineer');
    expect(values(find, 'nurse')[0]).toBe('Nurse');
    expect(values(find, 'ceo')).toContain('CEO (Chief Executive Officer)');
  });

  it('includes titles O*NET lacks', () => {
    expect(values(find, 'student')[0]).toBe('Student');
    expect(values(find, 'founder')[0]).toBe('Founder');
    expect(values(find, 'data scien')).toContain('Data Scientist');
  });

  it('only offers titles the server accepts (120 characters)', () => {
    expect(Math.max(...data.titles.map(([t]) => t.length))).toBeLessThanOrEqual(120);
  });

  it('matches the attribution /credits shows', () => {
    expect(data.sources).toEqual(sources.occupations);
  });
});

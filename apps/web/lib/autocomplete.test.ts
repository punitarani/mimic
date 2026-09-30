import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Finder, norm, occupationFinder, placeFinder } from './autocomplete';

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '..', 'public', 'autocomplete', name), 'utf8'));

const values = (find: Finder, q: string, n = 8) => find(q, n).map((s) => s.value);

describe('norm', () => {
  it('drops case, accents and punctuation', () => {
    expect(norm('São Paulo')).toBe('sao paulo');
    expect(norm('  Zürich,  CH ')).toBe('zurich ch');
  });
});

describe('placeFinder (fixture)', () => {
  const find = placeFinder({
    version: 1,
    sources: [],
    countries: [
      ['Portugal', 'PT', 'PRT', 10_000_000, []],
      ['United States', 'US', 'USA', 340_000_000, ['USA', 'America']],
      ['Singapore', 'SG', 'SGP', 6_000_000, []],
    ],
    regions: [
      ['Lisbon', 0, 'district', '', 2_000_000],
      ['Massachusetts', 1, 'state', 'MA', 7_000_000],
      ['Maine', 1, 'state', 'ME', 1_400_000],
      ['Central Singapore', 2, 'region', '', 3_000_000],
    ],
    cities: [
      ['Lisbon', 0, 0, 517_000],
      ['Cambridge', 1, 1, 110_000],
      ['Portland', 1, 2, 66_000],
      ['Singapore', 2, 3, 3_500_000],
      ['Lisbon', 1, 2, 9_000],
    ],
  });

  it('offers cities, states and countries', () => {
    expect(find('ma')).toEqual([
      { value: 'Massachusetts, United States', detail: 'State' },
      { value: 'Maine, United States', detail: 'State' },
    ]);
    expect(find('portugal')).toEqual([{ value: 'Portugal', detail: 'Country' }]);
    expect(values(find, 'cam')).toEqual(['Cambridge, Massachusetts, United States']);
  });

  it('ranks exact names first, then larger places', () => {
    expect(values(find, 'port')).toEqual(['Portugal', 'Portland, Maine, United States']);
    expect(values(find, 'lisbon')).toEqual(['Lisbon, Portugal', 'Lisbon, Maine, United States']);
  });

  it('drops a region that repeats the city or the country is the city', () => {
    expect(values(find, 'lisbon', 1)).toEqual(['Lisbon, Portugal']);
    expect(values(find, 'singapore')).toContain('Singapore');
    expect(values(find, 'singapore')).not.toContain('Singapore, Central Singapore, Singapore');
  });

  it('narrows by region or country after the name', () => {
    expect(values(find, 'lisbon, maine')).toEqual(['Lisbon, Maine, United States']);
    expect(values(find, 'lisbon me')).toEqual(['Lisbon, Maine, United States']);
    expect(values(find, 'cambridge usa')).toEqual(['Cambridge, Massachusetts, United States']);
  });

  it('matches aliases, whole country codes and words inside a name', () => {
    expect(values(find, 'usa')[0]).toBe('United States');
    expect(values(find, 'amer')).toEqual(['United States']);
    expect(values(find, 'us')[0]).toBe('United States');
    expect(values(find, 'states')).toEqual(['United States']);
  });

  it('returns nothing for an empty query or no match', () => {
    expect(find('  ')).toEqual([]);
    expect(find('xyzzy')).toEqual([]);
  });
});

describe('placeFinder (generated data)', () => {
  const find = placeFinder(read('places.v1.json') as Parameters<typeof placeFinder>[0]);

  it.each([
    ['palo alto', 'Palo Alto, California, United States'],
    ['cambridge ma', 'Cambridge, Massachusetts, United States'],
    ['london', 'London, England, United Kingdom'],
    ['sao paulo', 'São Paulo, Brazil'],
    ['california', 'California, United States'],
    ['bavaria', 'Bavaria, Germany'],
    ['germany', 'Germany'],
    ['uk', 'United Kingdom'],
  ])('%s → %s', (q, top) => {
    expect(find(q)[0]?.value).toBe(top);
  });

  it('labels each kind', () => {
    expect(find('texas')[0]).toEqual({ value: 'Texas, United States', detail: 'State' });
    expect(find('ontario')[0]).toEqual({ value: 'Ontario, Canada', detail: 'Province' });
    expect(find('japan')[0]).toEqual({ value: 'Japan', detail: 'Country' });
    expect(find('tokyo')[0]).toEqual({ value: 'Tokyo, Japan', detail: 'City' });
  });
});

describe('occupationFinder', () => {
  const find = occupationFinder(read('occupations.v1.json') as Parameters<typeof occupationFinder>[0]);

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
});

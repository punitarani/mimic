import { describe, expect, it } from 'vitest';
import {
  hostLabel,
  IntakeInput,
  isWebLink,
  mergeCandidates,
  nameMatch,
  type PersonCandidate,
  profileKey,
  searchCacheKey,
  searchCacheKeys,
  searchQueries,
  withScheme,
} from '../src';

const person = (name: string, url: string): PersonCandidate => ({ provider: 'exa', name, url, summary: '' });

describe('identity search queries (ADR-0027)', () => {
  it('never quotes the name, and leads every query with it', () => {
    const qs = searchQueries({
      displayName: 'Rosa Ibarra',
      location: 'Claremont, CA',
      occupation: 'Neuroscience graduate',
      employer: 'Pomona College',
    });
    expect(qs).toEqual([
      'Rosa Ibarra, Neuroscience graduate at Pomona College, Claremont, CA',
      'Rosa Ibarra, Neuroscience graduate at Pomona College',
      'Rosa Ibarra',
    ]);
    for (const q of qs) expect(q).not.toContain('"');
  });

  it('uses whichever of occupation and employer it has', () => {
    const base = { displayName: 'Sam Lee', location: 'Austin, TX' };
    expect(searchQueries({ ...base, occupation: null, employer: 'Acme' })[1]).toBe('Sam Lee, Acme');
    expect(searchQueries({ ...base, occupation: 'Nurse', employer: null })[1]).toBe('Sam Lee, Nurse');
    expect(searchQueries({ ...base, occupation: null, employer: null })).toEqual([
      'Sam Lee, Austin, TX',
      'Sam Lee',
    ]);
  });

  it('never lets a blank occupation hide the employer or school', () => {
    const base = { displayName: 'Rosa Ibarra', location: 'Claremont, CA' };
    expect(searchQueries({ ...base, occupation: '  ', employer: 'Pomona College' })[1]).toBe(
      'Rosa Ibarra, Pomona College',
    );
    // And intake stores a blank field as absent in the first place.
    const input = IntakeInput.parse({
      name: 'Rosa Ibarra',
      location: 'Claremont, CA',
      occupation: '   ',
      employer: '',
      attestSelf: true,
      consentSearch: true,
      consentResearch: false,
    });
    expect(input.occupation).toBeUndefined();
    expect(input.employer).toBeUndefined();
  });
});

describe('nameMatch', () => {
  it('matches first and last names, ignoring case, accents and punctuation', () => {
    expect(nameMatch('Rosa Ibarra', 'Rosa Ibarra')).toBe(2);
    expect(nameMatch('Rosa Ibarra', 'rosa ibárra')).toBe(2);
    expect(nameMatch('Rosa Ibarra', 'Rosa M. Ibarra')).toBe(2);
  });

  it('counts a last initial that ends the name, as LinkedIn shows names outside your network', () => {
    expect(nameMatch('Rosa Ibarra', 'Rosa I.')).toBe(2);
    // A middle initial is not a last name.
    expect(nameMatch('Rosa Ibarra', 'Rosa I. Guerrero')).toBe(1);
  });

  it('ignores suffixes and apostrophes', () => {
    expect(nameMatch('John Smith Jr.', 'John Smith')).toBe(2);
    expect(nameMatch('John Smith', 'John Smith, PhD')).toBe(2);
    expect(nameMatch("Mike O'Brien", 'Michael OBrien')).toBe(1);
    expect(nameMatch("Mike O'Brien", 'Mike O’Brien')).toBe(2);
  });

  it('scores namesakes as partial and strangers as none', () => {
    expect(nameMatch('Rosa Ibarra', 'Rosa Ibanez')).toBe(1);
    expect(nameMatch('Rosa Ibarra', 'Pablo Ibarra')).toBe(1);
    expect(nameMatch('Rosa Ibarra', 'Giovanni Guerrero')).toBe(0);
    expect(nameMatch('Rosa Ibarra', 'Unknown')).toBe(0);
    expect(nameMatch('', 'Rosa Ibarra')).toBe(0);
  });
});

describe('profileKey', () => {
  it('treats the same profile under different URL spellings as one', () => {
    const k = profileKey('https://www.linkedin.com/in/rosa-ibarra');
    expect(profileKey('https://ca.linkedin.com/in/rosa-ibarra/')).toBe(k);
    expect(profileKey('linkedin.com/in/rosa-ibarra?trk=abc')).toBe(k);
    expect(profileKey('HTTP://LinkedIn.com/in/Rosa-Ibarra#about')).toBe(k);
    expect(profileKey('https://m.linkedin.com/in/rosa-ibarra')).toBe(k);
    expect(profileKey('https://www.linkedin.com/in/rosa-ibarra?originalSubdomain=ca')).toBe(k);
    expect(profileKey('https://www.rosa.dev/')).toBe('rosa.dev');
  });

  it('keeps query parameters that name the page, and path case outside LinkedIn', () => {
    const a = profileKey('https://www.facebook.com/profile.php?id=1');
    expect(profileKey('https://www.facebook.com/profile.php?id=2')).not.toBe(a);
    expect(profileKey('https://facebook.com/profile.php?utm_source=x&id=1')).toBe(a);
    expect(profileKey('https://example.com/People/Rosa')).toBe('example.com/People/Rosa');
  });
});

describe('link helpers', () => {
  it('accepts only http(s) links with a real host', () => {
    expect(isWebLink('https://linkedin.com/in/rosa')).toBe(true);
    expect(isWebLink('http://rosa.dev')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('https://localhost')).toBe(false);
    expect(isWebLink('not a link')).toBe(false);
  });

  it('adds a scheme only when one is missing, and labels hosts', () => {
    expect(withScheme(' linkedin.com/in/rosa ')).toBe('https://linkedin.com/in/rosa');
    expect(withScheme('HTTP://rosa.dev')).toBe('HTTP://rosa.dev');
    expect(withScheme('')).toBe('');
    expect(hostLabel('https://www.linkedin.com/in/rosa')).toBe('linkedin.com');
  });
});

describe('mergeCandidates', () => {
  it('drops strangers, puts full-name matches first and ranks by agreement across queries', () => {
    const merged = mergeCandidates('Rosa Ibarra', [
      [
        person('Giovanni Guerrero', 'https://linkedin.com/in/gg'),
        person('Rosa Ibanez', 'https://linkedin.com/in/ri2'),
        person('Rosa I.', 'https://linkedin.com/in/ri'),
      ],
      [
        person('Rosa Ibarra', 'https://linkedin.com/in/rosa'),
        person('Rosa I.', 'https://www.linkedin.com/in/ri/'),
      ],
    ]);
    expect(merged.map((c) => c.url)).toEqual([
      'https://linkedin.com/in/ri', // full match, found by both queries
      'https://linkedin.com/in/rosa', // full match, one query
      'https://linkedin.com/in/ri2', // namesake
    ]);
  });

  it("always keeps and leads with the profile at the person's own link", () => {
    const link = 'https://www.linkedin.com/in/rosa-work';
    const merged = mergeCandidates(
      'Rosa Ibarra',
      [[person('R. Work Profile', link)], [person('Rosa Ibarra', 'https://linkedin.com/in/rosa')]],
      'linkedin.com/in/rosa-work/',
    );
    expect(merged.map((c) => c.url)).toEqual([link, 'https://linkedin.com/in/rosa']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => person('Rosa Ibarra', `https://x.dev/${i}`));
    expect(mergeCandidates('Rosa Ibarra', [many], undefined, 10)).toHaveLength(10);
  });
});

describe('search cache keys', () => {
  it('change with the employer and the link, and hard delete can find every one', () => {
    const m = {
      displayName: 'Rosa Ibarra',
      location: 'Claremont',
      occupation: null,
      employer: null,
      links: [],
    };
    const withEmployer = { ...m, employer: 'Pomona College' };
    const withLink = { ...m, links: ['https://linkedin.com/in/rosa', 'https://rosa.dev'] };
    expect(searchCacheKey(withEmployer)).not.toBe(searchCacheKey(m));
    expect(searchCacheKey(withLink)).not.toBe(searchCacheKey(m));
    expect(searchCacheKey(m)).toMatch(/^search:v2:/);
    const all = searchCacheKeys(withLink);
    expect(all).toContain(searchCacheKey(m)); // searched before any link
    expect(all).toContain(searchCacheKey(withLink)); // newest link
    expect(all).toContain(searchCacheKey(withLink, 'https://rosa.dev')); // an earlier link
    expect(all.some((k) => /^search:[0-9a-f]{64}$/.test(k))).toBe(true); // the pre-v2 key
  });
});

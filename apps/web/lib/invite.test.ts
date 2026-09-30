import { describe, expect, it } from 'vitest';
import { inviteFromQuery, newMimicHref } from './invite';

describe('inviteFromQuery', () => {
  it('returns the trimmed code', () => {
    expect(inviteFromQuery(' mimic-dev ')).toBe('mimic-dev');
  });

  it('ignores a missing or blank value', () => {
    expect(inviteFromQuery(null)).toBeNull();
    expect(inviteFromQuery(undefined)).toBeNull();
    expect(inviteFromQuery('')).toBeNull();
    expect(inviteFromQuery('   ')).toBeNull();
  });

  it('takes the first value when the parameter repeats', () => {
    expect(inviteFromQuery(['first', 'second'])).toBe('first');
    expect(inviteFromQuery([])).toBeNull();
  });
});

describe('newMimicHref', () => {
  it('links to /new without a code', () => {
    expect(newMimicHref(null)).toBe('/new');
  });

  it('carries the code, encoded', () => {
    expect(newMimicHref('mimic-dev')).toBe('/new?invite=mimic-dev');
    expect(newMimicHref('a b&c')).toBe('/new?invite=a+b%26c');
  });
});

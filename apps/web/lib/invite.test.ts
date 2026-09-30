import { describe, expect, it } from 'vitest';
import { inviteFromQuery, inviteRejected, newMimicHref } from './invite';

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

describe('inviteRejected', () => {
  it('is true for an invalid code', () => {
    expect(inviteRejected(403, 'That invite code is not valid.')).toBe(true);
  });

  it('is true for a validation error on the code', () => {
    expect(inviteRejected(400, 'inviteCode: String must contain at most 100 character(s)')).toBe(true);
    expect(inviteRejected(400, 'link: Invalid url; inviteCode: Required')).toBe(true);
  });

  it('is false for failures about anything else', () => {
    expect(inviteRejected(400, 'link: Invalid url')).toBe(false);
    expect(inviteRejected(429, 'Too many requests. Try again in a minute.')).toBe(false);
    expect(inviteRejected(500, 'Something went wrong.')).toBe(false);
  });
});

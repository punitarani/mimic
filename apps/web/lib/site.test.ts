import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from './site';

describe('site', () => {
  it("is prod's custom domain", () => {
    const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const domain = wrangler.match(/"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/)?.[1];
    expect(SITE_URL).toBe(`https://${domain}`);
  });

  it('fits preview limits', () => {
    // Longer text is cut off in chat bubbles and search results.
    expect(SITE_TITLE.length).toBeLessThanOrEqual(60);
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(155);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHARE_CARD, SITE_DESCRIPTION, SITE_TITLE } from './site';

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(file: string) {
  const png = readFileSync(new URL(`../public/${file}`, import.meta.url));
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), bytes: png.length };
}

describe('link preview', () => {
  it('fits preview limits', () => {
    // Longer text is cut off in chat bubbles and search results.
    expect(SITE_TITLE.length).toBeLessThanOrEqual(60);
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(155);
  });

  it('has a card of the size it declares, small enough for WhatsApp', () => {
    const card = pngSize('share-card.png');
    expect([card.width, card.height]).toEqual([SHARE_CARD.width, SHARE_CARD.height]);
    // WhatsApp shows no image above 300 KB.
    expect(card.bytes).toBeLessThan(300_000);
  });

  it('has a 180 px apple-touch-icon', () => {
    const icon = pngSize('apple-touch-icon.png');
    expect([icon.width, icon.height]).toEqual([180, 180]);
  });
});

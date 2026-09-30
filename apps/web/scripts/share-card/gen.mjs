#!/usr/bin/env node
/**
 * Renders the link preview images (ADR-0031):
 *
 *   public/share-card.png        the Open Graph card every shared link shows (1200×630)
 *   public/apple-touch-icon.png  iMessage's fallback icon and the home-screen icon (180×180)
 *
 * Usage: pnpm --filter @mimic/web gen:share-card
 *
 * The card is the app's own OverlapMark and the icon its Mark, rendered with react-dom/server and colored by the
 * light theme's tokens, read from app/globals.css, so a change to either reaches the images on the next run. Fonts
 * come from Google Fonts, as in the app; a font that fails to load stops the run rather than drawing a fallback.
 *
 * This directory is its own package, outside the pnpm workspace, so CI never installs Playwright. It needs a
 * Chromium for playwright@1.56.1: `pnpm --dir apps/web/scripts/share-card exec playwright install chromium` once
 * (Claude Code's remote env already has one). The output is committed; its hash versions the URLs (next.config.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mark } from '../../components/brand.tsx';
import { OverlapMark } from '../../components/session/overlap-mark.tsx';

const WEB = new URL('../../', import.meta.url);

/** The light theme's variables: `:root`, plus the `@theme inline` aliases components use (`--color-ink`). */
function tokens() {
  const css = readFileSync(new URL('app/globals.css', WEB), 'utf8');
  const block = (start) => {
    const i = css.indexOf(start);
    if (i < 0) throw new Error(`globals.css has no ${start}`);
    return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  };
  return `:root { ${block(':root {')} ${block('@theme inline {')} }`;
}

// A desktop Chrome user agent, so Google Fonts serves woff2.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

async function get(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res;
}

/** The Latin subset of a Google Fonts family, as an @font-face rule with a data URL. */
async function latinFace(name, query, weight) {
  const css = await get(`https://fonts.googleapis.com/css2?family=${query}&display=block`, {
    headers: { 'user-agent': UA },
  }).then((r) => r.text());
  const url = css
    .split('@font-face')
    .find((f) => f.includes('U+0000-00FF'))
    ?.match(/url\((.+?)\)/)?.[1];
  if (!url) throw new Error(`no Latin woff2 for ${name}`);
  const bytes = Buffer.from(await get(url).then((r) => r.arrayBuffer()));
  return `@font-face { font-family: '${name}'; font-weight: ${weight};
    src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2'); }`;
}

const page = (w, h, css, body) => `<!doctype html><html><head><style>
  ${tokens()}
  ${css}
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; -webkit-font-smoothing: antialiased; }
</style></head><body>${body}</body></html>`;

const fonts = (
  await Promise.all([
    latinFace('Hanken Grotesk', 'Hanken+Grotesk:wght@400..600', '400 600'),
    latinFace('Newsreader', 'Newsreader:opsz,wght@6..72,400..500', '400 500'),
  ])
).join('\n');

// The signature element over one question. No subtitle: it can't be read at chat bubble size, and the title and
// description under the image carry the explanation. The headline fits a centered 630 px square (WhatsApp's
// thumbnail crop), and the rule keeps the card's edge on white chat backgrounds. The mark is drawn at the app's
// size and zoomed, so its strokes and labels keep their proportions.
const card = page(
  1200,
  630,
  `${fonts}
  body {
    background: var(--fog); border: 2px solid var(--rule);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px;
  }
  .mark { zoom: 2.4; }
  h1 {
    text-align: center; color: var(--graphite);
    font: 400 82px/1 'Newsreader'; font-optical-sizing: auto; letter-spacing: -0.02em;
  }`,
  `<div class="mark">${renderToStaticMarkup(h(OverlapMark, { size: 144, f: 0.4 }))}</div>
  <h1>How predictable<br>are you?</h1>`,
);

// The Mark on the page color, with no text (so no fonts). iOS rounds the corners itself.
const appleIcon = page(
  180,
  180,
  'body { background: var(--fog); display: flex; align-items: center; justify-content: center; }',
  renderToStaticMarkup(h(Mark, { size: 132 })),
);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  throw new Error('run through `pnpm --filter @mimic/web gen:share-card`, which installs Playwright');
}
const browser = await chromium.launch().catch((e) => {
  throw new Error(
    `${e.message.split('\n')[0]}\nInstall Chromium: pnpm --dir apps/web/scripts/share-card exec playwright install chromium`,
  );
});
try {
  for (const [file, html, width, height, faces] of [
    ['share-card.png', card, 1200, 630, ["500 12px 'Hanken Grotesk'", "400 82px 'Newsreader'"]],
    ['apple-touch-icon.png', appleIcon, 180, 180, []],
  ]) {
    const tab = await browser.newPage({ viewport: { width, height } });
    await tab.setContent(html);
    // fonts.ready resolves even when a face fails to decode, so load each font the page uses and check them all.
    const missing = await tab.evaluate(async (faces) => {
      await Promise.allSettled(faces.map((f) => document.fonts.load(f)));
      return [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family);
    }, faces);
    if (missing.length) throw new Error(`fonts did not load: ${missing.join(', ')}`);
    writeFileSync(new URL(`public/${file}`, WEB), await tab.screenshot({ type: 'png' }));
    await tab.close();
    console.log(`public/${file}`);
  }
} finally {
  await browser.close();
}

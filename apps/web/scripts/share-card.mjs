// Renders the link preview images into app/ (ADR-0027): the Open Graph card every shared link shows, and the
// apple-touch-icon. They are committed, static files, so the Worker never renders an image.
//
//   pnpm --filter @mimic/web gen:share-card
//
// Needs network access for Google Fonts (the same families the app loads) and a Playwright Chromium.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const APP = new URL('../app/', import.meta.url);

// Design tokens (app/globals.css), light theme: the page color, graphite for the person, ink for the mimic.
const T = { fog: '#eef0f2', graphite: '#22252a', ink: '#3d3a8f', rule: '#d3d7dd' };

// A desktop Chrome user agent, so Google Fonts serves woff2.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** The Latin subset of a Google Fonts family, as a data URL. */
async function latinFont(family) {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}&display=block`, {
    headers: { 'user-agent': UA },
  }).then((r) => r.text());
  const face = css.split('@font-face').find((f) => f.includes('U+0000-00FF'));
  const url = face?.match(/url\((.+?)\)/)?.[1];
  if (!url) throw new Error(`No Latin woff2 for ${family}`);
  const bytes = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

const [hanken, newsreader] = await Promise.all([
  latinFont('Hanken+Grotesk:wght@400..600'),
  latinFont('Newsreader:opsz,wght@6..72,400..500'),
]);

const base = (w, h) => `
  @font-face { font-family: 'Hanken Grotesk'; src: url(${hanken}) format('woff2'); font-weight: 400 600; }
  @font-face { font-family: 'Newsreader'; src: url(${newsreader}) format('woff2'); font-weight: 400 500; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
  body { -webkit-font-smoothing: antialiased; }`;

// The signature element, "You" and "Mimic" as two overlapping circles, over one question. No subtitle: it can't be
// read at chat bubble size, and the title and description under the image carry the explanation. The headline fits
// a centered 630 px square (WhatsApp's thumbnail crop); the rule keeps the card's edge on white chat backgrounds.
const card = `<!doctype html><html><head><style>${base(1200, 630)}
  body {
    background: ${T.fog}; border: 2px solid ${T.rule};
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px;
  }
  text { font-family: 'Hanken Grotesk'; font-weight: 600; font-size: 36px; }
  h1 {
    text-align: center; color: ${T.graphite};
    font: 400 82px/1 'Newsreader'; font-optical-sizing: auto; letter-spacing: -0.02em;
  }
</style></head><body>
  <svg width="400" height="224" viewBox="0 0 400 224" aria-hidden="true">
    <circle cx="136" cy="112" r="106" fill="${T.graphite}" fill-opacity="0.08" stroke="${T.graphite}" stroke-width="5" />
    <circle cx="264" cy="112" r="106" fill="${T.ink}" fill-opacity="0.16" stroke="${T.ink}" stroke-width="5" />
    <text x="96" y="125" text-anchor="middle" fill="${T.graphite}">You</text>
    <text x="306" y="125" text-anchor="middle" fill="${T.ink}">Mimic</text>
  </svg>
  <h1>How predictable<br>are you?</h1>
</body></html>`;

// The Mark (components/brand.tsx) on the page color. iOS rounds the corners itself.
const appleIcon = `<!doctype html><html><head><style>${base(180, 180)}
  body { background: ${T.fog}; display: flex; align-items: center; justify-content: center; }
</style></head><body>
  <svg width="132" height="132" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="9" cy="12" r="7" fill="${T.graphite}" fill-opacity="0.85" />
    <circle cx="15" cy="12" r="7" fill="${T.ink}" fill-opacity="0.7" />
  </svg>
</body></html>`;

const browser = await chromium.launch();
try {
  for (const [file, html, width, height] of [
    ['opengraph-image.png', card, 1200, 630],
    ['apple-icon.png', appleIcon, 180, 180],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    writeFileSync(new URL(file, APP), await page.screenshot({ type: 'png' }));
    console.log(`app/${file}`);
  }
} finally {
  await browser.close();
}

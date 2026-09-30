// Browser check for the E3b preset in /lab (ADR-0045): the lab says it counts real people only, the preset sets E3b up
// as a draft (never started), and a second visit shows it as set up. Runs against `pnpm dev` (admin via DEV_MODE and
// ADMIN_EMAILS=dev@localhost) and saves docs/screenshots/m13-lab-preset.png. Uses the global Playwright:
//
//   NODE_PATH=$(npm root -g) node scripts/browser/lab-preset.mjs [http://localhost:3000]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'screenshots');
const log = (msg) => console.log(`✓ ${msg}`);
const NAME = 'E3b: category balance (M12) vs v4 selection';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/lab`);
  await page.getByRole('heading', { name: 'Lab', level: 1 }).waitFor();
  await page.getByText('Scripted sessions and imported panels are never counted here.').waitFor();
  log('the lab says it counts real people only');

  const presets = page.getByRole('heading', { name: 'Presets' }).locator('..');
  await presets.getByText(NAME).waitFor();
  const setUp = presets.getByRole('button', { name: 'Set up as a draft' });
  if (await setUp.count()) {
    await setUp.click();
    await presets.getByText('Set up · draft').waitFor();
    log('"Set up as a draft" registers both configs and saves a draft');
  } else {
    await presets.getByText(/Set up · /).waitFor();
    log('already set up in this database');
  }

  // The draft is listed with Start, and nothing is active because of it.
  const row = page
    .getByRole('listitem')
    .filter({ hasText: NAME })
    .filter({ has: page.getByRole('button', { name: 'Start' }) });
  await row.first().waitFor();
  const text = await row.first().innerText();
  assert.match(text, /draft/);
  assert.match(text, /control \(1\) cfg\.e3b\.control/);
  assert.match(text, /v8 \(1\) cfg\.default\.v8/);
  log('the draft lists both arms 1:1 and waits for Start');
  await page.getByRole('link', { name: 'Consented' }).waitFor();
  await page.getByText('cfg.e3b.control').first().waitFor();

  await page.reload();
  await presets.getByText('Set up · draft').waitFor();
  assert.equal(await presets.getByRole('button', { name: 'Set up as a draft' }).count(), 0, 'set up once');
  log('a second visit shows it as set up, with no button');

  await page.getByRole('heading', { name: 'Presets' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'm13-lab-preset.png') });
} finally {
  await browser.close();
}

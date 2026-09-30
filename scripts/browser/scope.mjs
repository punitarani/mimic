// Browser check for categories and consent (ADR-0043): intake, the keyboard, the session menu and the Topics and
// consent dialog, in light and dark, desktop and mobile. Runs against `pnpm dev` (invite code `mimic-dev`) and saves
// screenshots to docs/screenshots/m11-*.png. Uses the global Playwright:
//
//   NODE_PATH=$(npm root -g) node scripts/browser/scope.mjs [http://localhost:3000]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'screenshots');
const shot = (page, name, opts = {}) => page.screenshot({ path: join(OUT, `m11-${name}.png`), ...opts });
const log = (msg) => console.log(`✓ ${msg}`);

const browser = await chromium.launch();
try {
  // 1) Intake, desktop.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desk.newPage();
  await page.goto(`${BASE}/new?invite=mimic-dev`);
  const topics = page.getByRole('group', { name: 'What to ask about' });
  await topics.waitFor();
  for (const name of [
    'Personality and psychology',
    'Values, beliefs and politics',
    'Relationships, sexuality and life',
    'Work and money',
  ])
    assert.equal(await topics.getByLabel(name).isChecked(), true, `${name} starts on`);
  for (const name of ['Ask about political views', 'Ask about health and body'])
    assert.equal(await topics.getByLabel(name).isChecked(), false, `${name} starts off`);
  log('every category on and every sensitive area off by default');

  // Keyboard only: Tab into the fieldset, Space toggles, a disabled area is skipped.
  await page.getByLabel('Personality and psychology').focus();
  const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
  const tabTo = async (id, max = 12) => {
    for (let i = 0; i < max; i++) {
      if ((await focused()) === id) return;
      await page.keyboard.press('Tab');
    }
    assert.fail(`Tab never reached #${id}`);
  };
  await tabTo('scope-work');
  await page.keyboard.press('Space');
  assert.equal(await page.getByLabel('Work and money').isChecked(), false);
  assert.equal(await page.getByLabel('Ask about money in detail').isDisabled(), true);
  await page.keyboard.press('Tab');
  assert.notEqual(await focused(), 'scope-money', 'a disabled area is skipped by Tab');
  const lock = await page.getByLabel('Ask about money in detail').getAttribute('aria-describedby');
  assert.ok(lock?.includes('scope-work-lock'), 'a disabled area says why');
  log('keyboard: Tab reaches each category, Space toggles, disabled areas are skipped and described');

  await page.getByLabel('Personality and psychology').focus();
  await tabTo('scope-politics');
  await page.keyboard.press('Space');
  await tabTo('scope-health');
  await page.keyboard.press('Space');
  await page.getByLabel(/Use my answers, without my name/).check();
  const research = page.getByRole('group', { name: 'Research use of sensitive answers' });
  await research.waitFor();
  assert.equal(
    await research.getByRole('checkbox').count(),
    2,
    'one research box per consented special area',
  );
  log('research use shows only with research consent, one box per consented special area');
  await topics.scrollIntoViewIfNeeded();
  await shot(page, 'intake-scope', { fullPage: true });

  // Submit: no web search, so the session starts at once.
  await page.getByRole('textbox', { name: /^Name/ }).fill('Rowan Ellis');
  await page
    .getByRole('combobox', { name: /^Location/ })
    .or(page.getByRole('textbox', { name: /^Location/ }))
    .first()
    .fill('Lisbon, Portugal');
  await page.keyboard.press('Escape');
  await page.getByLabel(/Search the public web/).uncheck();
  await page.getByLabel("I'm building a mimic of myself").check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/m\/[A-Z0-9]+$/, { timeout: 60_000 });
  const mimicUrl = page.url();
  log(`mimic created: ${mimicUrl}`);

  // 2) Session menu and the Topics and consent dialog.
  await page.getByRole('button', { name: 'More' }).first().waitFor({ timeout: 60_000 });
  await page.getByText('Not asked about: Work and money').first().waitFor({ timeout: 60_000 });
  log('model panel names the topic turned off');
  await page.getByRole('button', { name: 'More' }).first().click();
  const item = page.getByRole('menuitem', { name: 'Topics and consent' });
  await item.waitFor();
  await shot(page, 'menu-topics');
  await item.click();
  const dialog = page.getByRole('dialog', { name: 'Topics and consent' });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Work and money').isChecked(), false);
  assert.equal(await dialog.getByLabel('Ask about political views').isChecked(), true);
  assert.equal(
    await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
    true,
    'focus moves into the dialog',
  );
  await shot(page, 'scope-sheet');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'More',
    'Escape closes and returns focus to the menu button',
  );
  log('dialog: focus moves in, Escape closes and returns focus');

  // Narrow: withdraw political views, then save.
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitem', { name: 'Topics and consent' }).click();
  await dialog.getByLabel('Ask about political views').uncheck();
  await dialog.getByText('will be hidden from your mimic from now on').waitFor();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page
    .getByText(/Topics saved/)
    .first()
    .waitFor();
  log('narrowing warns before saving, and the session confirms');

  // 3) Dark theme.
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitem', { name: 'Topics and consent' }).click();
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel('Ask about political views').isChecked(),
    false,
    'the change was saved',
  );
  await shot(page, 'scope-sheet-dark');
  await page.keyboard.press('Escape');
  await desk.close();

  // 4) Intake on a phone.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await phone.newPage();
  await mobile.goto(`${BASE}/new?invite=mimic-dev`);
  const mTopics = mobile.getByRole('group', { name: 'What to ask about' });
  await mTopics.waitFor();
  await mTopics.getByLabel('Ask about religion and worldview').check();
  await mTopics.scrollIntoViewIfNeeded();
  await shot(mobile, 'intake-scope-mobile', { fullPage: true });
  await phone.close();
  log('mobile intake rendered');
} finally {
  await browser.close();
}

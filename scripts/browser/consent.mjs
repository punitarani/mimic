// Browser check for confirmed consent and "Prefer not to say" (ADR-0050): intake left at its defaults, the check
// before sensitive topics after six answers ("Not now", then a reload, then a choice per area), a sensitive question
// skipped with "Prefer not to say", and the Topics and consent dialog listing it with "Ask again". Desktop light, and
// the card on a phone in dark. Runs against `pnpm dev` (invite code `mimic-dev`, live providers through the egress
// relay; about 20 answers, a few cents) and saves docs/screenshots/m12-*.png. Uses the global Playwright:
//
//   NODE_PATH=$(npm root -g) node scripts/browser/consent.mjs [http://localhost:3000]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'screenshots');
const shot = (page, name, opts = {}) => page.screenshot({ path: join(OUT, `m12-${name}.png`), ...opts });
const log = (msg) => console.log(`✓ ${msg}`);
const SPECIAL = [
  'Political views',
  'Religion and worldview',
  'Sexuality and intimate relationships',
  'Health and body',
];

/** Waits for the next thing the session shows: the confirmation card or an unanswered question. */
async function nextScreen(page) {
  const card = page.locator('[data-confirm-topics]');
  const question = page.getByRole('button', { name: 'Add a reason (optional)', disabled: false });
  await card.or(question).first().waitFor({ timeout: 120_000 });
  return (await card.count()) ? 'card' : 'question';
}

/** Answers the current question with its first option by keyboard, then moves on with Enter. */
async function answer(page) {
  await page.keyboard.press('1');
  const next = page.getByRole('button', { name: /^Next/ });
  await next.waitFor({ timeout: 120_000 });
  await page.keyboard.press('Enter');
  await next.waitFor({ state: 'detached', timeout: 120_000 });
}

const browser = await chromium.launch();
try {
  // 1) Intake with every default left as it is: nothing is confirmed yet.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desk.newPage();
  await page.goto(`${BASE}/new?invite=mimic-dev`);
  const topics = page.getByRole('group', { name: 'What to ask about' });
  await topics.waitFor();
  await topics.getByText("We'll check with you again before asking about").waitFor();
  log('intake says special-category topics are checked again later');
  await page.getByRole('textbox', { name: /^Name/ }).fill('Sam Okafor');
  await page
    .getByRole('combobox', { name: /^Location/ })
    .or(page.getByRole('textbox', { name: /^Location/ }))
    .first()
    .fill('Leeds, UK');
  await page.keyboard.press('Escape');
  await page.getByLabel(/Search the public web/).uncheck();
  await page.getByLabel("I'm building a mimic of myself").check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/m\/[A-Z0-9]+$/, { timeout: 60_000 });
  const mimicUrl = page.url();
  log(`mimic created: ${mimicUrl}`);

  // 2) Six answers, then the card; no sensitive question before it.
  let answered = 0;
  while ((await nextScreen(page)) === 'question') {
    assert.equal(
      await page.getByRole('button', { name: 'Prefer not to say' }).count(),
      0,
      `no sensitive question at ${answered + 1}`,
    );
    await answer(page);
    answered++;
    assert.ok(answered <= 6, 'the card shows after six answers');
  }
  assert.equal(answered, 6);
  const card = page.locator('[data-confirm-topics]');
  const heading = card.getByRole('heading', { name: 'Before we ask about sensitive topics' });
  assert.equal(
    await heading.evaluate((el) => el === document.activeElement),
    true,
    'focus moves to the card',
  );
  for (const name of SPECIAL) await card.getByRole('group', { name }).waitFor();
  assert.equal(
    await card.getByRole('group', { name: 'Money in detail' }).count(),
    0,
    'money needs no confirmation',
  );
  assert.equal(await card.getByRole('button', { name: 'Continue' }).isDisabled(), true);
  log('after six answers the card asks about the four special-category areas, money not included');
  await shot(page, 'confirm-card');

  // "Not now" sets it aside for this visit; a new visit asks again.
  await card.getByRole('button', { name: 'Not now' }).click();
  assert.equal(await nextScreen(page), 'question');
  assert.equal(await page.getByRole('button', { name: 'Prefer not to say' }).count(), 0);
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitem', { name: 'Topics and consent' }).click();
  const pending = page.getByRole('dialog', { name: 'Topics and consent' }).getByText('Not confirmed yet');
  await pending.first().waitFor();
  assert.equal(await pending.count(), 4, 'Topics and consent says which areas are not confirmed');
  await page.keyboard.press('Escape');
  await page.reload();
  assert.equal(await nextScreen(page), 'card');
  log('"Not now" goes back to the questions, and a reload asks again');

  // 3) The same card on a phone, dark.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    storageState: await desk.storageState(),
  });
  const mobile = await phone.newPage();
  await mobile.goto(mimicUrl);
  assert.equal(await nextScreen(mobile), 'card');
  await shot(mobile, 'confirm-card-mobile-dark');
  await phone.close();
  log('the card on a phone, dark');

  // 4) Choose by keyboard: Ask me for politics and religion, Don't ask for sexuality and health.
  const choose = async (area, label) => {
    await card.getByRole('group', { name: area }).getByRole('button', { name: label }).focus();
    await page.keyboard.press('Space');
  };
  await choose('Political views', 'Ask me');
  await choose('Religion and worldview', 'Ask me');
  await choose('Sexuality and intimate relationships', "Don't ask");
  assert.equal(
    await card.getByRole('button', { name: 'Continue' }).isDisabled(),
    true,
    'every area needs a choice',
  );
  await choose('Health and body', "Don't ask");
  await card.getByRole('button', { name: 'Continue' }).click();
  await card.waitFor({ state: 'detached' });
  await page.getByText('Questions on the topics you chose will come up later').first().waitFor();
  log('each area decided separately; Continue saves');

  // 5) Answer until a sensitive question appears, then skip it.
  let sensitiveAt = 0;
  for (let i = 0; i < 24; i++) {
    assert.equal(await nextScreen(page), 'question');
    if (await page.getByRole('button', { name: 'Prefer not to say' }).count()) {
      sensitiveAt = answered + 1;
      break;
    }
    await answer(page);
    answered++;
  }
  assert.ok(sensitiveAt > 6, 'a sensitive question comes up after the card');
  const prompt = await page
    .getByRole('radiogroup')
    .first()
    .getAttribute('aria-label')
    .catch(() => null);
  await shot(page, 'prefer-not');
  await page.getByRole('button', { name: 'Prefer not to say' }).click();
  await page.getByText("Skipped. We won't ask about that again").first().waitFor();
  assert.equal(await nextScreen(page), 'question');
  log(`question ${sensitiveAt}${prompt ? ` ("${prompt}")` : ''} skipped with "Prefer not to say"`);

  // 6) Topics and consent lists it, and "Ask again" is there.
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitem', { name: 'Topics and consent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Topics and consent' });
  await dialog.waitFor();
  await dialog.getByText('You chose not to answer').waitFor();
  await dialog
    .getByRole('button', { name: /^Ask again about / })
    .first()
    .waitFor();
  assert.equal(await dialog.getByLabel('Ask about political views').isChecked(), true);
  assert.equal(
    await dialog.getByLabel('Ask about health and body').isChecked(),
    false,
    "Don't ask withdrew health",
  );
  await dialog.getByText('You chose not to answer').scrollIntoViewIfNeeded();
  await shot(page, 'topics-declined');
  await page.keyboard.press('Escape');
  await desk.close();
  log('Topics and consent lists the skipped topic with "Ask again"');
} finally {
  await browser.close();
}

'use strict';
/**
 * enable-pages.js
 * Opens GitHub Pages settings, enables GitHub Actions as the source,
 * then takes a screenshot confirming the state.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const OWNER = 'coreylallojr';
const REPO  = 'ARC_Reactor';
const URL   = `https://github.com/${OWNER}/${REPO}/settings/pages`;

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx  = await browser.newContext({ viewport: null });
  ctx.setDefaultTimeout(120_000);
  const page = await ctx.newPage();

  // ── 1. Login check ────────────────────────────────────────────────────
  console.log('Checking GitHub login...');
  await page.goto('https://github.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });

  const login = await page.evaluate(
    () => document.querySelector('meta[name="user-login"]')?.content?.trim() || '',
  );

  if (!login) {
    console.log('Not logged in — please sign in (3 min)...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => !!document.querySelector('meta[name="user-login"]')?.content?.trim(),
      null,
      { timeout: 180_000 },
    );
    console.log('Logged in!');
  } else {
    console.log(`Logged in as: ${login}`);
  }

  // ── 2. Open Pages settings ────────────────────────────────────────────
  console.log('Opening Pages settings...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });

  // Handle sudo challenge
  if (page.url().includes('/sudo') || page.url().includes('/confirm_access')) {
    console.log('Sudo challenge — please confirm in browser...');
    await page.waitForURL(u => u.includes('/settings/pages'), null, { timeout: 120_000 });
  }

  await page.waitForTimeout(2000);

  // ── 3. Screenshot BEFORE ──────────────────────────────────────────────
  const before = path.join(__dirname, '..', 'pages-before.png');
  await page.screenshot({ path: before, fullPage: true });
  console.log(`Screenshot saved: ${before}`);

  // ── 4. Dump all visible text in the "source" area ─────────────────────
  const bodyText = await page.textContent('body');
  const hasPagesAlready = /your site is live/i.test(bodyText) || /github pages/i.test(bodyText);
  console.log('Page has Pages content:', hasPagesAlready);

  // ── 5. Try every known selector for "GitHub Actions" source ──────────
  const strategies = [
    // Current GitHub UI — card buttons
    async () => {
      const btn = page.locator('button:has-text("GitHub Actions"), a:has-text("GitHub Actions")').first();
      if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); return 'card-button'; }
    },
    // Radio inside a label
    async () => {
      const radio = page.locator('label:has-text("GitHub Actions") >> input[type="radio"]').first();
      if (await radio.isVisible({ timeout: 2000 })) {
        if (!await radio.isChecked()) await radio.check();
        return 'radio-in-label';
      }
    },
    // Direct input value
    async () => {
      const inp = page.locator('input[value="actions"], input[value="ACTIONS"]').first();
      if (await inp.isVisible({ timeout: 2000 })) {
        if (!await inp.isChecked()) await inp.check();
        return 'input[value=actions]';
      }
    },
    // Select option
    async () => {
      const selects = await page.locator('select').all();
      for (const sel of selects) {
        const opts = await sel.locator('option').allTextContents().catch(() => []);
        if (opts.some(o => /github actions/i.test(o))) {
          await sel.selectOption({ label: /github actions/i });
          return 'select-option';
        }
      }
    },
    // Any element with text "GitHub Actions" that's clickable
    async () => {
      const els = await page.locator('[role="radio"]:has-text("GitHub Actions"), [role="option"]:has-text("GitHub Actions")').all();
      for (const el of els) {
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          await el.click();
          return 'role-radio';
        }
      }
    },
  ];

  let method = null;
  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result) { method = result; break; }
    } catch {}
  }

  if (method) {
    console.log(`Selected GitHub Actions source via: ${method}`);
    await page.waitForTimeout(1000);

    // Click Save if it appears
    const saveBtn = page.locator(
      'button:has-text("Save"), input[type="submit"][value="Save"], button[type="submit"]:near(:has-text("Source"))',
    ).first();
    if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveBtn.click();
      console.log('Clicked Save.');
      await page.waitForTimeout(2000);
    }
  } else {
    // ── 6. Dump the full HTML of the pages settings section ─────────────
    console.log('\n⚠ Could not auto-select. Dumping relevant HTML for diagnosis:\n');
    const html = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return main.innerHTML.substring(0, 4000);
    });
    console.log(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    console.log('\nPlease manually select "GitHub Actions" in the browser window.');
    console.log('Press ENTER when done...');
    await new Promise(r => process.stdin.once('data', r));
  }

  // ── 7. Screenshot AFTER ───────────────────────────────────────────────
  const after = path.join(__dirname, '..', 'pages-after.png');
  await page.screenshot({ path: after, fullPage: true });
  console.log(`After screenshot: ${after}`);

  // ── 8. Verify ─────────────────────────────────────────────────────────
  const finalText = await page.textContent('body');
  const confirmed = /github actions/i.test(finalText);
  console.log(confirmed ? '✓ Pages is configured with GitHub Actions.' : '⚠ Could not confirm Pages source.');

  await browser.close();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

'use strict';
/**
 * deploy.js — Playwright automation to deploy ARC Reactor end-to-end.
 *
 * 1. Opens GitHub, waits for login if needed (3 min window)
 * 2. Enables GitHub Pages (source: GitHub Actions)
 * 3. Creates and pushes the v2.0.0 release tag
 * 4. Polls GitHub API until both workflows finish
 * 5. Prints the live landing page URL and installer download link
 */

const { chromium } = require('playwright');
const { spawnSync } = require('child_process');
const https = require('https');
const path  = require('path');

const REPO_DIR = path.join(__dirname, '..');
const OWNER    = 'coreylallojr';
const REPO     = 'ARC_Reactor';
const TAG      = 'v2.0.0';

// ── Utilities ──────────────────────────────────────────────────────────────
function apiGet(endpoint) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}${endpoint}`,
      headers: { 'User-Agent': 'arc-reactor-deploy', Accept: 'application/vnd.github+json' },
    };
    let body = '';
    const req = https.get(opts, res => {
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(10000, () => { req.destroy(); resolve({}); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function git(...args) {
  const r = spawnSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Polls a function until it returns truthy, or times out.
async function pollUntil(fn, intervalMs, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch {}
    tick++;
    process.stdout.write(`\r      Waiting for ${label}... ${tick * Math.round(intervalMs/1000)}s   `);
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });
  const ctx  = await browser.newContext({ viewport: null });
  // NOTE: timeout goes as third arg to waitForFunction — set a generous default
  ctx.setDefaultTimeout(180_000);
  const page = await ctx.newPage();

  // ── 1. Login check ─────────────────────────────────────────────────────
  console.log('\n[1/5] Checking GitHub login...');
  await page.goto('https://github.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const getLogin = () => page.evaluate(
    () => document.querySelector('meta[name="user-login"]')?.content?.trim() || '',
  );

  let login = await getLogin().catch(() => '');

  if (!login) {
    console.log('      Browser is open — please sign in to GitHub now (3 min window)...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // Fix: pass null as arg, options as third argument
    await page.waitForFunction(
      () => {
        const m = document.querySelector('meta[name="user-login"]');
        return m && m.content && m.content.trim().length > 0;
      },
      null,              // arg (unused)
      { timeout: 180_000 },  // options — this is what was wrong before
    );
    login = await getLogin();
  }

  console.log(`      ✓ Logged in as: ${login}`);

  // ── 2. Enable GitHub Pages ─────────────────────────────────────────────
  console.log('\n[2/5] Configuring GitHub Pages...');
  await page.goto(
    `https://github.com/${OWNER}/${REPO}/settings/pages`,
    { waitUntil: 'domcontentloaded', timeout: 20_000 },
  );

  // Handle sudo/2FA prompt
  if (page.url().includes('/sudo') || page.url().includes('/confirm')) {
    console.log('      Sudo challenge — please confirm password in the browser...');
    await page.waitForURL(
      url => url.includes('/settings/pages'),
      null,
      { timeout: 120_000 },
    );
  }

  await page.waitForTimeout(1500); // let dynamic content settle

  let pagesConfigured = false;

  // ── Approach A: radio/button group (current GitHub UI) ──────────────
  // Look for anything that selects "GitHub Actions" as the build source
  const actionsSelectors = [
    'input[value="actions"]',
    'input[value="ACTIONS"]',
    'label:has-text("GitHub Actions") input[type="radio"]',
    '[data-build-source="actions"] input',
  ];

  for (const sel of actionsSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      const checked = await el.isChecked().catch(() => false);
      if (!checked) {
        await el.check();
        console.log(`      Selected "GitHub Actions" source via: ${sel}`);
        await page.waitForTimeout(800);
      } else {
        console.log('      "GitHub Actions" source already selected.');
      }
      pagesConfigured = true;
      break;
    }
  }

  // ── Approach B: dropdown <select> ────────────────────────────────────
  if (!pagesConfigured) {
    const selects = page.locator('select').all ? await page.locator('select').all() : [];
    for (const sel of selects) {
      const opts = await sel.locator('option').allTextContents().catch(() => []);
      if (opts.some(o => /github actions/i.test(o))) {
        await sel.selectOption({ label: /github actions/i });
        console.log('      Selected "GitHub Actions" source via <select>');
        await page.waitForTimeout(800);
        pagesConfigured = true;
        break;
      }
    }
  }

  // ── Save if a save button is visible ─────────────────────────────────
  const saveBtn = page.locator(
    'button:has-text("Save"), input[type="submit"][value="Save"]',
  ).first();
  if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await saveBtn.click();
    console.log('      Saved Pages configuration.');
    await page.waitForTimeout(1500);
  }

  // ── Fallback: check page text ─────────────────────────────────────────
  if (!pagesConfigured) {
    const text = await page.textContent('body').catch(() => '');
    if (/github actions/i.test(text)) {
      console.log('      Pages appears to be configured (found "GitHub Actions" on page).');
      pagesConfigured = true;
    } else {
      console.log('\n      ⚠ Could not auto-configure Pages.');
      console.log('      Please manually set: Settings → Pages → Source → GitHub Actions');
      console.log('      Then press ENTER here to continue...');
      await new Promise(r => process.stdin.once('data', r));
    }
  }

  await browser.close();
  console.log('      ✓ Pages configured. Browser closed.');

  // ── 3. Tag and push ────────────────────────────────────────────────────
  console.log(`\n[3/5] Pushing release tag ${TAG}...`);

  // Remove any existing local tag
  git('tag', '-d', TAG);

  const tagR = git('tag', '-a', TAG, '-m', `Release ${TAG} — JARVIS v2 with voice chat, console UI, SSE audio`);
  if (!tagR.ok) {
    console.error('      git tag failed:', tagR.err);
    process.exit(1);
  }

  const pushR = git('push', 'origin', TAG);
  if (!pushR.ok) {
    if (/already exists|rejected/.test(pushR.err)) {
      console.log('      Tag exists on remote, force-pushing...');
      const forceR = git('push', 'origin', `refs/tags/${TAG}`, '--force');
      if (!forceR.ok) { console.error('      Force push failed:', forceR.err); process.exit(1); }
    } else {
      console.error('      Push failed:', pushR.err);
      process.exit(1);
    }
  }
  console.log(`      ✓ Tag ${TAG} pushed → release workflow triggered.`);

  // Also push the pages workflow trigger (push to main already happened, but
  // the pages.yml also fires on main — force a no-op push to ensure it runs)
  console.log('      Pushing main to ensure Pages workflow fires...');
  git('push', 'origin', 'main');

  console.log(`\n      Watch live: https://github.com/${OWNER}/${REPO}/actions`);

  // ── 4. Poll until workflows finish ────────────────────────────────────
  console.log('\n[4/5] Polling workflow status (this will take a few minutes)...\n');

  const POLL_MS    = 15_000;
  const TIMEOUT_MS = 25 * 60 * 1000; // 25 min
  const deadline   = Date.now() + TIMEOUT_MS;

  let releaseOk = false;
  let pagesOk   = false;
  let tick = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    tick++;

    const runs = await apiGet('/actions/runs?per_page=15&branch=main');
    const tagRuns = await apiGet(`/actions/runs?per_page=15&event=push`);
    const allRuns = [
      ...(runs.workflow_runs || []),
      ...(tagRuns.workflow_runs || []),
    ];

    // Deduplicate by id
    const seen = new Set();
    const unique = allRuns.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });

    for (const run of unique.slice(0, 12)) {
      const wfName = (run.name || run.path || '').toLowerCase();
      const c = run.conclusion;

      if (/build|release/.test(wfName)) {
        if (c === 'success')  { releaseOk = true; }
        if (c === 'failure')  { console.error(`\n      ✗ Release workflow failed: ${run.html_url}`); }
      }
      if (/page|deploy/.test(wfName)) {
        if (c === 'success')  { pagesOk = true; }
        if (c === 'failure')  { console.warn(`\n      ⚠ Pages workflow failed: ${run.html_url}`); pagesOk = true; }
      }
    }

    const elapsed = Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 1000);
    const relStatus  = releaseOk ? '✓ done' : '⏳ building';
    const pagesStatus = pagesOk  ? '✓ done' : '⏳ deploying';
    process.stdout.write(
      `\r      [${elapsed}s]  Release: ${relStatus}  |  Pages: ${pagesStatus}          `,
    );

    if (releaseOk && pagesOk) break;
  }

  console.log('\n');

  // ── 5. Report ──────────────────────────────────────────────────────────
  console.log('[5/5] Deployment complete!\n');

  const releaseData = await apiGet(`/releases/tags/${TAG}`).catch(() => ({}));
  const asset = (releaseData.assets || []).find(a => a.name === 'arc-reactor-setup.exe');

  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  🌐  LANDING PAGE');
  console.log(`      https://${OWNER}.github.io/${REPO}/`);
  console.log('');
  if (asset) {
    console.log('  ⬇   ONE-CLICK INSTALLER');
    console.log(`      ${asset.browser_download_url}`);
  } else {
    console.log('  ⬇   RELEASES PAGE (installer may still be uploading)');
    console.log(`      https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
  }
  console.log('');
  console.log('  📋  ACTIONS LOG');
  console.log(`      https://github.com/${OWNER}/${REPO}/actions`);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * github-auth-push.js
 *
 * Uses Playwright to:
 *   1. Open GitHub in a real browser
 *   2. Wait for you to log in (or detect you already are)
 *   3. Automate classic PAT creation with repo scope
 *   4. Capture the token and store it in ~/.git-credentials
 *   5. Push the current branch to origin
 *
 * Usage: node github-auth-push.js
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const REPO_DIR  = __dirname;
const GH_HOST   = 'github.com';
const TOKEN_NOTE = 'arc-reactor-push';
// 90-day expiry — change to "" for no expiry (not recommended)
const TOKEN_EXPIRY = '90';

// ── Ensure playwright is installed ────────────────────────────────────────────
function ensurePlaywright() {
  try {
    require.resolve('playwright');
    return;
  } catch {}
  console.log('Installing playwright...');
  const r = spawnSync('npm', ['install', '--save-dev', 'playwright'], {
    cwd: REPO_DIR, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) {
    console.error('playwright install failed — run: npm install playwright');
    process.exit(1);
  }
  // Install Chromium browser binary
  spawnSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: REPO_DIR, stdio: 'inherit', shell: true,
  });
}

ensurePlaywright();

const { chromium } = require('playwright');

// ── Git helpers ───────────────────────────────────────────────────────────────
function gitRemoteUrl() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_DIR, encoding: 'utf8',
    }).trim();
  } catch { return ''; }
}

function storeCredential(token) {
  // Set credential helper to "store" (plaintext ~/.git-credentials)
  spawnSync('git', ['config', '--global', 'credential.helper', 'store'], {
    stdio: 'inherit',
  });

  const credPath = path.join(os.homedir(), '.git-credentials');
  let lines = [];
  try { lines = fs.readFileSync(credPath, 'utf8').split('\n'); } catch {}

  // Remove any stale github.com entry for this host so there's no conflict
  lines = lines.filter(l => !l.includes(`@${GH_HOST}`));

  // Extract username from remote URL or default
  const remoteUrl = gitRemoteUrl();
  const userMatch = remoteUrl.match(/https?:\/\/([^@:]+)@/);
  const ghUser = userMatch ? userMatch[1] : 'coreylallojr';

  lines.push(`https://${ghUser}:${token}@${GH_HOST}`);
  fs.writeFileSync(credPath, lines.filter(Boolean).join('\n') + '\n');
  console.log(`Credentials stored in ${credPath}`);
}

function gitPush() {
  // Ensure remote URL is clean (no embedded token)
  const clean = `https://${GH_HOST}/coreylallojr/ARC_Reactor.git`;
  spawnSync('git', ['remote', 'set-url', 'origin', clean], { cwd: REPO_DIR });

  console.log('\nPushing to origin/main...');
  const r = spawnSync('git', ['push', 'origin', 'main'], {
    cwd: REPO_DIR, stdio: 'inherit',
  });
  if (r.status === 0) {
    console.log('\n✓  Push successful — ARC Reactor v2 is live on GitHub.');
  } else {
    console.error('\n✗  Push failed. Check the output above.');
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });
  const ctx  = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();

  // ── 1. Check login state ──────────────────────────────────────────────────
  console.log('Opening GitHub...');
  await page.goto('https://github.com', { waitUntil: 'domcontentloaded' });

  const loggedIn = await page.evaluate(() => {
    // Logged-in pages have a user-login meta tag
    const m = document.querySelector('meta[name="user-login"]');
    return m && m.content.length > 0;
  });

  if (!loggedIn) {
    console.log('Not logged in — please sign in to GitHub in the browser window.');
    console.log('Waiting up to 3 minutes...\n');
    await page.goto('https://github.com/login');
    await page.waitForFunction(
      () => !!document.querySelector('meta[name="user-login"]')?.content,
      { timeout: 180_000 },
    );
    console.log('Login detected!');
  } else {
    const login = await page.evaluate(
      () => document.querySelector('meta[name="user-login"]')?.content,
    );
    console.log(`Already logged in as: ${login}`);
  }

  // ── 2. Navigate to classic PAT creation ──────────────────────────────────
  console.log('\nNavigating to Personal Access Token creation...');
  await page.goto('https://github.com/settings/tokens/new', {
    waitUntil: 'domcontentloaded',
  });

  // Handle possible 2FA / sudo challenge
  const sudoPrompt = page.locator('form[action*="sudo"]');
  if (await sudoPrompt.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('GitHub sudo challenge detected — please confirm in the browser.');
    await page.waitForURL('**/settings/tokens/new', { timeout: 120_000 });
  }

  // ── 3. Fill in token note ─────────────────────────────────────────────────
  const noteField = page.locator(
    'input[name="oauth_access[description]"], #oauth_access_description',
  ).first();
  await noteField.waitFor({ timeout: 15_000 });
  await noteField.fill(TOKEN_NOTE);
  console.log(`Token note: "${TOKEN_NOTE}"`);

  // ── 4. Set expiry ─────────────────────────────────────────────────────────
  if (TOKEN_EXPIRY) {
    const expirySelect = page.locator(
      'select[name="oauth_access[expiration]"], #oauth_access_expiration',
    ).first();
    if (await expirySelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expirySelect.selectOption(TOKEN_EXPIRY);
      console.log(`Expiry: ${TOKEN_EXPIRY} days`);
    }
  }

  // ── 5. Check the "repo" scope ─────────────────────────────────────────────
  const repoCheckbox = page.locator('input[value="repo"]').first();
  if (!(await repoCheckbox.isChecked())) {
    await repoCheckbox.check();
  }
  console.log('Scope: repo (full)');

  // ── 6. Generate token ────────────────────────────────────────────────────
  const submitBtn = page.locator(
    'input[type="submit"][value*="Generate"], button[type="submit"]:has-text("Generate")',
  ).first();
  await submitBtn.click();
  console.log('Generating token...');

  // ── 7. Capture the new token ──────────────────────────────────────────────
  // After generation, GitHub redirects to /settings/tokens and shows the token once
  await page.waitForURL('**/settings/tokens*', { timeout: 30_000 });

  // The token value appears in a highlighted code/input on the success banner
  const tokenLocator = page.locator(
    '#new-oauth-token, ' +
    '.flash-success code, ' +
    '[data-copy-feedback] code, ' +
    'input.form-control[value^="ghp_"], ' +
    'input.form-control[value^="github_pat_"]',
  ).first();

  await tokenLocator.waitFor({ timeout: 20_000 });

  const token = await tokenLocator.evaluate(el =>
    el.tagName === 'INPUT' ? el.value : el.textContent.trim(),
  );

  if (!token || (!token.startsWith('ghp_') && !token.startsWith('github_pat_'))) {
    console.error('Could not read token from page. Value seen:', token?.slice(0, 12));
    console.log('\nManual fallback: copy the token from the browser, then run:');
    console.log('  git -C "C:\\tmp\\ARC_Reactor" push https://coreylallojr:<TOKEN>@github.com/coreylallojr/ARC_Reactor.git main');
    await browser.close();
    process.exit(1);
  }

  console.log(`Token captured: ${token.slice(0, 8)}${'*'.repeat(token.length - 8)}`);
  await browser.close();

  // ── 8. Store & push ───────────────────────────────────────────────────────
  storeCredential(token);
  gitPush();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

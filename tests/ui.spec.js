// ui.spec.js — Page load, tab navigation, keyboard shortcuts, settings
'use strict';
const { test, expect } = require('@playwright/test');

const UI_BASE = 'http://localhost:7474';

// ── Helper ────────────────────────────────────────────────────────────────────
async function waitForModules(page) {
  await page.waitForFunction(() => typeof window.switchTab === 'function', { timeout: 15000 });
}

// ── Page load ─────────────────────────────────────────────────────────────────

test.describe('Page load', () => {
  test('page has correct title', async ({ page }) => {
    await page.goto(UI_BASE);
    await expect(page).toHaveTitle('JARVIS Neural Core');
  });

  test('tab bar renders with 4 tabs', async ({ page }) => {
    await page.goto(UI_BASE);
    await expect(page.locator('#tab-bar')).toBeVisible();
    await expect(page.locator('#tab-neural')).toBeVisible();
    await expect(page.locator('#tab-graph')).toBeVisible();
    await expect(page.locator('#tab-skills')).toBeVisible();
    await expect(page.locator('#tab-memory')).toBeVisible();
  });

  test('NEURAL is the default active tab', async ({ page }) => {
    await page.goto(UI_BASE);
    await expect(page.locator('#tab-neural')).toHaveClass(/active/);
    await expect(page.locator('#tab-graph')).not.toHaveClass(/active/);
    await expect(page.locator('#tab-skills')).not.toHaveClass(/active/);
    await expect(page.locator('#tab-memory')).not.toHaveClass(/active/);
  });

  test('Three.js canvas appears after module init', async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: 15000 });
  });

  test('JARVIS title logo is visible', async ({ page }) => {
    await page.goto(UI_BASE);
    await expect(page.locator('#tt')).toBeVisible();
    const text = await page.locator('#tt .m').textContent();
    expect(text).toMatch(/J\.A\.R\.V\.I\.S/);
  });

  test('HUD panels are visible on neural tab', async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
    await expect(page.locator('#h1')).toBeVisible();
    await expect(page.locator('#h2')).toBeVisible();
  });

  test('page loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(UI_BASE);
    await waitForModules(page);
    // Allow CDN fetch errors (test environment may be offline) but not syntax/runtime errors
    const criticalErrors = errors.filter(e =>
      !e.includes('fetch') && !e.includes('net::') && !e.includes('Failed to load')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// ── Tab navigation ────────────────────────────────────────────────────────────

test.describe('Tab navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
  });

  test('clicking GRAPH tab activates it and shows panel', async ({ page }) => {
    await page.click('#tab-graph');
    await expect(page.locator('#tab-graph')).toHaveClass(/active/);
    await expect(page.locator('#panel-graph')).toHaveClass(/visible/);
    // Three.js canvas hidden
    await expect(page.locator('canvas')).toBeHidden();
  });

  test('clicking SKILLS tab activates it and shows panel', async ({ page }) => {
    await page.click('#tab-skills');
    await expect(page.locator('#tab-skills')).toHaveClass(/active/);
    await expect(page.locator('#panel-skills')).toHaveClass(/visible/);
  });

  test('clicking MEMORY tab activates it and shows panel', async ({ page }) => {
    await page.click('#tab-memory');
    await expect(page.locator('#tab-memory')).toHaveClass(/active/);
    await expect(page.locator('#panel-memory')).toHaveClass(/visible/);
  });

  test('clicking NEURAL tab returns to sphere', async ({ page }) => {
    await page.click('#tab-graph');
    await page.click('#tab-neural');
    await expect(page.locator('#tab-neural')).toHaveClass(/active/);
    await expect(page.locator('canvas')).toBeVisible();
    // Other panels not visible
    await expect(page.locator('#panel-graph')).not.toHaveClass(/visible/);
  });

  test('HUD elements hidden when not on neural tab', async ({ page }) => {
    await page.click('#tab-graph');
    await expect(page.locator('#h1')).toBeHidden();
    await expect(page.locator('#h2')).toBeHidden();
    await expect(page.locator('#tt')).toBeHidden();
  });

  test('HUD elements restored when switching back to neural', async ({ page }) => {
    await page.click('#tab-skills');
    await page.click('#tab-neural');
    await expect(page.locator('#h1')).toBeVisible();
    await expect(page.locator('#tt')).toBeVisible();
  });

  test('only one tab panel is visible at a time', async ({ page }) => {
    for (const tab of ['graph', 'skills', 'memory']) {
      await page.click(`#tab-${tab}`);
      const visiblePanels = await page.locator('.tab-panel.visible').count();
      expect(visiblePanels).toBe(1);
    }
  });

  test('rapid tab switching does not crash the page', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await page.click('#tab-graph');
      await page.click('#tab-skills');
      await page.click('#tab-memory');
      await page.click('#tab-neural');
    }
    // Page should still be functional
    await expect(page.locator('#tab-neural')).toHaveClass(/active/);
    await expect(page.locator('canvas')).toBeVisible();
  });
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
  });

  test('G key switches to graph tab', async ({ page }) => {
    await page.keyboard.press('g');
    await expect(page.locator('#tab-graph')).toHaveClass(/active/);
    await expect(page.locator('#panel-graph')).toHaveClass(/visible/);
  });

  test('K key switches to skills tab', async ({ page }) => {
    await page.keyboard.press('k');
    await expect(page.locator('#tab-skills')).toHaveClass(/active/);
  });

  test('R key switches to memory tab', async ({ page }) => {
    await page.keyboard.press('r');
    await expect(page.locator('#tab-memory')).toHaveClass(/active/);
  });

  test('N key switches back to neural tab', async ({ page }) => {
    await page.keyboard.press('g');
    await page.keyboard.press('n');
    await expect(page.locator('#tab-neural')).toHaveClass(/active/);
    await expect(page.locator('canvas')).toBeVisible();
  });

  test('S key opens settings panel', async ({ page }) => {
    await page.keyboard.press('s');
    await expect(page.locator('#settings')).toHaveClass(/open/);
  });

  test('S key toggles settings closed', async ({ page }) => {
    await page.keyboard.press('s');
    await page.keyboard.press('s');
    await expect(page.locator('#settings')).not.toHaveClass(/open/);
  });

  test('ESC closes settings panel', async ({ page }) => {
    await page.keyboard.press('s');
    await expect(page.locator('#settings')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings')).not.toHaveClass(/open/);
  });

  test('keyboard shortcuts do not fire when typing in an input', async ({ page }) => {
    await page.click('#tab-skills');
    await page.waitForSelector('#panel-skills.visible');
    // Open the skill form
    await page.click('button:has-text("+ NEW SKILL")');
    await page.click('#skill-form-name');
    // Type 'g' in the name input — should NOT switch to graph tab
    await page.keyboard.type('g');
    await expect(page.locator('#tab-skills')).toHaveClass(/active/);
    // Input should have received the character
    const val = await page.inputValue('#skill-form-name');
    expect(val).toBe('g');
  });

  test('C key toggles console panel', async ({ page }) => {
    await expect(page.locator('#console-panel')).toHaveClass(/console-hidden/);
    await page.keyboard.press('c');
    await expect(page.locator('#console-panel')).not.toHaveClass(/console-hidden/);
    await page.keyboard.press('c');
    await expect(page.locator('#console-panel')).toHaveClass(/console-hidden/);
  });
});

// ── Settings panel ────────────────────────────────────────────────────────────

test.describe('Settings panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
    await page.keyboard.press('s');
    await page.waitForSelector('#settings.open');
  });

  test('settings panel has voice level buttons', async ({ page }) => {
    await expect(page.locator('#vb1')).toBeVisible();
    await expect(page.locator('#vb2')).toBeVisible();
    await expect(page.locator('#vb0')).toBeVisible();
  });

  test('settings panel has personality buttons', async ({ page }) => {
    await expect(page.locator('#vbkey')).toBeVisible();
    await expect(page.locator('#vbtalk')).toBeVisible();
    await expect(page.locator('#vbverb')).toBeVisible();
  });

  test('settings panel has max context button', async ({ page }) => {
    await expect(page.locator('#vbmax')).toBeVisible();
  });

  test('voice level button 2 updates the display', async ({ page }) => {
    await page.click('#vb2');
    await page.waitForTimeout(300); // let the API call round-trip
    const voiceText = await page.locator('#evmode').textContent();
    expect(voiceText).toMatch(/KEY ONLY/i);
    // Restore
    await page.click('#vb1');
  });

  test('mute button changes label to MUTED', async ({ page }) => {
    await page.click('#vb0');
    await page.waitForTimeout(300);
    const voiceText = await page.locator('#evmode').textContent();
    expect(voiceText).toMatch(/MUTED/i);
    // Restore
    await page.click('#vb1');
    await page.waitForTimeout(300);
  });
});

// ── Console panel ─────────────────────────────────────────────────────────────

test.describe('Console panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
  });

  test('console panel starts hidden', async ({ page }) => {
    await expect(page.locator('#console-panel')).toHaveClass(/console-hidden/);
  });

  test('C key opens and closes console', async ({ page }) => {
    await page.keyboard.press('c');
    await expect(page.locator('#console-panel')).not.toHaveClass(/console-hidden/);
    await page.keyboard.press('c');
    await expect(page.locator('#console-panel')).toHaveClass(/console-hidden/);
  });

  test('console has input, send button, and mic button', async ({ page }) => {
    await page.keyboard.press('c');
    await expect(page.locator('#console-input')).toBeVisible();
    await expect(page.locator('#console-send')).toBeVisible();
    await expect(page.locator('#console-mic')).toBeVisible();
  });

  test('console close button (×) hides the panel', async ({ page }) => {
    await page.keyboard.press('c');
    await page.click('.console-close');
    await expect(page.locator('#console-panel')).toHaveClass(/console-hidden/);
  });

  test('typing in console input and pressing enter sends message', async ({ page }) => {
    await page.keyboard.press('c');
    await page.fill('#console-input', 'Hello JARVIS');
    await page.keyboard.press('Enter');
    // Input should be cleared
    await page.waitForTimeout(200);
    const val = await page.inputValue('#console-input');
    expect(val).toBe('');
    // Message should appear in console
    await expect(page.locator('.cmsg-user')).toContainText('Hello JARVIS');
  });

  test('ESC closes console when open', async ({ page }) => {
    await page.keyboard.press('c');
    await expect(page.locator('#console-panel')).not.toHaveClass(/console-hidden/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#console-panel')).toHaveClass(/console-hidden/);
  });
});

// skills.spec.js — Skills CRUD API + UI tests
'use strict';
const { test, expect } = require('@playwright/test');

const API_BASE = 'http://localhost:7476';
const UI_BASE  = 'http://localhost:7474';

// ── API-level skills CRUD ─────────────────────────────────────────────────────

test.describe('Skills REST API', () => {
  let createdSkillId = null;

  test('GET /v1/skills returns array with builtin skills', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/skills`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body).toHaveProperty('skills');
    expect(Array.isArray(body.skills)).toBe(true);
    // Builtin skills should exist
    const names = body.skills.map(s => s.id);
    expect(names).toContain('debug');
    expect(names).toContain('architect');
    expect(names).toContain('review');
  });

  test('POST /v1/skills creates a skill with correct fields', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/skills`, {
      data: {
        name:           'test-skill-api',
        description:    'Created by Playwright test',
        triggerPhrases: ['run test', 'do test'],
      },
    });
    expect(r.status()).toBe(201);
    const skill = await r.json();
    expect(skill.id).toBe('test-skill-api');
    expect(skill.name).toBe('test-skill-api');
    expect(skill.source).toBe('explicit');
    expect(skill.description).toBe('Created by Playwright test');
    expect(skill.triggerPhrases).toEqual(['run test', 'do test']);
    expect(skill.usageCount).toBe(0);
    createdSkillId = skill.id;
  });

  test('created skill appears in GET /v1/skills', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/skills`);
    const { skills } = await r.json();
    const found = skills.find(s => s.id === 'test-skill-api');
    expect(found).toBeDefined();
    expect(found.description).toBe('Created by Playwright test');
  });

  test('POST /v1/skills without name returns 400', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/skills`, {
      data: { description: 'Missing name field' },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toBeDefined();
  });

  test('DELETE /v1/skills/:id removes the skill', async ({ request }) => {
    const r = await request.delete(`${API_BASE}/v1/skills/test-skill-api`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);

    // Verify gone
    const check = await request.get(`${API_BASE}/v1/skills`);
    const { skills } = await check.json();
    expect(skills.find(s => s.id === 'test-skill-api')).toBeUndefined();
  });

  test('DELETE /v1/skills/:id on non-existent skill returns 404', async ({ request }) => {
    const r = await request.delete(`${API_BASE}/v1/skills/no-such-skill-xyz`);
    expect(r.status()).toBe(404);
  });

  test('multiple skills can be created in parallel', async ({ request }) => {
    const creates = await Promise.all([1, 2, 3].map(i =>
      request.post(`${API_BASE}/v1/skills`, {
        data: { name: `parallel-skill-${i}`, description: `Parallel skill ${i}` },
      })
    ));
    for (const r of creates) expect(r.status()).toBe(201);

    const list = await request.get(`${API_BASE}/v1/skills`);
    const { skills } = await list.json();
    for (let i = 1; i <= 3; i++) {
      expect(skills.find(s => s.id === `parallel-skill-${i}`)).toBeDefined();
    }

    // Cleanup
    await Promise.all([1, 2, 3].map(i =>
      request.delete(`${API_BASE}/v1/skills/parallel-skill-${i}`)
    ));
  });

  test('skill name with spaces gets slugified as ID', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/skills`, {
      data: { name: 'My Complex Skill Name' },
    });
    expect(r.status()).toBe(201);
    const skill = await r.json();
    expect(skill.id).toBe('my-complex-skill-name');
    await request.delete(`${API_BASE}/v1/skills/${skill.id}`);
  });
});

// ── UI-level skills interactions ──────────────────────────────────────────────

test.describe('Skills tab UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    // Wait for module scripts to initialize
    await page.waitForFunction(() => typeof window.switchTab === 'function', { timeout: 15000 });
    await page.click('#tab-skills');
    await page.waitForSelector('#panel-skills.visible', { timeout: 8000 });
  });

  test('Skills panel shows skill count', async ({ page }) => {
    // Wait for loadSkills to finish
    await page.waitForFunction(
      () => document.getElementById('skills-count')?.textContent?.match(/\d+\s+skill/),
      { timeout: 8000 }
    );
    const countText = await page.locator('#skills-count').textContent();
    expect(countText).toMatch(/\d+ skill/);
  });

  test('builtin skills are rendered in the list', async ({ page }) => {
    await page.waitForFunction(
      () => document.querySelectorAll('.skill-card').length >= 3,
      { timeout: 8000 }
    );
    const cards = await page.locator('.skill-card').count();
    expect(cards).toBeGreaterThanOrEqual(3);
  });

  test('builtin skills have no delete button', async ({ page }) => {
    await page.waitForSelector('.skill-card', { timeout: 8000 });
    const builtinCards = page.locator('.skill-card:has(.skill-source.builtin)');
    // No .skill-del inside builtin cards
    for (const card of await builtinCards.all()) {
      const delBtn = card.locator('.skill-del');
      expect(await delBtn.count()).toBe(0);
    }
  });

  test('"+ NEW SKILL" button shows the create form', async ({ page }) => {
    // Form starts hidden
    const form = page.locator('#skill-create-form');
    await expect(form).not.toHaveClass(/open/);

    await page.click('button:has-text("+ NEW SKILL")');
    await expect(form).toHaveClass(/open/);
  });

  test('CANCEL button hides the form', async ({ page }) => {
    await page.click('button:has-text("+ NEW SKILL")');
    await expect(page.locator('#skill-create-form')).toHaveClass(/open/);

    await page.click('button:has-text("CANCEL")');
    await expect(page.locator('#skill-create-form')).not.toHaveClass(/open/);
  });

  test('creating a skill via form adds it to the list', async ({ page }) => {
    const skillName = `ui-skill-${Date.now()}`;
    const skillId = skillName;

    await page.click('button:has-text("+ NEW SKILL")');
    await page.fill('#skill-form-name', skillName);
    await page.fill('#skill-form-triggers', 'run ui, test ui');
    await page.fill('#skill-form-desc', 'Created from Playwright UI test');
    await page.click('button:has-text("CREATE")');

    // Form should close and list should reload
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.skill-name')].some(el => el.textContent.includes(name)),
      skillName,
      { timeout: 8000 }
    );

    const skillNames = await page.locator('.skill-name').allTextContents();
    expect(skillNames.some(n => n.includes(skillName))).toBe(true);

    // Cleanup via API
    await fetch(`${API_BASE}/v1/skills/${skillId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('created skill shows DELETE button', async ({ page }) => {
    const skillName = `del-test-${Date.now()}`;
    await page.click('button:has-text("+ NEW SKILL")');
    await page.fill('#skill-form-name', skillName);
    await page.click('button:has-text("CREATE")');

    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.skill-name')].some(el => el.textContent.includes(name)),
      skillName,
      { timeout: 8000 }
    );

    // Find the card for our skill and check it has a DELETE button
    const card = page.locator('.skill-card').filter({ hasText: skillName });
    await expect(card.locator('.skill-del')).toBeVisible();

    // Click DELETE
    await card.locator('.skill-del').click();

    // Skill should disappear
    await page.waitForFunction(
      (name) => ![...document.querySelectorAll('.skill-name')].some(el => el.textContent.includes(name)),
      skillName,
      { timeout: 8000 }
    );
  });

  test('form validation: empty name shows no crash', async ({ page }) => {
    await page.click('button:has-text("+ NEW SKILL")');
    // Try to create without a name
    await page.fill('#skill-form-name', '');
    await page.click('button:has-text("CREATE")');
    // Form should still be visible (no crash, no creation)
    await expect(page.locator('#skill-create-form')).toHaveClass(/open/);
  });
});

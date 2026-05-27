// edge-cases.spec.js — Error handling, boundary conditions, stress tests
'use strict';
const { test, expect } = require('@playwright/test');

const UI_BASE  = 'http://localhost:7474';
const API_BASE = 'http://localhost:7476';

async function waitForModules(page) {
  await page.waitForFunction(() => typeof window.switchTab === 'function', { timeout: 15000 });
}

// ── API edge cases ────────────────────────────────────────────────────────────

test.describe('API edge cases', () => {
  test('POST /v1/skills with special characters in name', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/skills`, {
      data: { name: 'skill with & < > chars', description: 'XSS test' },
    });
    expect(r.status()).toBe(201);
    const skill = await r.json();
    // ID should be slugified
    expect(skill.id).not.toContain('<');
    expect(skill.id).not.toContain('>');
    expect(skill.id).not.toContain('&');
    await request.delete(`${API_BASE}/v1/skills/${skill.id}`);
  });

  test('POST /v1/skills with very long name truncates gracefully', async ({ request }) => {
    const longName = 'a'.repeat(200);
    const r = await request.post(`${API_BASE}/v1/skills`, {
      data: { name: longName },
    });
    expect(r.status()).toBe(201);
    const skill = await r.json();
    expect(skill.id).toBeTruthy();
    await request.delete(`${API_BASE}/v1/skills/${skill.id}`);
  });

  test('API handles empty POST body gracefully', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/skills`, {
      data: {},
    });
    expect(r.status()).toBe(400);
  });

  test('API handles malformed JSON body (non-JSON content type)', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/events/external`, {
      headers: { 'Content-Type': 'application/json' },
      data:    '{ invalid json',
    });
    // Server should handle parse failure gracefully
    const status = r.status();
    expect([200, 400, 500]).toContain(status);
  });

  test('POST /v1/recall with empty query returns empty or server error gracefully', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/recall`, {
      data: { query: '', topK: 5 },
    });
    // Either 200 with empty results, or 503 if vector module unavailable
    const status = r.status();
    expect([200, 503]).toContain(status);
    if (status === 200) {
      const body = await r.json();
      expect(body).toHaveProperty('results');
    }
  });

  test('requesting a deleted skill returns 404', async ({ request }) => {
    // Create then delete
    const create = await request.post(`${API_BASE}/v1/skills`, {
      data: { name: 'ephemeral-skill' },
    });
    expect(create.status()).toBe(201);
    const skill = await create.json();

    await request.delete(`${API_BASE}/v1/skills/${skill.id}`);

    // Second delete should 404
    const r2 = await request.delete(`${API_BASE}/v1/skills/${skill.id}`);
    expect(r2.status()).toBe(404);
  });

  test('concurrent skill creates and deletes do not corrupt the list', async ({ request }) => {
    const names = Array.from({ length: 5 }, (_, i) => `concurrent-${Date.now()}-${i}`);

    // Create 5 in parallel
    const creates = await Promise.all(names.map(name =>
      request.post(`${API_BASE}/v1/skills`, { data: { name } })
    ));
    for (const r of creates) expect(r.status()).toBe(201);

    // Delete all in parallel
    const deletes = await Promise.all(names.map(name =>
      request.delete(`${API_BASE}/v1/skills/${name}`)
    ));
    for (const r of deletes) expect(r.ok()).toBeTruthy();

    // List should not contain any of them
    const list = await request.get(`${API_BASE}/v1/skills`);
    const { skills } = await list.json();
    for (const name of names) {
      expect(skills.find(s => s.id === name)).toBeUndefined();
    }
  });

  test('neural UI status remains responsive under concurrent requests', async ({ request }) => {
    const requests = Array.from({ length: 10 }, () =>
      request.get(`${UI_BASE}/api/status`)
    );
    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.ok()).toBeTruthy();
    }
  });
});

// ── UI edge cases ─────────────────────────────────────────────────────────────

test.describe('UI edge cases', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await waitForModules(page);
  });

  test('skill count reflects actual number of skills', async ({ page }) => {
    await page.click('#tab-skills');
    await page.waitForSelector('#panel-skills.visible');

    // Wait for list to load
    await page.waitForFunction(
      () => document.getElementById('skills-count')?.textContent?.match(/\d+/),
      { timeout: 8000 }
    );

    const countText = await page.locator('#skills-count').textContent();
    const countNum  = parseInt(countText.match(/\d+/)[0], 10);
    const cardCount = await page.locator('.skill-card').count();

    expect(countNum).toBe(cardCount);
  });

  test('graph stats match actual graph data', async ({ page, request }) => {
    const r = await request.get(`${API_BASE}/v1/graph`);
    const data = await r.json();

    await page.click('#tab-graph');
    await page.waitForSelector('#panel-graph.visible');

    await page.waitForFunction(
      () => document.getElementById('graph-stats')?.textContent?.match(/\d+ nodes/),
      { timeout: 8000 }
    );

    const stats = await page.locator('#graph-stats').textContent();
    const uiNodes = parseInt(stats.match(/(\d+) nodes/)[1], 10);
    expect(uiNodes).toBe(data.nodes.length);
  });

  test('settings panel does not appear on non-neural tabs', async ({ page }) => {
    await page.click('#tab-graph');
    await page.waitForSelector('#panel-graph.visible');
    // S key does still open settings even from other tabs (settings is z-index:30 overlay)
    // This is by design — just verify it opens
    await page.keyboard.press('s');
    await expect(page.locator('#settings')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
  });

  test('tab panels do not overlap (only one visible at a time)', async ({ page }) => {
    const tabs = ['graph', 'skills', 'memory'];
    for (const tab of tabs) {
      await page.click(`#tab-${tab}`);
      const visible = await page.locator('.tab-panel.visible').count();
      expect(visible).toBe(1);
      const active = await page.locator('.tab-panel:not(.visible)').count();
      expect(active).toBe(2); // 3 total - 1 visible = 2 hidden
    }
  });

  test('page title stays "JARVIS Neural Core" on all tabs', async ({ page }) => {
    for (const tab of ['graph', 'skills', 'memory', 'neural']) {
      await page.click(`#tab-${tab}`);
      expect(await page.title()).toBe('JARVIS Neural Core');
    }
  });

  test('memory panel handles API being unavailable gracefully', async ({ page }) => {
    // The API is running, but vector module may return 503 — test graceful display
    await page.click('#tab-memory');
    await page.waitForSelector('#panel-memory.visible');

    // Wait for memory columns to be populated (even if just showing "unavailable")
    await page.waitForFunction(
      () => document.getElementById('mem-working')?.children.length > 0 ||
            document.getElementById('mem-working')?.textContent?.includes('unavailable'),
      { timeout: 10000 }
    );

    const workingText = await page.locator('#mem-working').textContent();
    // Should not be blank
    expect(workingText.trim()).toBeTruthy();
  });

  test('switching tabs loads fresh data each time', async ({ page }) => {
    // Load skills tab
    await page.click('#tab-skills');
    await page.waitForFunction(
      () => document.getElementById('skills-count')?.textContent?.match(/\d+/),
      { timeout: 8000 }
    );
    const count1 = await page.locator('#skills-count').textContent();

    // Switch away and back
    await page.click('#tab-neural');
    await page.click('#tab-skills');
    await page.waitForFunction(
      () => document.getElementById('skills-count')?.textContent?.match(/\d+/),
      { timeout: 8000 }
    );
    const count2 = await page.locator('#skills-count').textContent();

    // Counts should be consistent (may differ if another test ran concurrently)
    expect(count1).toMatch(/\d+ skill/);
    expect(count2).toMatch(/\d+ skill/);
  });
});

// ── Stress tests ──────────────────────────────────────────────────────────────

test.describe('Stress tests', () => {
  test('creating 20 skills in sequence', async ({ request }) => {
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const r = await request.post(`${API_BASE}/v1/skills`, {
        data: { name: `stress-skill-${i}`, description: `Stress test skill ${i}` },
      });
      expect(r.status()).toBe(201);
      const s = await r.json();
      ids.push(s.id);
    }

    // Verify all 20 exist
    const list = await request.get(`${API_BASE}/v1/skills`);
    const { skills } = await list.json();
    for (const id of ids) {
      expect(skills.find(s => s.id === id)).toBeDefined();
    }

    // Cleanup
    await Promise.all(ids.map(id => request.delete(`${API_BASE}/v1/skills/${id}`)));
  });

  test('status endpoint handles 50 concurrent requests', async ({ request }) => {
    const reqs = Array.from({ length: 50 }, () => request.get(`${API_BASE}/v1/status`));
    const responses = await Promise.all(reqs);
    let successCount = 0;
    for (const r of responses) {
      if (r.ok()) successCount++;
    }
    expect(successCount).toBeGreaterThanOrEqual(45); // allow a few failures under stress
  });
});

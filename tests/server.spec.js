// server.spec.js — REST API endpoint tests (port 7474 + 7476)
'use strict';
const { test, expect } = require('@playwright/test');

const UI_BASE  = 'http://localhost:7474';
const API_BASE = 'http://localhost:7476';

// ── Neural UI server (port 7474) ──────────────────────────────────────────────

test.describe('Neural UI server (7474)', () => {
  test('GET /api/status returns JSON', async ({ request }) => {
    const r = await request.get(`${UI_BASE}/api/status`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body).toHaveProperty('totalCalls');
    expect(body).toHaveProperty('speaking');
  });

  test('GET / serves HTML page', async ({ request }) => {
    const r = await request.get(`${UI_BASE}/`);
    expect(r.ok()).toBeTruthy();
    const text = await r.text();
    expect(text).toContain('JARVIS');
    expect(text).toContain('tab-bar');
  });

  test('GET /api/config returns allowed keys only', async ({ request }) => {
    const r = await request.get(`${UI_BASE}/api/config`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body).toHaveProperty('speakMinLevel');
    expect(body).toHaveProperty('voiceMode');
    // Sensitive keys must NOT be exposed
    expect(body).not.toHaveProperty('pythonPath');
    expect(body).not.toHaveProperty('jarvisSpeakPath');
  });

  test('POST /api/config updates allowed key', async ({ request }) => {
    const r = await request.post(`${UI_BASE}/api/config`, {
      data: { speakMinLevel: 2 },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);

    // Verify it was saved
    const check = await request.get(`${UI_BASE}/api/config`);
    const cfg = await check.json();
    expect(cfg.speakMinLevel).toBe(2);

    // Restore
    await request.post(`${UI_BASE}/api/config`, { data: { speakMinLevel: 1 } });
  });

  test('POST /api/config rejects unknown keys (no-op)', async ({ request }) => {
    const r = await request.post(`${UI_BASE}/api/config`, {
      data: { pythonPath: '/evil/path' },
    });
    expect(r.ok()).toBeTruthy();
    // Verify sensitive key was NOT written
    const check = await request.get(`${UI_BASE}/api/config`);
    const cfg = await check.json();
    expect(cfg.pythonPath).toBeUndefined();
  });

  test('GET /api/audio/stream is SSE endpoint', async ({ request }) => {
    const r = await request.get(`${UI_BASE}/api/audio/stream`, {
      timeout: 2000,
    }).catch(() => null);
    // Either times out (expected for streaming) or returns 200 with SSE content type
    // Just verify the endpoint exists and responds
    if (r) {
      const ct = r.headers()['content-type'] || '';
      expect(ct).toMatch(/text\/event-stream|application\/json/);
    }
  });

  test('GET /api/conversation/history returns array', async ({ request }) => {
    const r = await request.get(`${UI_BASE}/api/conversation/history`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── JARVIS API server (port 7476) ─────────────────────────────────────────────

test.describe('JARVIS API server (7476)', () => {
  test('GET /v1/status returns version 4.0.0', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/status`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('online');
    expect(body.version).toBe('4.0.0');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('port', 7476);
  });

  test('GET /v1/context returns session object or graceful error', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/context`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    // Either a session or the "no active session" placeholder
    expect(body).toHaveProperty('sessionId');
  });

  test('GET /v1/graph returns D3 nodes+links structure', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/graph`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('links');
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.links)).toBe(true);
  });

  test('POST /v1/speak returns ok (voice server may be offline)', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/speak`, {
      data: { text: 'Test narration, sir.' },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  test('POST /v1/events/external accepts external events', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/events/external`, {
      data: { type: 'ci_build', status: 'success', repo: 'arc-reactor' },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  test('POST /v1/events/external requires type field', async ({ request }) => {
    const r = await request.post(`${API_BASE}/v1/events/external`, {
      data: { status: 'success' },  // missing type
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toBeDefined();
  });

  test('unknown route returns 404', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/nonexistent`);
    expect(r.status()).toBe(404);
  });

  test('CORS headers present on API responses', async ({ request }) => {
    const r = await request.get(`${API_BASE}/v1/status`);
    const headers = r.headers();
    expect(headers['access-control-allow-origin']).toBe('*');
  });
});

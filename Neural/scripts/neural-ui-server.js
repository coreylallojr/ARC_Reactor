// Neural/scripts/neural-ui-server.js
// Serves the JARVIS neural visualization UI, live status, SSE audio push,
// proactive commentary triggers, and text chat endpoint.
'use strict';
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const os    = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const STATE_PATH      = path.join(config.neural, '.session-state.json');
const LOCK_PATH       = path.join(config.neural, '.voice-lock');
const TTS_ACTIVE_PATH = path.join(config.neural, '.tts-active');
const STATUS_PATH     = path.join(config.neural, 'status.md');
const INTENT_PATH     = path.join(config.neural, 'context', 'current-intent.md');
const HISTORY_PATH    = path.join(config.neural, '.voice-history.json');
const HTML_PATH       = path.join(__dirname, '..', 'ui', 'jarvis-neural.html');
const PENDING_AUDIO   = path.join(config.neural, '.pending-audio');
const PORT            = 7474;

const CACHE_DIR = path.join(os.homedir(), '.claude', 'jarvis-audio', 'cache');

const memory    = require('./jarvis-memory');
const fallbacks = require('./jarvis-fallbacks');
const { warmupCache } = require('./jarvis-cache-warmup');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readField(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return m ? m[1].trim() : '';
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function getStatus() {
  let toolCounts = {}, sessionId = 'none', lastLine = '', currentTask = '', currentAction = '';
  let audioFile = null;
  try {
    const p = fs.readFileSync(PENDING_AUDIO, 'utf8').trim();
    if (p) { audioFile = path.basename(p); fs.writeFileSync(PENDING_AUDIO, ''); }
  } catch {}
  try {
    const s = fs.readFileSync(STATUS_PATH, 'utf8');
    const toolsMatch = s.match(/^tools:\s*(\{.*?\})/m);
    if (toolsMatch) toolCounts = JSON.parse(toolsMatch[1]);
    sessionId = readField(s, 'session');
  } catch {}
  try { const hist = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); lastLine = hist[hist.length - 1] || ''; } catch {}
  try { const intent = fs.readFileSync(INTENT_PATH, 'utf8'); currentAction = readField(intent, 'action'); currentTask = currentAction; } catch {}
  const totalCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  const speaking = browserSpeaking || fs.existsSync(TTS_ACTIVE_PATH);
  return { speaking, audioFile, lastLine, toolCounts, currentTask, currentAction, sessionId, totalCalls };
}

let browserSpeaking = false;
const ALLOWED_CONFIG_KEYS = new Set(['speakMinLevel', 'ollamaModel', 'ollamaUrl', 'maxContextMode', 'voiceMode']);

// ── SSE audio push ────────────────────────────────────────────────────────────

const sseAudioClients = new Set();
let lastPushedAudio = '';

function pushAudioEvent(filename) {
  if (!filename) return;
  const data = `data: ${JSON.stringify({ type: 'audio_ready', filename })}\n\n`;
  for (const client of sseAudioClients) {
    try { client.write(data); } catch { sseAudioClients.delete(client); }
  }
}

// Server-side poll for .pending-audio — replaces browser 150ms poll for audio
setInterval(() => {
  try {
    const p = fs.readFileSync(PENDING_AUDIO, 'utf8').trim();
    if (p && p !== lastPushedAudio) {
      lastPushedAudio = p;
      fs.writeFileSync(PENDING_AUDIO, '');
      pushAudioEvent(path.basename(p));
    }
  } catch {}
}, 30); // 30ms server-side check instead of 150ms browser poll

// ── Proactive triggers ────────────────────────────────────────────────────────

const proactiveCooldowns = new Map();

const PROACTIVE_TRIGGERS = [
  { id: 'idle_45s',
    check: (s) => s && s.lastToolCallTime && (Date.now() - s.lastToolCallTime) > 45000,
    cooldown: 120000, category: 'IDLE' },
  { id: 'repeated_error',
    check: (s) => s && (s.consecutiveErrors || 0) >= 3,
    cooldown: 180000, category: 'REPEATED_ERROR' },
  { id: 'long_session',
    check: (s) => s && s.startTime && (Date.now() - s.startTime) > 30 * 60 * 1000,
    cooldown: 20 * 60 * 1000, category: 'LONG_SESSION' },
  { id: 'milestone_25',
    check: (s) => s && (s.callCount || 0) > 0 && (s.callCount % 25 === 0),
    cooldown: 5000, category: 'MILESTONE' },
];

async function speakProactive(text) {
  // Re-read config in case it changed
  let cfg = config;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  if (!cfg.pythonPath || !cfg.jarvisSpeakPath) return;

  const proc = spawn(cfg.pythonPath, [cfg.jarvisSpeakPath, '--path-only', text], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let wavPath = '';
  proc.stdout.on('data', d => { wavPath += d.toString(); });
  await new Promise(resolve => proc.on('close', resolve).on('error', resolve));
  const filename = wavPath.trim() ? path.basename(wavPath.trim()) : null;
  if (filename) {
    pushAudioEvent(filename);
    // Update voice history for subtitle display
    try {
      let hist = [];
      try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch {}
      hist.push(text);
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist.slice(-20)));
    } catch {}
  }
}

let lastMilestoneCalls = -1;
setInterval(async () => {
  const state = loadState();
  if (!state) return;
  for (const trigger of PROACTIVE_TRIGGERS) {
    if (!trigger.check(state)) continue;

    // Special: milestone fires once per 25-call boundary
    if (trigger.id === 'milestone_25') {
      if (state.callCount === lastMilestoneCalls) continue;
      lastMilestoneCalls = state.callCount;
    } else {
      const lastFired = proactiveCooldowns.get(trigger.id) || 0;
      if (Date.now() - lastFired < trigger.cooldown) continue;
      proactiveCooldowns.set(trigger.id, Date.now());
    }

    const line = fallbacks.selectFallback(trigger.category, state);
    speakProactive(line).catch(() => {});
    break; // one proactive at a time
  }
}, 15000);

// ── Ollama warm start ─────────────────────────────────────────────────────────

function warmupOllama() {
  if (!config.ollamaUrl || !config.ollamaModel) return;
  const base = config.ollamaUrl.replace(/\/v1.*$/, '');
  fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ollamaModel, prompt: 'System ready.', stream: false }),
  }).catch(() => {});
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.end(); return; }

  // SSE stream for audio push
  if (req.url === '/api/audio/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseAudioClients.add(res);
    req.on('close', () => sseAudioClients.delete(res));
    return;
  }

  if (req.url === '/api/speaking' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { const { speaking } = JSON.parse(body); browserSpeaking = !!speaking; } catch {}
      res.end('{}');
    });
    return;
  }

  if (req.url === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(getStatus()));
    return;
  }

  if (req.url === '/api/config' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const safe = {};
      for (const k of ALLOWED_CONFIG_KEYS) safe[k] = cfg[k];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(safe));
    } catch (e) { res.statusCode = 500; res.end(e.message); }
    return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        for (const [k, v] of Object.entries(update)) { if (ALLOWED_CONFIG_KEYS.has(k)) cfg[k] = v; }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // Text chat endpoint — routes message through voice server or direct Ollama
  if (req.url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { text, projectPath } = JSON.parse(body);
        if (!text) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify({ ok: true })); // immediate response to browser

        // Forward to voice server if running, else handle directly
        fetch('http://localhost:7475/voice/transcript', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, projectPath }),
        }).catch(() => {
          // Voice server not running — respond directly via Ollama
          directOllamaResponse(text, projectPath);
        });
      } catch { res.statusCode = 400; res.end('{}'); }
    });
    return;
  }

  // Conversation history for console panel
  if (req.url.startsWith('/api/conversation/history')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const projectPath = params.get('project') || config.vault || '';
    const history = memory.getConversationHistory(projectPath, 20);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(history));
    return;
  }

  if (req.url.startsWith('/audio/') && req.method === 'GET') {
    const filename = path.basename(req.url.slice(7));
    const filePath = path.join(CACHE_DIR, filename);
    try {
      const data = fs.readFileSync(filePath);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(data);
    } catch { res.statusCode = 404; res.end('Not found'); }
    return;
  }

  try {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (e) { res.statusCode = 404; res.end('Neural UI not found: ' + e.message); }
});

// Fallback direct Ollama response (when voice server isn't running)
async function directOllamaResponse(text, projectPath) {
  if (!config.ollamaUrl || !config.ollamaModel) return;
  try {
    const base = config.ollamaUrl.replace(/\/v1.*$/, '');
    const ctx = memory.loadRecentContext(projectPath || '', 'direct');
    const ctxStr = ctx.previousSession ? `Prior session: ${ctx.previousSession}\n` : '';
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel, stream: false,
        messages: [
          { role: 'system', content: 'You are JARVIS. British, dry, precise. 1-3 sentences. Say "sir". Never start with "I".' },
          { role: 'user', content: `${ctxStr}${text}` },
        ],
      }),
    });
    const data = await res.json();
    const reply = (data.message?.content || '').trim();
    if (reply) {
      memory.saveTurn('direct', 'jarvis', reply, projectPath || '');
      // Push as audio history update
      try { let hist = []; try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch {} hist.push(reply); fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist.slice(-20))); } catch {}
      await speakProactive(reply);
    }
  } catch {}
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nJARVIS Neural Core online → http://localhost:${PORT}\n`);
  spawn('cmd', ['/c', 'start', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  warmupOllama();
  // Pre-generate TTS cache for all fallback lines (background, non-blocking)
  warmupCache().catch(() => {});
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} already in use — opening existing instance.`);
    spawn('cmd', ['/c', 'start', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  } else { console.error(e); }
});

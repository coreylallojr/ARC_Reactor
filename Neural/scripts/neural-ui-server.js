// Neural/scripts/neural-ui-server.js
// Serves the JARVIS neural visualization UI and exposes live status endpoint
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const LOCK_PATH       = path.join(config.neural, '.voice-lock');
const TTS_ACTIVE_PATH = path.join(config.neural, '.tts-active'); // only true during audio playback
const STATUS_PATH = path.join(config.neural, 'status.md');
const INTENT_PATH = path.join(config.neural, 'context', 'current-intent.md');
const HISTORY_PATH = path.join(config.neural, '.voice-history.json');
const HTML_PATH   = path.join(__dirname, '..', 'ui', 'jarvis-neural.html');
const PORT = 7474;

const CACHE_DIR       = path.join(require('os').homedir(), '.claude', 'jarvis-audio', 'cache');
const PENDING_AUDIO   = path.join(config.neural, '.pending-audio');

function readField(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return m ? m[1].trim() : '';
}

function getStatus() {
  let toolCounts = {};
  let sessionId = 'none';
  let lastLine = '';
  let currentTask = '';
  let currentAction = '';

  let audioFile = null;
  try {
    const p = fs.readFileSync(PENDING_AUDIO, 'utf8').trim();
    if (p) {
      audioFile = path.basename(p);
      fs.writeFileSync(PENDING_AUDIO, ''); // clear after reading so browser only gets it once
    }
  } catch {}

  try {
    const s = fs.readFileSync(STATUS_PATH, 'utf8');
    const toolsMatch = s.match(/^tools:\s*(\{.*?\})/m);
    if (toolsMatch) toolCounts = JSON.parse(toolsMatch[1]);
    sessionId = readField(s, 'session');
  } catch {}

  try {
    const hist = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    lastLine = hist[hist.length - 1] || '';
  } catch {}

  try {
    const intent = fs.readFileSync(INTENT_PATH, 'utf8');
    currentAction = readField(intent, 'action');
    currentTask = currentAction;
  } catch {}

  const totalCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  const speaking = browserSpeaking || fs.existsSync(TTS_ACTIVE_PATH);

  return { speaking, audioFile, lastLine, toolCounts, currentTask, currentAction, sessionId, totalCalls };
}

let browserSpeaking = false;

// Config keys the UI is allowed to update
const ALLOWED_CONFIG_KEYS = new Set(['speakMinLevel', 'ollamaModel', 'ollamaUrl', 'maxContextMode']);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.end(); return; }

  if (req.url === '/api/speaking' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { speaking } = JSON.parse(body);
        browserSpeaking = !!speaking;
      } catch {}
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
        for (const [k, v] of Object.entries(update)) {
          if (ALLOWED_CONFIG_KEYS.has(k)) cfg[k] = v;
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.url.startsWith('/audio/') && req.method === 'GET') {
    const filename = path.basename(req.url.slice(7)); // strip /audio/
    const filePath = path.join(CACHE_DIR, filename);
    try {
      const data = fs.readFileSync(filePath);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
    return;
  }

  try {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (e) {
    res.statusCode = 404;
    res.end('Neural UI not found: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nJARVIS Neural Core online → http://localhost:${PORT}\n`);
  spawn('cmd', ['/c', 'start', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} already in use — opening existing instance.`);
    spawn('cmd', ['/c', 'start', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.error(e);
  }
});

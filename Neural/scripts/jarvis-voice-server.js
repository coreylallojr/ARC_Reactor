'use strict';
// JARVIS Voice Conversation Server — port 7475
// Receives voice transcripts, routes to Ollama (simple Q) or claude -p (code task),
// generates TTS, pushes audio back to browser via SSE.
// No external npm deps — uses built-in http, child_process, fs.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const os     = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const VOICE_PORT  = 7475;

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const memory  = require('./jarvis-memory');
const fallbacks = require('./jarvis-fallbacks');
const { buildContext, formatContext } = require('./neural-context');

// SSE clients for browser push
const sseClients = new Set();
let voiceState = 'idle'; // idle | listening | thinking | speaking

// Session context
let currentSession = {
  sessionId: Date.now().toString(36),
  projectPath: config.vault || process.cwd(),
  turnCount: 0,
};

function pushEvent(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

function setState(state) {
  voiceState = state;
  pushEvent({ type: 'status', state });
}

// ── Ollama helpers ─────────────────────────────────────────────────────────────

// Load current session state written by neural-logger.js
function loadCurrentState() {
  try {
    const statePath = path.join(config.neural || os.homedir(), '.session-state.json');
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch { return {}; }
}

// Split accumulated buffer on sentence boundaries; call onSentence for each complete sentence.
// Returns the remaining (incomplete) buffer fragment.
function flushSentences(buffer, onSentence, force) {
  const sentenceEnd = /[.!?](?:\s|$)/g;
  let lastIndex = 0;
  let match;
  while ((match = sentenceEnd.exec(buffer)) !== null) {
    const sentence = buffer.slice(lastIndex, match.index + 1).trim();
    if (sentence.length > 8) onSentence(sentence);
    lastIndex = match.index + 1;
  }
  const remaining = buffer.slice(lastIndex);
  if (force && remaining.trim().length > 8) onSentence(remaining.trim());
  return force ? '' : remaining;
}

// Streaming Ollama chat — calls onSentence for each complete sentence as tokens arrive.
// Falls back to batch behaviour when onSentence is not provided.
async function ollamaChatStreaming(systemPrompt, userPrompt, maxWords, onSentence) {
  maxWords = maxWords || 60;
  if (!config.ollamaUrl || !config.ollamaModel) return null;
  const base = config.ollamaUrl.replace(/\/v1.*$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let text = '';
  let sentenceBuffer = '';
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) { clearTimeout(timer); return null; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.message?.content) {
            const token = d.message.content;
            text += token;
            sentenceBuffer += token;
            // Stream tokens to browser
            pushEvent({ type: 'token', token });
            // Flush complete sentences for streaming TTS
            if (onSentence) {
              sentenceBuffer = flushSentences(sentenceBuffer, onSentence, false);
            }
            if (text.split(/\s+/).filter(Boolean).length >= maxWords) {
              controller.abort();
              reader.cancel().catch(() => {});
              break outer;
            }
          }
          if (d.done) break outer;
        } catch {}
      }
    }
    // Flush any remaining sentence fragment
    if (onSentence && sentenceBuffer.trim()) {
      flushSentences(sentenceBuffer, onSentence, true);
    }
    clearTimeout(timer);
    return text.replace(/^["'`]+|["'`]+$/g, '').trim() || null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Legacy batch wrapper — kept for classifyIntent which doesn't need sentence streaming
async function ollamaChat(systemPrompt, userPrompt, maxWords) {
  return ollamaChatStreaming(systemPrompt, userPrompt, maxWords, null);
}

async function classifyIntent(transcript) {
  const prompt = `Classify this user request. Return ONLY valid JSON, nothing else.
Request: "${transcript.replace(/"/g, "'")}"
Return: {"type":"question","requiresCode":false} OR {"type":"task","requiresCode":true}
- "question": factual, conversational, status query answerable without running code
- "task": requires file editing, running code, reading files, executing commands`;

  const result = await ollamaChat(
    'You are a request classifier. Output ONLY valid JSON. No explanation.',
    prompt,
    20
  );
  try {
    const match = (result || '').match(/\{[^}]+\}/);
    return match ? JSON.parse(match[0]) : { type: 'question', requiresCode: false };
  } catch {
    return { type: 'question', requiresCode: false };
  }
}

// ── TTS pipeline ───────────────────────────────────────────────────────────────

function generateSpeech(text) {
  return new Promise((resolve) => {
    if (!config.pythonPath || !config.jarvisSpeakPath) { resolve(null); return; }
    const proc = spawn(config.pythonPath, [config.jarvisSpeakPath, '--path-only', text], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => resolve(out.trim() ? path.basename(out.trim()) : null));
    proc.on('error', () => resolve(null));
  });
}

async function speakAndPush(text) {
  if (!text) return;
  setState('speaking');
  pushEvent({ type: 'jarvis_text', text });
  const filename = await generateSpeech(text);
  if (filename) {
    pushEvent({ type: 'audio_ready', filename });
    // Also write to .pending-audio for any clients not on SSE
    try {
      const pendingPath = path.join(path.dirname(CONFIG_PATH), '.pending-audio');
      fs.writeFileSync(pendingPath, filename);
    } catch {}
  }
  setState('idle');
}

// ── Voice router ───────────────────────────────────────────────────────────────

function buildVoiceSystem(ctx) {
  const ctxLine = ctx ? formatContext(ctx) : '';
  return `You are JARVIS, Iron Man's AI assistant. British, dry, confident, precise.
You are having a voice conversation. Respond in 1-3 sentences.
Say what the information implies — not just the raw answer.
Say "sir" once per response. Never start with "I". No markdown.
${ctxLine ? `Current context: ${ctxLine}` : ''}
Output: spoken text only.`.trim();
}

async function handleTranscript(transcript) {
  if (!transcript || !transcript.trim()) return;

  setState('thinking');
  memory.saveTurn(currentSession.sessionId, 'user', transcript, currentSession.projectPath);
  currentSession.turnCount++;

  // Immediate acknowledgment
  await speakAndPush("On it, sir.");

  setState('thinking');

  // Build rich context for system prompt
  const sessionState = loadCurrentState();
  const projectCtx = await buildContext(sessionState, currentSession.projectPath);
  const voiceSystem = buildVoiceSystem(projectCtx);

  // Enrich fallback context with project state for token replacement
  const fallbackCtx = {
    ...sessionState,
    focusFile: projectCtx.focusFile,
    gitBranch: projectCtx.gitBranch,
    errorStreak: projectCtx.errorStreak,
    sessionOps: projectCtx.sessionOps,
    durationMin: projectCtx.durationMin,
  };

  const intent = await classifyIntent(transcript);

  if (!intent.requiresCode) {
    // Direct Ollama answer path — streaming TTS
    const ctx = memory.loadRecentContext(currentSession.projectPath, currentSession.sessionId);
    const ctxStr = ctx.previousSession ? `Previous session: ${ctx.previousSession}\n` : '';
    const histStr = ctx.recentTurns.length > 0
      ? 'Recent:\n' + ctx.recentTurns.map(t => `${t.role}: ${t.content}`).join('\n') + '\n'
      : '';

    // Audio queue: sentence TTS jobs fire in parallel with generation,
    // but we push audio_queued events in arrival order so the browser
    // plays them sequentially.
    const audioQueue = [];
    let fullText = '';

    const onSentence = (sentence) => {
      // Fire TTS immediately — do NOT await; runs concurrently with token generation
      const ttsPromise = generateSpeech(sentence).then((filename) => {
        if (filename) {
          pushEvent({ type: 'audio_queued', filename });
          try {
            const pendingPath = path.join(path.dirname(CONFIG_PATH), '.pending-audio');
            fs.writeFileSync(pendingPath, filename);
          } catch {}
        }
        return filename;
      });
      audioQueue.push(ttsPromise);
    };

    setState('speaking');
    const response = await ollamaChatStreaming(
      voiceSystem,
      `${ctxStr}${histStr}User: ${transcript}`,
      55,
      onSentence
    );
    fullText = response || fallbacks.selectFallback('IDLE', fallbackCtx);

    // If streaming TTS produced no audio (e.g. TTS not configured), fall back to batch
    if (audioQueue.length === 0) {
      pushEvent({ type: 'jarvis_text', text: fullText });
      const filename = await generateSpeech(fullText);
      if (filename) {
        pushEvent({ type: 'audio_ready', filename });
        try {
          const pendingPath = path.join(path.dirname(CONFIG_PATH), '.pending-audio');
          fs.writeFileSync(pendingPath, filename);
        } catch {}
      }
    } else {
      pushEvent({ type: 'jarvis_text', text: fullText });
      // Await all queued TTS jobs to ensure they complete before going idle
      await Promise.all(audioQueue);
    }

    memory.saveTurn(currentSession.sessionId, 'jarvis', fullText, currentSession.projectPath);
    setState('idle');
  } else {
    // Claude Code execution path
    setState('thinking');
    const result = await runClaudeCode(transcript);
    const summaryPrompt = `The user asked: "${transcript}"\nResult: ${result.substring(0, 800)}\nSummarise what happened in 2-3 JARVIS sentences. Be specific about outcomes.`;

    const audioQueue = [];
    const onSentence = (sentence) => {
      const ttsPromise = generateSpeech(sentence).then((filename) => {
        if (filename) {
          pushEvent({ type: 'audio_queued', filename });
          try {
            const pendingPath = path.join(path.dirname(CONFIG_PATH), '.pending-audio');
            fs.writeFileSync(pendingPath, filename);
          } catch {}
        }
        return filename;
      });
      audioQueue.push(ttsPromise);
    };

    setState('speaking');
    const summary = await ollamaChatStreaming(voiceSystem, summaryPrompt, 55, onSentence);
    const text = summary || fallbacks.selectFallback('TASK_COMPLETE', fallbackCtx);

    if (audioQueue.length === 0) {
      pushEvent({ type: 'jarvis_text', text });
      const filename = await generateSpeech(text);
      if (filename) {
        pushEvent({ type: 'audio_ready', filename });
        try {
          const pendingPath = path.join(path.dirname(CONFIG_PATH), '.pending-audio');
          fs.writeFileSync(pendingPath, filename);
        } catch {}
      }
    } else {
      pushEvent({ type: 'jarvis_text', text });
      await Promise.all(audioQueue);
    }

    memory.saveTurn(currentSession.sessionId, 'jarvis', text, currentSession.projectPath);
    setState('idle');
  }
}

function runClaudeCode(prompt) {
  return new Promise((resolve) => {
    const projectPath = currentSession.projectPath || process.cwd();
    const child = spawn('claude', ['-p', prompt], {
      cwd: projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });
    child.on('close', () => resolve(output.slice(-1200)));
    child.on('error', () => resolve('Claude Code execution encountered an error.'));
    // Timeout after 5 minutes
    setTimeout(() => { try { child.kill(); } catch {} resolve(output.slice(-1200)); }, 300000);
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.end(); return; }

  // SSE stream — browser subscribes here for voice state + audio events
  if (req.url === '/voice/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', state: voiceState })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Receive transcript from browser
  if (req.url === '/voice/transcript' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { text, projectPath } = JSON.parse(body);
        if (projectPath) currentSession.projectPath = projectPath;
        res.end(JSON.stringify({ ok: true }));
        // Handle async — don't await in HTTP handler
        handleTranscript(text).catch(e => {
          console.error('[voice] Error:', e.message);
          setState('idle');
        });
      } catch {
        res.statusCode = 400; res.end('{}');
      }
    });
    return;
  }

  // Status endpoint
  if (req.url === '/voice/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ state: voiceState, session: currentSession.sessionId }));
    return;
  }

  // Direct speak endpoint (for testing / proactive triggers)
  if (req.url === '/voice/speak' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        res.end(JSON.stringify({ ok: true }));
        speakAndPush(text).catch(() => {});
      } catch {
        res.statusCode = 400; res.end('{}');
      }
    });
    return;
  }

  // Conversation history for console panel
  if (req.url.startsWith('/voice/history')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const projectPath = params.get('project') || currentSession.projectPath;
    const history = memory.getConversationHistory(projectPath, 20);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(history));
    return;
  }

  res.statusCode = 404;
  res.end('{}');
});

server.listen(VOICE_PORT, '127.0.0.1', () => {
  console.log(`JARVIS Voice Server online → http://localhost:${VOICE_PORT}`);
  // Warm up Ollama
  if (config.ollamaUrl && config.ollamaModel) {
    const base = config.ollamaUrl.replace(/\/v1.*$/, '');
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.ollamaModel, prompt: 'System ready.', stream: false }),
    }).catch(() => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Voice server port ${VOICE_PORT} already in use.`);
  } else {
    console.error('[voice server]', e);
  }
});

// Neural/scripts/neural-logger.js
// Thin hook shim — connects to the JARVIS daemon via named pipe and sends the
// event JSON, then exits. Target latency: ~10ms when daemon is running.
// Falls back to minimal sync file writes (no TTS/Ollama) when daemon is absent.
'use strict';

const net  = require('net');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\jarvis-neural'
  : '/tmp/jarvis-neural.sock';

const isStop = process.argv.includes('--stop');

// ── Read stdin then dispatch ──────────────────────────────────────────────────

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}

  const payload = JSON.stringify({ ...input, _type: isStop ? 'stop' : 'tool' }) + '\n';

  let exited = false;
  function done() {
    if (exited) return;
    exited = true;
    process.exit(0);
  }

  // Guard: if we never connect or fallback within 500ms, exit anyway
  const bailout = setTimeout(() => {
    try { socket.destroy(); } catch {}
    fallbackWrite(input, isStop);
    done();
  }, 500);
  bailout.unref();

  const socket = net.connect(PIPE, () => {
    clearTimeout(bailout);
    socket.write(payload);
    socket.end();
    socket.on('finish', done);
    socket.on('close',  done);
  });

  socket.on('error', () => {
    clearTimeout(bailout);
    // Daemon not running — minimal sync fallback, no TTS/Ollama
    fallbackWrite(input, isStop);
    done();
  });
});

// ── Fallback: minimal file I/O, no speech ────────────────────────────────────

function fallbackWrite(input, isStop) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const neural = config.neural || require('os').homedir();

    if (isStop) {
      // Mark status as complete
      const ts = new Date().toISOString();
      const sessionId = input.session_id || 'unknown';
      let toolCounts = {};
      try {
        const state = JSON.parse(fs.readFileSync(path.join(neural, '.session-state.json'), 'utf8'));
        toolCounts = state.toolCounts || {};
      } catch {}
      const toolSummary = Object.entries(toolCounts).map(([t, n]) => `${t} ×${n}`).join(' · ');
      const statusContent = [
        '---', `updated: "${ts}"`, `session: ${sessionId}`,
        `task: complete`, `level: 2`, `tools: ${JSON.stringify(toolCounts)}`,
        `awaiting_input: false`, '---', '', 'Session complete.', '',
        `**Tools this session:** ${toolSummary || 'none'}`,
      ].join('\n');
      try { fs.writeFileSync(path.join(neural, 'status.md'), statusContent); } catch {}
      return;
    }

    // PostToolUse: update session state and append to tool log only
    const toolName  = input.tool_name || 'Unknown';
    const toolInput = input.tool_input || {};
    const sessionId = input.session_id || 'unknown';
    const responseText = typeof input.tool_response === 'string'
      ? input.tool_response
      : JSON.stringify(input.tool_response || '');
    const hasError = responseText.toLowerCase().includes('error') || responseText.toLowerCase().includes('failed');
    const ts = new Date().toISOString();
    const statePath = path.join(neural, '.session-state.json');

    let state = { sessionId: null, callCount: 0, toolCounts: {}, lastTool: null,
                  consecutiveSame: 0, startTime: Date.now(), errorCount: 0,
                  consecutiveErrors: 0, fileEditCounts: {}, lastToolCallTime: Date.now() };
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}

    const isNewSession = state.sessionId !== sessionId;
    let nextState;
    if (isNewSession) {
      nextState = {
        sessionId, callCount: 1, toolCounts: { [toolName]: 1 }, lastTool: toolName,
        consecutiveSame: 0, startTime: Date.now(), errorCount: hasError ? 1 : 0,
        consecutiveErrors: hasError ? 1 : 0, fileEditCounts: {}, lastToolCallTime: Date.now(),
      };
    } else {
      const consecutiveSame   = state.lastTool === toolName ? (state.consecutiveSame || 0) + 1 : 0;
      const consecutiveErrors = hasError ? (state.consecutiveErrors || 0) + 1 : 0;
      const fileEditCounts    = { ...(state.fileEditCounts || {}) };
      if ((toolName === 'Write' || toolName === 'Edit') && toolInput) {
        const fp = toolInput.file_path || toolInput.path || '';
        if (fp) { const bn = path.basename(fp); fileEditCounts[bn] = (fileEditCounts[bn] || 0) + 1; }
      }
      nextState = {
        sessionId, callCount: (state.callCount || 0) + 1,
        toolCounts: { ...state.toolCounts, [toolName]: (state.toolCounts[toolName] || 0) + 1 },
        lastTool: toolName, consecutiveSame,
        startTime: state.startTime || Date.now(),
        errorCount: (state.errorCount || 0) + (hasError ? 1 : 0),
        consecutiveErrors, fileEditCounts,
        lastToolCallTime: Date.now(),
      };
    }

    try { fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2)); } catch {}
    try {
      fs.appendFileSync(
        path.join(neural, 'tool-log.jsonl'),
        JSON.stringify({ ts, session: sessionId, tool: toolName, level: 1, fallback: true }) + '\n'
      );
    } catch {}
  } catch {}
}

# ARC Reactor v2 — Implementation Roadmap
> Version: 2.0.0-draft | Date: 2025-05-26

This is the build order. Follow it exactly. Each sprint ends with a working, shippable state. Never start a sprint if the previous one isn't passing its tests.

---

## Sprint Map

```
Sprint 1: Talkative JARVIS (3–4 days)
Sprint 2: Performance & Infrastructure (2–3 days)
Sprint 3: Conversation Memory (2–3 days)
Sprint 4: Text Chat UI (3–4 days)
Sprint 5: Neural UI States (2–3 days)
Sprint 6: Voice Conversation Mode (5–7 days)
Sprint 7: Polish & Docs (2–3 days)
```

Total estimate: 20–27 working days.

Sprints 1–3 are independent of each other and can be reordered. Sprint 4 depends on Sprint 3. Sprint 5 is independent. Sprint 6 depends on Sprints 1–4.

---

## Sprint 1: Talkative JARVIS

**Goal:** JARVIS speaks 2–3 sentences with real observations. Proactive idle commentary fires.

**Files modified:** `Neural/scripts/neural-logger.js`, `config.json` schema

---

### Step 1.1 — Add `voiceMode` to config

In `install.js` and `config.json` template, add:
```json
"voiceMode": 2
```

In `Neural/scripts/neural-logger.js`, at startup:
```javascript
const config = JSON.parse(fs.readFileSync(CONFIG_PATH));
const voiceMode = config.voiceMode ?? 1;
```

**Test:** `jarvis voice 1` sets voiceMode: 1. `jarvis voice 2` sets 2. No crash.

---

### Step 1.2 — Build context object

In `neural-logger.js`, add session tracking object:
```javascript
const session = {
  startTime: Date.now(),
  toolCallCount: 0,
  errorCount: 0,
  consecutiveErrors: 0,
  fileEditCounts: {},    // { 'filename': editCount }
  lastError: null,
  activeTask: null,
  lastToolCall: Date.now(),
  newDirectoryEntered: false,
};
```

Update `fileEditCounts` whenever Write/Edit tool fires. Reset `consecutiveErrors` on non-error tool call.

**Test:** After 3 Write calls to `main.js`, `session.fileEditCounts['main.js']` is 3.

---

### Step 1.3 — Replace Ollama prompt with tier system

Find the `buildOllamaPrompt()` function (or wherever the prompt string is built).

Replace with:
```javascript
function buildOllamaPrompt(toolName, target, resultSummary, session, voiceMode) {
  const ctx = buildContextSummary(session);
  
  if (voiceMode <= 1) {
    return `You are JARVIS. One sentence. Describe: ${toolName} on ${target}. Result: ${resultSummary}`;
  }
  
  if (voiceMode === 2) {
    return `You are JARVIS from Iron Man. Dry, British, confident, precise.

Tool executed: ${toolName}
Target: ${target}
Result: ${resultSummary}
Session context: ${ctx}

Respond in 2–3 sentences. Say what this implies about the larger task, not just what it did. One dry observation. Never describe the tool itself. Never start with "I".`;
  }
  
  return `You are JARVIS from Iron Man. Dry, British, confident, precise.

Tool: ${toolName} | Target: ${target} | Result: ${resultSummary}
Context: ${ctx}
Errors this session: ${session.errorCount}
Most-edited files: ${topFiles(session)}

Respond in 3–5 sentences. Volunteer relevant observations. You may ask a question if the task seems ambiguous. Reference session history naturally. Never say "Certainly" or "Of course". Never start with "I".`;
}
```

**Test:** In voiceMode 2, every voice line is 2+ sentences. Run 5 tool calls, verify in console.

---

### Step 1.4 — Build fallback library

Create `Neural/scripts/jarvis-fallbacks.js`:
```javascript
module.exports = {
  SESSION_START: [...],
  TASK_COMPLETE: [...],
  ERROR: [...],
  LONG_TASK: [...],
  IDLE: [...],
  MILESTONE: [...],
};
```

With 8–10 lines per category (50+ total, as specified in personality spec).

In `neural-logger.js`:
```javascript
const fallbacks = require('./jarvis-fallbacks');

function selectFallback(category, session) {
  const lines = fallbacks[category] || fallbacks.IDLE;
  const line = lines[Math.floor(Math.random() * lines.length)];
  return line.replace('{toolCallCount}', session.toolCallCount)
             .replace('{taskName}', session.activeTask || 'current task');
}
```

**Test:** `selectFallback('ERROR', session)` returns a contextual error line, not always the same one.

---

### Step 1.5 — Add proactive commentary loop

At the bottom of `neural-logger.js`, after all existing code:
```javascript
const PROACTIVE_TRIGGERS = [
  { id: 'idle_45s', check: (s) => Date.now() - s.lastToolCall > 45000, cooldown: 120000,
    category: 'IDLE' },
  { id: 'repeated_error', check: (s) => s.consecutiveErrors >= 3, cooldown: 180000,
    category: 'ERROR' },
  { id: 'long_session', check: (s) => Date.now() - s.startTime > 30 * 60 * 1000,
    cooldown: 20 * 60 * 1000, category: 'LONG_TASK' },
  { id: 'milestone', check: (s) => s.toolCallCount > 0 && s.toolCallCount % 25 === 0,
    cooldown: 0, category: 'MILESTONE' },
];

const cooldowns = new Map();

setInterval(async () => {
  for (const trigger of PROACTIVE_TRIGGERS) {
    if (!trigger.check(session)) continue;
    const last = cooldowns.get(trigger.id) || 0;
    if (Date.now() - last < trigger.cooldown) continue;
    cooldowns.set(trigger.id, Date.now());
    const line = selectFallback(trigger.category, session);
    await speak(line);
    break;
  }
}, 15000);
```

**Test:** Leave terminal idle for 45+ seconds → JARVIS speaks an idle line. Confirm it doesn't fire again for 2 minutes.

---

### Sprint 1 Done Criteria

- [ ] `voiceMode: 2` in default config
- [ ] Ollama generates 2–3 sentences per tool call in voiceMode 2
- [ ] Fallback library has 50+ lines across 6 categories
- [ ] Idle commentary fires after 45s
- [ ] Repeated error commentary fires at 3rd consecutive error
- [ ] Session milestone fires at 25-call marks

---

## Sprint 2: Performance & Infrastructure

**Goal:** Audio plays in <300ms at startup. WebSocket push replaces file polling. Ollama warm start.

**Files modified:** `Neural/ui/jarvis-neural.html`, `Neural/scripts/neural-server.js`, `Neural/scripts/neural-logger.js`

---

### Step 2.1 — Ollama warm start

In `neural-logger.js`, at session start (after hooks are registered):
```javascript
async function warmOllama() {
  try {
    await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model: config.ollamaModel, prompt: 'System ready.', stream: false }),
    });
  } catch {}
}
warmOllama();
```

**Test:** First tool call after warm start responds in ~200ms (model already loaded).

---

### Step 2.2 — WAV cache pre-warming

Create `Neural/scripts/jarvis-cache-warmup.js`:
- Import all fallback lines from `jarvis-fallbacks.js`
- For each line, check if MD5 hash file exists in `~/.claude/jarvis-audio/cache/`
- If not, generate with Piper and save
- Report: `N lines cached, X total MB`

Add CLI command: `jarvis cache warmup`

In `neural-server.js`, run cache warmup async on server start (non-blocking):
```javascript
spawn('node', [CACHE_WARMUP_SCRIPT], { detached: true, stdio: 'ignore' }).unref();
```

**Test:** `jarvis cache warmup` runs to completion. Second run: all files already cached, no Piper calls.

---

### Step 2.3 — WebSocket push for audio (replace file polling)

This is the highest-impact performance change. Replace the `.pending-audio` file bridge.

**In `neural-server.js`:** Add WebSocket server alongside existing HTTP:
```javascript
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server: httpServer });

const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

// Called by neural-logger.js when audio is ready
function pushAudioReady(filename) {
  for (const ws of clients) {
    ws.send(JSON.stringify({ type: 'audio_ready', filename }));
  }
}
```

**In `neural-logger.js`:** Replace `fs.writeFileSync('.pending-audio', filename)` with HTTP call to internal push endpoint, or import and call `pushAudioReady()` directly.

**In `jarvis-neural.html`:** Replace 150ms polling interval with WebSocket listener:
```javascript
// REMOVE THIS:
// setInterval(async () => { ... poll /audio/pending ... }, 150);

// REPLACE WITH:
const pushWs = new WebSocket('ws://localhost:7474');
pushWs.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'audio_ready') {
    playAudioFile(msg.filename);
  }
};
```

**Test:** Voice line fires → audio plays with no perceivable delay. No polling interval in DevTools.

---

### Sprint 2 Done Criteria

- [ ] First Ollama response after startup: < 200ms
- [ ] First cached audio line: < 100ms (no Piper synthesis)
- [ ] Audio push: < 50ms from file ready to browser play start
- [ ] No `.pending-audio` polling in browser DevTools network tab
- [ ] `jarvis cache warmup` pre-caches all 50+ fallback lines

---

## Sprint 3: Conversation Memory

**Goal:** JARVIS remembers previous sessions. Context injected into every Ollama call.

**Files modified:** `Neural/scripts/neural-logger.js`, new `Neural/scripts/jarvis-memory.js`

---

### Step 3.1 — Install better-sqlite3

```bash
cd C:\tmp\ARC_Reactor
npm install better-sqlite3
```

Test import works: `node -e "require('better-sqlite3')"` → no error.

---

### Step 3.2 — Create database schema

Create `Neural/scripts/jarvis-memory.js`:
```javascript
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.claude', 'jarvis-memory.db');

let db;
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        turn INTEGER,
        role TEXT,
        content TEXT,
        tool_context TEXT,
        timestamp INTEGER,
        project_path TEXT
      );
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        summary TEXT,
        key_facts TEXT,
        created_at INTEGER,
        turn_count INTEGER,
        project_path TEXT
      );
    `);
  }
  return db;
}
module.exports = { getDb, DB_PATH };
```

**Test:** Run `node -e "require('./Neural/scripts/jarvis-memory').getDb()"` → file created at `~/.claude/jarvis-memory.db`.

---

### Step 3.3 — Save turns

In `neural-logger.js`, after each JARVIS narration:
```javascript
const { getDb } = require('./jarvis-memory');

function saveTurn(role, content, toolContext = null) {
  getDb().prepare(`
    INSERT INTO conversations (session_id, turn, role, content, tool_context, timestamp, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(SESSION_ID, turnCount++, role, content,
         toolContext ? JSON.stringify(toolContext) : null,
         Date.now(), PROJECT_PATH);
}
```

Call `saveTurn('jarvis', voiceLine)` after each narration. Call `saveTurn('system', eventDesc)` on hook events.

**Test:** Run 5 tool calls. Check `jarvis-memory.db` has 5 rows in `conversations`.

---

### Step 3.4 — Inject context into Ollama prompts

In `buildOllamaPrompt()`, add context from DB:
```javascript
function loadRecentContext(projectPath, currentSessionId) {
  const recent = getDb().prepare(`
    SELECT role, content FROM conversations
    WHERE project_path = ? ORDER BY timestamp DESC LIMIT 5
  `).all(projectPath);
  
  const prevSummary = getDb().prepare(`
    SELECT summary FROM session_summaries
    WHERE project_path = ? AND session_id != ?
    ORDER BY created_at DESC LIMIT 1
  `).get(projectPath, currentSessionId);
  
  return {
    recentTurns: recent.reverse(),
    previousSession: prevSummary?.summary || null,
  };
}
```

Add to voiceMode 2+ prompts:
```
Previous session: {previousSession || 'First session in this project'}
Recent context: {recentTurns.map(t => `${t.role}: ${t.content}`).join('\n')}
```

**Test:** JARVIS references the previous session's work in his opening line on the second session.

---

### Step 3.5 — Session summarization on Stop hook

The `Stop` hook fires when Claude Code session ends.

In `neural-logger.js`, `Stop` hook handler:
```javascript
async function onSessionStop() {
  // Collect all turns from this session
  const turns = getDb().prepare(`
    SELECT role, content FROM conversations
    WHERE session_id = ? ORDER BY turn ASC
  `).all(SESSION_ID);
  
  if (turns.length === 0) return;
  
  const transcript = turns.map(t => `${t.role}: ${t.content}`).join('\n');
  
  const summaryPrompt = `Summarize this AI coding session in 2–3 sentences. Focus on: what was built or fixed, major decisions, what's left to do. Be specific about filenames and outcomes. Session transcript:\n${transcript}`;
  
  const summary = await callOllama(summaryPrompt);
  
  getDb().prepare(`
    INSERT OR REPLACE INTO session_summaries (session_id, summary, created_at, turn_count, project_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(SESSION_ID, summary, Date.now(), turns.length, PROJECT_PATH);
}
```

**Test:** Finish a session. Check `session_summaries` table has a row with an accurate summary.

---

### Sprint 3 Done Criteria

- [ ] `jarvis-memory.db` created automatically on first run
- [ ] Every JARVIS narration saved to `conversations` table
- [ ] Session summary written on Stop hook
- [ ] Next session greeting references previous session summary
- [ ] Context from last 5 turns injected into Ollama prompts

---

## Sprint 4: Text Chat UI

**Goal:** Console panel appears on `[C]` key. Text input routes through voice server. Messages stream in. History persists.

**Files modified:** `Neural/ui/jarvis-neural.html`, `Neural/scripts/neural-server.js`

**Depends on:** Sprint 3 (SQLite memory), Sprint 2 (WebSocket push)

---

### Step 4.1 — Add console panel HTML/CSS

In `jarvis-neural.html`, before the closing `</body>`:
```html
<div id="console-panel" class="console-hidden">
  <div class="console-header">
    <span>J.A.R.V.I.S. CONSOLE</span>
    <button onclick="toggleConsole()">×</button>
  </div>
  <div id="console-messages"></div>
  <div class="console-input-row">
    <input id="console-input" type="text" placeholder="Type a message..." />
    <button id="console-send">SEND</button>
  </div>
</div>
```

Add the CSS from `v2-personality-spec.md` Section "Text Conversation UI".

**Test:** `toggleConsole()` in DevTools → panel slides in/out. Sphere still visible. No layout breaks.

---

### Step 4.2 — Wire `[C]` keyboard shortcut

```javascript
document.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') {
    if (document.activeElement === document.getElementById('console-input')) return;
    toggleConsole();
  }
});
```

**Test:** Press C anywhere on the page → console toggles. Typing in input field doesn't toggle.

---

### Step 4.3 — Wire console input to voice server

Console `SEND` button (and Enter key) sends to voice server:
```javascript
document.getElementById('console-send').addEventListener('click', sendConsoleMessage);
document.getElementById('console-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendConsoleMessage();
});

function sendConsoleMessage() {
  const input = document.getElementById('console-input');
  const text = input.value.trim();
  if (!text) return;
  
  appendUserMessage(text);
  voiceSocket.send(JSON.stringify({ type: 'transcript', text }));
  input.value = '';
}
```

**Test:** Type "what time is it" → user message appears in console → JARVIS responds.

---

### Step 4.4 — Auto-append JARVIS voice lines to console

All JARVIS speech (triggered by tool calls or direct responses) auto-appears in console:
```javascript
// In the section that handles incoming audio from voice server/neural server
function onJarvisSpeak(text) {
  if (consolePanelOpen) {
    appendJarvisMessage(text);
  }
  // existing subtitle display...
}
```

**Test:** Trigger a tool call → JARVIS narrates → line appears in console even if it was triggered by Claude Code, not by a console message.

---

### Step 4.5 — Token streaming in console

Voice server streams Ollama tokens to browser:
```javascript
// In jarvis-voice-server.js, when sending Ollama response:
ollamaResponse.on('token', (token) => {
  ws.send(JSON.stringify({ type: 'jarvis_text_token', token, messageId }));
});
```

Browser builds message token by token:
```javascript
let streamEl = null;
function onJarvisToken(token, messageId) {
  if (!streamEl || streamEl.dataset.msgId !== messageId) {
    streamEl = appendJarvisMessageEl();
    streamEl.dataset.msgId = messageId;
  }
  streamEl.textContent += token;
  scrollConsoleToBottom();
}
```

**Test:** Ask a question via console → text appears word by word, not all at once.

---

### Step 4.6 — Load history on panel open

When console opens, load last 20 messages from SQLite:
```javascript
function toggleConsole() {
  consolePanelOpen = !consolePanelOpen;
  document.getElementById('console-panel').classList.toggle('console-hidden');
  
  if (consolePanelOpen && !historyLoaded) {
    loadConsoleHistory();
    historyLoaded = true;
  }
}

async function loadConsoleHistory() {
  const resp = await fetch('/api/conversation/history');
  const msgs = await resp.json();
  msgs.forEach(m => {
    if (m.role === 'user') appendUserMessage(m.content, m.timestamp, true);
    else appendJarvisMessage(m.content, m.timestamp, true);
  });
}
```

Add `/api/conversation/history` endpoint to `neural-server.js` that queries SQLite.

**Test:** Close and reopen app. Open console → previous conversation visible.

---

### Sprint 4 Done Criteria

- [ ] Console slides in/out with `[C]` key
- [ ] Typing in console sends to JARVIS and gets response
- [ ] All JARVIS voice lines (hook-triggered and direct) appear in console
- [ ] Responses stream token by token
- [ ] History loads on panel open, persists across sessions

---

## Sprint 5: Neural UI States

**Goal:** Listening, thinking, error states are visually distinct. Idle has breathing, drift, ambient signals.

**Files modified:** `Neural/ui/jarvis-neural.html`

**Depends on:** None (fully self-contained visual work)

---

### Step 5.1 — Add new uniforms and shader code

In `nodeMat` ShaderMaterial, add uniforms:
```javascript
listenColor: { value: 0.0 },  // 0=cyan, 1=gold
errorFlash: { value: 0.0 },
```

In fragment shader, mix colors based on uniforms. (See `v2-neural-ui-spec.md` GLSL section.)

**Test:** `nodeMat.uniforms.listenColor.value = 1.0` in DevTools → sphere turns gold.

---

### Step 5.2 — Listening state

Add `listeningMode` boolean and smooth `listeningTimer`.

In `loop()`: fade listenColor up/down. Update ear ring opacity.

Add ear rings to scene (face camera each frame).

**Test:** `listeningMode = true` → gold sphere + ear rings. `listeningMode = false` → returns to cyan.

---

### Step 5.3 — Thinking state

Add `thinkingMode` and `thinkingTimer`.

In `loop()`: ramp bloom up. Rotate processing ring. Override node spiral in `updateNodes()`.

**Test:** `thinkingMode = true` → bloom increases + ring sweeps + nodes spiral. Clean.

---

### Step 5.4 — Error state

Add `errorFlash` timer (600ms countdown).

In `loop()`: decay `errorFlash` uniform from 1→0 over 600ms. Flash red ring.

**Test:** `triggerError()` in DevTools → brief red flash, returns to normal.

---

### Step 5.5 — Idle improvements

Add breathing to core: `+ 0.06 * Math.sin(t * (Math.PI * 2 / 4.0))`.

Add particle drift to `updateNodes()` for idle nodes.

Ambient signals: lower the `activeSmooth` threshold for signal generation.

Session HUD: add HTML element, update via `setInterval`.

**Test:** At idle, core breathes slowly. A few nodes drift. Signals still pulse. HUD shows uptime.

---

### Step 5.6 — VU meter

In `drawWave()`, add 3-bar energy visualization.

**Test:** During JARVIS speech, 3 colored bars visible. Not visible at idle (no audio).

---

### Sprint 5 Done Criteria

- [ ] Gold listening state with ear rings
- [ ] Blue spiral thinking state with processing ring
- [ ] Red flash error state
- [ ] Breathing core at idle
- [ ] Particle drift at idle
- [ ] Session HUD always visible
- [ ] VU meter during speech

---

## Sprint 6: Voice Conversation Mode

**Goal:** Full STT→Ollama/Claude Code→TTS loop. Hands-free. <2s response time.

**Files modified:** `Neural/ui/jarvis-neural.html`, new `Neural/scripts/jarvis-voice-server.js`, new `python/jarvis-whisper.py`, `main.js`

**Depends on:** Sprints 1, 2, 3, 4

---

### Step 6.1 — Create voice server skeleton

Create `Neural/scripts/jarvis-voice-server.js`:
- WebSocket server on port 7475
- Log all incoming messages
- No logic yet — just connectivity

**Test:** Start server. Open `ws://localhost:7475` in Postman or browser DevTools → connection succeeds.

---

### Step 6.2 — Add Web Speech API to Neural UI

In `jarvis-neural.html`, add microphone button and Web Speech API setup.

On button click: start recognition, show "Listening..." subtitle, update sphere to listening state.

On speech result: send transcript to voice server WebSocket.

**Test:** Click mic → say something → transcript logged in voice server console.

---

### Step 6.3 — Add intent classification

In `jarvis-voice-server.js`, add `classifyIntent()` using Ollama.

Test with hard-coded transcripts:
- "what time is it" → `{ requiresCode: false }`
- "run the tests" → `{ requiresCode: true }`

**Test:** 10 test phrases classified correctly. JSON parse never fails (add retry on malformed).

---

### Step 6.4 — Direct Ollama response path

For `requiresCode: false`:
- Build prompt with context from memory DB
- Stream Ollama response
- Call existing `generateSpeech()` for TTS
- Push audio to browser via WebSocket

**Test:** Ask "How long have we been working?" → JARVIS answers verbally. <800ms response.

---

### Step 6.5 — Claude Code subprocess path

For `requiresCode: true`:
- Spawn `claude -p <transcript>` with `--output-format stream-json`
- Wait for completion
- Summarize with Ollama
- Push summary audio to browser

**Test:** Say "list the files in this directory" → Claude Code executes → JARVIS summarizes result.

---

### Step 6.6 — Wire state messages to Neural UI

Voice server sends `{ type: "status", state: "..." }` during each phase.

Neural UI maps these to sphere state changes:
- `listening` → `listeningMode = true`
- `thinking` → `thinkingMode = true`
- `speaking` → normal audio reactivity
- `idle` → all states off

**Test:** Full voice round-trip with correct sphere color changes at each phase.

---

### Step 6.7 — Add to Electron main process

In `main.js`, add voice server start alongside neural server.

Add voice toggle to tray menu.

Kill voice server on app quit.

**Test:** App starts → both ports 7474 and 7475 open. App quits cleanly.

---

### Step 6.8 — Add faster-whisper backend (optional)

Create `python/jarvis-whisper.py` per voice chat spec.

Add `sttBackend: "whisper"` config option.

If `sttBackend === "whisper"`, voice server spawns whisper process and pipes audio.

**Test:** `jarvis config set sttBackend whisper` → voice works offline, better accuracy.

---

### Sprint 6 Done Criteria

- [ ] Voice button visible in Neural UI
- [ ] Click mic → sphere turns gold → listen → sphere turns blue → think → respond → idle
- [ ] Simple questions answered directly by Ollama (<800ms)
- [ ] Code tasks execute via Claude Code, JARVIS narrates each step
- [ ] Final summary spoken after task completion
- [ ] All conversation turns saved to memory DB
- [ ] Works end-to-end on Windows (Web Speech API default)

---

## Sprint 7: Polish & Docs

**Goal:** Ship-ready quality. v2 Sphinx docs. All platforms tested.

---

### Step 7.1 — Cross-platform testing

Test on:
- Windows 11 (primary) ✓
- macOS (Sequoia) — test via CI or collaborator
- Ubuntu 22.04 LTS — test via WSL2 or VM

Issues typically found:
- Piper binary path differences (handled by cross-platform path logic in installer)
- Web Speech API not available in some Linux browsers → show fallback message
- `better-sqlite3` needs platform-specific native binding (check `npm install` succeeds on all)

---

### Step 7.2 — Update Sphinx docs for v2

Update `docs/index.rst`: add v2 features to landing page.

Create `docs/voice-conversation.rst`: step-by-step voice setup.

Create `docs/personality.rst`: explain voice tiers and proactive triggers.

Update `docs/configuration.rst`: all new config keys.

Update `docs/changelog.rst`: v2 release notes.

**Test:** `make html` in `docs/` → no errors. Open `_build/html/index.html` → renders correctly.

---

### Step 7.3 — End-to-end smoke test checklist

Run through this list before tagging v2.0.0:

- [ ] Fresh install from `node install.js` — completes without manual intervention
- [ ] `jarvis start` → Neural UI opens, JARVIS greeting plays within 3 seconds
- [ ] Run a Claude Code session — every tool call narrated (voiceMode 2: 2+ sentences)
- [ ] Idle for 45+ seconds → JARVIS speaks unprompted
- [ ] Press `[C]` → console opens. Type a message → JARVIS responds in text and audio.
- [ ] Click microphone → speak → JARVIS responds verbally
- [ ] Ask voice command requiring code → Claude Code executes → JARVIS summarizes
- [ ] `jarvis stop` → all processes exit cleanly
- [ ] Restart `jarvis start` → greeting references previous session
- [ ] Electron app: installs, tray icon appears, setup wizard works, `Launch JARVIS` button works

---

## Critical Path Summary

The only hard dependency chain is:

```
Sprint 1 (Talkative) → Sprint 3 (Memory) → Sprint 4 (Text UI) → Sprint 6 (Voice)
Sprint 2 (Performance) can run any time, ideally before Sprint 6
Sprint 5 (Neural UI) is completely independent
```

If short on time, the minimum v2 that beats OpenJarvis is:
1. **Sprint 1** — talkative JARVIS (instant improvement, high impact)
2. **Sprint 6** — voice conversation (headline feature, OpenJarvis doesn't have it)
3. **Sprint 3** — memory (makes voice conversation useful long-term)

Sprints 2, 4, 5 make it polish and competitive on every dimension, but Sprints 1+6+3 alone would be a stronger product than OpenJarvis.

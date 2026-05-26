# ARC Reactor v2 — Voice Conversation: Detailed Specification
> Version: 2.0.0-draft | Date: 2025-05-26

---

## Overview

Voice Conversation Mode transforms ARC Reactor from a passive narrator into an active voice agent. You speak, JARVIS processes your intent, Claude Code executes if needed, and JARVIS responds — all in under 2 seconds.

This document covers the full implementation: server architecture, STT backends, intent routing, audio pipeline, and step-by-step build instructions.

---

## Architecture Diagram

```
[Browser Mic]
      │  MediaStream
      ▼
[Web Speech API / Whisper Bridge]
      │  transcript string
      ▼
[WebSocket → jarvis-voice-server.js :7475]
      │
      ├─ [Context Manager]  ──  loads session history from SQLite
      │
      ▼
[Intent Classifier (Ollama)]
      │
      ├──► type: 'question' ──► [Ollama Direct Response] ──► TTS ──► WebSocket audio push ──► Browser plays
      │
      └──► type: 'task' ──────► [claude -p subprocess] ──► hooks fire ──► JARVIS narrates each step
                                                                │
                                                                ▼
                                                       [Session complete]
                                                                │
                                                                ▼
                                                       [Ollama summary] ──► TTS ──► WebSocket push ──► Browser plays
```

---

## Component Specifications

### 1. `jarvis-voice-server.js` (new file, port 7475)

WebSocket server. Receives audio or transcript from browser. Routes to correct handler. Sends audio back.

**Endpoints:**
- `ws://localhost:7475` — main WebSocket
- `GET /api/voice/status` — returns `{ active: bool, session: string }`

**Message protocol (browser → server):**
```json
{ "type": "transcript", "text": "show me the failing tests" }
{ "type": "audio_chunk", "data": "<base64 PCM>" }
{ "type": "session_start", "projectPath": "/path/to/project" }
{ "type": "session_end" }
```

**Message protocol (server → browser):**
```json
{ "type": "audio_ready", "url": "/audio/abc123.wav" }
{ "type": "status", "state": "listening|thinking|speaking|idle" }
{ "type": "transcript_echo", "text": "..." }
{ "type": "jarvis_text", "text": "On it, sir.", "stream": false }
{ "type": "jarvis_text_token", "token": "On" }
```

**Core logic:**
```javascript
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'transcript') {
      await handleTranscript(ws, msg.text);
    }
  });
});

async function handleTranscript(ws, text) {
  ws.send(JSON.stringify({ type: 'status', state: 'thinking' }));
  
  const context = await loadContext(currentSession.projectPath);
  const intent = await classifyIntent(text, context);
  
  // Immediate acknowledgment
  const ack = intent.requiresCode
    ? "On it, sir."
    : "One moment.";
  await speakAndSend(ws, ack);
  
  if (!intent.requiresCode) {
    const response = await generateDirectResponse(text, context);
    await speakAndSend(ws, response);
  } else {
    const result = await runClaudeCode(text, ws);
    const summary = await summarizeResult(result, context);
    await speakAndSend(ws, summary);
  }
  
  ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
}
```

---

### 2. Intent Classifier

Ollama classifies each voice input as `question` or `task`.

**Prompt:**
```
Classify this user request in one JSON object. No other text.
Request: "{transcript}"

Return: { "type": "question" | "task", "requiresCode": true | false, "urgency": 1 | 2 | 3 }

- "question": factual, conversational, or status query
- "task": requires file editing, running code, building, deploying
- "requiresCode": true if Claude Code agent needs to act
- "urgency": 1=low, 2=normal, 3=immediate (user sounds frustrated or blocked)
```

**Examples:**
- "What time is it?" → `{ type: "question", requiresCode: false }`
- "Run the tests" → `{ type: "task", requiresCode: true }`
- "What was the last error?" → `{ type: "question", requiresCode: false }` (answered from context)
- "Fix the failing login test" → `{ type: "task", requiresCode: true }`

---

### 3. Claude Code Subprocess Bridge

When intent is `task`, spawn `claude -p` with the user's transcript as the prompt.

```javascript
async function runClaudeCode(prompt, ws) {
  const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json'], {
    cwd: currentSession.projectPath,
    env: { ...process.env },
  });

  let outputLines = [];

  child.stdout.on('data', (chunk) => {
    // Claude Code streams events — hook PostToolUse fires separately
    // We just collect output here for final summary
    outputLines.push(chunk.toString());
  });

  return new Promise((resolve) => {
    child.on('close', () => resolve(outputLines.join('')));
  });
}
```

The `PostToolUse` hook fires as normal during this subprocess — JARVIS narrates each action in real time. No changes to the hook system needed.

---

### 4. STT Implementation

#### Option A: Web Speech API (default, zero install)

```javascript
// In jarvis-neural.html
const recognition = new webkitSpeechRecognition() || new SpeechRecognition();
recognition.continuous = false;
recognition.interimResults = true;
recognition.lang = 'en-US';

recognition.onresult = (event) => {
  const transcript = event.results[0][0].transcript;
  const isFinal = event.results[0].isFinal;
  
  if (isFinal) {
    voiceSocket.send(JSON.stringify({ type: 'transcript', text: transcript }));
  } else {
    // Show live transcript in UI
    updateLiveTranscript(transcript);
  }
};

function startListening() {
  recognition.start();
  setSphereState('listening');
}
```

#### Option B: faster-whisper (offline, more accurate)

`jarvis-whisper.py` — receives audio via stdin pipe, returns transcript via stdout:

```python
from faster_whisper import WhisperModel
import sys, json, io

model = WhisperModel("base.en", device="cpu", compute_type="int8")

while True:
    # Read audio length prefix, then audio bytes
    length_bytes = sys.stdin.buffer.read(4)
    if not length_bytes:
        break
    length = int.from_bytes(length_bytes, 'little')
    audio_bytes = sys.stdin.buffer.read(length)
    
    audio_array = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = model.transcribe(audio_array, beam_size=5, language="en")
    
    transcript = " ".join(seg.text.strip() for seg in segments)
    result = json.dumps({ "transcript": transcript, "confidence": 0.9 })
    sys.stdout.write(result + "\n")
    sys.stdout.flush()
```

Voice server spawns `jarvis-whisper.py` on startup if `sttBackend: "whisper"` in config.

---

### 5. Audio Return Path

When JARVIS generates a voice response, the audio plays in the browser via WebSocket push:

```javascript
// Server side — after Piper generates wav
async function speakAndSend(ws, text) {
  const wavPath = await generateSpeech(text);  // existing Piper pipeline
  const wavBase64 = fs.readFileSync(wavPath).toString('base64');
  
  ws.send(JSON.stringify({
    type: 'audio_ready',
    text: text,
    audioBase64: wavBase64,
  }));
}

// Browser side
voiceSocket.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'audio_ready') {
    const blob = base64ToBlob(msg.audioBase64, 'audio/wav');
    const url = URL.createObjectURL(blob);
    playAudioFile(url);  // existing audio engine
    showSubtitle(msg.text);
  }
};
```

This replaces the current file-poll bridge with WebSocket push. Audio latency: 0ms (vs 150ms polling).

---

### 6. Context Manager

Maintains conversation state across turns within a session.

```javascript
class ContextManager {
  constructor(dbPath, projectPath) {
    this.db = new Database(dbPath);
    this.projectPath = projectPath;
    this.sessionId = generateSessionId();
    this.turnCount = 0;
  }

  async getContext() {
    const recentTurns = this.db.prepare(`
      SELECT role, content FROM conversations
      WHERE project_path = ? ORDER BY timestamp DESC LIMIT 5
    `).all(this.projectPath);

    const prevSummary = this.db.prepare(`
      SELECT summary FROM session_summaries
      WHERE session_id != ? ORDER BY created_at DESC LIMIT 1
    `).get(this.sessionId);

    return {
      recentTurns: recentTurns.reverse(),
      previousSession: prevSummary?.summary || null,
      projectPath: this.projectPath,
    };
  }

  async saveTurn(role, content, toolContext = null) {
    this.db.prepare(`
      INSERT INTO conversations (session_id, turn, role, content, tool_context, timestamp, project_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.sessionId, ++this.turnCount, role, content, 
           toolContext ? JSON.stringify(toolContext) : null,
           Date.now(), this.projectPath);
  }
}
```

---

### 7. Wake Word (Optional)

Browser-based keyword detection using `@picovoice/porcupine-web`:

```javascript
// jarvis-neural.html — optional, only if wakeWord: true in config
import { PorcupineWeb } from '@picovoice/porcupine-web';

const porcupine = await PorcupineWeb.fromPublicDirectory(
  accessKey,       // Free Picovoice key, user provides in config
  [{ label: 'JARVIS', publicPath: '/porcupine/jarvis_wasm.ppn' }],
  (keywordIndex) => {
    if (keywordIndex === 0) startListening();  // "JARVIS" detected
  }
);
await porcupine.start();
```

Config: `jarvis config set wakeWord true`, `jarvis config set picovoiceKey <key>`.

---

## UX Flow (Step by Step)

```
1. User opens Neural UI
2. JARVIS greeting plays: "Good morning, sir. Systems are online."
3. Voice button visible at bottom-right (microphone icon)

── Conversation Turn ──
4. User clicks microphone (or says "JARVIS" if wake word enabled)
5. Sphere shifts to GOLD (#ffc040) — listening state
6. Subtitle shows: "Listening..."
7. User speaks: "Run the failing tests and tell me what broke"
8. Live transcript appears as user speaks
9. User stops speaking (800ms silence detected)
10. Sphere shifts to CYAN SPIRAL — thinking state
11. JARVIS says immediately: "On it, sir." (pre-generated from fallback cache — plays in <100ms)
12. Claude Code subprocess starts
13. Each tool call fires PostToolUse hook — JARVIS narrates each action
14. Sphere reacts to each narration (existing audio reactivity)
15. Tests complete
16. Ollama generates summary: "Three tests failed, sir. All in the auth middleware. The token validation function appears to be returning null on refresh."
17. Piper generates WAV, WebSocket push to browser
18. JARVIS speaks the summary — sphere pulses with his voice
19. Sphere returns to IDLE — breathing cyan glow
20. Conversation panel logs the full exchange
```

---

## Foolproof Build Steps

### Step 1: Create voice server file

Create `Neural/scripts/jarvis-voice-server.js`:
- WebSocket server on port 7475
- Import existing `generateSpeech()` from `jarvis-speak.js`
- Import `Database` from `better-sqlite3`
- Implement `handleTranscript()` per spec above

**Test:** `node jarvis-voice-server.js` → no crash, port 7475 open.

### Step 2: Wire Neural UI WebSocket

In `jarvis-neural.html`, add voice UI elements:
- `<button id="voice-btn">🎤</button>` 
- `<div id="live-transcript"></div>`
- Voice WebSocket connection on `ws://localhost:7475`
- Web Speech API `recognition` object

**Test:** Click mic button → subtitle shows "Listening..." → speak → see transcript.

### Step 3: Add intent classification

In `jarvis-voice-server.js`, add `classifyIntent()` using Ollama:
- Send prompt with transcript
- Parse JSON response
- Log classification to console

**Test:** Send `{ type: "transcript", text: "what time is it" }` → logs `{ type: "question", requiresCode: false }`.

### Step 4: Add direct Ollama response path

For `requiresCode: false` intents:
- Build prompt with conversation history
- Stream Ollama response
- Generate speech
- Push audio to browser

**Test:** Ask "What's my session duration?" → JARVIS responds with a voice line.

### Step 5: Add Claude Code subprocess path

For `requiresCode: true` intents:
- Spawn `claude -p <transcript>` in project directory
- Wait for completion
- Summarize result with Ollama
- Push audio to browser

**Test:** Say "list the files in this directory" → Claude Code runs → JARVIS summarizes.

### Step 6: Add SQLite context persistence

Install `better-sqlite3`. Implement `ContextManager`:
- Save each turn on write
- Load last 5 turns on read
- Pass to every Ollama prompt

**Test:** Have 3-turn conversation, restart server, start new session → JARVIS greeting references previous session.

### Step 7: Add UI state transitions

Wire sphere state changes to voice server messages:
- `status: "listening"` → gold sphere
- `status: "thinking"` → spiral animation
- `status: "speaking"` → normal audio reactivity
- `status: "idle"` → breathing idle

**Test:** Each state is visually distinct. No stuck states.

### Step 8: Add to Electron app

- Start `jarvis-voice-server.js` alongside existing Neural server in `main.js`
- Add voice toggle to system tray menu
- Kill voice server on app quit

**Test:** App starts → both ports 7474 and 7475 open → voice works end-to-end.

---

## Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Time-to-first-audio (question) | < 800ms | Ollama + Piper + WebSocket push |
| Time-to-acknowledgment (task) | < 100ms | Pre-cached "On it, sir." |
| Time-to-final-audio (task) | < 2s after agent completes | Summarization + Piper |
| STT latency (Web Speech) | ~200ms | Browser native |
| STT latency (Whisper base) | ~400ms | Local, no network |
| Claude Code overhead | 0ms | Existing hooks fire unchanged |

---

## Config Keys

```json
{
  "voiceMode": 2,
  "sttBackend": "webspeech",
  "wakeWord": false,
  "picovoiceKey": "",
  "voiceServerPort": 7475,
  "maxConversationTurns": 20,
  "sqliteDb": "~/.claude/jarvis-memory.db"
}
```

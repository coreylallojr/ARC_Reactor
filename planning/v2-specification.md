# ARC Reactor v2 — Full Product Specification
> Version: 2.0.0-draft | Date: 2025-05-26

---

## Vision

v2 transforms ARC Reactor from a **narration companion** into a **voice-first AI agent interface**. JARVIS stops being a bystander that describes what Claude Code does and becomes an active participant you can have a real conversation with — while still watching everything your AI agent does and narrating it live.

The three pillars of v2:

1. **Talkative JARVIS** — He always has something to say. Multi-sentence responses. Proactive commentary. Genuine personality.
2. **Voice Conversation** — Talk to him. He talks back. In real time. Claude Code executes the actions.
3. **Conversation UI** — Text chat overlay in the Neural UI. Full history. Context-aware.

---

## Feature Specifications

---

### FEATURE 1: Talkative Personality Mode

**Problem:** Current JARVIS says one short sentence per tool call. Movie JARVIS is constantly talking, volunteering information, asking clarifying questions, making observations. The gap is jarring.

**Solution:** A new personality mode (`talkative`) that enables multi-sentence responses, proactive commentary, and personality-driven interjections.

#### 1.1 Voice Tiers

| Mode | Config value | Behavior |
|---|---|---|
| `silent` | `voiceMode: 0` | No narration |
| `key` | `voiceMode: 1` | Current behavior: 1 sentence on significant calls |
| `talkative` | `voiceMode: 2` | 2-4 sentences, personality, observations |
| `verbose` | `voiceMode: 3` | Full commentary, asks questions, proactive |

Set via: `jarvis voice talkative` or the Neural UI toggle.

#### 1.2 Multi-Sentence Prompts

In `talkative` mode, the Ollama prompt changes:

```
You are JARVIS. Narrate this in 2-3 sentences. Be dry, British, confident.
Observe what the action implies about the larger task. Make a subtle witty remark.
Never just describe the tool — say what it *means*.
```

#### 1.3 Proactive Commentary

JARVIS fires spontaneously (not just on tool calls) when:
- A session has been idle for 45 seconds: *"Still here, sir. Awaiting your next move."*
- An error repeats 3+ times: *"Sir, I notice we've encountered this error three times. Shall I suggest an alternative approach?"*
- A session lasts >30 minutes: *"We've been at this for half an hour, sir. Shall I summarize progress?"*
- A new file pattern is detected: *"You appear to be entering unfamiliar codebase territory, sir."*

Implementation: `neural-logger.js` maintains a heartbeat timer and proactive trigger registry.

#### 1.4 Context-Aware Responses

JARVIS reads the session context before generating each line:
- What task is being worked on?
- How many errors in this session?
- Which files are being edited most?
- What's the session duration?

This context is passed to Ollama in every prompt, making responses genuinely relevant rather than generic.

#### 1.5 Fallback Personality Library

50+ fallback lines organized by context (not random):
- Session start lines
- Error recovery lines
- Task completion lines
- Long-running task encouragement lines
- Idle/waiting lines
- Milestone celebration lines

---

### FEATURE 2: Voice Conversation Mode

**This is the v2 headline feature.**

A real STT→LLM→TTS→Claude Code conversation loop. You talk. JARVIS understands. Claude Code acts. JARVIS narrates the result. Fully hands-free.

#### 2.1 Architecture

```
[Microphone]
     │
     ▼
[STT Engine]  ──────────────────────────────────────────────────
     │                                                          │
     │ transcript                                Browser (Web Speech API) — zero install, free
     ▼                                           Local (faster-whisper) — offline, accurate
[Context Manager]
     │
     │ augmented prompt (transcript + session memory + intent)
     ▼
[Voice Router]
     │
     ├─► Simple question? → Ollama answers directly → TTS → play
     │
     └─► Needs agent action? → claude -p subprocess → executes in Claude Code session
              │
              ▼
         [PostToolUse hooks fire]
              │
              ▼
         [JARVIS narrates each action]
              │
              ▼
         [Session response ready]
              │
              ▼
         [Ollama summarizes result → TTS → play]
```

#### 2.2 Components

**`jarvis-voice-server.js`** (port 7475)
- WebSocket server for real-time STT streaming
- Manages voice session state
- Routes between direct Ollama responses and Claude Code execution
- Sends audio back to Neural UI for playback

**`jarvis-whisper.py`** (optional local STT)
- Wraps faster-whisper for offline transcription
- Accepts audio chunks via stdin, streams transcript tokens via stdout
- Model: `base.en` (fast) or `small.en` (accurate), configurable

**Voice Router** (in `jarvis-voice-server.js`)
```javascript
// Classify intent
const intent = await classifyVoiceIntent(transcript);
// intent: { type: 'question'|'task'|'command', requiresCode: bool, urgency: 1-3 }

if (!intent.requiresCode) {
  // Direct Ollama response — fast path (no Claude Code needed)
  const response = await generateDirectResponse(transcript, sessionContext);
  await speak(response);
} else {
  // Claude Code path — full agent execution
  const claudeProcess = spawnClaudeCode(transcript, sessionContext);
  // hooks will narrate as it runs
  await claudeProcess.completion;
  const summary = await summarizeSession(claudeProcess.result);
  await speak(summary);
}
```

**Context Manager**
- Maintains rolling 20-turn conversation history (per-session SQLite)
- Injects last 5 turns into every Ollama prompt
- Ollama-based summarization when history exceeds 20 turns
- Projects last 3 tool calls as context for voice responses

#### 2.3 STT Backends

| Backend | Latency | Quality | Cost | Offline |
|---|---|---|---|---|
| **Web Speech API** (browser) | ~200ms | Good | Free | No (needs internet for Google STT) |
| **faster-whisper** (`base.en`) | ~400ms | Better | Free | Yes |
| **faster-whisper** (`small.en`) | ~800ms | Best local | Free | Yes |

Default: Web Speech API. Switch via `jarvis config set sttBackend whisper`.

#### 2.4 Voice UX Flow

1. User presses **voice button** (or says wake phrase if enabled)
2. Mic activates — Neural UI shows **listening state** (sphere pulses, different color)
3. User speaks — live transcript appears in UI as they talk
4. User stops speaking — 800ms silence detection triggers processing
5. JARVIS says *"On it, sir."* immediately (before processing completes)
6. If direct answer: JARVIS responds, sphere pulses with his voice
7. If agent task: Each tool call fires — JARVIS narrates — sphere reacts
8. JARVIS delivers final summary — sphere returns to idle

#### 2.5 Wake Word (Optional)

- Browser-based keyword detection using `@picovoice/porcupine-web` (free for personal use)
- Wake phrase: "Hey JARVIS" or "JARVIS"
- Activates listening without pressing any button
- Configurable: `jarvis config set wakeWord true`

---

### FEATURE 3: Text Conversation UI

A conversation panel integrated into the Neural UI. Not a separate app or tab — a slide-in overlay over the existing sphere visualization.

#### 3.1 UI Layout

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│                  [  3D SPHERE  ]                        │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ JARVIS CONSOLE                              [×]   │  │
│  │ ─────────────────────────────────────────────── │  │
│  │ 14:23 ▸ You: show me the failing tests           │  │
│  │ 14:23 ◉ JARVIS: Running the test suite now,     │  │
│  │         sir. I'll report back shortly.          │  │
│  │ 14:24 ◉ JARVIS: 3 tests failed. The issue       │  │
│  │         appears to be in the auth middleware.   │  │
│  │ ─────────────────────────────────────────────── │  │
│  │ ▸ Type a message...             [🎤] [SEND]     │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│ [JARVIS subtitle text here]                             │
└─────────────────────────────────────────────────────────┘
```

The sphere stays live and reactive. The console panel is a glass/translucent overlay at the bottom. `[C]` keyboard shortcut toggles it.

#### 3.2 Message Types

- **User text messages** — sent to voice router (same path as voice)
- **JARVIS voice lines** — automatically appear as messages when spoken
- **Tool call summaries** — tool groups summarized as single console lines
- **Session markers** — `── Session started ──`, `── 14 tool calls ──`

#### 3.3 Conversation Persistence

- History stored in `Neural/.conversation.db` (SQLite)
- Last 50 exchanges shown in console; full history scrollable
- Per-project history: keyed by working directory path
- Export: `jarvis conversation export` → markdown file

#### 3.4 Streaming Responses

JARVIS's text responses stream in word-by-word (like ChatGPT). The Ollama response is streamed via the existing API and each token is pushed to the console in real-time. Audio playback starts simultaneously with streaming (first sentence plays while rest is still generating).

---

### FEATURE 4: Neural UI Overhaul

Major visual improvements to the 3D sphere while preserving the core Three.js architecture.

#### 4.1 Listening State

When voice mode is active and JARVIS is listening, the sphere enters **listening mode**:
- Color shifts from cyan to **warm gold** (`#ffc040`)
- Nodes slow down and lean toward the camera
- A subtle "ear" ring appears — 2 orbital rings that face the user
- Waveform changes to incoming audio visualization
- Subtitle shows live transcript as user speaks

#### 4.2 Thinking State

When JARVIS is processing (waiting for Ollama or Claude Code response):
- Bloom strength increases slowly
- Nodes rotate in an organized spiral pattern
- A "processing" ring sweeps around the sphere
- Text: `PROCESSING...` with animated ellipsis

#### 4.3 Shell / Idle Improvements

- **Particle drift**: During idle, some nodes slowly drift slightly off the sphere surface and return
- **Ambient signals**: Signal pulses along edges even at idle (slower, dimmer)
- **Breathing core**: Core glow has a slow 4s breathing rhythm at idle
- **Session data overlay**: Small session counter, current task, uptime — always visible

#### 4.4 Speech Quality Indicators

Visual feedback for confidence/quality:
- High confidence Ollama response → bright cyan narration
- Fallback line → slightly dimmer, cooler blue
- Error state → brief red ring pulse before returning to cyan

#### 4.5 Voice Activity Visualization

During JARVIS speech, the waveform panel shows:
- Real waveform (existing, keep)
- VU meter: 3 vertical bars showing bass/mid/treble energy
- Speaking confidence indicator (how loud/clear the synthesis was)

#### 4.6 Performance Targets

- Maintain 60fps at idle on integrated GPU
- Maintain 60fps during speech/audio reactivity
- GPU memory: under 200MB (Three.js scene)
- Page load: under 3 seconds on localhost

---

### FEATURE 5: Conversation Memory

Simple, effective persistence without the complexity of vector stores.

#### 5.1 Architecture

SQLite only (no FAISS, no embeddings for v2). Fast, zero-dependency, cross-platform.

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  turn INTEGER,
  role TEXT,    -- 'user' | 'jarvis' | 'system'
  content TEXT,
  tool_context TEXT,  -- JSON: which tools ran, what changed
  timestamp INTEGER,
  project_path TEXT   -- working directory when spoken
);

CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY,
  summary TEXT,
  key_facts TEXT,  -- JSON array of extractedimportant points
  created_at INTEGER,
  turn_count INTEGER
);
```

#### 5.2 Context Injection

Before every Ollama call, inject:
- Last 5 turns from current session (full)
- Summary of previous sessions for same `project_path` (1-2 sentences)
- Current task from `context/active-task.md`

#### 5.3 Session Summarization

After a session ends (Stop hook fires):
- Ollama summarizes the full session into 2-3 sentences
- Key facts extracted: files changed, errors resolved, decisions made
- Stored in `session_summaries`
- Used as context in the next session

#### 5.4 Cross-Session Continuity

When JARVIS starts in a project he's been in before:
> *"Welcome back, sir. Last time we were working on the voice chat implementation. You resolved the audio context issue and were planning the streaming response system."*

Generated by querying the last 3 session summaries for the current `project_path`.

---

### FEATURE 6: Performance Upgrades

Speed improvements throughout the pipeline.

#### 6.1 TTS Response Time

**Current path:** Ollama generates text → Python spawns → Piper generates wav → file written → browser polls (150ms delay) → browser fetches wav → plays

**v2 path:** Ollama streams first sentence → Piper begins synthesis while rest generates → first wav ready in ~600ms → browser receives push notification → plays immediately

Changes:
- Voice server listens on WebSocket instead of file polling
- Server pushes audio URL to browser immediately instead of waiting for poll
- First sentence streams ahead of full response
- Poll interval drops from 150ms to WebSocket push (0ms latency)

Expected improvement: **800ms → 300ms** time-to-first-audio

#### 6.2 Ollama Warm Start

When `jarvis start` fires:
- Immediately send a warmup prompt to Ollama (`"System ready."`)
- This loads the model into GPU/RAM before the first real call
- First tool call narration: ~800ms → ~200ms (model already loaded)

#### 6.3 WAV Cache Pre-warming

On startup, pre-generate WAVs for the 50 most common JARVIS lines:
- Session start lines
- Standard narration lines
- Fallback lines
These are instant — no Piper synthesis required.

```bash
jarvis cache warmup    # generate the 50 core lines
jarvis cache status    # how many phrases cached, total size
```

#### 6.4 Model Upgrade Path

Support for larger Ollama models via simple config:

| Model | Speed | Quality | VRAM |
|---|---|---|---|
| `llama3.2:1b` | Fast (current) | Good | 1GB |
| `llama3.1:8b` | Medium | Great | 5GB |
| `qwen2.5:7b` | Medium | Great | 5GB |
| `gemma3:12b` | Slower | Excellent | 8GB |

Recommendation: `llama3.1:8b` for users with 8GB+ VRAM. Switch via `jarvis config set ollamaModel llama3.1:8b`.

---

## v2 Release Definition of Done

| Feature | Acceptance Criteria |
|---|---|
| Talkative mode | JARVIS speaks 2-4 sentences in verbose mode, proactive idle commentary fires |
| Voice conversation | Full STT→Ollama/Claude→TTS loop works end-to-end, <2s response time |
| Text chat UI | Console panel opens, messages stream, history persists across sessions |
| Neural UI states | Listening/thinking/speaking states visually distinct |
| Conversation memory | Sessions summarized, next session greeting references last session |
| WebSocket push | Audio plays <400ms after JARVIS response ready |
| Cache warmup | First voice line plays in <300ms after startup |
| Windows/Mac/Linux | All features work on all three platforms |
| Docs | v2 Sphinx docs updated, install guide updated |

---

## What We Are NOT Building in v2

- ❌ Skill system / plugin ecosystem (too complex, not differentiating)
- ❌ Multi-channel (Telegram, Slack, etc.) — not the use case
- ❌ Vector database / FAISS / embeddings — SQLite is sufficient for v2
- ❌ Pearl mining — irrelevant
- ❌ Eval framework — not a research tool
- ❌ Security guardrails — trust level is owner's local machine
- ❌ Fine-tuning pipeline — out of scope
- ❌ Mobile app — desktop first

These may come in v3 if adoption warrants it. v2 is about depth, not breadth.

# ARC Reactor vs OpenJarvis — Competitive Analysis
> Deep comparison as of May 2025. Basis for v2 specification.

---

## Executive Summary

OpenJarvis is a **research-grade AI platform** built by the Stanford SAIL / Hazy Research lab. It is technically sophisticated, multi-language (Python + Rust + TypeScript/Tauri), and covers an enormous feature surface. It is **not** a polished consumer product — it requires WSL2 on Windows, has no real-time voice loop, and its onboarding is deeply technical.

ARC Reactor is a **Claude Code companion layer** with a unique 3D voice-reactive visualization. It is simpler, Windows-native, and does one thing extremely well: making AI agent work feel alive.

**The core insight:** OpenJarvis is a research platform trying to be an assistant. ARC Reactor is an assistant that can become a platform. Our path to beating them is through the experience layer they have entirely neglected — voice-first interaction, visual presence, and personality.

---

## Feature Matrix

| Feature | ARC Reactor v1 | OpenJarvis v1 | Advantage |
|---|---|---|---|
| **3D visualization** | ✅ Three.js sphere, real FFT reactivity | ❌ None | **ARC Reactor** |
| **Voice narration** | ✅ Every tool call, JARVIS personality | ⚠️ One-shot TTS only (morning digest) | **ARC Reactor** |
| **Live voice chat** | ❌ Not built | ❌ Research-stage stub | **Tie (gap for both)** |
| **Text chat UI** | ❌ No conversation panel | ✅ Full chat with streaming | **OpenJarvis** |
| **Windows native** | ✅ Node.js, no WSL | ❌ Requires WSL2 | **ARC Reactor** |
| **One-command install** | ✅ `node install.js` | ❌ Multi-step, uv + Docker + config | **ARC Reactor** |
| **Claude Code hooks** | ✅ Native hook integration | ❌ None | **ARC Reactor** |
| **Local LLM** | ✅ Ollama (auto-start) | ✅ Ollama + vLLM + SGLang + MLX | OpenJarvis |
| **Voice model** | ✅ Piper JARVIS (Paul Bettany trained) | ⚠️ Kokoro (generic voices) | **ARC Reactor** |
| **STT** | ❌ Not built | ✅ faster-whisper + Deepgram | OpenJarvis |
| **Conversation memory** | ❌ No persistence | ✅ SQLite + FAISS + ColBERT | OpenJarvis |
| **Personality / character** | ✅ JARVIS persona throughout | ❌ Generic AI assistant | **ARC Reactor** |
| **Skill system** | ❌ None | ✅ 13,700+ skills | OpenJarvis |
| **Multi-channel** | ❌ None | ✅ 20+ channels | OpenJarvis |
| **Electron app** | ✅ Tray app + setup wizard | ✅ Tauri desktop app | Tie |
| **Proactive AI** | ⚠️ Narrates only | ✅ Scheduled agents, monitoring | OpenJarvis |
| **Context compression** | ❌ None | ⚠️ Implemented but LLM path stubbed | **Tie (both weak)** |
| **Security guardrails** | ❌ None | ✅ PII scan, injection detect, SSRF | OpenJarvis |
| **Energy monitoring** | ❌ None | ✅ GPU/CPU/Apple power stats | OpenJarvis |
| **Eval framework** | ❌ None | ✅ 30+ datasets | OpenJarvis |
| **macOS/Linux** | ⚠️ Partial (Python TTS is cross-platform) | ✅ Full support | OpenJarvis |
| **Visual identity** | ✅ Stark Industries, arc reactor, JARVIS | ❌ Generic dark UI | **ARC Reactor** |

---

## Where We Win

### 1. The 3D Neural UI
OpenJarvis has no visualization whatsoever. Their UI is a standard React chat interface that looks like any other LLM product. Our Three.js sphere with real FFT audio reactivity is genuinely novel — no open-source JARVIS project has anything close. This is the strongest differentiation we have and must be the centerpiece of all marketing and screenshots.

### 2. Voice as Identity
OpenJarvis's TTS is an afterthought — it's used in one agent (morning digest) with a generic Cartesia voice. Our Piper model is trained on Paul Bettany's actual JARVIS performance. The personality is woven into every prompt, every fallback line, every voice interaction. This is the emotional core of the product.

### 3. Claude Code Integration
OpenJarvis has a `claude_code.py` file that spawns Claude Code as a subprocess but it's not the primary interaction model. Our entire product is built *around* Claude Code hooks — JARVIS lives inside the tool-call pipeline, not alongside it. This is architecturally unique and gives us access to every single action the AI takes.

### 4. Windows Native, Zero WSL
OpenJarvis requires WSL2 on Windows. Every Windows developer using Claude Code (which runs natively on Windows) can use ARC Reactor without any Unix environment. This is a real market differentiator.

### 5. Onboarding
OpenJarvis's install requires: `pip install openjarvis`, `uv` package manager, `config.toml` with 5 sections, Docker for sandbox, then `jarvis init`. Our install is `node install.js`.

---

## Where They Win (Our v2 Priorities)

### 1. Live Voice Conversation (Critical Gap)
Neither of us has a real-time voice loop (STT → LLM → TTS → back to STT). OpenJarvis explicitly marks this as "Research-Stage." **This is the single biggest unlock for v2.** The first JARVIS project to ship a real voice conversation loop with good UX wins.

### 2. Text Conversation UI
We have no way to type to JARVIS. The Neural UI is a visualization, not a chat interface. OpenJarvis's chat is feature-rich: streaming, tool cards, markdown, citations. We need a conversation overlay in the Neural UI — not as a separate page, but as a panel that slides in while the sphere stays visible.

### 3. Memory / Context Persistence
OpenJarvis has SQLite + FAISS + ColBERT + BM25. We have nothing — each Claude Code session starts cold. v2 needs at minimum: conversation history that persists across sessions, and context injection for the voice chat mode.

### 4. JARVIS Personality Depth
JARVIS in the films is constantly commenting, volunteering information, being dry and witty, and proactively surfacing relevant things. Our current JARVIS narrates tool calls — he doesn't truly *converse*. v2 needs:
- Much more talkative mode (multiple sentences, not one)
- Proactive commentary (not just reactive to tool calls)
- Text conversation with genuine back-and-forth
- Memory of what was discussed

---

## OpenJarvis Weaknesses to Exploit

1. **No live voice loop** — Ship ours first, make it the centerpiece
2. **Generic personality** — Double down on JARVIS branding and character
3. **Windows hostile** — Market explicitly to Windows Claude Code users
4. **Complex setup** — Our installer is already better; make it even more seamless
5. **Research-grade UX** — They optimize for extensibility; we optimize for delight
6. **No visual identity** — Our 3D sphere is the brand; invest in it heavily
7. **LLM conversation quality** — Their prompts are generic; ours are character-driven

---

## Positioning Statement for v2

> ARC Reactor is the only AI agent companion that **looks**, **sounds**, and **feels** like JARVIS from the films. While other projects build platforms, we build presence. Every action your AI takes is narrated by the voice of J.A.R.V.I.S. Every word he speaks is rendered live in a 3D visualization that pulses with his actual voice. You can talk to him and he talks back — proactively, intelligently, and always with something to say.

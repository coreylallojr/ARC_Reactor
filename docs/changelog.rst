Changelog
=========

v1.0.0 — 2025-05-26
---------------------

Initial release.

**Core**

- ``neural-logger.js`` — PostToolUse/Stop hook handler with voice scoring, Ollama generation, Piper TTS bridge
- ``neural-ui-server.js`` — HTTP server on :7474 with audio bridge and live status API
- ``jarvis-neural.html`` — Three.js Fibonacci sphere, 152 nodes mapped to Web Audio frequency bins, real-time FFT reactivity
- ``jarvis-cli.js`` — Full CLI with cross-platform Ollama detection (Windows/macOS/Linux)
- ``jarvis_speak.py`` — Cross-platform Piper TTS wrapper with MD5 WAV cache

**App**

- Electron tray app with first-run setup wizard
- System check: Node, Python, Ollama, Piper model, Claude Code
- Auto-detection of Python path with manual browse fallback
- One-click hook installation and shell alias setup
- ``node install.js`` — CLI-only installer, no Electron required

**Audio**

- Browser Web Audio API replaces Python ``winsound`` — enables real-time analysis
- ``AudioContext`` activation gate with queuing (handles browser autoplay policy)
- Per-node frequency bin mapping: bass hits equator, treble hits poles
- ``audioRms`` and ``audioBass`` drive all visual parameters: bloom, ring speed, core scale, node displacement

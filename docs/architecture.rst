Architecture
============

How JARVIS works, end to end.


The Full Pipeline
-----------------

.. code-block:: text

   ┌─────────────────────────────────────────────────────────┐
   │  Claude Code                                            │
   │  ─────────────────────────────────────────────────────  │
   │  1. Claude calls a tool (Read, Edit, Bash, Agent...)    │
   │  2. Tool executes                                       │
   │  3. PostToolUse hook fires → neural-logger.js           │
   └────────────────────────────┬────────────────────────────┘
                                │ stdin (JSON: tool name, input, response)
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  neural-logger.js  (hook handler)                       │
   │  ─────────────────────────────────────────────────────  │
   │  • Scores the tool call (1–8 points)                    │
   │  • Updates session state + tool log                     │
   │  • Spawns detached voice worker (non-blocking)          │
   │  • Main process exits immediately → Claude unblocked    │
   └────────────────────────────┬────────────────────────────┘
                                │ (detached child process)
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Voice Worker  (neural-logger.js --worker)              │
   │  ─────────────────────────────────────────────────────  │
   │  • Builds compact prompt (task + tool context)          │
   │  • Streams response from Ollama API                     │
   │  • Stops after 14 words (fast cutoff)                   │
   │  • Falls back to static JARVIS phrase if Ollama is down │
   └────────────────────────────┬────────────────────────────┘
                                │ text
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  jarvis_speak.py  (Piper TTS)                           │
   │  ─────────────────────────────────────────────────────  │
   │  • MD5-hashes "jarvis-medium:" + text → cache key       │
   │  • If cached: returns path immediately                  │
   │  • If not: synthesizes .wav via Piper ONNX model        │
   │  • Returns .wav path via stdout (--path-only mode)      │
   └────────────────────────────┬────────────────────────────┘
                                │ wav filename
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  .pending-audio  (file bridge)                          │
   │  ─────────────────────────────────────────────────────  │
   │  Basename of .wav written here                          │
   │  Neural UI server reads + clears on each poll           │
   └────────────────────────────┬────────────────────────────┘
                                │ HTTP GET /audio/<filename>
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Neural UI  (jarvis-neural.html + Web Audio API)        │
   │  ─────────────────────────────────────────────────────  │
   │  • Polls /api/status every 150ms                        │
   │  • Fetches .wav via /audio/<filename>                   │
   │  • Plays through AudioContext → AnalyserNode            │
   │  • Every animation frame: reads FFT data                │
   │  • 152 sphere nodes each mapped to a frequency bin      │
   │  • Node displacement, bloom, rings, core all react      │
   └─────────────────────────────────────────────────────────┘


Files
-----

.. code-block:: text

   ARC_Reactor/
   ├── main.js                      Electron: tray, BrowserWindow, IPC
   ├── preload.js                   Electron contextBridge for setup UI
   ├── install.js                   CLI installer (no Electron needed)
   ├── package.json                 Electron + electron-builder config
   │
   ├── setup/
   │   └── setup.html               First-run wizard (system check → hooks → launch)
   │
   ├── Neural/
   │   ├── config.json              All runtime configuration
   │   │
   │   ├── scripts/
   │   │   ├── jarvis-cli.js        CLI: start/stop/status/speak/config/voice
   │   │   ├── neural-logger.js     Hook handler: scoring, Ollama, TTS bridge
   │   │   └── neural-ui-server.js  HTTP server :7474, /api/status, /audio/*
   │   │
   │   ├── ui/
   │   │   └── jarvis-neural.html   Three.js sphere + Web Audio (self-contained)
   │   │
   │   ├── context/                 Runtime: current task, intent, errors
   │   ├── patterns/                Detected tool sequence patterns
   │   └── sessions/                Archived session logs
   │
   └── python/
       └── jarvis_speak.py          Piper TTS wrapper (cross-platform)


Runtime Files
-------------

These files are created at runtime and excluded from the repository:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - File
     - Purpose
   * - ``Neural/.pending-audio``
     - Bridge: hook writes wav filename, server reads+clears it
   * - ``Neural/.voice-lock``
     - Prevents concurrent TTS synthesis
   * - ``Neural/.session-state.json``
     - Tool call counts, session ID, last tool used
   * - ``Neural/.voice-history.json``
     - Last 20 spoken lines (used for dedup and context)
   * - ``Neural/.server.pid``
     - PID of the running server process
   * - ``Neural/status.md``
     - Human-readable status updated after each tool call
   * - ``Neural/tool-log.jsonl``
     - Full append-only log of every tool call this install
   * - ``~/.claude/jarvis-audio/cache/``
     - MD5-named ``.wav`` files — the TTS cache


Design Decisions
----------------

**Why not block Claude while speaking?**

The hook fires in the middle of Claude's work. If JARVIS blocked while generating
speech, Claude would freeze waiting for TTS. Instead:

1. The main hook process does only fast synchronous file I/O, then exits
2. A detached child process handles Ollama + TTS asynchronously
3. Claude gets unblocked immediately; JARVIS speaks seconds later

**Why write a file instead of a socket?**

The Neural UI server and the hook worker are separate processes with no shared
memory. A file (``.pending-audio``) is the simplest zero-dependency IPC mechanism —
the server polls it every 150ms, reads the filename, clears it, serves the audio.

**Why browser audio instead of Python playback?**

Python's ``winsound`` (Windows) or ``afplay`` (macOS) plays audio but can't expose
real-time frequency data. Moving playback to the browser's Web Audio API gives us
an ``AnalyserNode`` that outputs FFT data every animation frame — enabling the
sphere to react to JARVIS's actual voice waveform rather than a simulation.

**Why Fibonacci sphere + frequency bins?**

A Fibonacci distribution gives uniform node coverage without poles. Each node is
pre-assigned a frequency bin based on its Y-position (bass at equator, treble at
poles) during sphere construction. This mapping is O(1) per frame — no sorting,
no dynamic assignment.

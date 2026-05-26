Voice Model
===========

JARVIS uses a Piper ONNX neural voice model trained specifically on Paul Bettany's
portrayal of J.A.R.V.I.S in the MCU Iron Man films.

The model was created by `jgkawell <https://github.com/jgkawell/jarvis>`_ and is
separate from this project. You download it once and it lives on your machine permanently.


Download
--------

1. Go to `github.com/jgkawell/jarvis/releases <https://github.com/jgkawell/jarvis/releases>`_
2. Download the latest ``jarvis-medium`` release
3. You need two files:

   - ``jarvis-medium.onnx`` (~60 MB — the neural network weights)
   - ``jarvis-medium.onnx.json`` (~2 KB — the voice configuration)


Placement
---------

Place both files in ``~/.claude/jarvis-piper/``:

.. code-block:: bash

   # macOS / Linux
   mkdir -p ~/.claude/jarvis-piper
   mv jarvis-medium.onnx     ~/.claude/jarvis-piper/
   mv jarvis-medium.onnx.json ~/.claude/jarvis-piper/

.. code-block:: powershell

   # Windows (PowerShell)
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\jarvis-piper"
   # Then move/copy both files there

Verify the path:

.. code-block:: text

   ~/.claude/
   └── jarvis-piper/
       ├── jarvis-medium.onnx        ← required
       └── jarvis-medium.onnx.json   ← required


How Voice Generation Works
--------------------------

JARVIS generates voice lines in two stages:

**Stage 1 — LLM (Ollama)**

When Claude Code fires a tool call, ``neural-logger.js`` sends a compact prompt to
your local Ollama instance:

.. code-block:: text

   You are JARVIS, Iron Man's British AI assistant.
   Narrate software work in 8-14 words. Say "sir".
   Never mention tool names, file names, or paths.
   Output: one spoken line only, no quotes.

The model (``llama3.2:1b`` by default) generates a contextual one-liner like:
*"The system is taking shape, sir."*

**Stage 2 — Piper TTS**

The generated text is passed to ``jarvis_speak.py``, which:

1. Computes an MD5 hash of ``"jarvis-medium:" + text``
2. Checks if ``~/.claude/jarvis-audio/cache/<hash>.wav`` exists
3. If not: calls the Piper ONNX model to synthesize the speech and saves it
4. Returns the ``.wav`` file path

The cache means any phrase JARVIS has ever said is instant on repeat.

**Stage 3 — Browser Audio**

The ``.wav`` filename is written to ``.pending-audio``.
The Neural UI polls every 150ms, fetches the file via ``/audio/<filename>``,
plays it through the Web Audio API, and routes it through an analyser node
so the 3D sphere reacts to the real frequency data.


Changing the Voice Model
------------------------

Any Piper-compatible ONNX model will work. To use a different voice:

1. Download a model from `Piper's voice list <https://github.com/rhasspy/piper/blob/master/VOICES.md>`_
2. Update the paths in ``jarvis_speak.py``:

.. code-block:: python

   MODEL_PATH  = os.path.expanduser("~/.claude/jarvis-piper/your-model.onnx")
   CONFIG_PATH = os.path.expanduser("~/.claude/jarvis-piper/your-model.onnx.json")
   VOICE_KEY   = "your-model"  # used for cache key


Changing the LLM
-----------------

The default model is ``llama3.2:1b`` — fast, small, good enough for one-liners.
For richer, more contextual narration, use a larger model:

.. code-block:: bash

   ollama pull llama3.1:8b
   jarvis config set ollamaModel llama3.1:8b

Any Ollama-compatible model works. Larger models produce better JARVIS lines
but add latency to each tool call narration.

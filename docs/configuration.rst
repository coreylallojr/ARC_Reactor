Configuration
=============

All JARVIS settings live in ``Neural/config.json``. This file is written by the
installer and updated by ``jarvis config set`` commands or the settings panel in
the Neural UI.


config.json Reference
----------------------

.. code-block:: json

   {
     "vault":                  "/path/to/ARC_Reactor",
     "neural":                 "/path/to/ARC_Reactor/Neural",
     "pythonPath":             "/usr/bin/python3",
     "jarvisSpeakPath":        "/Users/you/.claude/jarvis_speak.py",
     "ollamaUrl":              "http://localhost:11434/v1/chat/completions",
     "ollamaModel":            "llama3.2:1b",
     "patternThreshold":       3,
     "speakMinLevel":          1,
     "maxContextMode":         false,
     "sessionStartBonus":      2,
     "errorBonus":             4,
     "consecutiveSamePenalty": 1,
     "toolScores": {
       "Read":  1,
       "Grep":  1,
       "Glob":  1,
       "Edit":  2,
       "Write": 3,
       "Bash":  3,
       "Agent": 4
     }
   }


Voice Scoring System
--------------------

JARVIS doesn't speak on every single tool call by default — it scores each call
and speaks when the score meets the configured threshold.

**Base scores** (from ``toolScores``):

.. list-table::
   :header-rows: 1
   :widths: 20 10 70

   * - Tool
     - Score
     - Rationale
   * - Read, Grep, Glob
     - 1
     - Routine lookups — low significance
   * - Edit, PowerShell
     - 2
     - Meaningful changes — medium significance
   * - Write, Bash
     - 3
     - Creating files, running commands — high significance
   * - Agent
     - 4
     - Spawning subagents — maximum significance

**Score modifiers:**

- ``+sessionStartBonus`` (default: 2) — added to the first call of a new session
- ``+errorBonus`` (default: 4) — added when the tool response contains an error
- ``-consecutiveSamePenalty`` (default: 1) — subtracted after 3+ identical consecutive calls

**Voice level gate** (``speakMinLevel``):

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Value
     - Behavior
   * - ``1``
     - Speak on all calls (score ≥ 1). Every tool call narrated.
   * - ``2``
     - Speak on key calls only (score ≥ 2). Skips routine reads and searches.
   * - ``99``
     - Muted. No speech generation.


Max Context Mode
----------------

When ``maxContextMode`` is ``false`` (default), JARVIS's voice prompt only receives:

- The current task description
- The tool name and a summary of what was modified
- The last 2 voice lines (to avoid repetition)

When ``maxContextMode`` is ``true``, JARVIS also receives a snippet of the **tool
response output** — useful for giving more accurate narration but slightly slower
and more token-intensive.

Toggle via:

.. code-block:: bash

   jarvis config set maxContextMode true

Or press ``X`` in the Neural UI.


Neural UI Settings
-------------------

The settings panel (press ``S`` in the UI) lets you change voice level and max context
mode live without restarting anything. Changes are written back to ``config.json``
immediately.

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Key
     - Action
   * - ``S``
     - Toggle settings panel
   * - ``1``
     - Voice: all calls
   * - ``2``
     - Voice: key only
   * - ``M``
     - Toggle mute
   * - ``X``
     - Toggle max context mode
   * - ``ESC``
     - Close settings panel

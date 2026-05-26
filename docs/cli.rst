CLI Reference
=============

The ``jarvis`` command manages the full JARVIS stack from any terminal.

.. code-block:: text

   ╔════════════════════════════════════════════════════════════╗
   ║                                                            ║
   ║         ◉  J · A · R · V · I · S  ◉                       ║
   ║         Just A Rather Very Intelligent System              ║
   ║                                                            ║
   ╚════════════════════════════════════════════════════════════╝


System Commands
---------------

.. describe:: jarvis

   Alias for ``jarvis start``. Starts everything and opens the UI.

.. describe:: jarvis start

   Starts the full JARVIS stack:

   1. Launches Ollama if it's not running (polls up to 8 seconds)
   2. Starts the Neural UI server on ``http://localhost:7474``
   3. Opens the UI in your default browser
   4. Speaks ``"Systems online. Welcome back, sir."``

   If the server is already running, opens the browser without restarting.

.. describe:: jarvis stop

   Shuts down the Neural UI server. Uses the saved PID; falls back to
   port scan (``netstat`` / ``lsof``) if the PID file is stale.

.. describe:: jarvis restart

   Stops then starts. Useful after config changes.

.. describe:: jarvis status

   Prints live system status:

   .. code-block:: text

     J.A.R.V.I.S
     ──────────────────────────────
     Server     ● online  http://localhost:7474
     Ollama     ● online  llama3.2:1b
     Voice      all
     Max ctx    off
     Calls      14 this session
     Last line  "The system is taking shape, sir."

.. describe:: jarvis open

   Opens the Neural UI in the browser. Starts the server first if it's not running.


Voice Commands
--------------

.. describe:: jarvis speak <text>

   Immediately synthesize and play a voice line:

   .. code-block:: bash

      jarvis speak "All systems are nominal, sir."

   Uses Piper TTS directly. Does not go through Ollama.

.. describe:: jarvis voice all

   Set narration to **all tool calls** (default). Every Read, Edit, Bash, Agent
   call triggers a voice line.

.. describe:: jarvis voice key

   Set narration to **key tool calls only**. Only significant actions (Edit, Write,
   Bash, Agent) are narrated. Quiet for repetitive reads and searches.

.. describe:: jarvis voice mute

   **Silence** all voice narration. Hooks still run but skip speech generation.
   Toggle back with ``jarvis voice all`` or ``jarvis voice key``.


Configuration Commands
-----------------------

.. describe:: jarvis config

   Print all current configuration values:

   .. code-block:: bash

      jarvis config

.. describe:: jarvis config set <key> <value>

   Set a config value. Types are auto-coerced (``true``/``false`` → boolean,
   numeric strings → numbers, everything else → string):

   .. code-block:: bash

      jarvis config set ollamaModel llama3.1:8b
      jarvis config set speakMinLevel 2
      jarvis config set maxContextMode true

   Changes take effect immediately for new hook calls. The running server
   is also notified for live settings like ``speakMinLevel``.

.. describe:: jarvis help

   Print the full command reference with arc reactor formatting.


Configuration Keys
------------------

.. list-table::
   :header-rows: 1
   :widths: 22 15 63

   * - Key
     - Default
     - Description
   * - ``ollamaModel``
     - ``llama3.2:1b``
     - Ollama model used to generate JARVIS voice lines
   * - ``ollamaUrl``
     - ``http://localhost:11434/v1/chat/completions``
     - Ollama API endpoint
   * - ``speakMinLevel``
     - ``1``
     - Minimum score for narration: ``1``=all, ``2``=key only, ``99``=mute
   * - ``maxContextMode``
     - ``false``
     - When ``true``, includes tool output in the voice generation prompt
   * - ``pythonPath``
     - auto-detected
     - Full path to the Python 3 executable
   * - ``jarvisSpeakPath``
     - ``~/.claude/jarvis_speak.py``
     - Path to the TTS bridge script
   * - ``patternThreshold``
     - ``3``
     - How many sessions before a tool pattern is recorded

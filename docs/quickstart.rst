Quick Start
===========

JARVIS is running on your machine in under 5 minutes. Here's the path.

.. raw:: html

   <div class="install-steps">

     <div class="install-step">
       <div class="install-step-content">
         <h4>Install Prerequisites</h4>
         <p>You need four things. Each is a one-line install.</p>
       </div>
     </div>

     <div class="install-step">
       <div class="install-step-content">
         <h4>Clone &amp; Install</h4>
         <p>One command clones the repo and runs the installer.</p>
       </div>
     </div>

     <div class="install-step">
       <div class="install-step-content">
         <h4>Download the Voice Model</h4>
         <p>Drop two files into <code>~/.claude/jarvis-piper/</code>. That's it.</p>
       </div>
     </div>

     <div class="install-step">
       <div class="install-step-content">
         <h4>Launch</h4>
         <p>Type <code>jarvis start</code> from any terminal. Open Claude Code. Start talking to it. JARVIS narrates everything.</p>
       </div>
     </div>

   </div>


Step 1 — Prerequisites
-----------------------

Install each of these once. They're all free.

.. list-table::
   :header-rows: 1
   :widths: 20 40 40

   * - Requirement
     - Install Command
     - Notes
   * - **Node.js** v18+
     - Download from `nodejs.org <https://nodejs.org>`_
     - Powers the server and CLI
   * - **Python 3.x**
     - Download from `python.org <https://python.org>`_
     - Powers the Piper TTS voice engine
   * - **Ollama**
     - Download from `ollama.com <https://ollama.com>`_
     - Free local LLM — generates JARVIS lines
   * - **Claude Code**
     - ``npm install -g @anthropic-ai/claude-code``
     - The AI agent JARVIS rides inside

After installing Ollama, pull the voice generation model:

.. code-block:: bash

   ollama pull llama3.2:1b

And install the Python TTS library:

.. code-block:: bash

   pip install piper-tts


Step 2 — Clone & Install
--------------------------

.. code-block:: bash

   git clone https://github.com/coreylallojr/ARC_Reactor.git
   cd ARC_Reactor
   node install.js

The installer will:

- Auto-detect your Python path
- Install ``piper-tts`` if missing
- Copy ``jarvis_speak.py`` to ``~/.claude/``
- Write your ``config.json`` with correct paths
- Wire ``PostToolUse`` and ``Stop`` hooks into ``~/.claude/settings.json``
- Add the ``jarvis`` command to your shell profile

.. note::

   On Windows, the ``jarvis`` command is available after opening a **new** PowerShell window.
   On macOS/Linux, run ``source ~/.bashrc`` (or ``~/.zshrc``) in your current terminal.


Step 3 — Voice Model
---------------------

The JARVIS voice is a Piper ONNX model trained specifically on Paul Bettany's MCU performance,
created by `jgkawell <https://github.com/jgkawell/jarvis>`_.

1. Download ``jarvis-medium.onnx`` and ``jarvis-medium.onnx.json`` from the
   `releases page <https://github.com/jgkawell/jarvis/releases>`_

2. Create the directory and place both files there:

.. code-block:: bash

   # macOS / Linux
   mkdir -p ~/.claude/jarvis-piper
   # Drop the two files in there

   # Windows (PowerShell)
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\jarvis-piper"
   # Drop the two files in there

The final structure should be:

.. code-block:: text

   ~/.claude/
   └── jarvis-piper/
       ├── jarvis-medium.onnx
       └── jarvis-medium.onnx.json


Step 4 — Launch
----------------

.. code-block:: bash

   jarvis start

This will:

1. Start Ollama (if not already running)
2. Start the Neural UI server on ``http://localhost:7474``
3. Open the Neural UI in your browser
4. Speak ``"Systems online. Welcome back, sir."``

Now open Claude Code and start a task. JARVIS will narrate every action.

.. tip::

   When the browser opens, **click anywhere on the Neural UI** to activate audio.
   Browsers require a user interaction before playing sound.
   After the first click, all future voice lines play automatically.


That's It
---------

You're done. JARVIS is now active in every Claude Code session, permanently.

- **To check status**: ``jarvis status``
- **To change voice level**: ``jarvis voice key`` (only significant actions)
- **To mute**: ``jarvis voice mute``
- **To test the voice**: ``jarvis speak "Hello sir"``
- **Full command list**: ``jarvis help``

See :doc:`cli` for the complete command reference.

Installation
============

This page covers both installation paths in full detail.


Option A — Electron App
------------------------

The Electron app gives you a system tray icon, a setup wizard, and automatic server management.
No terminal required after first install.

.. code-block:: bash

   git clone https://github.com/coreylallojr/ARC_Reactor.git
   cd ARC_Reactor
   npm install
   npm start

On first launch, the setup wizard opens and walks you through:

- System check (Node, Python, Ollama, Piper model, Claude Code)
- Python path configuration
- Automatic hook installation
- Shell alias setup

After setup, the app lives in your system tray. Click the arc reactor icon to:

- Open the Neural UI
- Test the voice
- Restart the server
- Access settings

.. note::

   The Electron app requires ``npm install`` to download Electron itself (~80MB).
   This is a one-time download.


Option B — CLI Only
--------------------

No Electron. Just Node.js.

.. code-block:: bash

   git clone https://github.com/coreylallojr/ARC_Reactor.git
   cd ARC_Reactor
   node install.js

The installer is interactive — it detects Python, offers to install ``piper-tts``,
writes all config and hooks, and adds the ``jarvis`` shell alias.

After installation, manage everything from your terminal:

.. code-block:: bash

   jarvis start      # start everything
   jarvis stop       # stop the server
   jarvis status     # live status
   jarvis help       # all commands


What the Installer Does
------------------------

Both installation paths do the same underlying work:

**1. Copies** ``jarvis_speak.py`` to ``~/.claude/jarvis_speak.py``

This is the TTS bridge script. It calls the Piper ONNX model and caches every generated
``.wav`` file by MD5 hash so repeated phrases are instant.

**2. Writes** ``Neural/config.json``

Fills in your actual Python path and file system paths. The blank template ships with
placeholder values; the installer fills them in based on your system.

**3. Wires hooks into** ``~/.claude/settings.json``

Adds two entries:

.. code-block:: json

   {
     "hooks": {
       "PostToolUse": [{
         "matcher": ".*",
         "hooks": [{ "type": "command", "command": "node /path/to/neural-logger.js" }]
       }],
       "Stop": [{
         "matcher": "",
         "hooks": [{ "type": "command", "command": "node /path/to/neural-logger.js --stop" }]
       }]
     }
   }

This is what makes JARVIS permanent. Every Claude Code session fires these hooks
regardless of which project you're in or which terminal you use.

**4. Adds shell alias**

- **Windows**: Appends ``function jarvis { node "..." @args }`` to PowerShell profile
- **macOS/Linux**: Appends ``alias jarvis='node "..."'`` to ``.bashrc`` / ``.zshrc``


Manual Hook Installation
-------------------------

If you prefer to add hooks yourself:

1. Open ``~/.claude/settings.json`` (create it if it doesn't exist)
2. Add the following, replacing the path with your actual clone location:

.. code-block:: json

   {
     "hooks": {
       "PostToolUse": [{
         "matcher": ".*",
         "hooks": [{
           "type": "command",
           "command": "node \"/path/to/ARC_Reactor/Neural/scripts/neural-logger.js\"",
           "timeout": 30
         }]
       }],
       "Stop": [{
         "matcher": "",
         "hooks": [{
           "type": "command",
           "command": "node \"/path/to/ARC_Reactor/Neural/scripts/neural-logger.js\" --stop",
           "timeout": 30
         }]
       }]
     }
   }


Uninstalling
------------

To remove JARVIS completely:

1. **Remove the hooks** from ``~/.claude/settings.json`` (delete the ``PostToolUse`` and ``Stop`` entries)
2. **Remove the shell alias** from your profile (``Microsoft.PowerShell_profile.ps1`` / ``.bashrc`` / ``.zshrc``)
3. **Delete the repo folder**
4. Optionally delete ``~/.claude/jarvis_speak.py``, ``~/.claude/jarvis-piper/``, and ``~/.claude/jarvis-audio/``

Claude Code is unaffected — it just stops receiving hook events.


Updating
--------

.. code-block:: bash

   cd ARC_Reactor
   git pull
   # No reinstall needed — hooks point to the scripts in place

If ``config.json`` format changes between versions, run ``node install.js`` again.
It's safe to re-run — it merges rather than overwrites existing config.

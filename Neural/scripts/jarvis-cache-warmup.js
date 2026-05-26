'use strict';
// Pre-generates WAV files for all fallback lines at startup to eliminate
// first-use TTS latency. Runs once per session from neural-ui-server.js.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CACHE_DIR   = path.join(os.homedir(), '.claude', 'jarvis-audio', 'cache');

function generateWav(pythonPath, speakPath, text) {
  return new Promise(resolve => {
    const proc = spawn(pythonPath, [speakPath, '--path-only', text], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => resolve(out.trim() || null));
    proc.on('error', () => resolve(null));
  });
}

async function warmupCache() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return; }
  if (!config.pythonPath || !config.jarvisSpeakPath) return;

  const fallbacks = require('./jarvis-fallbacks');
  const allLines = [];
  for (const category of Object.keys(fallbacks.FALLBACKS || {})) {
    const lines = fallbacks.FALLBACKS[category];
    if (Array.isArray(lines)) {
      for (const line of lines) {
        // Skip lines with tokens that need runtime substitution
        if (!line.includes('{')) allLines.push(line);
      }
    }
  }

  // Add common fixed phrases
  allLines.push('On it, sir.', 'Understood, sir.', 'All systems nominal, sir.');

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Stagger generation to avoid hammering TTS at once
  for (const line of allLines) {
    await generateWav(config.pythonPath, config.jarvisSpeakPath, line);
    await new Promise(r => setTimeout(r, 80));
  }
}

// Only run when invoked directly
if (require.main === module) {
  warmupCache().catch(() => {});
}

module.exports = { warmupCache };

#!/usr/bin/env node
/**
 * ARC Reactor — CLI Installer
 * Run this if you don't want the Electron app:
 *   node install.js
 *
 * What it does:
 *   1. Copies jarvis_speak.py to ~/.claude/jarvis_speak.py
 *   2. Writes config.json with your actual paths
 *   3. Wires PostToolUse + Stop hooks into ~/.claude/settings.json
 *   4. Adds `jarvis` alias to your shell profile
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

const NEURAL_DIR    = path.join(__dirname, 'Neural');
const CONFIG_PATH   = path.join(NEURAL_DIR, 'config.json');
const SPEAK_SRC     = path.join(__dirname, 'python', 'jarvis_speak.py');
const SPEAK_DEST    = path.join(os.homedir(), '.claude', 'jarvis_speak.py');
const CLAUDE_DIR    = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

const C = {
  cyan:  '\x1b[96m', green: '\x1b[32m', yellow: '\x1b[33m',
  red:   '\x1b[31m', dim:   '\x1b[2m',  bold:   '\x1b[1m', reset: '\x1b[0m',
};
const c = (col, txt) => C[col] + txt + C.reset;
const log  = (msg) => console.log('  ' + msg);
const ok   = (msg) => log(c('green',  '✓ ') + msg);
const warn = (msg) => log(c('yellow', '⚠ ') + msg);
const err  = (msg) => log(c('red',    '✗ ') + msg);
const info = (msg) => log(c('dim',    '  ') + msg);

function detectPython() {
  const candidates = ['python3', 'python', 'python3.12', 'python3.11'];
  for (const p of candidates) {
    try {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) return { exe: p, version: (r.stdout || r.stderr || '').trim() };
    } catch {}
  }
  return null;
}

async function prompt(question, defaultVal = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const q = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(q, (ans) => { rl.close(); resolve(ans.trim() || defaultVal); });
  });
}

async function main() {
  console.log('');
  console.log(c('bold', c('cyan', '  ◉  ARC Reactor — JARVIS Installer  ◉')));
  console.log(c('dim',  '  ──────────────────────────────────────────'));
  console.log('');

  // ── Python detection ──────────────────────────────────────────────────────
  log('Detecting Python...');
  let pyResult = detectPython();
  let pythonPath;

  if (pyResult) {
    ok(`Found: ${pyResult.exe} (${pyResult.version})`);
    const custom = await prompt(`Python path`, pyResult.exe);
    pythonPath = custom;
  } else {
    warn('Python not found in PATH.');
    pythonPath = await prompt('Enter full path to python executable');
  }

  // Verify chosen python
  const verifyResult = spawnSync(pythonPath, ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (verifyResult.status !== 0) {
    err(`Cannot run python at: ${pythonPath}`);
    process.exit(1);
  }
  ok(`Python: ${(verifyResult.stdout || verifyResult.stderr || '').trim()}`);

  // ── Check piper-tts ───────────────────────────────────────────────────────
  log('Checking piper-tts...');
  const piperCheck = spawnSync(pythonPath, ['-c', 'import piper; print("ok")'], { encoding: 'utf8', timeout: 5000 });
  if (piperCheck.status === 0) {
    ok('piper-tts installed');
  } else {
    warn('piper-tts not installed. Installing now...');
    const install = spawnSync(pythonPath, ['-m', 'pip', 'install', 'piper-tts'], { stdio: 'inherit', timeout: 120000 });
    if (install.status !== 0) {
      err('pip install piper-tts failed. Install manually: pip install piper-tts');
    } else {
      ok('piper-tts installed');
    }
  }

  // ── Copy jarvis_speak.py ──────────────────────────────────────────────────
  log('Installing jarvis_speak.py...');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(SPEAK_SRC, SPEAK_DEST);
  ok(`Copied to ${SPEAK_DEST}`);

  // ── Check Piper model ─────────────────────────────────────────────────────
  const modelPath = path.join(os.homedir(), '.claude', 'jarvis-piper', 'jarvis-medium.onnx');
  if (fs.existsSync(modelPath)) {
    ok('JARVIS voice model found');
  } else {
    warn('JARVIS voice model not found.');
    info('Download jarvis-medium.onnx + jarvis-medium.onnx.json from the README');
    info(`Place both files in: ${path.dirname(modelPath)}`);
  }

  // ── Write config.json ─────────────────────────────────────────────────────
  log('Writing config.json...');
  const config = {
    vault:    __dirname.replace(/\\/g, '/'),
    neural:   NEURAL_DIR.replace(/\\/g, '/'),
    pythonPath: pythonPath.replace(/\\/g, '/'),
    jarvisSpeakPath: SPEAK_DEST.replace(/\\/g, '/'),
    ollamaUrl:   'http://localhost:11434/v1/chat/completions',
    ollamaModel: 'llama3.2:1b',
    patternThreshold: 3,
    speakMinLevel: 1,
    voiceMode: 2,
    maxContextMode: false,
    sessionStartBonus: 2,
    errorBonus: 4,
    consecutiveSamePenalty: 1,
    voiceServerPort: 7475,
    sttBackend: 'webspeech',
    wakeWord: false,
    toolScores: { Read:1, Grep:1, Glob:1, Edit:2, Write:3, Bash:3, Agent:4 },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  ok('config.json saved');

  // ── Write Claude Code hooks ───────────────────────────────────────────────
  log('Writing Claude Code hooks...');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch {}

  const loggerPath = path.join(NEURAL_DIR, 'scripts', 'neural-logger.js').replace(/\\/g, '/');
  settings.hooks = settings.hooks || {};
  settings.hooks.PostToolUse = [{
    matcher: '.*',
    hooks: [{ type: 'command', command: `node "${loggerPath}"`, timeout: 30 }],
  }];
  settings.hooks.Stop = [{
    matcher: '',
    hooks: [{ type: 'command', command: `node "${loggerPath}" --stop`, timeout: 30 }],
  }];

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  ok('Hooks written to ~/.claude/settings.json');

  // ── Shell alias ───────────────────────────────────────────────────────────
  log('Writing shell alias...');
  const cliPath = path.join(NEURAL_DIR, 'scripts', 'jarvis-cli.js');
  const isWin   = process.platform === 'win32';

  if (isWin) {
    try {
      const psProfile = path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      fs.mkdirSync(path.dirname(psProfile), { recursive: true });
      let existing = '';
      try { existing = fs.readFileSync(psProfile, 'utf8'); } catch {}
      if (!existing.includes('jarvis-cli.js')) {
        fs.appendFileSync(psProfile, `\nfunction jarvis { node "${cliPath}" @args }\n`);
        ok('PowerShell alias added (restart terminal to use `jarvis` command)');
      } else {
        info('PowerShell alias already present');
      }
    } catch (e) {
      warn('Could not write PowerShell profile: ' + e.message);
    }
  } else {
    const bashLine = `\nalias jarvis='node "${cliPath}"'\n`;
    let added = false;
    for (const prof of ['.bashrc', '.zshrc', '.bash_profile'].map(p => path.join(os.homedir(), p))) {
      if (fs.existsSync(prof)) {
        const content = fs.readFileSync(prof, 'utf8');
        if (!content.includes('jarvis-cli.js')) {
          fs.appendFileSync(prof, bashLine);
          ok(`Alias added to ${path.basename(prof)} (run 'source ~/${path.basename(prof)}' or open a new terminal)`);
          added = true;
          break;
        } else {
          info('Alias already present in ' + path.basename(prof));
          added = true;
          break;
        }
      }
    }
    if (!added) warn('Could not find .bashrc/.zshrc — add alias manually: ' + bashLine.trim());
  }

  // ── Create required directories ───────────────────────────────────────────
  for (const dir of ['context', 'patterns', 'sessions'].map(d => path.join(NEURAL_DIR, d))) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.gitkeep'))) {
      fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    }
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(c('bold', c('cyan', '  ◉  Setup complete  ◉')));
  console.log('');
  info('Start JARVIS:  node Neural/scripts/jarvis-cli.js start');
  info('Or after alias: jarvis start');
  info('');
  info('Then open Claude Code and start coding — JARVIS will narrate every action.');
  console.log('');
}

main().catch(e => { err(e.message); process.exit(1); });

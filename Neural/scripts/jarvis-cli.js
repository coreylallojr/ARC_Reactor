#!/usr/bin/env node
// jarvis-cli.js — Local JARVIS system CLI
// Usage: node jarvis-cli.js [command] [...args]
'use strict';

const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { execSync, spawn } = require('child_process');

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_PATH  = path.join(__dirname, '..', 'config.json');
const PID_PATH     = path.join(__dirname, '..', '.server.pid');
const HISTORY_PATH = path.join(__dirname, '..', '.voice-history.json');
const SERVER_SCRIPT = path.join(__dirname, 'neural-ui-server.js');

const OLLAMA_PORT = 11434;

// ─── Ollama path detection ────────────────────────────────────────────────────
function findOllamaExe() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    'ollama',
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return 'ollama';
}

// ─── ANSI Colors ──────────────────────────────────────────────────────────────
const C = {
  cyan:        '\x1b[36m',
  brightCyan:  '\x1b[96m',
  blue:        '\x1b[34m',
  brightBlue:  '\x1b[94m',
  white:       '\x1b[97m',
  green:       '\x1b[32m',
  yellow:      '\x1b[33m',
  red:         '\x1b[31m',
  dim:         '\x1b[2m',
  bold:        '\x1b[1m',
  reset:       '\x1b[0m',
};

function c(color, text) { return C[color] + text + C.reset; }

// ─── Config helpers ───────────────────────────────────────────────────────────
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    die('Cannot read config.json: ' + e.message);
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── Voice level helpers ──────────────────────────────────────────────────────
function levelName(n) {
  if (n <= 1)  return 'all';
  if (n === 2) return 'key';
  return 'mute';
}

function levelValue(name) {
  const map = { all: 1, key: 2, mute: 99 };
  return map[String(name).toLowerCase()];
}

// ─── Server check ─────────────────────────────────────────────────────────────
function isRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:7474/api/status', { timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function getServerStatus() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:7474/api/status', { timeout: 800 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── Ollama helpers ───────────────────────────────────────────────────────────
function isOllamaRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, { timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureOllama() {
  if (await isOllamaRunning()) return true;
  process.stdout.write('  Starting Ollama... ');
  const ollamaExe = findOllamaExe();
  spawn(ollamaExe, ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isOllamaRunning()) {
      process.stdout.write(c('green', 'ready') + '\n');
      return true;
    }
  }
  process.stdout.write(c('yellow', 'timeout — voice lines may be silent') + '\n');
  return false;
}

// ─── Startup polling ──────────────────────────────────────────────────────────
async function waitForServer(tries = 20, interval = 400) {
  for (let i = 0; i < tries; i++) {
    if (await isRunning()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

// ─── PID helpers ─────────────────────────────────────────────────────────────
function readPid() {
  try {
    const raw = fs.readFileSync(PID_PATH, 'utf8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

function writePid(pid) {
  fs.writeFileSync(PID_PATH, String(pid));
}

function clearPid() {
  try { fs.unlinkSync(PID_PATH); } catch {}
}

// ─── Find PID by port via netstat ─────────────────────────────────────────────
function findPidByPort(port) {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `netstat -aon | findstr ":${port} "`
      : `lsof -ti :${port}`;
    const out = execSync(cmd, { shell: isWin ? 'cmd.exe' : '/bin/sh', encoding: 'utf8' });
    if (!isWin) return parseInt(out.trim(), 10) || null;
    const lines = out.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const localAddr = parts[1] || '';
      if (localAddr.endsWith(`:${port}`)) {
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch {}
  return null;
}

// ─── Kill process ─────────────────────────────────────────────────────────────
function killPid(pid) {
  try {
    process.kill(pid);
    return true;
  } catch {
    try {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
      execSync(cmd, { shell: isWin ? 'cmd.exe' : '/bin/sh', stdio: 'ignore' });
      return true;
    } catch { return false; }
  }
}

// ─── Open browser ─────────────────────────────────────────────────────────────
function openBrowser(url) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const cmd   = isWin ? ['cmd', ['/c', 'start', url]] : isMac ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', shell: false });
  child.unref();
}

// ─── Speak ───────────────────────────────────────────────────────────────────
function speak(text) {
  const cfg = readConfig();
  const python = cfg.pythonPath || 'python3';
  const script = cfg.jarvisSpeakPath;
  if (!script) { console.log(c('yellow', '  jarvisSpeakPath not set — run setup first.')); return; }
  const child = spawn(python, [script, text], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

// ─── POST to server config ────────────────────────────────────────────────────
function postServerConfig(update) {
  return new Promise((resolve) => {
    const body = JSON.stringify(update);
    const opts = {
      hostname: '127.0.0.1',
      port: 7474,
      path: '/api/config',
      method: 'POST',
      timeout: 800,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function die(msg) {
  console.error(c('red', '  Error: ') + msg);
  process.exit(1);
}

function pad(str, len) {
  return String(str).padEnd(len);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdStart() {
  await ensureOllama();
  const already = await isRunning();
  if (already) {
    console.log(c('cyan', '  J.A.R.V.I.S') + c('dim', ' — already online'));
    openBrowser('http://localhost:7474');
    return;
  }

  console.log(c('dim', '  Starting JARVIS server...'));
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  writePid(child.pid);

  const up = await waitForServer();
  if (up) {
    console.log(c('green', '  ● JARVIS online') + c('dim', '  http://localhost:7474'));
    openBrowser('http://localhost:7474');
    speak('Systems online. Welcome back, sir.');
  } else {
    clearPid();
    die('Server did not come up within 8 seconds. Check ' + SERVER_SCRIPT);
  }
}

async function cmdStop() {
  let pid = readPid();
  if (!pid) {
    pid = findPidByPort(7474);
    if (!pid) {
      const running = await isRunning();
      if (!running) { console.log(c('yellow', '  Server is not running.')); return; }
      die('Could not determine server PID. Kill manually.');
    }
  }
  const ok = killPid(pid);
  clearPid();
  if (ok) console.log(c('green', '  ● JARVIS offline') + c('dim', `  (PID ${pid} terminated)`));
  else die(`Failed to kill PID ${pid}.`);
}

async function cmdRestart() {
  await cmdStop();
  await new Promise(r => setTimeout(r, 600));
  await cmdStart();
}

async function cmdStatus() {
  const cfg = readConfig();
  const [online, ollamaOnline] = await Promise.all([isRunning(), isOllamaRunning()]);
  const apiStatus = online ? await getServerStatus() : null;

  let totalCalls = 0, lastLine = '';
  if (apiStatus) {
    totalCalls = apiStatus.totalCalls || 0;
    lastLine   = apiStatus.lastLine   || '';
  } else {
    try {
      const hist = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (Array.isArray(hist) && hist.length > 0) lastLine = hist[hist.length - 1];
    } catch {}
  }

  const serverStr  = online ? c('green', '● online') + c('dim', '  http://localhost:7474') : c('red', '○ offline');
  const ollamaStr  = ollamaOnline ? c('green', '● online') + c('dim', `  ${cfg.ollamaModel || '—'}`) : c('yellow', '○ offline');
  const lastLineStr = lastLine ? c('dim', `"${lastLine}"`) : c('dim', '—');

  console.log('');
  console.log(c('bold', c('cyan', '  J.A.R.V.I.S')));
  console.log(c('dim', '  ──────────────────────────────'));
  console.log(`  ${pad('Server',   10)} ${serverStr}`);
  console.log(`  ${pad('Ollama',   10)} ${ollamaStr}`);
  console.log(`  ${pad('Voice',    10)} ${levelName(cfg.speakMinLevel || 1)}`);
  console.log(`  ${pad('Max ctx',  10)} ${cfg.maxContextMode ? c('cyan', 'on') : c('dim', 'off')}`);
  console.log(`  ${pad('Calls',    10)} ${totalCalls} this session`);
  console.log(`  ${pad('Last line',10)} ${lastLineStr}`);
  console.log('');
}

async function cmdOpen() {
  const running = await isRunning();
  if (!running) { await cmdStart(); }
  else { openBrowser('http://localhost:7474'); }
}

function cmdSpeak(args) {
  const text = args.join(' ').trim();
  if (!text) die('Usage: jarvis speak <text>');
  speak(text);
  console.log(c('dim', `  Speaking: "${text}"`));
}

function cmdConfig(args) {
  if (args.length === 0) {
    const cfg = readConfig();
    const EDITABLE = [
      ['ollamaUrl',       'Ollama endpoint URL'],
      ['ollamaModel',     'Ollama model name'],
      ['speakMinLevel',   'Voice level (1=all, 2=key, 99=mute)'],
      ['maxContextMode',  'Max context mode (true/false)'],
      ['pythonPath',      'Python executable path'],
      ['jarvisSpeakPath', 'jarvis_speak.py path'],
    ];
    console.log('');
    console.log(c('bold', c('cyan', '  JARVIS Config')));
    console.log(c('dim', '  ─────────────────────────────────────────────────'));
    for (const [key, desc] of EDITABLE) {
      const val = cfg[key];
      const display = val === undefined ? c('dim', '—') : val === '' ? c('dim', '(empty)') : String(val);
      console.log(`  ${c('cyan', pad(key, 20))} ${c('dim', pad(desc, 36))} ${display}`);
    }
    console.log('');
    return;
  }
  if (args[0] === 'set') {
    const key = args[1], rawVal = args.slice(2).join(' ');
    if (!key || !rawVal) die('Usage: jarvis config set <key> <value>');
    let value = rawVal === 'true' ? true : rawVal === 'false' ? false : (!isNaN(Number(rawVal)) && rawVal.trim() !== '' ? Number(rawVal) : rawVal);
    const cfg = readConfig();
    cfg[key] = value;
    writeConfig(cfg);
    console.log(c('green', `  ✓ ${key}`) + c('dim', ' = ') + String(value));
    return;
  }
  die('Usage: jarvis config [set <key> <value>]');
}

async function cmdVoice(args) {
  const mode = (args[0] || '').toLowerCase();
  const level = levelValue(mode);
  if (level === undefined) die('Usage: jarvis voice all|key|mute');
  const cfg = readConfig();
  cfg.speakMinLevel = level;
  writeConfig(cfg);
  if (await isRunning()) await postServerConfig({ speakMinLevel: level });
  console.log(c('green', `  Voice set to: ${mode}`) + c('dim', ` (speakMinLevel=${level})`));
}

function cmdHelp() {
  const bc = C.brightCyan, bb = C.brightBlue, d = C.dim, bl = C.bold, y = C.yellow, g = C.green, r = C.reset;
  const arc   = s => `${bc}${s}${r}`;
  const label = s => `${bl}${bc}${s}${r}`;
  const cmd2  = s => `${bc}${s}${r}`;
  const arg   = s => `${y}${s}${r}`;
  const key   = s => `${bb}${s}${r}`;
  const val   = s => `${g}${s}${r}`;
  const ghost = s => `${d}${s}${r}`;
  const W = 58;
  const box = { tl:arc('╔'), tr:arc('╗'), bl2:arc('╚'), br:arc('╝'), h:arc('═'), v:arc('║'), ml:arc('╠'), mr:arc('╣') };

  function boxRow(content = '') {
    const stripped = content.replace(/\x1b\[[0-9;]*m/g, '');
    const pad2 = Math.max(0, W - stripped.length);
    return `  ${box.v} ${content}${' '.repeat(pad2)} ${box.v}`;
  }
  function sectionHead(title) {
    return `  ${arc('◈')}${arc('─── ')}${label(title)}${arc(' ───────────────────────────────────────────◈')}`;
  }

  console.log('');
  console.log(`  ${box.tl}${arc('═'.repeat(W + 2))}${box.tr}`);
  console.log(boxRow(''));
  console.log(boxRow(`        ${label('◉  J · A · R · V · I · S  ◉')}`));
  console.log(boxRow(`        ${ghost('Just A Rather Very Intelligent System')}`));
  console.log(boxRow(''));
  console.log(boxRow(`  ${arc('·─·')} ${ghost('Neural Core')}  ${arc('◆')}  ${ghost('Ollama Voice')}  ${arc('◆')}  ${ghost('Claude Code Bridge')}  ${arc('·─·')}`));
  console.log(boxRow(''));
  console.log(`  ${box.bl2}${arc('═'.repeat(W + 2))}${box.br}`);

  const sections = [
    ['SYSTEM', [
      ['jarvis',         '',             'Start Ollama + server + open UI'],
      ['jarvis start',   '',             'Same as above'],
      ['jarvis stop',    '',             'Shut down the Neural server'],
      ['jarvis restart', '',             'Stop then start'],
      ['jarvis status',  '',             'Live status — server, Ollama, voice, last line'],
      ['jarvis open',    '',             'Open browser UI (starts server if needed)'],
    ]],
    ['VOICE', [
      ['jarvis speak',   '<text>',        'Speak a line immediately via Piper TTS'],
      ['jarvis voice',   'all|key|mute',  'Set tool hook narration level'],
    ]],
    ['CONFIGURATION', [
      ['jarvis config',      '',              'Show all config values'],
      ['jarvis config set',  '<key> <value>', 'Set a value (auto-coerces types)'],
      ['jarvis help',        '',              'Show this screen'],
    ]],
  ];

  for (const [title, cmds] of sections) {
    console.log('');
    console.log(sectionHead(title));
    console.log('');
    for (const [c3, a, desc] of cmds) {
      const cmdStr  = cmd2(c3) + (a ? ' ' + arg(a) : '');
      const vis     = c3 + (a ? ' ' + a : '');
      const spacing = ' '.repeat(Math.max(1, 36 - vis.length));
      console.log(`  ${arc('  ▸')} ${cmdStr}${spacing}${ghost(desc)}`);
    }
  }

  console.log('');
  console.log(`  ${arc('◈')}${arc('─────────────────────────────────────────')}${ghost(' Neural Core ')}${arc('──◈')}`);
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd  = args[0] || 'start';

  switch (cmd) {
    case 'start':    await cmdStart(); break;
    case 'stop':     await cmdStop(); break;
    case 'restart':  await cmdRestart(); break;
    case 'status':   await cmdStatus(); break;
    case 'open':     await cmdOpen(); break;
    case 'speak':    cmdSpeak(args.slice(1)); break;
    case 'config':   cmdConfig(args.slice(1)); break;
    case 'voice':    await cmdVoice(args.slice(1)); break;
    case 'help': case '--help': case '-h': cmdHelp(); break;
    default:
      console.log(c('yellow', `  Unknown command: ${cmd}`));
      cmdHelp();
      process.exit(1);
  }
}

main().catch(err => { die(err.message || String(err)); });

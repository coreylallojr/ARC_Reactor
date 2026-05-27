'use strict';
// ARC Reactor — JARVIS Electron main process
// Manages tray, server lifecycle, setup wizard, and Ollama

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');

// ── Paths ─────────────────────────────────────────────────────────────────────
const APP_DIR        = app.getAppPath();
const NEURAL_DIR     = path.join(APP_DIR, 'Neural');
const CONFIG_PATH    = path.join(NEURAL_DIR, 'config.json');
const SERVER_SCRIPT  = path.join(NEURAL_DIR, 'scripts', 'neural-ui-server.js');
const VOICE_SCRIPT   = path.join(NEURAL_DIR, 'scripts', 'jarvis-voice-server.js');
const DAEMON_SCRIPT  = path.join(NEURAL_DIR, 'scripts', 'neural-daemon.js');
const API_SCRIPT     = path.join(NEURAL_DIR, 'scripts', 'jarvis-api-server.js');
const SETUP_HTML     = path.join(APP_DIR, 'setup', 'setup.html');

// ── State ─────────────────────────────────────────────────────────────────────
let tray               = null;
let serverProcess      = null;
let voiceServerProcess = null;
let apiServerProcess   = null;
let setupWindow        = null;
let serverOnline       = false;

// ── Tray icon: arc reactor ring generated from raw RGBA ───────────────────────
function buildTrayIcon() {
  const S = 32;
  const buf = Buffer.alloc(S * S * 4, 0);
  const cx = S / 2, cy = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * S + x) * 4;
      if (d >= 13 && d <= 15) {
        // outer ring — cyan
        buf[i] = 0; buf[i+1] = 200; buf[i+2] = 255; buf[i+3] = 240;
      } else if (d >= 9 && d <= 11) {
        // inner ring
        buf[i] = 0; buf[i+1] = 160; buf[i+2] = 220; buf[i+3] = 200;
      } else if (d <= 5) {
        // core glow
        const fade = 1 - (d / 5);
        buf[i] = Math.floor(80 * fade);
        buf[i+1] = Math.floor(210 * fade);
        buf[i+2] = 255;
        buf[i+3] = Math.floor(230 * fade);
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: S, height: S });
}

// ── Config helpers ────────────────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function needsSetup() {
  const cfg = readConfig();
  if (!cfg.pythonPath || cfg.pythonPath.includes('{{')) return true;
  if (!fs.existsSync(cfg.pythonPath)) return true;
  const modelDir = path.join(os.homedir(), '.claude', 'jarvis-piper');
  if (!fs.existsSync(path.join(modelDir, 'jarvis-medium.onnx'))) return true;
  return false;
}

// ── Server management ─────────────────────────────────────────────────────────
function probe(url, timeout = 800) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (serverProcess) return;
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  serverProcess.on('exit', () => { serverProcess = null; serverOnline = false; updateTray(); });

  // Start voice server alongside neural server
  if (!voiceServerProcess) {
    voiceServerProcess = spawn(process.execPath, [VOICE_SCRIPT], {
      cwd: NEURAL_DIR,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    voiceServerProcess.on('exit', () => { voiceServerProcess = null; });
  }

  // Start REST + WebSocket API server (port 7476)
  if (!apiServerProcess) {
    apiServerProcess = spawn(process.execPath, [API_SCRIPT], {
      cwd: NEURAL_DIR,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    apiServerProcess.on('exit', () => { apiServerProcess = null; });
  }

  // Poll until up
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 400));
    if (await probe('http://127.0.0.1:7474/api/status')) {
      serverOnline = true;
      updateTray();
      if (Notification.isSupported()) {
        new Notification({ title: 'J.A.R.V.I.S', body: 'Neural core online, sir.' }).show();
      }
      return;
    }
  }
}

function stopServer() {
  if (voiceServerProcess) {
    try { voiceServerProcess.kill(); } catch {}
    voiceServerProcess = null;
  }
  if (apiServerProcess) {
    try { apiServerProcess.kill(); } catch {}
    apiServerProcess = null;
  }
  if (!serverProcess) return;
  try { serverProcess.kill(); } catch {}
  serverProcess = null;
  serverOnline = false;

  // Kill daemon if running
  try {
    const pidFile = path.join(readConfig().neural || os.homedir(), '.daemon.pid');
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    try { fs.unlinkSync(pidFile); } catch {}
  } catch {}
}

// ── Ollama helpers ────────────────────────────────────────────────────────────
function findOllamaExe() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    'ollama',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'ollama';
}

async function ensureOllama() {
  if (await probe('http://127.0.0.1:11434/api/tags')) return;
  spawn(findOllamaExe(), ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await probe('http://127.0.0.1:11434/api/tags')) return;
  }
}

// ── Setup window ──────────────────────────────────────────────────────────────
function openSetup() {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 680,
    height: 740,
    title: 'J.A.R.V.I.S — First Run Setup',
    backgroundColor: '#000810',
    resizable: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(SETUP_HTML);
  setupWindow.setMenuBarVisibility(false);
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ── Tray menu ─────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'J.A.R.V.I.S', enabled: false },
    { type: 'separator' },
    {
      label: serverOnline ? '● Open Neural UI' : '○ Start JARVIS',
      click: async () => {
        if (!serverOnline) {
          await ensureOllama();
          await startServer();
        }
        shell.openExternal('http://localhost:7474');
      },
    },
    {
      label: 'Speak Test',
      click: () => {
        const cfg = readConfig();
        if (cfg.pythonPath && cfg.jarvisSpeakPath) {
          spawn(cfg.pythonPath, [cfg.jarvisSpeakPath, 'All systems nominal, sir.'], {
            detached: true, stdio: 'ignore', windowsHide: true,
          }).unref();
        }
      },
    },
    { type: 'separator' },
    {
      label: serverOnline ? 'Server: Online ✓' : 'Server: Offline',
      enabled: false,
    },
    {
      label: 'Restart Server',
      click: async () => { stopServer(); await startServer(); },
    },
    { type: 'separator' },
    { label: 'Setup / Config', click: openSetup },
    { label: 'View on GitHub', click: () => shell.openExternal('https://github.com/coreylallojr/ARC_Reactor') },
    { type: 'separator' },
    { label: 'Quit JARVIS', click: () => { stopServer(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(serverOnline ? 'J.A.R.V.I.S — Online' : 'J.A.R.V.I.S — Offline');
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  app.setName('ARC Reactor');
  app.dock && app.dock.hide(); // macOS: no dock icon

  tray = new Tray(buildTrayIcon());
  tray.setToolTip('J.A.R.V.I.S — Starting...');
  updateTray();

  if (needsSetup()) {
    openSetup();
  } else {
    await ensureOllama();
    await startServer();
    if (serverOnline) shell.openExternal('http://localhost:7474');
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit when all windows close — we live in the tray
  e.preventDefault && e.preventDefault();
});

app.on('before-quit', () => { stopServer(); });

// ── IPC from setup window ─────────────────────────────────────────────────────
const { ipcMain } = require('electron');

ipcMain.handle('get-app-dir',   () => APP_DIR);
ipcMain.handle('get-neural-dir', () => NEURAL_DIR);
ipcMain.handle('get-config',    () => readConfig());
ipcMain.handle('get-home-dir',  () => os.homedir());
ipcMain.handle('get-platform',  () => process.platform);

ipcMain.handle('probe-python', async (_, pythonPath) => {
  return new Promise(resolve => {
    const p = spawn(pythonPath, ['--version'], { stdio: 'pipe', windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve(code === 0 ? out.trim() : null));
    p.on('error', () => resolve(null));
  });
});

ipcMain.handle('probe-ollama', async () => {
  return await probe('http://127.0.0.1:11434/api/tags');
});

ipcMain.handle('probe-piper-model', async () => {
  const modelPath = path.join(os.homedir(), '.claude', 'jarvis-piper', 'jarvis-medium.onnx');
  return fs.existsSync(modelPath);
});

ipcMain.handle('probe-claude-code', async () => {
  return new Promise(resolve => {
    const p = spawn('claude', ['--version'], { stdio: 'pipe', shell: true, windowsHide: true });
    p.on('close', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
});

ipcMain.handle('save-config', async (_, updates) => {
  try {
    const cfg = readConfig();
    const merged = { ...cfg, ...updates };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('write-hooks', async () => {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

    const loggerPath = path.join(NEURAL_DIR, 'scripts', 'neural-logger.js').replace(/\\/g, '/');
    const hooks = {
      PostToolUse: [{
        matcher: '.*',
        hooks: [{ type: 'command', command: `node "${loggerPath}"`, timeout: 30 }],
      }],
      Stop: [{
        matcher: '',
        hooks: [{ type: 'command', command: `node "${loggerPath}" --stop`, timeout: 30 }],
      }],
    };

    // Merge — don't blow away existing hooks
    settings.hooks = settings.hooks || {};
    settings.hooks.PostToolUse = hooks.PostToolUse;
    settings.hooks.Stop = hooks.Stop;

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('write-shell-alias', async () => {
  try {
    const cliPath = path.join(NEURAL_DIR, 'scripts', 'jarvis-cli.js').replace(/\\/g, '\\\\');
    const results = {};

    // PowerShell profile
    try {
      const psProfile = path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      fs.mkdirSync(path.dirname(psProfile), { recursive: true });
      let existing = '';
      try { existing = fs.readFileSync(psProfile, 'utf8'); } catch {}
      if (!existing.includes('jarvis-cli.js')) {
        fs.appendFileSync(psProfile, `\nfunction jarvis { node "${cliPath.replace(/\\\\/g, '\\')}" @args }\n`);
      }
      results.powershell = true;
    } catch (e) { results.powershell = false; results.powershellError = e.message; }

    // Bash / zsh profile
    try {
      const cliUnix = path.join(NEURAL_DIR, 'scripts', 'jarvis-cli.js');
      const bashLine = `\nalias jarvis='node "${cliUnix}"'\n`;
      for (const prof of ['.bashrc', '.zshrc', '.bash_profile']) {
        const p = path.join(os.homedir(), prof);
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8');
          if (!content.includes('jarvis-cli.js')) {
            fs.appendFileSync(p, bashLine);
          }
        }
      }
      results.bash = true;
    } catch (e) { results.bash = false; }

    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-file-dialog', async (_, opts) => {
  const result = await dialog.showOpenDialog(setupWindow, opts);
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('write-mcp-config', async (_, neuralDir) => {
  try {
    const mcpPath = path.join(os.homedir(), '.claude', 'mcp.json');
    let mcp = {};
    try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch {}
    const scriptPath = path.join(neuralDir || NEURAL_DIR, 'scripts', 'jarvis-mcp-server.js').replace(/\\/g, '/');
    mcp.mcpServers = mcp.mcpServers || {};
    mcp.mcpServers.jarvis = { command: 'node', args: [scriptPath] };
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-jarvis', async () => {
  if (setupWindow) { setupWindow.close(); setupWindow = null; }
  await ensureOllama();
  await startServer();
  if (serverOnline) shell.openExternal('http://localhost:7474');
  updateTray();
});

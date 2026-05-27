'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT_DIR   = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'Neural', 'config.json');
const BACKUP_PATH = path.join(os.tmpdir(), 'jarvis-test-config-backup.json');

module.exports = async function globalSetup() {
  // ── Backup current config ──────────────────────────────────────────────────
  let original = '{}';
  try { original = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch {}
  fs.writeFileSync(BACKUP_PATH, original);

  // ── Patch config with real paths for test run ──────────────────────────────
  let config = {};
  try { config = JSON.parse(original); } catch {}

  config.neural = path.join(ROOT_DIR, 'Neural').replace(/\\/g, '/');
  config.vault  = ROOT_DIR.replace(/\\/g, '/');

  // Ensure ollamaUrl/model present for code paths that check them
  config.ollamaUrl   = config.ollamaUrl   || 'http://localhost:11434/v1/chat/completions';
  config.ollamaModel = config.ollamaModel || 'llama3.2:1b';
  config.speakMinLevel = config.speakMinLevel || 1;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  // ── Ensure required directories exist ─────────────────────────────────────
  const dbDir = path.join(os.homedir(), '.claude', 'jarvis-db');
  fs.mkdirSync(dbDir, { recursive: true });

  const audioDir = path.join(os.homedir(), '.claude', 'jarvis-audio', 'cache');
  fs.mkdirSync(audioDir, { recursive: true });

  // ── Seed a fresh skills file so tests start in a known state ──────────────
  const skillsPath = path.join(dbDir, 'skills.json');
  const builtins = [
    {
      id: 'debug', name: 'debug', source: 'builtin',
      triggerPhrases: ['debug', 'trace this', "what's wrong"],
      description: 'Systematic debugging workflow', usageCount: 0,
    },
    {
      id: 'architect', name: 'architect', source: 'builtin',
      triggerPhrases: ['architect this', 'review architecture'],
      description: 'Architecture review workflow', usageCount: 0,
    },
    {
      id: 'review', name: 'review', source: 'builtin',
      triggerPhrases: ['review this', 'code review'],
      description: 'Code review workflow', usageCount: 0,
    },
  ];
  fs.writeFileSync(skillsPath, JSON.stringify(builtins, null, 2));

  // ── Reset graph to empty ───────────────────────────────────────────────────
  const graphPath = path.join(dbDir, 'graph.json');
  fs.writeFileSync(graphPath, JSON.stringify({ nodes: {}, edges: [], meta: { version: 1, nodeCount: 0, edgeCount: 0, lastPruned: null } }, null, 2));

  console.log('[setup] JARVIS test environment ready — neural:', config.neural);
};

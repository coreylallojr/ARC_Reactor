'use strict';
// Conversation persistence — JSON file-based, zero native deps, cross-platform.
// Stores turn history and session summaries in ~/.claude/jarvis-memory/

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const MEMORY_DIR        = path.join(os.homedir(), '.claude', 'jarvis-memory');
const CONVERSATIONS_PATH = path.join(MEMORY_DIR, 'conversations.json');
const SUMMARIES_PATH    = path.join(MEMORY_DIR, 'summaries.json');

function ensureDir() {
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {}
}

function loadConversations() {
  try { return JSON.parse(fs.readFileSync(CONVERSATIONS_PATH, 'utf8')); } catch { return []; }
}

function saveConversations(convs) {
  ensureDir();
  fs.writeFileSync(CONVERSATIONS_PATH, JSON.stringify(convs.slice(-500), null, 2));
}

function loadSummaries() {
  try { return JSON.parse(fs.readFileSync(SUMMARIES_PATH, 'utf8')); } catch { return []; }
}

function saveSummaries(summaries) {
  ensureDir();
  fs.writeFileSync(SUMMARIES_PATH, JSON.stringify(summaries.slice(-50), null, 2));
}

function saveTurn(sessionId, role, content, projectPath) {
  try {
    const convs = loadConversations();
    convs.push({
      id: (typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : Date.now().toString(36),
      sessionId,
      role,       // 'user' | 'jarvis' | 'system'
      content,
      timestamp: Date.now(),
      projectPath: projectPath || '',
    });
    saveConversations(convs);
  } catch {}
}

function loadRecentContext(projectPath, currentSessionId) {
  try {
    const convs = loadConversations();
    const recentTurns = convs
      .filter(c => c.projectPath === projectPath)
      .slice(-5)
      .map(c => ({ role: c.role, content: c.content }));

    const summaries = loadSummaries();
    const prevSummary = summaries
      .filter(s => s.projectPath === projectPath && s.sessionId !== currentSessionId)
      .slice(-1)[0];

    return {
      recentTurns,
      previousSession: prevSummary ? prevSummary.summary : null,
    };
  } catch {
    return { recentTurns: [], previousSession: null };
  }
}

function saveSessionSummary(sessionId, projectPath, summary) {
  try {
    const summaries = loadSummaries();
    // Update if exists, else append
    const idx = summaries.findIndex(s => s.sessionId === sessionId);
    const entry = { sessionId, projectPath: projectPath || '', summary, createdAt: Date.now() };
    if (idx >= 0) summaries[idx] = entry; else summaries.push(entry);
    saveSummaries(summaries);
  } catch {}
}

function getConversationHistory(projectPath, limit) {
  limit = limit || 20;
  try {
    const convs = loadConversations();
    return convs.filter(c => c.projectPath === projectPath).slice(-limit);
  } catch { return []; }
}

module.exports = { saveTurn, loadRecentContext, saveSessionSummary, getConversationHistory };

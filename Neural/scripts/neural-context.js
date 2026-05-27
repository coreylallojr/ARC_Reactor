'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function buildContext(sessionState, projectPath) {
  const ctx = {};

  // Git stats (fast, synchronous)
  try {
    const diff = execSync('git diff --stat HEAD', { cwd: projectPath || process.cwd(), timeout: 2000, encoding: 'utf8' });
    const changedMatch = diff.match(/(\d+) files? changed/);
    const insertMatch  = diff.match(/(\d+) insertions?\(\+\)/);
    const deleteMatch  = diff.match(/(\d+) deletions?\(-\)/);
    ctx.gitChanged    = changedMatch ? parseInt(changedMatch[1]) : 0;
    ctx.gitInsertions = insertMatch  ? parseInt(insertMatch[1])  : 0;
    ctx.gitDeletions  = deleteMatch  ? parseInt(deleteMatch[1])  : 0;
  } catch {}

  // Branch name
  try {
    ctx.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath || process.cwd(), timeout: 1000, encoding: 'utf8' }).trim();
  } catch { ctx.gitBranch = null; }

  // Session narrative
  const state = sessionState || {};
  ctx.errorStreak   = state.consecutiveErrors || 0;
  ctx.sessionOps    = state.callCount || 0;
  ctx.durationMin   = Math.floor((Date.now() - (state.startTime || Date.now())) / 60000);

  // Top file being edited
  const fileCounts = state.fileEditCounts || {};
  const topFile = Object.entries(fileCounts).sort((a, b) => b[1] - a[1])[0];
  ctx.focusFile     = topFile ? topFile[0] : null;
  ctx.focusFileOps  = topFile ? topFile[1] : 0;

  // Project type inference
  try {
    const files = fs.readdirSync(projectPath || process.cwd());
    if (files.some(f => f === 'package.json')) ctx.projectType = 'node';
    else if (files.some(f => f === 'requirements.txt' || f === 'setup.py')) ctx.projectType = 'python';
    else if (files.some(f => f === 'go.mod')) ctx.projectType = 'go';
    else if (files.some(f => f === 'Cargo.toml')) ctx.projectType = 'rust';
    else ctx.projectType = 'code';
  } catch { ctx.projectType = 'code'; }

  return ctx;
}

// Format for injection into Ollama prompt — compact, ~100 tokens max
function formatContext(ctx) {
  const parts = [];
  if (ctx.gitBranch && ctx.gitBranch !== 'HEAD') parts.push(`Branch: ${ctx.gitBranch}`);
  if (ctx.gitChanged > 0) parts.push(`${ctx.gitChanged} files changed (+${ctx.gitInsertions}/-${ctx.gitDeletions})`);
  if (ctx.focusFile) parts.push(`Focus: ${ctx.focusFile} (${ctx.focusFileOps}x edits)`);
  if (ctx.errorStreak >= 2) parts.push(`${ctx.errorStreak} consecutive errors`);
  if (ctx.durationMin > 0) parts.push(`${ctx.durationMin}min session`);
  if (ctx.sessionOps > 0) parts.push(`${ctx.sessionOps} ops`);
  return parts.join('. ');
}

module.exports = { buildContext, formatContext };

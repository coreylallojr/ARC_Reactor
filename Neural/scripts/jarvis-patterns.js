'use strict';
// Neural/scripts/jarvis-patterns.js
// Pattern miner — observes tool sequences, crosses thresholds, proposes new skills.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROPOSAL_THRESHOLD   = 3;  // distinct sessions with this pattern
const PROPOSAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_SEQUENCE_LENGTH  = 2;
const MAX_SEQUENCE_LENGTH  = 5;

// ── Storage path ──────────────────────────────────────────────────────────────

const PATTERNS_DIR  = path.join(os.homedir(), '.claude', 'jarvis-db');
const PATTERNS_PATH = path.join(PATTERNS_DIR, 'patterns.json');

// ── In-memory session sequences ───────────────────────────────────────────────
// Map<sessionId, string[]>  — persists only for the lifetime of the process.

const sessionSequences = new Map();

// ── Disk helpers ──────────────────────────────────────────────────────────────

function ensureDir() {
  try { fs.mkdirSync(PATTERNS_DIR, { recursive: true }); } catch {}
}

function loadPatterns() {
  try {
    return JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf8'));
  } catch {
    return { sequences: {} };
  }
}

function savePatterns(data) {
  ensureDir();
  try { fs.writeFileSync(PATTERNS_PATH, JSON.stringify(data, null, 2)); } catch {}
}

// ── Fingerprint helpers ───────────────────────────────────────────────────────

/**
 * Deduplicate consecutive identical tool names in an array.
 * e.g. ['Grep', 'Grep', 'Read'] => ['Grep', 'Read']
 */
function dedupeConsecutive(arr) {
  const out = [];
  for (const item of arr) {
    if (out.length === 0 || out[out.length - 1] !== item) out.push(item);
  }
  return out;
}

/**
 * Generate all contiguous subsequences of length MIN_SEQUENCE_LENGTH..MAX_SEQUENCE_LENGTH
 * from a deduplicated window.
 */
function generateSubsequences(window) {
  const deduped = dedupeConsecutive(window);
  const subs = [];
  for (let len = MIN_SEQUENCE_LENGTH; len <= Math.min(MAX_SEQUENCE_LENGTH, deduped.length); len++) {
    for (let start = 0; start <= deduped.length - len; start++) {
      subs.push(deduped.slice(start, start + len));
    }
  }
  return subs;
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Record a tool call for the current session.
 * Called by neural-daemon.js on every handlePostToolUse.
 */
function recordToolCall(toolName, sessionId) {
  if (!toolName || !sessionId) return;

  // Append to session sequence
  if (!sessionSequences.has(sessionId)) sessionSequences.set(sessionId, []);
  const seq = sessionSequences.get(sessionId);
  seq.push(toolName);

  // Keep only the last MAX_SEQUENCE_LENGTH * 2 calls (sliding window)
  const windowSize = MAX_SEQUENCE_LENGTH * 2;
  if (seq.length > windowSize) seq.splice(0, seq.length - windowSize);

  // Generate all sub-sequences from the current window
  const window = seq.slice(-MAX_SEQUENCE_LENGTH);
  const subsequences = generateSubsequences(window);
  if (subsequences.length === 0) return;

  const data = loadPatterns();

  for (const subseq of subsequences) {
    const fingerprint = subseq.join('::');
    if (!data.sequences[fingerprint]) {
      data.sequences[fingerprint] = {
        fingerprint,
        sequence: subseq,
        count: 0,
        sessions: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        proposedAt: null,
        dismissedAt: null,
        skillId: null,
      };
    }
    const entry = data.sequences[fingerprint];
    entry.lastSeen = Date.now();
    // Count each session only once per fingerprint
    if (!entry.sessions.includes(sessionId)) {
      entry.sessions.push(sessionId);
      entry.count = entry.sessions.length;
    }
  }

  savePatterns(data);
}

/**
 * Check if any pattern has crossed the threshold and is eligible for proposal.
 * Returns: { fingerprint, sequence, count, sessions } or null.
 */
function checkForProposal(sessionId) {
  const data = loadPatterns();
  const now  = Date.now();

  const eligible = Object.values(data.sequences).filter(entry => {
    if (entry.count < PROPOSAL_THRESHOLD) return false;
    if (entry.skillId) return false; // already converted
    if (entry.dismissedAt && (now - entry.dismissedAt) < PROPOSAL_COOLDOWN_MS) return false;
    if (entry.proposedAt  && (now - entry.proposedAt)  < PROPOSAL_COOLDOWN_MS) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  // Return highest-count eligible pattern
  eligible.sort((a, b) => b.count - a.count);
  const best = eligible[0];
  return {
    fingerprint: best.fingerprint,
    sequence:    best.sequence,
    count:       best.count,
    sessions:    best.sessions,
  };
}

/**
 * Mark a proposal as shown (starts cooldown).
 */
function markProposed(fingerprint) {
  const data = loadPatterns();
  if (data.sequences[fingerprint]) {
    data.sequences[fingerprint].proposedAt = Date.now();
    savePatterns(data);
  }
}

/**
 * Mark a proposal as dismissed by the user (starts cooldown).
 */
function markDismissed(fingerprint) {
  const data = loadPatterns();
  if (data.sequences[fingerprint]) {
    data.sequences[fingerprint].dismissedAt = Date.now();
    savePatterns(data);
  }
}

/**
 * Mark a proposal as converted to a skill.
 */
function markConverted(fingerprint, skillId) {
  const data = loadPatterns();
  if (data.sequences[fingerprint]) {
    data.sequences[fingerprint].skillId = skillId;
    savePatterns(data);
  }
}

/**
 * Return the current session's accumulated tool sequence.
 */
function getCurrentSequence(sessionId) {
  return sessionSequences.get(sessionId) ? sessionSequences.get(sessionId).slice() : [];
}

/**
 * Reset a session's in-memory sequence (call on session end).
 */
function resetSession(sessionId) {
  sessionSequences.delete(sessionId);
}

/**
 * Return all patterns with their status.
 */
function getPatterns() {
  return loadPatterns();
}

module.exports = {
  recordToolCall,
  checkForProposal,
  markProposed,
  markDismissed,
  markConverted,
  getCurrentSequence,
  resetSession,
  getPatterns,
};

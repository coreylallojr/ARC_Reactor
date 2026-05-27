'use strict';
// Neural/scripts/jarvis-skills.js
// Skill registry — CRUD, activation detection, execution.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

let graph;
try { graph = require('./jarvis-graph'); } catch {}

// ── Storage path ──────────────────────────────────────────────────────────────

const SKILLS_DIR  = path.join(os.homedir(), '.claude', 'jarvis-db');
const SKILLS_PATH = path.join(SKILLS_DIR, 'skills.json');

// ── Built-in skills ───────────────────────────────────────────────────────────

const BUILTIN_SKILLS = [
  {
    id: 'debug',
    name: 'Debug',
    source: 'builtin',
    triggerPhrases: ['debug', 'trace this', "what's wrong", 'fix the error', 'investigate'],
    toolSequence: ['Grep', 'Read', 'Edit'],
    systemPromptOverride: null,
    contextRequirements: ['focusFile', 'recentErrors'],
    description: 'Systematic debugging: search for the error, read relevant files, apply a fix.',
    usageCount: 0,
    lastUsed: null,
    createdAt: new Date().toISOString(),
    learnedFrom: [],
  },
  {
    id: 'architect',
    name: 'Architect',
    source: 'builtin',
    triggerPhrases: ['architect', 'design this', 'plan the structure', 'how should we build', 'layout'],
    toolSequence: ['Glob', 'Read', 'Write'],
    systemPromptOverride: null,
    contextRequirements: ['projectPath'],
    description: 'High-level design pass: scan the codebase, read key files, write a design document or skeleton.',
    usageCount: 0,
    lastUsed: null,
    createdAt: new Date().toISOString(),
    learnedFrom: [],
  },
  {
    id: 'review',
    name: 'Review',
    source: 'builtin',
    triggerPhrases: ['review', 'check this', 'look over', 'audit', 'code review'],
    toolSequence: ['Read', 'Grep', 'Bash'],
    systemPromptOverride: null,
    contextRequirements: ['focusFile'],
    description: 'Code review pass: read the file, search for patterns, run checks.',
    usageCount: 0,
    lastUsed: null,
    createdAt: new Date().toISOString(),
    learnedFrom: [],
  },
];

// ── Disk helpers ──────────────────────────────────────────────────────────────

function ensureDir() {
  try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}
}

function loadSkills() {
  try {
    return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8'));
  } catch {
    // File doesn't exist — seed with built-ins
    ensureDir();
    try { fs.writeFileSync(SKILLS_PATH, JSON.stringify(BUILTIN_SKILLS, null, 2)); } catch {}
    return BUILTIN_SKILLS.map(s => ({ ...s }));
  }
}

function saveSkills(skills) {
  ensureDir();
  try { fs.writeFileSync(SKILLS_PATH, JSON.stringify(skills, null, 2)); } catch {}
}

// ── Skill lookup ──────────────────────────────────────────────────────────────

/**
 * Find a skill by exact id, or by fuzzy trigger phrase match.
 * Returns skill object or null.
 */
function findSkill(query) {
  if (!query) return null;
  const skills = loadSkills();
  const q = query.toLowerCase().trim();

  // Exact id match first
  const byId = skills.find(s => s.id === q);
  if (byId) return byId;

  // Trigger phrase substring match (longest phrase wins)
  const withMatch = skills
    .map(skill => {
      const match = (skill.triggerPhrases || [])
        .filter(tp => q.includes(tp.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];
      return match ? { skill, matchLen: match.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.matchLen - a.matchLen);

  return withMatch.length > 0 ? withMatch[0].skill : null;
}

// ── Sequence detection ────────────────────────────────────────────────────────

/**
 * Check if the current tool sequence tail matches any skill's toolSequence.
 * sequence: array of recent tool names (most recent last).
 * Returns: matching skill or null.
 */
function detectSkillFromSequence(sequence) {
  if (!sequence || sequence.length === 0) return null;
  const skills = loadSkills().filter(s => s.toolSequence && s.toolSequence.length >= 2);
  for (const skill of skills) {
    const seq = skill.toolSequence;
    if (sequence.length >= seq.length) {
      const tail = sequence.slice(-seq.length);
      if (seq.every((tool, i) => tool === tail[i])) return skill;
    }
  }
  return null;
}

// ── Transcript detection ──────────────────────────────────────────────────────

/**
 * Check if a voice transcript contains a trigger phrase.
 * Returns: matching skill or null.
 */
function detectSkillFromTranscript(transcript) {
  if (!transcript) return null;
  const skills = loadSkills();
  const lower = transcript.toLowerCase();

  // Collect all (skill, phrase) pairs, sort by phrase length desc for specificity
  const candidates = [];
  for (const skill of skills) {
    for (const phrase of (skill.triggerPhrases || [])) {
      if (lower.includes(phrase.toLowerCase())) {
        candidates.push({ skill, phraseLen: phrase.length });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.phraseLen - a.phraseLen);
  return candidates[0].skill;
}

// ── Activation recording ──────────────────────────────────────────────────────

/**
 * Increment usageCount and update lastUsed for a skill.
 */
function recordActivation(skillId) {
  const skills = loadSkills();
  const idx = skills.findIndex(s => s.id === skillId);
  if (idx < 0) return;
  skills[idx].usageCount = (skills[idx].usageCount || 0) + 1;
  skills[idx].lastUsed = new Date().toISOString();
  saveSkills(skills);
}

// ── Skill creation ────────────────────────────────────────────────────────────

/**
 * Create a new skill. opts may include: triggerPhrases, toolSequence,
 * systemPromptOverride, contextRequirements, description, learnedFrom.
 * Returns the created skill object.
 */
function createSkill(name, source, opts) {
  opts = opts || {};
  const skills = loadSkills();

  // Build base id from name
  let baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let id = baseId;
  let suffix = 2;
  while (skills.find(s => s.id === id)) {
    id = `${baseId}-${suffix}`;
    suffix++;
  }

  const newSkill = {
    id,
    name,
    source: source || 'explicit',
    triggerPhrases: opts.triggerPhrases || [],
    toolSequence:   opts.toolSequence   || [],
    systemPromptOverride: opts.systemPromptOverride || null,
    contextRequirements:  opts.contextRequirements  || [],
    description: opts.description || '',
    usageCount:  0,
    lastUsed:    null,
    createdAt:   new Date().toISOString(),
    learnedFrom: opts.learnedFrom || [],
  };

  skills.push(newSkill);
  saveSkills(skills);

  // Register in knowledge graph
  if (graph) {
    try {
      graph.addNode(id, 'skill', {
        name,
        triggerPhrases: newSkill.triggerPhrases,
        usageCount: 0,
      });
    } catch {}
  }

  return newSkill;
}

// ── Sorted lists ──────────────────────────────────────────────────────────────

/**
 * Return top N skills sorted by usageCount descending.
 */
function getTopSkills(n) {
  n = n !== undefined ? n : 10;
  return loadSkills()
    .slice()
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
    .slice(0, n);
}

/**
 * Return all skills with stats (alias for loadSkills with a full array).
 */
function listSkills() {
  return loadSkills();
}

// ── Module init: ensure built-ins exist ───────────────────────────────────────
// loadSkills() already seeds the file on first call if missing.
// Calling it here ensures the file is created at module load time.
(function init() {
  try { loadSkills(); } catch {}
}());

module.exports = {
  loadSkills,
  saveSkills,
  findSkill,
  detectSkillFromSequence,
  detectSkillFromTranscript,
  recordActivation,
  createSkill,
  getTopSkills,
  listSkills,
};

'use strict';
// Neural/scripts/jarvis-rag.js
// RAG pipeline — query → retrieve → re-rank → inject into prompts.
// Depends on jarvis-vector.js and jarvis-graph.js (lazy-required, optional).

const path = require('path');
const os   = require('os');

let vector, graph;
try { vector = require('./jarvis-vector'); } catch {}
try { graph  = require('./jarvis-graph');  } catch {}

const MAX_CONTEXT_TOKENS   = 200;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_CHARS    = MAX_CONTEXT_TOKENS * APPROX_CHARS_PER_TOKEN;

// ── Graph context helper ──────────────────────────────────────────────────────

async function getGraphContext(focusFile) {
  if (!graph || !focusFile) return '';
  try {
    const neighbors = graph.getNeighbors(path.basename(focusFile), { maxDepth: 2 });
    if (!neighbors || neighbors.length === 0) return '';
    const relevant = neighbors
      .filter(n => n.node.type === 'error' || n.node.type === 'skill')
      .slice(0, 3)
      .map(n => `${n.node.type}: ${n.node.id} (${n.edge.type})`);
    return relevant.length > 0 ? `Related: ${relevant.join(', ')}` : '';
  } catch { return ''; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build RAG context string for injection into an Ollama prompt.
 * queryText: what we're asking about (tool name + file + error text)
 * sessionState: from .session-state.json
 * Returns: string, max ~200 tokens, or '' if nothing relevant
 */
async function buildContext(queryText, sessionState) {
  if (!vector) return '';
  try {
    const results = await vector.search(queryText, 8);
    if (!results || results.length === 0) return '';

    // Filter out very low scores
    const relevant = results.filter(r => r.score > 0.05);
    if (relevant.length === 0) return '';

    // Derive focus file from session state (most-edited file)
    const focusFile = sessionState && sessionState.fileEditCounts
      ? (Object.entries(sessionState.fileEditCounts)
          .sort((a, b) => b[1] - a[1])[0] || [])[0] || ''
      : '';

    // Build context string within token budget
    const parts = [];
    let totalChars = 0;

    for (const r of relevant.slice(0, 5)) {
      const snippet = r.content.trim().substring(0, 300);
      const line = `[${r.chunkType} · ${path.basename(r.sourcePath)}]: ${snippet}`;
      if (totalChars + line.length > MAX_CONTEXT_CHARS) break;
      parts.push(line);
      totalChars += line.length + 1;
    }

    if (parts.length === 0) return '';

    // Graph augmentation — append related nodes if budget allows
    const graphCtx = await getGraphContext(focusFile);
    let base = `Relevant context:\n${parts.join('\n')}`;
    if (graphCtx && totalChars + graphCtx.length + 1 <= MAX_CONTEXT_CHARS) {
      base += `\n${graphCtx}`;
    }

    return base;
  } catch { return ''; }
}

/**
 * Retrieve raw vector results (for MCP jarvis_recall tool).
 */
async function search(query, topK) {
  topK = topK !== undefined ? topK : 5;
  if (!vector) return [];
  try {
    return await vector.search(query, topK) || [];
  } catch { return []; }
}

/**
 * Index a new piece of knowledge explicitly.
 */
async function remember(content, type, sourcePath) {
  type       = type       || 'note';
  sourcePath = sourcePath || 'manual';
  if (!vector) return;
  try {
    vector.addChunk(sourcePath, type, content);
  } catch {}
}

module.exports = { buildContext, search, remember };

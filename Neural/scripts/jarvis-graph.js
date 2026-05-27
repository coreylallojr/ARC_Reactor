'use strict';
// JARVIS Knowledge Graph — JSON-backed, in-memory, persisted to ~/.claude/jarvis-db/graph.json
// Uses only Node.js built-ins: fs, path, os, crypto

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const DB_DIR    = path.join(os.homedir(), '.claude', 'jarvis-db');
const GRAPH_PATH = path.join(DB_DIR, 'graph.json');
const ERROR_LOG  = path.join(DB_DIR, 'errors.log');

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------
function logError(msg, err) {
  try {
    const line = `[${new Date().toISOString()}] [graph] ${msg}${err ? ': ' + (err.stack || err.message || err) : ''}\n`;
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NODE_TYPES = new Set(['file', 'function', 'error', 'skill', 'concept', 'session']);
const EDGE_TYPES = new Set(['imports', 'edits', 'causes', 'fixes', 'uses_skill', 'references', 'related']);
const PERMANENT_TYPES = new Set(['skill', 'session']); // never pruned
const MAX_NODES = 2000;

// ---------------------------------------------------------------------------
// In-memory graph state
// ---------------------------------------------------------------------------
let graph = {
  nodes: {},
  edges: [],
  meta:  { version: 1, nodeCount: 0, edgeCount: 0, lastPruned: null },
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function load() {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    if (!fs.existsSync(GRAPH_PATH)) {
      graph = emptyGraph();
      return;
    }
    const raw = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
    // Validate and merge defensively
    graph = {
      nodes: raw.nodes  || {},
      edges: Array.isArray(raw.edges) ? raw.edges : [],
      meta:  { version: 1, nodeCount: 0, edgeCount: 0, lastPruned: raw.meta?.lastPruned || null },
    };
    recalcMeta();
  } catch (err) {
    logError('load failed', err);
    graph = emptyGraph();
  }
}

function emptyGraph() {
  return {
    nodes: {},
    edges: [],
    meta:  { version: 1, nodeCount: 0, edgeCount: 0, lastPruned: null },
  };
}

function recalcMeta() {
  graph.meta.nodeCount = Object.keys(graph.nodes).length;
  graph.meta.edgeCount = graph.edges.length;
}

function save() {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    recalcMeta();
    fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf8');
  } catch (err) {
    logError('save failed', err);
  }
}

// Load on require
load();

// ---------------------------------------------------------------------------
// Node operations
// ---------------------------------------------------------------------------
function addNode(id, type, data) {
  try {
    const now = Date.now();
    if (graph.nodes[id]) {
      // Upsert: update data + updatedAt, keep createdAt, recompute edgeCount
      graph.nodes[id].data      = data;
      graph.nodes[id].updatedAt = now;
      // type can be updated too if passed again
      if (type) graph.nodes[id].type = type;
    } else {
      graph.nodes[id] = {
        id,
        type:      type || 'concept',
        data:      data || {},
        createdAt: now,
        updatedAt: now,
        edgeCount: 0,
      };
      // Enforce max 2000 nodes
      if (Object.keys(graph.nodes).length > MAX_NODES) {
        _pruneToLimit();
      }
    }
    save();
  } catch (err) {
    logError('addNode failed', err);
  }
}

function removeNode(id) {
  try {
    if (!graph.nodes[id]) return;
    delete graph.nodes[id];
    // Remove all edges involving this node
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
    _syncEdgeCounts();
    save();
  } catch (err) {
    logError('removeNode failed', err);
  }
}

function getNode(id) {
  return graph.nodes[id] || null;
}

// ---------------------------------------------------------------------------
// Edge operations
// ---------------------------------------------------------------------------
function edgeId(fromId, toId, type) {
  return `${fromId}::${type}::${toId}`;
}

function addEdge(fromId, toId, type, weight = 1) {
  try {
    const now = Date.now();
    const eid = edgeId(fromId, toId, type);
    const existing = graph.edges.findIndex(e => e.id === eid);
    if (existing >= 0) {
      // Idempotent: update weight
      graph.edges[existing].weight = weight;
    } else {
      graph.edges.push({ id: eid, from: fromId, to: toId, type, weight, createdAt: now });
      // Increment edgeCount for both nodes if they exist
      if (graph.nodes[fromId]) graph.nodes[fromId].edgeCount = (graph.nodes[fromId].edgeCount || 0) + 1;
      if (graph.nodes[toId])   graph.nodes[toId].edgeCount   = (graph.nodes[toId].edgeCount   || 0) + 1;
    }
    save();
  } catch (err) {
    logError('addEdge failed', err);
  }
}

function removeEdge(fromId, toId, type) {
  try {
    const eid = edgeId(fromId, toId, type);
    const before = graph.edges.length;
    graph.edges = graph.edges.filter(e => e.id !== eid);
    if (graph.edges.length < before) {
      _syncEdgeCounts();
      save();
    }
  } catch (err) {
    logError('removeEdge failed', err);
  }
}

// Recalculate edgeCount for all nodes from scratch
function _syncEdgeCounts() {
  for (const node of Object.values(graph.nodes)) node.edgeCount = 0;
  for (const edge of graph.edges) {
    if (graph.nodes[edge.from]) graph.nodes[edge.from].edgeCount++;
    if (graph.nodes[edge.to])   graph.nodes[edge.to].edgeCount++;
  }
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------
function getNeighbors(nodeId, { edgeTypes, direction = 'both', maxDepth = 1 } = {}) {
  try {
    const results = [];
    const visited = new Set([nodeId]);
    const queue   = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id: current, depth } = queue.shift();
      if (depth >= maxDepth) continue;

      for (const edge of graph.edges) {
        if (edgeTypes && !edgeTypes.includes(edge.type)) continue;

        let neighborId = null;
        if (direction === 'out'  && edge.from === current) neighborId = edge.to;
        if (direction === 'in'   && edge.to   === current) neighborId = edge.from;
        if (direction === 'both') {
          if (edge.from === current) neighborId = edge.to;
          else if (edge.to === current) neighborId = edge.from;
        }

        if (neighborId && !visited.has(neighborId) && graph.nodes[neighborId]) {
          visited.add(neighborId);
          results.push({ node: graph.nodes[neighborId], edge, depth: depth + 1 });
          queue.push({ id: neighborId, depth: depth + 1 });
        }
      }
    }
    return results;
  } catch (err) {
    logError('getNeighbors failed', err);
    return [];
  }
}

function findPath(fromId, toId) {
  try {
    if (fromId === toId) return [fromId];
    const visited = new Set([fromId]);
    const queue   = [[fromId]];
    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      // Find all connected node IDs (undirected)
      for (const edge of graph.edges) {
        let next = null;
        if (edge.from === current) next = edge.to;
        else if (edge.to === current) next = edge.from;
        if (next && !visited.has(next)) {
          const newPath = [...path, next];
          if (next === toId) return newPath;
          visited.add(next);
          queue.push(newPath);
        }
      }
    }
    return null; // no path found
  } catch (err) {
    logError('findPath failed', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
function getHotNodes(topN = 10) {
  try {
    return Object.values(graph.nodes)
      .sort((a, b) => (b.edgeCount || 0) - (a.edgeCount || 0))
      .slice(0, topN);
  } catch (err) {
    logError('getHotNodes failed', err);
    return [];
  }
}

function getStats() {
  try {
    const nodesByType = {};
    for (const node of Object.values(graph.nodes)) {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    }
    return {
      nodeCount:   Object.keys(graph.nodes).length,
      edgeCount:   graph.edges.length,
      nodesByType,
    };
  } catch (err) {
    logError('getStats failed', err);
    return { nodeCount: 0, edgeCount: 0, nodesByType: {} };
  }
}

// ---------------------------------------------------------------------------
// D3 format
// ---------------------------------------------------------------------------
function toD3Format() {
  try {
    return {
      nodes: Object.values(graph.nodes).map(n => ({
        id:          n.id,
        type:        n.type,
        label:       (n.data && n.data.label) || n.id,
        description: (n.data && n.data.description) || '',
        ...n.data,
      })),
      links: graph.edges.map(e => ({ source: e.from, target: e.to, type: e.type, weight: e.weight })),
    };
  } catch (err) {
    logError('toD3Format failed', err);
    return { nodes: [], links: [] };
  }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------
function pruneStale(olderThanDays = 30) {
  try {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (PERMANENT_TYPES.has(node.type)) continue;
      if (node.updatedAt < cutoff) {
        delete graph.nodes[id];
        pruned++;
      }
    }
    if (pruned > 0) {
      // Remove dangling edges
      graph.edges = graph.edges.filter(e => graph.nodes[e.from] && graph.nodes[e.to]);
      _syncEdgeCounts();
      graph.meta.lastPruned = Date.now();
      save();
    }
    return pruned;
  } catch (err) {
    logError('pruneStale failed', err);
    return 0;
  }
}

// Enforce max 2000 nodes: prune oldest non-skill/session nodes first
function _pruneToLimit() {
  try {
    const mutable = Object.values(graph.nodes)
      .filter(n => !PERMANENT_TYPES.has(n.type))
      .sort((a, b) => a.updatedAt - b.updatedAt); // oldest first

    while (Object.keys(graph.nodes).length > MAX_NODES && mutable.length > 0) {
      const victim = mutable.shift();
      delete graph.nodes[victim.id];
    }
    graph.edges = graph.edges.filter(e => graph.nodes[e.from] && graph.nodes[e.to]);
    _syncEdgeCounts();
    graph.meta.lastPruned = Date.now();
  } catch (err) {
    logError('_pruneToLimit failed', err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  addNode,
  removeNode,
  addEdge,
  removeEdge,
  getNode,
  getNeighbors,
  getHotNodes,
  findPath,
  toD3Format,
  pruneStale,
  getStats,
  save,
  load,
};

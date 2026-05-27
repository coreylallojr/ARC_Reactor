'use strict';
// JARVIS Fusion Retrieval (JFR) — dual-index: TF-IDF + vector embeddings, fused via RRF.
// DB: better-sqlite3 at ~/.claude/jarvis-db/jarvis.db
// Embeddings: Ollama nomic-embed-text (non-blocking queue)

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const http   = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------
const DB_DIR    = path.join(os.homedir(), '.claude', 'jarvis-db');
const DB_PATH   = path.join(DB_DIR, 'jarvis.db');
const ERROR_LOG = path.join(DB_DIR, 'errors.log');

const CONFIG_PATH = path.join('C:', 'tmp', 'ARC_Reactor', 'Neural', 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getOllamaBase() {
  const cfg = readConfig();
  // config.json stores ollamaUrl as the completions endpoint — extract base
  if (cfg.ollamaUrl) {
    try {
      const u = new URL(cfg.ollamaUrl);
      return `${u.protocol}//${u.host}`;
    } catch {}
  }
  return 'http://localhost:11434';
}

function logError(msg, err) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}${err ? ': ' + (err.stack || err.message || err) : ''}\n`;
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
}

// ---------------------------------------------------------------------------
// DB (lazy init)
// ---------------------------------------------------------------------------
let _db = null;

function getDB() {
  if (_db) return _db;
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const Database = require('better-sqlite3');
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        chunk_type  TEXT NOT NULL,
        content     TEXT NOT NULL,
        tfidf_terms TEXT,
        embedding   BLOB,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_type   ON chunks(chunk_type);
    `);
  } catch (err) {
    logError('getDB failed', err);
    _db = null;
  }
  return _db;
}

function close() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Chunk ID hash
// ---------------------------------------------------------------------------
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h + str.charCodeAt(i)) % 99999999;
  return String(h).padStart(8, '0');
}

function makeChunkId(sourcePath, chunkType, content) {
  return `${sourcePath}::${chunkType}::${simpleHash(content)}`;
}

// ---------------------------------------------------------------------------
// Stopwords & TF-IDF
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'a','an','the','is','it','in','of','to','and','or','for','with',
  'that','this','be','was','are','as','at','by','from','on','not',
  'but','if','its','do','we','he','she','they','i','my','you','your',
  'have','has','had','been','will','would','could','should','can',
  'their','which','when','what','how','there','then','than','so',
  'into','up','out','about','all','more','also','no','s','t',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function computeTfIdf(content) {
  const tokens = tokenize(content);
  if (tokens.length === 0) return {};
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const tf = {};
  for (const [t, cnt] of Object.entries(freq)) tf[t] = cnt / tokens.length;
  // IDF will be applied at query time (lazy); store TF scores for now,
  // fused at query time with IDF computed from live index.
  return tf;
}

// IDF cache: term -> idf score
let _idfCache = null;
let _idfCacheSize = 0;

function getIdfCache(db) {
  try {
    const total = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    if (_idfCache && _idfCacheSize === total) return _idfCache;
    // Rebuild from stored tfidf_terms
    const rows = db.prepare('SELECT tfidf_terms FROM chunks WHERE tfidf_terms IS NOT NULL').all();
    const docFreq = {};
    for (const row of rows) {
      try {
        const terms = JSON.parse(row.tfidf_terms);
        for (const t of Object.keys(terms)) docFreq[t] = (docFreq[t] || 0) + 1;
      } catch {}
    }
    const cache = {};
    for (const [t, df] of Object.entries(docFreq)) {
      cache[t] = Math.log(total / (df + 1));
    }
    _idfCache = cache;
    _idfCacheSize = total;
    return cache;
  } catch (err) {
    logError('getIdfCache failed', err);
    return {};
  }
}

function invalidateIdfCache() {
  _idfCache = null;
  _idfCacheSize = 0;
}

// ---------------------------------------------------------------------------
// TF-IDF search — returns top-20 with score
// ---------------------------------------------------------------------------
function tfidfSearch(db, query) {
  try {
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    const idf = getIdfCache(db);
    const rows = db.prepare('SELECT id, source_path, chunk_type, content, tfidf_terms FROM chunks WHERE tfidf_terms IS NOT NULL').all();
    const scored = [];
    for (const row of rows) {
      try {
        const tf = JSON.parse(row.tfidf_terms);
        let score = 0;
        for (const t of qTerms) {
          if (tf[t]) score += tf[t] * (idf[t] || 1);
        }
        if (score > 0) scored.push({ id: row.id, sourcePath: row.source_path, chunkType: row.chunk_type, content: row.content, score });
      } catch {}
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20);
  } catch (err) {
    logError('tfidfSearch failed', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Embedding (Ollama)
// ---------------------------------------------------------------------------
async function embed(text) {
  return new Promise((resolve) => {
    try {
      const base = getOllamaBase();
      const body = JSON.stringify({ model: 'nomic-embed-text', prompt: text });
      const url = new URL('/api/embeddings', base);
      const options = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.embedding && Array.isArray(parsed.embedding)) {
              resolve(new Float32Array(parsed.embedding));
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    } catch (err) {
      logError('embed request failed', err);
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Embedding cache (in-memory Map<id, Float32Array>)
// ---------------------------------------------------------------------------
let _embCache = null; // Map<id, Float32Array>

function getEmbCache(db) {
  if (_embCache) return _embCache;
  _embCache = new Map();
  try {
    const rows = db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL').all();
    for (const row of rows) {
      try {
        const arr = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        _embCache.set(row.id, arr);
      } catch {}
    }
  } catch (err) {
    logError('getEmbCache load failed', err);
  }
  return _embCache;
}

function invalidateEmbCache() {
  _embCache = null;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Vector search — returns top-20 with score
// ---------------------------------------------------------------------------
async function vectorSearch(db, query) {
  try {
    const qVec = await embed(query);
    if (!qVec) return [];
    const cache = getEmbCache(db);
    const scored = [];
    const meta = db.prepare('SELECT id, source_path, chunk_type, content FROM chunks WHERE embedding IS NOT NULL').all();
    for (const row of meta) {
      const vec = cache.get(row.id);
      if (!vec) continue;
      const score = cosineSim(qVec, vec);
      scored.push({ id: row.id, sourcePath: row.source_path, chunkType: row.chunk_type, content: row.content, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20);
  } catch (err) {
    logError('vectorSearch failed', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// RRF Fusion
// ---------------------------------------------------------------------------
function rrf(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (rank + k));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Embed queue (background, non-blocking)
// ---------------------------------------------------------------------------
const embedQueue = []; // Array of { id }
let _embedRunning = 0;
const MAX_CONCURRENT = 2;
const EMBED_DELAY_MS = 50;

function processEmbedQueue() {
  if (embedQueue.length === 0 || _embedRunning >= MAX_CONCURRENT) return;
  const item = embedQueue.shift();
  _embedRunning++;
  const db = getDB();
  if (!db) { _embedRunning--; return; }
  try {
    const row = db.prepare('SELECT content FROM chunks WHERE id = ?').get(item.id);
    if (!row) { _embedRunning--; scheduleEmbedQueue(); return; }
    embed(row.content).then(vec => {
      if (vec) {
        try {
          const buf = Buffer.from(vec.buffer);
          db.prepare('UPDATE chunks SET embedding = ?, updated_at = ? WHERE id = ?')
            .run(buf, Date.now(), item.id);
          invalidateEmbCache();
        } catch (err) {
          logError('processEmbedQueue write failed', err);
        }
      }
      _embedRunning--;
      scheduleEmbedQueue();
    }).catch(() => {
      _embedRunning--;
      scheduleEmbedQueue();
    });
  } catch (err) {
    logError('processEmbedQueue failed', err);
    _embedRunning--;
    scheduleEmbedQueue();
  }
}

function scheduleEmbedQueue() {
  if (embedQueue.length === 0) return;
  setTimeout(processEmbedQueue, EMBED_DELAY_MS);
}

function enqueueEmbed(id) {
  embedQueue.push({ id });
  setImmediate(processEmbedQueue);
}

function getEmbedQueueLength() {
  return embedQueue.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function addChunk(sourcePath, chunkType, content) {
  try {
    const db = getDB();
    if (!db) return null;
    const id        = makeChunkId(sourcePath, chunkType, content);
    const tfidf     = computeTfIdf(content);
    const now       = Date.now();
    db.prepare(`
      INSERT INTO chunks (id, source_path, chunk_type, content, tfidf_terms, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content     = excluded.content,
        tfidf_terms = excluded.tfidf_terms,
        embedding   = NULL,
        updated_at  = excluded.updated_at
    `).run(id, sourcePath, chunkType, content, JSON.stringify(tfidf), now, now);
    invalidateIdfCache();
    invalidateEmbCache();
    enqueueEmbed(id);
    return id;
  } catch (err) {
    logError('addChunk failed', err);
    return null;
  }
}

function removeChunks(sourcePath) {
  try {
    const db = getDB();
    if (!db) return;
    db.prepare('DELETE FROM chunks WHERE source_path = ?').run(sourcePath);
    invalidateIdfCache();
    invalidateEmbCache();
  } catch (err) {
    logError('removeChunks failed', err);
  }
}

async function search(query, topK = 5) {
  try {
    const db = getDB();
    if (!db) return [];
    const [tfidfResults, vecResults] = await Promise.all([
      Promise.resolve(tfidfSearch(db, query)),
      vectorSearch(db, query),
    ]);
    if (tfidfResults.length === 0 && vecResults.length === 0) return [];
    const fusedIds = rrf([tfidfResults, vecResults]);
    // Build a lookup from both result sets
    const lookup = new Map();
    for (const r of [...tfidfResults, ...vecResults]) lookup.set(r.id, r);
    const results = [];
    for (const id of fusedIds.slice(0, topK)) {
      const r = lookup.get(id);
      if (r) results.push({ id: r.id, sourcePath: r.sourcePath, chunkType: r.chunkType, content: r.content, score: r.score });
    }
    return results;
  } catch (err) {
    logError('search failed', err);
    return [];
  }
}

function getChunksBySource(sourcePath) {
  try {
    const db = getDB();
    if (!db) return [];
    return db.prepare('SELECT * FROM chunks WHERE source_path = ?').all(sourcePath);
  } catch (err) {
    logError('getChunksBySource failed', err);
    return [];
  }
}

function getStats() {
  try {
    const db = getDB();
    if (!db) return { totalChunks: 0, embeddedChunks: 0, queueLength: getEmbedQueueLength() };
    const total    = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const embedded = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get().n;
    return { totalChunks: total, embeddedChunks: embedded, queueLength: getEmbedQueueLength() };
  } catch (err) {
    logError('getStats failed', err);
    return { totalChunks: 0, embeddedChunks: 0, queueLength: getEmbedQueueLength() };
  }
}

module.exports = {
  addChunk,
  removeChunks,
  search,
  getChunksBySource,
  getStats,
  embed,
  getDB,
  close,
  getEmbedQueueLength,
};

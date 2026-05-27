// Neural/scripts/jarvis-watcher.js
// File ingestion system — watches directories, chunks content, feeds knowledge base.
// Uses Node.js built-ins only: fs, path, os, crypto
'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

// ── Lazy-load optional dependencies (jarvis-vector, jarvis-graph) ─────────────

let vector = null;
let graph  = null;

function getVector() {
  if (vector) return vector;
  try {
    vector = require('./jarvis-vector');
  } catch {
    console.warn('[jarvis-watcher] jarvis-vector not found — chunk indexing disabled');
    vector = null;
  }
  return vector;
}

function getGraph() {
  if (graph) return graph;
  try {
    graph = require('./jarvis-graph');
  } catch {
    console.warn('[jarvis-watcher] jarvis-graph not found — graph updates disabled');
    graph = null;
  }
  return graph;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE    = 500 * 1024; // 500 KB
const CHUNK_MAX_CHARS  = 1600;       // ~400 tokens
const CHUNK_OVERLAP    = 200;        // ~50 tokens
const CHUNK_MIN_CHARS  = 20;
const DEBOUNCE_MS      = 300;
const SCAN_CONCURRENCY = 10;
const SCAN_DELAY_MS    = 20;

const WATCHED_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx',
  '.py', '.go', '.rs', '.java', '.rb',
  '.c', '.cpp', '.h',
  '.md', '.json', '.yaml', '.yml', '.toml', '.env',
]);

const CODE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx',
  '.py', '.go', '.rs', '.java', '.rb',
  '.c', '.cpp', '.h',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build',
  '.next', '__pycache__', '.cache',
]);

// Patterns for filenames/paths that may contain credentials — skip entirely
const CRED_PATTERNS = [
  /creds/i, /secret/i, /token/i,
  /\bkey\b/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i,
];

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, import('fs').FSWatcher>} */
const attachedDirs = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const debounceTimers = new Map();

let chunksIndexed  = 0;
let queueLength    = 0;
let lastActivity   = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[jarvis-watcher] ${msg}`);
}

function shouldSkipPath(relPath) {
  const parts = relPath.replace(/\\/g, '/').split('/');
  // Skip any segment that matches SKIP_DIRS
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  const base = path.basename(relPath);
  // Skip minified / source-map files
  if (base.endsWith('.min.js') || base.endsWith('.map')) return true;
  // Skip package-lock.json
  if (base === 'package-lock.json') return true;
  // Skip credential-sensitive filenames
  for (const pat of CRED_PATTERNS) {
    if (pat.test(base)) return true;
  }
  return false;
}

function getExt(filePath) {
  return path.extname(filePath).toLowerCase();
}

function isBinary(buffer) {
  // Heuristic: if any null byte exists in the first 8KB, treat as binary
  const check = buffer.slice(0, 8192);
  return check.indexOf(0) !== -1;
}

function makeChunkId(filePath, index) {
  const hash = crypto.createHash('sha1').update(`${filePath}::${index}`).digest('hex').slice(0, 8);
  return `chunk:${hash}`;
}

function tokenEstimate(str) {
  return Math.ceil(str.length / 4);
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/** Split content into windows of CHUNK_MAX_CHARS with CHUNK_OVERLAP overlap */
function windowChunks(content) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + CHUNK_MAX_CHARS, content.length);
    const text = content.slice(start, end).trim();
    if (text.length >= CHUNK_MIN_CHARS) chunks.push(text);
    if (end >= content.length) break;
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }
  return chunks;
}

/** Chunk a code file by function/class boundaries */
function chunkCodeFile(content) {
  // Boundary patterns — match at start of line
  const BOUNDARY = /^(?:(?:export\s+)?(?:async\s+)?function\s+\w|(?:export\s+)?(?:default\s+)?class\s+\w|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(|def\s+\w|func\s+\w|fn\s+\w)/m;

  const lines    = content.split('\n');
  const segments = [];
  let current    = [];

  for (const line of lines) {
    if (BOUNDARY.test(line) && current.length > 0) {
      segments.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) segments.push(current.join('\n'));

  const chunks = [];
  for (const seg of segments) {
    if (seg.length <= CHUNK_MAX_CHARS) {
      if (seg.trim().length >= CHUNK_MIN_CHARS) chunks.push(seg.trim());
    } else {
      // Segment too large — window it
      chunks.push(...windowChunks(seg));
    }
  }
  return chunks.length > 0 ? chunks : windowChunks(content);
}

/** Chunk a markdown/docs file by ## headings */
function chunkMarkdown(content) {
  const sections = content.split(/^##\s+/m);
  const chunks   = [];
  for (let i = 0; i < sections.length; i++) {
    const text = (i === 0 ? sections[i] : '## ' + sections[i]).trim();
    if (text.length < CHUNK_MIN_CHARS) continue;
    if (text.length <= CHUNK_MAX_CHARS) {
      chunks.push(text);
    } else {
      chunks.push(...windowChunks(text));
    }
  }
  return chunks.length > 0 ? chunks : windowChunks(content);
}

/** Chunk a JSON config — whole file if small, otherwise skip */
function chunkJson(content) {
  const trimmed = content.trim();
  if (trimmed.length < 500) return [trimmed];
  return []; // too large — skip
}

/** Chunk an .env file — extract key names only, redact values */
function chunkEnv(content) {
  const keys = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      if (key) keys.push(`${key}=<redacted>`);
    }
  }
  if (keys.length === 0) return [];
  return [keys.join('\n')];
}

/** Dispatch chunking based on extension */
function chunkContent(content, ext) {
  if (ext === '.env')  return chunkEnv(content);
  if (ext === '.json') return chunkJson(content);
  if (ext === '.md')   return chunkMarkdown(content);
  if (CODE_EXTS.has(ext)) return chunkCodeFile(content);
  // yaml/yml/toml — treat as generic windows
  return windowChunks(content);
}

// ── Import extraction ─────────────────────────────────────────────────────────

/** Extract relative imports from source content */
function extractImports(content, ext) {
  const imports = [];
  const addRelative = (rawPath) => {
    if (rawPath && (rawPath.startsWith('./') || rawPath.startsWith('../'))) {
      imports.push(rawPath);
    }
  };

  if (CODE_EXTS.has(ext) && ext !== '.py' && ext !== '.go' && ext !== '.rs') {
    // JS/TS: require('...'), from '...', import '...'
    const re = /(?:require\s*\(\s*|from\s+|import\s+)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) addRelative(m[1]);
  }

  if (ext === '.py') {
    // Python: import X, from X import
    const re = /^(?:from|import)\s+(\.[\w./]+)/mg;
    let m;
    while ((m = re.exec(content)) !== null) addRelative(m[1]);
  }

  if (ext === '.go') {
    // Go: import "..." or import ( "..." )
    const re = /import\s+(?:"(\.\/[^"]+)"|(?:\(\s*(?:[^)]*?"(\.\/[^"]+)"[^)]*?)\)))/g;
    let m;
    while ((m = re.exec(content)) !== null) addRelative(m[1] || m[2]);
  }

  if (ext === '.rs') {
    // Rust uses mod declarations with relative paths
    const re = /mod\s+(\w+)\s*;/g;
    // Only handle explicit path attributes for relative
    const pathRe = /#\[path\s*=\s*"(\.\/[^"]+)"\]/g;
    let m;
    while ((m = pathRe.exec(content)) !== null) addRelative(m[1]);
  }

  return imports;
}

/** Resolve a relative import path to an absolute path */
function resolveImport(importPath, fromFilePath) {
  const dir      = path.dirname(fromFilePath);
  const resolved = path.resolve(dir, importPath);
  return resolved;
}

// ── Graph & vector updates ────────────────────────────────────────────────────

function updateGraph(relativePath, filePath, content, ext) {
  const g = getGraph();
  if (!g) return;
  try {
    g.addNode(relativePath, 'file', {
      path: filePath,
      language: ext.replace('.', ''),
      lastModified: Date.now(),
    });
    const imports = extractImports(content, ext);
    for (const imp of imports) {
      try {
        const resolved = resolveImport(imp, filePath);
        g.addEdge(relativePath, resolved, 'imports', 1);
      } catch {}
    }
  } catch (err) {
    log(`graph update error for ${relativePath}: ${err.message}`);
  }
}

function removeFromGraph(relativePath) {
  const g = getGraph();
  if (!g) return;
  try {
    if (typeof g.removeNode === 'function') g.removeNode(relativePath);
  } catch {}
}

function indexChunks(dirPath, relativePath, filePath, content, ext) {
  const v = getVector();
  if (!v) return;
  const chunks = chunkContent(content, ext);
  const ns     = `${dirPath}::${relativePath}`;
  try {
    // Remove old chunks for this file first
    if (typeof v.removeChunks === 'function') v.removeChunks(ns);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || chunk.length < CHUNK_MIN_CHARS) continue;
      const id = makeChunkId(ns, i);
      v.addChunk(id, chunk, {
        source: ns,
        filePath,
        chunkIndex: i,
        totalChunks: chunks.length,
        ext,
        language: ext.replace('.', ''),
      });
      chunksIndexed++;
    }
  } catch (err) {
    log(`vector index error for ${relativePath}: ${err.message}`);
  }
}

function removeFromIndex(dirPath, relativePath) {
  const v = getVector();
  if (!v) return;
  const ns = `${dirPath}::${relativePath}`;
  try {
    if (typeof v.removeChunks === 'function') v.removeChunks(ns);
  } catch {}
}

// ── File processing ───────────────────────────────────────────────────────────

function processFile(dirPath, relPath, filePath) {
  const ext = getExt(filePath);

  if (!WATCHED_EXTS.has(ext)) return;
  if (shouldSkipPath(relPath)) return;

  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  if (!stat.isFile()) return;
  if (stat.size > MAX_FILE_SIZE) {
    log(`skipping large file: ${relPath} (${stat.size} bytes)`);
    return;
  }

  let buffer;
  try { buffer = fs.readFileSync(filePath); } catch (err) {
    log(`read error: ${relPath} — ${err.message}`);
    return;
  }

  if (isBinary(buffer)) return;

  let content;
  try { content = buffer.toString('utf8'); } catch { return; }

  lastActivity = Date.now();
  indexChunks(dirPath, relPath, filePath, content, ext);
  updateGraph(relPath, filePath, content, ext);
}

// ── File change handler ───────────────────────────────────────────────────────

function handleFileChange(dirPath, filename, event) {
  if (!filename) return;
  const relPath  = filename.replace(/\\/g, '/');
  const filePath = path.join(dirPath, filename);
  const ext      = getExt(filePath);

  if (!WATCHED_EXTS.has(ext)) return;
  if (shouldSkipPath(relPath)) return;

  lastActivity = Date.now();

  // Check if file still exists (delete vs modify)
  let exists = false;
  try { exists = fs.existsSync(filePath); } catch {}

  if (!exists || event === 'rename' && !exists) {
    // File deleted
    log(`deleted: ${relPath}`);
    removeFromIndex(dirPath, relPath);
    removeFromGraph(relPath);
    return;
  }

  log(`changed: ${relPath}`);
  processFile(dirPath, relPath, filePath);
}

// ── Debounce ──────────────────────────────────────────────────────────────────

function debounce(key, ms, fn) {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, ms);
  debounceTimers.set(key, timer);
}

// ── Directory scanning (initial full index) ───────────────────────────────────

function walkDir(dirPath, callback) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

async function scanDirectory(dirPath) {
  const files = [];
  walkDir(dirPath, (fp) => {
    const ext     = getExt(fp);
    const relPath = path.relative(dirPath, fp).replace(/\\/g, '/');
    if (WATCHED_EXTS.has(ext) && !shouldSkipPath(relPath)) files.push(fp);
  });

  log(`initial scan: ${dirPath} — ${files.length} files queued`);
  queueLength += files.length;

  // Process in batches of SCAN_CONCURRENCY with SCAN_DELAY_MS between batches
  for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
    const batch = files.slice(i, i + SCAN_CONCURRENCY);
    for (const fp of batch) {
      const relPath = path.relative(dirPath, fp).replace(/\\/g, '/');
      processFile(dirPath, relPath, fp);
      queueLength--;
    }
    if (i + SCAN_CONCURRENCY < files.length) {
      await new Promise(resolve => setTimeout(resolve, SCAN_DELAY_MS));
    }
  }

  log(`initial scan complete: ${dirPath}`);
}

// ── Attach / detach ───────────────────────────────────────────────────────────

function attach(dirPath) {
  const resolved = path.resolve(dirPath);

  if (attachedDirs.has(resolved)) {
    log(`already watching: ${resolved}`);
    return;
  }

  if (!fs.existsSync(resolved)) {
    log(`directory not found: ${resolved}`);
    return;
  }

  log(`attaching: ${resolved}`);

  let watcher = null;
  try {
    watcher = fs.watch(
      resolved,
      { recursive: true },
      (event, filename) => {
        if (!filename) return;
        const key = `${resolved}::${filename}`;
        debounce(key, DEBOUNCE_MS, () => handleFileChange(resolved, filename, event));
      }
    );

    watcher.on('error', (err) => {
      log(`watcher error on ${resolved}: ${err.message} — watcher disabled`);
      watcher.close();
      attachedDirs.delete(resolved);
    });

  } catch (err) {
    log(`fs.watch unsupported on ${resolved}: ${err.message} — watcher disabled`);
    watcher = null;
  }

  // Even if watcher fails, store a placeholder so the dir is "attached" for CLI status
  attachedDirs.set(resolved, watcher);

  // Initial scan in background (non-blocking)
  setImmediate(() => {
    scanDirectory(resolved).catch(err => {
      log(`scan error on ${resolved}: ${err.message}`);
    });
  });
}

function detach(dirPath) {
  const resolved = path.resolve(dirPath);
  const watcher  = attachedDirs.get(resolved);
  if (!watcher && !attachedDirs.has(resolved)) {
    log(`not watching: ${resolved}`);
    return;
  }

  log(`detaching: ${resolved}`);
  if (watcher) {
    try { watcher.close(); } catch {}
  }
  attachedDirs.delete(resolved);

  // Remove all chunks for this directory from the vector index
  const v = getVector();
  if (v && typeof v.removeChunks === 'function') {
    // Remove any chunks whose source starts with this dir path
    try {
      if (typeof v.removeChunksByDir === 'function') {
        v.removeChunksByDir(resolved);
      }
    } catch {}
  }
}

function getAttachedDirs() {
  return Array.from(attachedDirs.keys());
}

function rechunk(filePath) {
  const resolved = path.resolve(filePath);
  // Find which attached dir this file belongs to
  let ownerDir = null;
  for (const dirPath of attachedDirs.keys()) {
    if (resolved.startsWith(dirPath + path.sep) || resolved.startsWith(dirPath + '/')) {
      ownerDir = dirPath;
      break;
    }
  }
  if (!ownerDir) {
    log(`rechunk: ${resolved} is not inside any attached directory`);
    return;
  }
  const relPath = path.relative(ownerDir, resolved).replace(/\\/g, '/');
  log(`rechunking: ${relPath}`);
  processFile(ownerDir, relPath, resolved);
}

function getStats() {
  return {
    attachedDirs: getAttachedDirs(),
    chunksIndexed,
    queueLength,
    lastActivity,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  attach,
  detach,
  getAttachedDirs,
  rechunk,
  getStats,
};

// ── CLI mode ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'attach': {
      const targetDir = args[0];
      if (!targetDir) {
        console.error('Usage: node jarvis-watcher.js attach <directory>');
        process.exit(1);
      }
      attach(targetDir);
      // Keep process alive — the watcher holds the event loop open
      // If watcher was disabled (unsupported FS), we still need to stay alive
      // to let the initial scan finish, then exit gracefully.
      const keepAlive = setInterval(() => {
        if (attachedDirs.size === 0) {
          clearInterval(keepAlive);
          process.exit(0);
        }
      }, 5000);

      process.on('SIGINT',  () => { detach(path.resolve(args[0])); process.exit(0); });
      process.on('SIGTERM', () => { detach(path.resolve(args[0])); process.exit(0); });
      break;
    }

    case 'detach': {
      const targetDir = args[0];
      if (!targetDir) {
        console.error('Usage: node jarvis-watcher.js detach <directory>');
        process.exit(1);
      }
      // Detach is stateless in CLI mode — just print confirmation
      log(`detach request for: ${path.resolve(targetDir)}`);
      process.exit(0);
      break;
    }

    case 'status': {
      const stats = getStats();
      console.log('\nJARVIS Watcher — Status');
      console.log('───────────────────────');
      console.log(`Attached dirs : ${stats.attachedDirs.length > 0 ? stats.attachedDirs.join(', ') : '(none)'}`);
      console.log(`Chunks indexed: ${stats.chunksIndexed}`);
      console.log(`Queue length  : ${stats.queueLength}`);
      console.log(`Last activity : ${stats.lastActivity ? new Date(stats.lastActivity).toISOString() : '(none)'}`);
      process.exit(0);
      break;
    }

    default: {
      console.error('Usage:');
      console.error('  node jarvis-watcher.js attach <directory>');
      console.error('  node jarvis-watcher.js detach <directory>');
      console.error('  node jarvis-watcher.js status');
      process.exit(1);
    }
  }
}

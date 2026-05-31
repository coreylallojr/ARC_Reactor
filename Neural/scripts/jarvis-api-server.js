'use strict';
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { spawn }    = require('child_process');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const API_PORT = 7476;
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const DB_DIR = path.join(os.homedir(), '.claude', 'jarvis-db');

// ---------------------------------------------------------------------------
// Skills storage
// ---------------------------------------------------------------------------
const SKILLS_PATH = path.join(DB_DIR, 'skills.json');

// ---------------------------------------------------------------------------
// Course storage
// ---------------------------------------------------------------------------
const COURSE_DATA_PATH = path.join(__dirname, '..', 'data', 'ee-course.json');
const PROGRESS_PATH    = path.join(DB_DIR, 'course-progress.json');

function loadSkills() {
  try { return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')); } catch { return []; }
}

function saveSkills(skills) {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(SKILLS_PATH, JSON.stringify(skills, null, 2));
  } catch {}
}

function initSkills() {
  if (fs.existsSync(SKILLS_PATH)) return;
  const builtins = [
    {
      id: 'debug',
      name: 'debug',
      source: 'builtin',
      triggerPhrases: ['debug', 'trace this', "what's wrong", 'find the bug'],
      description: 'Systematic debugging: Grep errors → Read relevant files → analyze → propose fix',
      usageCount: 0
    },
    {
      id: 'architect',
      name: 'architect',
      source: 'builtin',
      triggerPhrases: ['architect this', 'review architecture', 'analyze structure'],
      description: 'Architecture review: Read all modified files → analyze dependencies → identify issues → summarize',
      usageCount: 0
    },
    {
      id: 'review',
      name: 'review',
      source: 'builtin',
      triggerPhrases: ['review this', 'code review', 'check this code'],
      description: 'Code review: Read file → check for issues → suggest improvements',
      usageCount: 0
    }
  ];
  saveSkills(builtins);
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveProgress(p) {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
  } catch {}
}

let _courseCache = null;
function loadCourseData() {
  if (_courseCache) return _courseCache;
  try { return (_courseCache = JSON.parse(fs.readFileSync(COURSE_DATA_PATH, 'utf8'))); }
  catch { return null; }
}

function parseCourseUrl(pathname) {
  const parts = pathname.replace(/^\/+/, '').split('/');
  // ['v1', 'courses', courseId?, seg3?, lessonId?]
  const courseId = parts[2] || null;
  const seg3     = parts[3] || null;
  const lessonId = parts[4] || null;
  const action   = seg3 === 'progress' ? 'progress' : seg3 === 'lessons' ? 'lessons' : null;
  return { courseId, action, lessonId };
}

// ---------------------------------------------------------------------------
// SSE broadcasting
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Skill execution via spawn
// ---------------------------------------------------------------------------
function runSkill(skill, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', `Run the ${skill.name} workflow`], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Skill execution timed out (5 min)'));
    }, 5 * 60 * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      const output = stdout || stderr || `exit code ${code}`;
      resolve(output);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Forward to voice server
// ---------------------------------------------------------------------------
function forwardToVoice(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const opts = {
      hostname: 'localhost',
      port: 7475,
      path: '/voice/speak',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = http.request(opts, res => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Parse :id param from URL pathname
// e.g. /v1/skills/my-skill  →  'my-skill'
// e.g. /v1/skills/my-skill/run  →  { id: 'my-skill', action: 'run' }
// ---------------------------------------------------------------------------
function parseSkillPath(pathname) {
  // pathname = /v1/skills/<id>  or  /v1/skills/<id>/run
  const parts = pathname.replace(/^\/+/, '').split('/');
  // parts: ['v1', 'skills', id, ...]
  const id     = parts[2] || null;
  const action = parts[3] || null;
  return { id, action };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function router(route, url, req, res) {
  // ── GET /v1/status ────────────────────────────────────────────────────────
  if (route === 'GET /v1/status') {
    return json(res, {
      status: 'online',
      port: API_PORT,
      clients: sseClients.size,
      uptime: process.uptime(),
      version: '4.0.0'
    });
  }

  // ── GET /v1/events  (SSE) ─────────────────────────────────────────────────
  if (route === 'GET /v1/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return; // keep connection open
  }

  // ── GET /v1/context ───────────────────────────────────────────────────────
  if (route === 'GET /v1/context') {
    try {
      const sessionFile = path.join(config.neural || '', '.session-state.json');
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      return json(res, data);
    } catch {
      return json(res, { sessionId: null, callCount: 0, message: 'No active session' });
    }
  }

  // ── GET /v1/skills ────────────────────────────────────────────────────────
  if (route === 'GET /v1/skills') {
    const skills = loadSkills();
    return json(res, { skills });
  }

  // ── POST /v1/skills ───────────────────────────────────────────────────────
  if (route === 'POST /v1/skills') {
    const body = await readBody(req);
    if (!body.name) {
      return json(res, { error: 'name is required' }, 400);
    }
    const skill = {
      id:                   body.name.toLowerCase().replace(/\s+/g, '-'),
      name:                 body.name,
      source:               'explicit',
      triggerPhrases:       body.triggerPhrases || [],
      description:          body.description || '',
      toolSequence:         body.toolSequence || undefined,
      systemPromptOverride: body.systemPromptOverride || undefined,
      usageCount:           0,
      createdAt:            Date.now()
    };
    // strip undefined keys
    Object.keys(skill).forEach(k => skill[k] === undefined && delete skill[k]);

    const skills = loadSkills();
    skills.push(skill);
    saveSkills(skills);
    broadcast({ type: 'skill_created', skill });
    return json(res, skill, 201);
  }

  // ── Routes with :id  (/v1/skills/*)  ─────────────────────────────────────
  if (url.pathname.startsWith('/v1/skills/')) {
    const { id, action } = parseSkillPath(url.pathname);

    // DELETE /v1/skills/:id
    if (req.method === 'DELETE' && !action) {
      const skills   = loadSkills();
      const filtered = skills.filter(s => s.id !== id);
      if (filtered.length === skills.length) {
        return json(res, { error: 'Skill not found' }, 404);
      }
      saveSkills(filtered);
      broadcast({ type: 'skill_deleted', skillId: id });
      return json(res, { ok: true });
    }

    // POST /v1/skills/:id/run
    if (req.method === 'POST' && action === 'run') {
      const skills = loadSkills();
      const skill  = skills.find(s => s.id === id);
      if (!skill) {
        return json(res, { error: 'Skill not found' }, 404);
      }

      broadcast({ type: 'skill_running', skillId: id });

      let output;
      try {
        output = await runSkill(skill, config.vault || process.cwd());
      } catch (e) {
        output = e.message;
      }

      broadcast({ type: 'skill_complete', skillId: id, result: output.slice(-800) });

      // update usage stats
      skill.usageCount = (skill.usageCount || 0) + 1;
      skill.lastUsed   = Date.now();
      saveSkills(skills);

      return json(res, { ok: true, result: output.slice(-800) });
    }

    return json(res, { error: 'Not found' }, 404);
  }

  // ── POST /v1/recall ───────────────────────────────────────────────────────
  if (route === 'POST /v1/recall') {
    const body = await readBody(req);
    let vector;
    try { vector = require('./jarvis-vector'); } catch (e) {
      return json(res, { error: 'Vector module unavailable: ' + e.message }, 503);
    }
    const results = await vector.search(body.query || '', body.topK || 5);
    return json(res, { results });
  }

  // ── GET /v1/graph ─────────────────────────────────────────────────────────
  if (route === 'GET /v1/graph') {
    let graph;
    try { graph = require('./jarvis-graph'); } catch (e) {
      return json(res, { error: 'Graph module unavailable: ' + e.message }, 503);
    }
    const data = graph.toD3Format();
    return json(res, data);
  }

  // ── POST /v1/graph/query ──────────────────────────────────────────────────
  if (route === 'POST /v1/graph/query') {
    const body = await readBody(req);
    let graph;
    try { graph = require('./jarvis-graph'); } catch (e) {
      return json(res, { error: 'Graph module unavailable: ' + e.message }, 503);
    }
    const neighbors = graph.getNeighbors(body.nodeId, { maxDepth: body.depth || 2 });
    return json(res, { neighbors });
  }

  // ── POST /v1/speak ────────────────────────────────────────────────────────
  if (route === 'POST /v1/speak') {
    const body = await readBody(req);
    const text = body.text || '';
    try {
      await forwardToVoice(text);
    } catch {
      // voice server unavailable — write to pending file
      try {
        const pendingPath = path.join(config.neural || os.homedir(), '.pending-audio-text');
        fs.writeFileSync(pendingPath, text, 'utf8');
      } catch {}
    }
    return json(res, { ok: true });
  }

  // ── POST /v1/remember ─────────────────────────────────────────────────────
  if (route === 'POST /v1/remember') {
    const body = await readBody(req);
    let vector;
    try { vector = require('./jarvis-vector'); } catch (e) {
      return json(res, { error: 'Vector module unavailable: ' + e.message }, 503);
    }
    const id = await vector.addChunk('api-memory', body.type || 'note', body.content || '');
    return json(res, { ok: true, id });
  }

  // ── POST /v1/events/external ──────────────────────────────────────────────
  if (route === 'POST /v1/events/external') {
    const body = await readBody(req);
    if (!body.type) {
      return json(res, { error: 'type is required' }, 400);
    }
    try {
      fs.mkdirSync(DB_DIR, { recursive: true });
      const line = JSON.stringify({
        ...body,
        receivedAt: Date.now()
      }) + '\n';
      fs.appendFileSync(path.join(DB_DIR, 'external-events.jsonl'), line, 'utf8');
    } catch {}
    broadcast({ type: 'external_event', event: body });
    return json(res, { ok: true });
  }

  // ── GET /v1/courses ────────────────────────────────────────────────────────
  if (route === 'GET /v1/courses') {
    const course = loadCourseData();
    if (!course) return json(res, { error: 'Course data not found' }, 404);
    const progress       = loadProgress();
    const courseProgress = progress[course.id] || {};
    const summary = {
      id:           course.id,
      title:        course.title,
      version:      course.version,
      totalLessons: course.totalLessons,
      modules: course.modules.map(mod => {
        const total     = mod.lessons.length;
        const completed = mod.lessons.filter(l => courseProgress[l.id] && courseProgress[l.id].completed).length;
        return {
          id:               mod.id,
          title:            mod.title,
          order:            mod.order,
          totalLessons:     total,
          completedLessons: completed,
          lessons: mod.lessons.map(l => ({
            id:        l.id,
            title:     l.title,
            order:     l.order,
            completed: !!(courseProgress[l.id] && courseProgress[l.id].completed),
            quizScore: courseProgress[l.id] ? courseProgress[l.id].quizScore : null,
          }))
        };
      })
    };
    return json(res, { courses: [summary] });
  }

  // ── /v1/courses/* ──────────────────────────────────────────────────────────
  if (url.pathname.startsWith('/v1/courses/')) {
    const { courseId, action, lessonId } = parseCourseUrl(url.pathname);

    // GET /v1/courses/:courseId
    if (req.method === 'GET' && courseId && !action) {
      const course = loadCourseData();
      if (!course || course.id !== courseId) return json(res, { error: 'Course not found' }, 404);
      const progress       = loadProgress();
      const courseProgress = progress[course.id] || {};
      const safe = {
        ...course,
        modules: course.modules.map(mod => ({
          ...mod,
          lessons: mod.lessons.map(l => ({
            id:        l.id,
            title:     l.title,
            order:     l.order,
            completed: !!(courseProgress[l.id] && courseProgress[l.id].completed),
            quizScore: courseProgress[l.id] ? courseProgress[l.id].quizScore : null,
          }))
        }))
      };
      return json(res, safe);
    }

    // GET /v1/courses/:courseId/lessons/:lessonId
    if (req.method === 'GET' && courseId && action === 'lessons' && lessonId) {
      const course = loadCourseData();
      if (!course || course.id !== courseId) return json(res, { error: 'Course not found' }, 404);
      let lesson = null;
      for (const mod of course.modules) {
        const found = mod.lessons.find(l => l.id === lessonId);
        if (found) { lesson = { ...found, moduleId: mod.id, moduleTitle: mod.title }; break; }
      }
      if (!lesson) return json(res, { error: 'Lesson not found' }, 404);
      const progress = loadProgress();
      const lp       = (progress[courseId] || {})[lessonId] || {};
      lesson.completed = !!(lp.completed);
      lesson.quizScore = lp.quizScore !== undefined ? lp.quizScore : null;
      return json(res, lesson);
    }

    // POST /v1/courses/:courseId/progress
    if (req.method === 'POST' && courseId && action === 'progress') {
      const body = await readBody(req);
      if (!body.lessonId) return json(res, { error: 'lessonId required' }, 400);
      const progress = loadProgress();
      if (!progress[courseId]) progress[courseId] = {};
      progress[courseId][body.lessonId] = {
        completed:   !!(body.completed),
        quizScore:   typeof body.quizScore === 'number' ? body.quizScore : null,
        completedAt: Date.now(),
      };
      saveProgress(progress);
      broadcast({ type: 'lesson_completed', courseId, lessonId: body.lessonId, quizScore: body.quizScore });
      return json(res, { ok: true });
    }

    return json(res, { error: 'Not found' }, 404);
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  return json(res, { error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url   = new URL(req.url, `http://localhost:${API_PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    await router(route, url, req, res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(API_PORT, '127.0.0.1', () => {
  console.log(`JARVIS API online → http://localhost:${API_PORT}`);
  initSkills(); // ensure built-in skills exist
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log(`JARVIS API port ${API_PORT} already in use`);
  else console.error('[api]', e.message);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { broadcast, server };

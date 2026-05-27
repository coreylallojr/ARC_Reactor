// Neural/scripts/neural-daemon.js
// Persistent IPC daemon — receives hook events via named pipe, handles all
// heavy work (Ollama narration, TTS, session state, vault writes) so that the
// hook shim (neural-logger.js) can exit in ~10ms.
'use strict';

const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const os     = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const voiceMode = config.voiceMode ?? 1;

// ── Named pipe path ───────────────────────────────────────────────────────────

const PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\jarvis-neural'
  : '/tmp/jarvis-neural.sock';

// ── PID file ──────────────────────────────────────────────────────────────────

const DAEMON_PID_PATH = path.join(config.neural || os.homedir(), '.daemon.pid');

try { fs.writeFileSync(DAEMON_PID_PATH, String(process.pid)); } catch {}

// ── Error log ─────────────────────────────────────────────────────────────────

const ERROR_LOG = path.join(config.neural || os.homedir(), 'context', 'daemon-errors.log');

function logError(context, err) {
  try {
    const line = `[${new Date().toISOString()}] ${context}: ${err && err.message ? err.message : String(err)}\n`;
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
}

// ── Supporting modules ────────────────────────────────────────────────────────

const fallbacks = require('./jarvis-fallbacks');
const memory    = require('./jarvis-memory');

let rag, skills, patterns;
try { rag      = require('./jarvis-rag');      } catch {}
try { skills   = require('./jarvis-skills');   } catch {}
try { patterns = require('./jarvis-patterns'); } catch {}

let lastAnnouncedSkill = null;

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreToolCall(toolName, { isFirstCall, consecutiveSame, hasError }) {
  const base = config.toolScores ? (config.toolScores[toolName] ?? 1) : 1;
  let score = base;
  if (isFirstCall)         score += config.sessionStartBonus ?? 2;
  if (hasError)            score += config.errorBonus ?? 4;
  if (consecutiveSame >= 3) score -= config.consecutiveSamePenalty ?? 1;
  return Math.max(0, score);
}

function scoreToLevel(score) {
  if (score <= 1) return 1;
  if (score <= 3) return 2;
  if (score <= 5) return 3;
  return 4;
}

// ── Narrative templates ───────────────────────────────────────────────────────

const TEMPLATES = {
  Read:   { L1: () => 'Reading.',           L2: () => 'Analyzing the file structure, sir.' },
  Write:  { L1: () => 'Writing.',           L2: () => 'Updating the vault, sir.' },
  Edit:   { L1: () => 'Editing.',           L2: () => 'Making the edit, sir.' },
  Bash:   { L1: () => 'Running command.',   L2: () => 'Running the operation, sir.' },
  Grep:   { L1: () => 'Searching.',         L2: () => 'Searching the codebase, sir.' },
  Glob:   { L1: () => 'Scanning.',          L2: () => 'Scanning the file system, sir.' },
  Agent:  { L1: () => 'Spawning subagent.', L2: () => 'Dispatching a subagent, sir.' },
};

function generateNarrative(toolName, toolInput, level) {
  const tpl = TEMPLATES[toolName] ?? { L1: () => `Using ${toolName}.`, L2: () => `Running ${toolName}, sir.` };
  const key = level >= 2 ? 'L2' : 'L1';
  return (tpl[key] ?? tpl.L1)(toolInput || {});
}

function generateStopLine(recentTools, awaitingInput) {
  if (awaitingInput) return 'Standing by, sir. Your input is required.';
  if (recentTools.length === 0) return 'All systems nominal, sir.';
  const writtenFiles = recentTools
    .filter(t => t.tool === 'Write' || t.tool === 'Edit')
    .map(t => t.file)
    .filter(Boolean);
  if (writtenFiles.length > 0) {
    const f = path.basename(writtenFiles[writtenFiles.length - 1] || 'file');
    return `${f} updated, sir.`;
  }
  const toolCounts = {};
  for (const t of recentTools) toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;
  const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0];
  if (topTool && topTool[1] >= 3) return `${topTool[1]} ${topTool[0].toLowerCase()} operations complete, sir.`;
  return 'As always, sir, a pleasure.';
}

// ── Session state ─────────────────────────────────────────────────────────────

const STATE_PATH = path.join(config.neural || os.homedir(), '.session-state.json');

function loadSessionState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath || STATE_PATH, 'utf8')); } catch {
    return {
      sessionId: null, callCount: 0, toolCounts: {}, lastTool: null,
      consecutiveSame: 0, startTime: Date.now(), errorCount: 0,
      consecutiveErrors: 0, fileEditCounts: {}, lastToolCallTime: Date.now(),
    };
  }
}

function updateSessionState(state, incomingSessionId, toolName, toolInput, hasError) {
  const isNewSession = state.sessionId !== incomingSessionId;
  if (isNewSession) {
    return {
      sessionId: incomingSessionId, callCount: 1,
      toolCounts: { [toolName]: 1 }, lastTool: toolName,
      consecutiveSame: 0, startTime: Date.now(),
      errorCount: hasError ? 1 : 0, consecutiveErrors: hasError ? 1 : 0,
      fileEditCounts: {}, lastToolCallTime: Date.now(),
    };
  }
  const consecutiveSame   = state.lastTool === toolName ? (state.consecutiveSame || 0) + 1 : 0;
  const prevConsecErrors  = state.consecutiveErrors || 0;
  const consecutiveErrors = hasError ? prevConsecErrors + 1 : 0;
  const fileEditCounts    = { ...(state.fileEditCounts || {}) };
  if ((toolName === 'Write' || toolName === 'Edit') && toolInput) {
    const fp = toolInput.file_path || toolInput.path || '';
    if (fp) {
      const bn = path.basename(fp);
      fileEditCounts[bn] = (fileEditCounts[bn] || 0) + 1;
    }
  }
  return {
    sessionId: incomingSessionId,
    callCount: (state.callCount || 0) + 1,
    toolCounts: { ...state.toolCounts, [toolName]: (state.toolCounts[toolName] || 0) + 1 },
    lastTool: toolName, consecutiveSame,
    startTime: state.startTime || Date.now(),
    errorCount: (state.errorCount || 0) + (hasError ? 1 : 0),
    consecutiveErrors, fileEditCounts,
    lastToolCallTime: Date.now(),
  };
}

function saveSessionState(state, statePath) {
  try { fs.writeFileSync(statePath || STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
}

// ── Intent reader ─────────────────────────────────────────────────────────────

const INTENT_PATH       = path.join(config.neural || os.homedir(), 'context', 'current-intent.md');
const VOICE_HISTORY_PATH = path.join(config.neural || os.homedir(), '.voice-history.json');

function parseIntent() {
  try {
    const content = fs.readFileSync(INTENT_PATH, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = {};
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    if (fm.spoken === 'true') return null;
    return {
      action: fm.action || '', contextPrev: fm.context_prev || '',
      nextStep: fm.next_step || '',
      stepCurrent: parseInt(fm.step_current) || 0,
      stepTotal: parseInt(fm.step_total) || 0,
      needsApproval: fm.needs_approval === 'true',
      milestone: fm.milestone === 'true', milestoneText: fm.milestone_text || '',
    };
  } catch { return null; }
}

function markIntentSpoken() {
  try {
    const content = fs.readFileSync(INTENT_PATH, 'utf8');
    fs.writeFileSync(INTENT_PATH, content.replace(/^spoken:\s*false/m, 'spoken: true'));
  } catch {}
}

function loadVoiceHistory() {
  try { return JSON.parse(fs.readFileSync(VOICE_HISTORY_PATH, 'utf8')); } catch { return []; }
}

function saveVoiceHistory(history) {
  try { fs.writeFileSync(VOICE_HISTORY_PATH, JSON.stringify(history.slice(-20))); } catch {}
}

// ── AI Voice Generation ───────────────────────────────────────────────────────

function getSystemPrompt() {
  if (voiceMode >= 3) {
    return `You are JARVIS, Iron Man's AI assistant. British, dry, confident, precise.
Narrate in 3-5 sentences. Say what the action implies about the larger task.
Volunteer relevant observations. You may ask a question if the task seems ambiguous.
Reference session history naturally when relevant.
Never say "Certainly", "Of course", "Absolutely". Never start with "I".
Say "sir" once. Output: spoken text only, no quotes, no markdown.`;
  }
  if (voiceMode >= 2) {
    return `You are JARVIS, Iron Man's AI assistant. British, dry, confident, precise.
Narrate in 2-3 sentences. Say what the action implies about the larger task — not just what it did.
Make one dry observation. Never describe the tool name. Never start with "I".
Say "sir" once. Output: spoken text only, no quotes, no markdown.`;
  }
  return `You are JARVIS, Iron Man's British AI assistant. Narrate software work in 8-14 words. Say "sir". Never mention tool names, file names, or paths. Output: one spoken line only, no quotes.
Examples: "The system is taking shape, sir." / "Your attention is required, sir." / "As always, sir, a pleasure."`;
}

function buildContextSummary(state) {
  const durationMin = Math.floor((Date.now() - (state.startTime || Date.now())) / 60000);
  const topFiles = Object.entries(state.fileEditCounts || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([f, n]) => `${f}(×${n})`).join(', ');
  return [
    `${durationMin}min elapsed`,
    `${state.callCount || 0} ops`,
    state.errorCount ? `${state.errorCount} errors` : null,
    topFiles ? `Editing: ${topFiles}` : null,
  ].filter(Boolean).join('. ');
}

function extractResponseSummary(toolName, responseText) {
  if (!responseText || typeof responseText !== 'string') return null;
  const lines = responseText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
  if (lines.length === 0) return null;
  const snippet = (lines.length > 4 ? lines[lines.length - 1] : lines[0]).substring(0, 100);
  return snippet ? `Output: ${snippet}` : null;
}

function extractCodeChange(toolName, toolInput) {
  if (!toolInput) return null;
  if (toolName === 'Edit') {
    const firstChanged = (toolInput.old_string || '').split('\n').find(l => l.trim().length > 4 && !l.trim().startsWith('//')) || '';
    const summary = firstChanged.trim().substring(0, 70);
    return summary ? `Modified: ${summary}` : null;
  }
  if (toolName === 'Write') {
    const match = (toolInput.content || '').match(/(?:function|const|class|async function|def)\s+(\w+)/);
    return match ? `Wrote: ${match[1]}` : null;
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = (toolInput.command || '').replace(/\s+/g, ' ').trim().substring(0, 60);
    return cmd ? `Ran: ${cmd}` : null;
  }
  return null;
}

function buildVoicePrompts(intent, toolContext, history, state) {
  const toolInput    = toolContext && toolContext.toolInput;
  const toolName     = toolContext && toolContext.toolName;
  const toolResponse = toolContext && toolContext.toolResponse;
  const parts = [];

  if (toolContext && toolContext.isStop) {
    const totalOps  = toolContext.totalOps || 0;
    const topTools  = toolContext.topTools || '';
    const taskAction = toolContext.taskAction || '';
    if (totalOps > 0) parts.push({ pri: 1, text: `Session complete. ${totalOps} operations: ${topTools}.` });
    else parts.push({ pri: 1, text: 'Session complete.' });
    if (taskAction) parts.push({ pri: 2, text: `Task: ${taskAction.substring(0, 70)}` });
    parts.push({ pri: 3, text: 'Deliver a closing summary. What was accomplished this session?' });
  } else if (intent && intent.needsApproval) {
    parts.push({ pri: 1, text: 'Approval required before proceeding.' });
    if (intent.action) parts.push({ pri: 2, text: `For: ${intent.action.substring(0, 65)}` });
  } else if (intent && intent.action) {
    parts.push({ pri: 2, text: `Task: ${intent.action.substring(0, 70)}` });
    if (intent.stepCurrent > 0 && intent.stepTotal > 0) parts.push({ pri: 4, text: `Step ${intent.stepCurrent} of ${intent.stepTotal}` });
    if (intent.nextStep) parts.push({ pri: 4, text: `Next: ${intent.nextStep.substring(0, 50)}` });
    if (intent.milestone && intent.milestoneText) parts.push({ pri: 3, text: `Milestone: ${intent.milestoneText.substring(0, 60)}` });
  } else {
    parts.push({ pri: 3, text: 'Active session in progress.' });
  }

  const change = extractCodeChange(toolName, toolInput);
  if (change) parts.push({ pri: 3, text: change });

  if (config.maxContextMode && toolResponse) {
    const responseSummary = extractResponseSummary(toolName, toolResponse);
    if (responseSummary) parts.push({ pri: 3, text: responseSummary });
  }
  if (toolContext && toolContext.hasError) parts.push({ pri: 1, text: 'Error encountered.' });

  if (voiceMode >= 2 && state) {
    const ctx = buildContextSummary(state);
    if (ctx) parts.push({ pri: 4, text: `Context: ${ctx}` });
    try {
      const memCtx = memory.loadRecentContext(config.vault || '', toolContext && toolContext.sessionId ? toolContext.sessionId : '');
      if (memCtx.previousSession) parts.push({ pri: 5, text: `Prior session: ${memCtx.previousSession.substring(0, 80)}` });
    } catch {}
  }

  const avoid = history.filter(Boolean).slice(-2);
  if (avoid.length > 0) {
    parts.push({ pri: 6, text: `Do not repeat: ${avoid.map(l => `"${l.substring(0, 35)}"`).join('; ')}` });
  }

  const MAX_CHARS = voiceMode >= 2 ? 900 : 600;
  parts.sort((a, b) => a.pri - b.pri);
  let result = '';
  for (const p of parts) {
    if (result.length + p.text.length + 1 < MAX_CHARS) result += (result ? '\n' : '') + p.text;
  }

  const closing = (toolContext && toolContext.isStop)
    ? '\n\nSummarise this session in one JARVIS line.'
    : '\n\nGenerate the JARVIS line.';
  return result + closing;
}

function cleanModelOutput(raw) {
  if (!raw) return null;
  return raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(JARVIS:|Output:|Line:|Response:)\s*/i, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function generateViaOllama(userPrompt) {
  if (!config.ollamaUrl || !config.ollamaModel) return null;
  const base = config.ollamaUrl.replace(/\/v1.*$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  const maxWords = voiceMode >= 2 ? 55 : 14;
  let text = '';
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: true,
        messages: [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user',   content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) { clearTimeout(timer); return null; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.message && d.message.content) {
            text += d.message.content;
            if (text.split(/\s+/).filter(Boolean).length >= maxWords) {
              controller.abort(); reader.cancel().catch(() => {}); break outer;
            }
          }
          if (d.done) break outer;
        } catch {}
      }
    }
    clearTimeout(timer);
    return cleanModelOutput(text) || null;
  } catch {
    clearTimeout(timer);
    return cleanModelOutput(text) || null;
  }
}

function staticFallbackLine(toolContext, state) {
  if (!toolContext || toolContext.isStop) return fallbacks.selectFallback('TASK_COMPLETE', state);
  if (toolContext.hasError) return fallbacks.selectFallback('ERROR', state);
  return fallbacks.selectFallback('IDLE', state);
}

async function generateVoiceLine(intent, toolContext, history, state) {
  // RAG context injection (voiceMode >= 2 only, to keep mode 1 snappy)
  let ragContext = '';
  if (rag && voiceMode >= 2) {
    const q = toolContext
      ? `${toolContext.toolName} ${JSON.stringify(toolContext.toolInput || {}).substring(0, 80)}`
      : 'session context';
    ragContext = await rag.buildContext(q, state).catch(() => '');
  }
  const userPrompt = buildVoicePrompts(intent, toolContext, history, state);
  const fullPrompt = ragContext ? `${ragContext}\n\n${userPrompt}` : userPrompt;
  const raw = await generateViaOllama(fullPrompt);
  if (!raw) return staticFallbackLine(toolContext, state);
  const words = raw.split(/\s+/);
  const limit = voiceMode >= 2 ? 70 : 22;
  if (words.length > limit) return words.slice(0, limit - 2).join(' ');
  return raw;
}

// ── Session summarization ─────────────────────────────────────────────────────

async function summarizeSession(sessionId, state) {
  try {
    if (!config.ollamaUrl || !config.ollamaModel) return;
    const totalOps = Object.values(state.toolCounts || {}).reduce((a, b) => a + b, 0);
    const topTools = Object.entries(state.toolCounts || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => `${n}× ${t}`).join(', ');
    const durationMin = Math.floor((Date.now() - (state.startTime || Date.now())) / 60000);

    const prompt = `Summarize this AI coding session in 2-3 sentences. Be specific.
Total: ${totalOps} operations (${topTools}). Duration: ${durationMin} minutes.
Key files edited: ${Object.keys(state.fileEditCounts || {}).join(', ') || 'none'}.
Errors: ${state.errorCount || 0}.
Write as if briefing someone who will continue this work next session.`;

    const base = config.ollamaUrl.replace(/\/v1.*$/, '');
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel, stream: false,
        messages: [
          { role: 'system', content: 'You are a concise session summarizer. 2-3 sentences max.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const summary = cleanModelOutput(data.message && data.message.content ? data.message.content : (data.response || ''));
    if (summary) memory.saveSessionSummary(sessionId, config.vault || '', summary);
  } catch {}
}

// ── Voice lock ────────────────────────────────────────────────────────────────

const VOICE_LOCK_PATH = path.join(config.neural || os.homedir(), '.voice-lock');
const LOCK_MAX_AGE_MS = 35000;

function acquireVoiceLock() {
  try {
    if (fs.existsSync(VOICE_LOCK_PATH)) {
      const stat = fs.statSync(VOICE_LOCK_PATH);
      if (Date.now() - stat.mtimeMs > LOCK_MAX_AGE_MS) fs.unlinkSync(VOICE_LOCK_PATH);
      else return false;
    }
    fs.writeFileSync(VOICE_LOCK_PATH, String(process.pid));
    return true;
  } catch { return false; }
}

function releaseVoiceLock() {
  try { fs.unlinkSync(VOICE_LOCK_PATH); } catch {}
}

// ── Vault writers ─────────────────────────────────────────────────────────────

function appendEntry(toolName, level, narrative, sessionId, ts, links) {
  const linkLine = links && links.length > 0 ? `\n*${links.join(' · ')}*` : '';
  const block = [`\n<!-- ENTRY:${ts}:${toolName}:L${level} -->`, narrative + linkLine, `<!-- /ENTRY -->`].join('\n');
  try { fs.appendFileSync(path.join(config.neural || os.homedir(), 'current.md'), block + '\n'); } catch {}
}

function writeStatus(toolName, level, narrative, state, awaitingInput) {
  const ts = new Date().toISOString();
  const toolSummary = Object.entries(state.toolCounts).map(([t, n]) => `${t} ×${n}`).join(' · ');
  const content = [
    '---', `updated: "${ts}"`, `session: ${state.sessionId || 'none'}`,
    `task: active`, `level: ${level}`, `tools: ${JSON.stringify(state.toolCounts)}`,
    `awaiting_input: ${awaitingInput}`, '---', '', narrative, '',
    `**Tools this session:** ${toolSummary || 'none'}`,
  ].join('\n');
  try { fs.writeFileSync(path.join(config.neural || os.homedir(), 'status.md'), content); } catch {}
}

function appendToolLog(entry) {
  try {
    fs.appendFileSync(
      path.join(config.neural || os.homedir(), 'tool-log.jsonl'),
      JSON.stringify(entry) + '\n'
    );
  } catch {}
}

function writeActiveTask(task, sessionId) {
  const content = [
    '---',
    `updated: "${new Date().toISOString()}"`,
    `session: ${sessionId || 'none'}`,
    '---', '', task,
  ].join('\n');
  try { fs.writeFileSync(path.join(config.neural || os.homedir(), 'context', 'active-task.md'), content); } catch {}
}

function appendRecentError(toolName, errorText, sessionId) {
  const entry = `\n- **${new Date().toISOString()}** [${sessionId}] \`${toolName}\`: ${errorText.substring(0, 120)}`;
  const filePath = path.join(config.neural || os.homedir(), 'context', 'recent-errors.md');
  let current = '';
  try { current = fs.readFileSync(filePath, 'utf8'); } catch { current = '---\nupdated: ""\ncount: 0\n---\n'; }
  const lines   = current.split('\n').filter(l => l.startsWith('- **'));
  const recent  = lines.slice(-4);
  const header  = current.split('\n- **')[0];
  try { fs.writeFileSync(filePath, header + '\n' + recent.join('\n') + entry); } catch {}
}

// ── Entity linker ─────────────────────────────────────────────────────────────

const ENTITY_PATTERNS = [
  { pattern: /agents\/(\w+)/,    link: (m) => `[[agents/${m[1]}]]` },
  { pattern: /toolkits\/(\w+)/, link: (m) => `[[toolkits/${m[1]}]]` },
  { pattern: /domo-workflows/,  link: () => `[[domo-workflows]]` },
  { pattern: /Sessions\/(\S+)/, link: (m) => `[[Sessions/${m[1]}]]` },
];

function extractEntityLinks(toolInput) {
  const text = JSON.stringify(toolInput || '');
  const links = [];
  for (const { pattern, link } of ENTITY_PATTERNS) {
    const match = text.match(pattern);
    if (match) links.push(link(match));
  }
  return links;
}

// ── Pattern detection ─────────────────────────────────────────────────────────

function detectAndWritePattern(currentToolName, state) {
  const recent = Object.keys(state.toolCounts);
  if (recent.length < 2) return;
  const sequenceKey = recent.slice(-3).join('-').toLowerCase();
  const patternDir  = path.join(config.neural || os.homedir(), 'patterns');
  const patternPath = path.join(patternDir, `${sequenceKey}.json`);
  let patternData   = { count: 0, sessions: [] };
  try { patternData = JSON.parse(fs.readFileSync(patternPath, 'utf8')); } catch {}
  if (!patternData.sessions.includes(state.sessionId)) {
    patternData.count++;
    patternData.sessions.push(state.sessionId);
    try {
      fs.mkdirSync(patternDir, { recursive: true });
      fs.writeFileSync(patternPath, JSON.stringify(patternData, null, 2));
    } catch {}
  }
  if (patternData.count >= (config.patternThreshold || 3)) {
    const notePath = path.join(patternDir, `${sequenceKey}.md`);
    if (!fs.existsSync(notePath)) {
      const tools = recent.slice(-3);
      const noteContent = [
        '---', `pattern: ${sequenceKey}`, `count: ${patternData.count}`,
        `detected: "${new Date().toISOString()}"`, '---',
        '', `# Pattern: ${tools.join(' → ')}`, '',
        `Detected ${patternData.count} times across sessions.`,
      ].join('\n');
      try { fs.writeFileSync(notePath, noteContent); } catch {}
    }
  }
  try {
    const allPatterns = fs.readdirSync(patternDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(patternDir, f), 'utf8'));
          return { sequence: f.replace('.json', ''), count: d.count };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    if (allPatterns.length > 0) {
      const hotLines = allPatterns.map(p => `- \`${p.sequence.split('-').join(' → ')}\` — ${p.count} sessions`);
      fs.writeFileSync(
        path.join(config.neural || os.homedir(), 'context', 'hot-paths.md'),
        `---\nupdated: "${new Date().toISOString()}"\n---\n\n${hotLines.join('\n')}\n`
      );
    }
  } catch {}
}

// ── Voice ─────────────────────────────────────────────────────────────────────

async function speak(toolContext, state) {
  if (!acquireVoiceLock()) return;
  try {
    const intent  = parseIntent();
    const history = loadVoiceHistory();
    const text    = await generateVoiceLine(intent, toolContext, history, state);
    if (!text) { releaseVoiceLock(); return; }
    if (history.length > 0 && history[history.length - 1] === text) { releaseVoiceLock(); return; }
    if (intent) markIntentSpoken();
    history.push(text);
    saveVoiceHistory(history);

    try { memory.saveTurn(toolContext && toolContext.sessionId ? toolContext.sessionId : 'unknown', 'jarvis', text, config.vault || ''); } catch {}

    await new Promise((resolve) => {
      const proc = spawn(
        config.pythonPath,
        [config.jarvisSpeakPath, '--path-only', text],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      );
      let wavPath = '', ttsErr = '';
      proc.stdout.on('data', d => { wavPath += d.toString(); });
      proc.stderr.on('data', d => { ttsErr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          try {
            fs.appendFileSync(
              path.join(config.neural || os.homedir(), 'context', 'recent-errors.md'),
              `\n- **${new Date().toISOString()}** TTS exit ${code}: ${ttsErr.substring(0, 100)}`
            );
          } catch {}
        }
        const trimmed = wavPath.trim();
        if (trimmed) {
          try { fs.writeFileSync(path.join(config.neural || os.homedir(), '.pending-audio'), path.basename(trimmed)); } catch {}
        }
        releaseVoiceLock();
        resolve();
      });
      proc.on('error', () => { releaseVoiceLock(); resolve(); });
    });
  } catch (err) {
    logError('speak', err);
    releaseVoiceLock();
  }
}

// ── PostToolUse handler ───────────────────────────────────────────────────────

async function handlePostToolUse(input) {
  try {
    const toolName    = input.tool_name || 'Unknown';
    const toolInput   = input.tool_input || {};
    const sessionId   = input.session_id || 'unknown';
    const responseText = typeof input.tool_response === 'string'
      ? input.tool_response
      : JSON.stringify(input.tool_response || '');
    const hasError = responseText.toLowerCase().includes('error') || responseText.toLowerCase().includes('failed');
    const ts = new Date().toISOString();

    const state       = loadSessionState();
    const isFirstCall = state.sessionId !== sessionId;
    const nextState   = updateSessionState(state, sessionId, toolName, toolInput, hasError);
    saveSessionState(nextState);

    // Pattern tracking
    if (patterns) {
      try { patterns.recordToolCall(toolName, sessionId); } catch {}
    }

    // Skill detection
    if (skills) {
      try {
        const recentTools = Object.keys(nextState.toolCounts); // approximate sequence
        const matchedSkill = skills.detectSkillFromSequence(recentTools);
        if (matchedSkill && matchedSkill.id !== lastAnnouncedSkill) {
          lastAnnouncedSkill = matchedSkill.id;
          skills.recordActivation(matchedSkill.id);
        }
      } catch {}
    }

    const score     = scoreToolCall(toolName, { isFirstCall, consecutiveSame: nextState.consecutiveSame, hasError });
    const level     = hasError ? 4 : scoreToLevel(score);
    const narrative = generateNarrative(toolName, toolInput, level);
    const links     = extractEntityLinks(toolInput);

    appendEntry(toolName, level, narrative, sessionId, ts, links);
    writeStatus(toolName, level, narrative, nextState, false);
    appendToolLog({ ts, session: sessionId, tool: toolName, args: toolInput, level, score });
    detectAndWritePattern(toolName, nextState);
    if (isFirstCall) writeActiveTask(`Session ${sessionId} — ${toolName} on ${JSON.stringify(toolInput).substring(0, 60)}`, sessionId);
    if (hasError) appendRecentError(toolName, responseText, sessionId);

    if (level >= (config.speakMinLevel || 1)) {
      await speak(
        { toolName, toolCounts: nextState.toolCounts, sessionId, toolInput, toolResponse: responseText, hasError },
        nextState
      );
    }

    // Pattern proposal announcement (non-blocking, level >= 2 only)
    if (patterns && level >= 2) {
      try {
        const proposal = patterns.checkForProposal(sessionId);
        if (proposal) {
          patterns.markProposed(proposal.fingerprint);
          setTimeout(async () => {
            const proposalText = `Sir, I've noticed a pattern — ${proposal.sequence.join(' then ')} — appearing across ${proposal.count} sessions. Shall I save that as a skill?`;
            try {
              let hist = [];
              try { hist = JSON.parse(fs.readFileSync(VOICE_HISTORY_PATH, 'utf8')); } catch {}
              hist.push(proposalText);
              fs.writeFileSync(VOICE_HISTORY_PATH, JSON.stringify(hist.slice(-20)));
              await speak({ toolName: 'Pattern', sessionId, isProposal: true }, nextState);
            } catch {}
          }, 2000);
        }
      } catch {}
    }
  } catch (err) {
    logError('handlePostToolUse', err);
  }
}

// ── Stop handler ──────────────────────────────────────────────────────────────

async function handleStop(input) {
  try {
    const sessionId = input.session_id || 'unknown';
    const ts = new Date().toISOString();
    const state = loadSessionState();
    const recentEntries = Object.entries(state.toolCounts).map(([tool]) => ({ tool }));
    const logLine = generateStopLine(recentEntries, false);

    const block = `\n<!-- STOP:${ts} -->\n${logLine}\n<!-- /STOP -->\n`;
    try { fs.appendFileSync(path.join(config.neural || os.homedir(), 'current.md'), block); } catch {}

    const toolSummary = Object.entries(state.toolCounts).map(([t, n]) => `${t} ×${n}`).join(' · ');
    const statusContent = [
      '---', `updated: "${ts}"`, `session: ${state.sessionId || sessionId}`,
      `task: complete`, `level: 2`, `tools: ${JSON.stringify(state.toolCounts)}`,
      `awaiting_input: false`, '---', '', logLine, '',
      `**Tools this session:** ${toolSummary || 'none'}`,
    ].join('\n');
    try { fs.writeFileSync(path.join(config.neural || os.homedir(), 'status.md'), statusContent); } catch {}
    try { fs.unlinkSync(INTENT_PATH); } catch {}
    try { fs.unlinkSync(VOICE_HISTORY_PATH); } catch {}

    // Speak closing line
    const totalOps  = Object.values(state.toolCounts).reduce((a, b) => a + b, 0);
    const topTools  = Object.entries(state.toolCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => `${n} ${t}`).join(', ');
    const stopIntent = parseIntent();
    const taskAction = stopIntent ? (stopIntent.action || '') : '';

    const stopState = {
      callCount: state.callCount || 0,
      toolCounts: state.toolCounts,
      startTime: state.startTime,
      errorCount: state.errorCount || 0,
      fileEditCounts: state.fileEditCounts || {},
    };

    await speak(
      {
        toolName: 'Stop', toolCounts: state.toolCounts,
        sessionId, isStop: true,
        totalOps, topTools, taskAction,
      },
      stopState
    );

    await summarizeSession(sessionId, { ...stopState, sessionId });

    // Reset pattern session sequence
    if (patterns) { try { patterns.resetSession(sessionId); } catch {} }
  } catch (err) {
    logError('handleStop', err);
  }
}

// ── Message router ────────────────────────────────────────────────────────────

function handleMessage(msg) {
  try {
    if (msg._type === 'stop') {
      handleStop(msg).catch(err => logError('handleStop async', err));
    } else {
      handlePostToolUse(msg).catch(err => logError('handlePostToolUse async', err));
    }
  } catch (err) {
    logError('handleMessage', err);
  }
}

// ── IPC server ────────────────────────────────────────────────────────────────

// Remove stale socket on non-Windows before binding
if (process.platform !== 'win32') {
  try { fs.unlinkSync(PIPE); } catch {}
}

const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleMessage(JSON.parse(line)); } catch (err) { logError('JSON parse', err); }
    }
  });
  socket.on('error', () => {}); // ignore individual socket errors
});

server.on('error', (err) => {
  logError('server', err);
  process.exit(1);
});

server.listen(PIPE, () => {
  console.log(`JARVIS daemon online — pipe: ${PIPE}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch {}
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(PIPE); } catch {}
  }
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

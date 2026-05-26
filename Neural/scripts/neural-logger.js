// Neural/scripts/neural-logger.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreToolCall(toolName, { isFirstCall, consecutiveSame, hasError }) {
  const base = config.toolScores[toolName] ?? 1;
  let score = base;
  if (isFirstCall) score += config.sessionStartBonus;
  if (hasError) score += config.errorBonus;
  if (consecutiveSame >= 3) score -= config.consecutiveSamePenalty;
  return Math.max(0, score);
}

function scoreToLevel(score) {
  if (score <= 1) return 1;
  if (score <= 3) return 2;
  if (score <= 5) return 3;
  return 4;
}

// ── Narrative templates (log text only — not spoken) ──────────────────────────

const TEMPLATES = {
  Read: {
    L1: (_) => `Reading.`,
    L2: (_) => `Analyzing the file structure, sir.`,
  },
  Write: {
    L1: (_) => `Writing.`,
    L2: (_) => `Updating the vault, sir.`,
  },
  Edit: {
    L1: (_) => `Editing.`,
    L2: (_) => `Making the edit, sir.`,
  },
  Bash: {
    L1: (_) => `Running command.`,
    L2: (_) => `Running the operation, sir.`,
  },
  Grep: {
    L1: (_) => `Searching.`,
    L2: (_) => `Searching the codebase, sir.`,
  },
  Glob: {
    L1: (_) => `Scanning.`,
    L2: (_) => `Scanning the file system, sir.`,
  },
  Agent: {
    L1: (_) => `Spawning subagent.`,
    L2: (_) => `Dispatching a subagent, sir.`,
  },
};

function generateNarrative(toolName, toolInput, level) {
  const tpl = TEMPLATES[toolName] ?? {
    L1: () => `Using ${toolName}.`,
    L2: () => `Running ${toolName}, sir.`,
  };
  const key = level >= 2 ? 'L2' : 'L1';
  return (tpl[key] ?? tpl.L1)(toolInput || {});
}

// ── Stop line (log text only — not spoken) ────────────────────────────────────

function generateStopLine(recentTools, awaitingInput) {
  if (awaitingInput) {
    return 'Standing by, sir. Your input is required.';
  }
  if (recentTools.length === 0) {
    return 'All systems nominal, sir.';
  }
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
  if (topTool && topTool[1] >= 3) {
    return `${topTool[1]} ${topTool[0].toLowerCase()} operations complete, sir.`;
  }
  return 'As always, sir, a pleasure.';
}

// ── Session state ─────────────────────────────────────────────────────────────

const STATE_PATH = path.join(config.neural, '.session-state.json');

function loadSessionState(statePath) {
  statePath = statePath || STATE_PATH;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { sessionId: null, callCount: 0, toolCounts: {}, lastTool: null, consecutiveSame: 0 };
  }
}

function updateSessionState(state, incomingSessionId, toolName) {
  const isNewSession = state.sessionId !== incomingSessionId;
  if (isNewSession) {
    return {
      sessionId: incomingSessionId,
      callCount: 1,
      toolCounts: { [toolName]: 1 },
      lastTool: toolName,
      consecutiveSame: 0,
    };
  }
  const consecutiveSame = state.lastTool === toolName ? state.consecutiveSame + 1 : 0;
  return {
    sessionId: incomingSessionId,
    callCount: state.callCount + 1,
    toolCounts: { ...state.toolCounts, [toolName]: (state.toolCounts[toolName] || 0) + 1 },
    lastTool: toolName,
    consecutiveSame,
  };
}

function saveSessionState(state, statePath) {
  statePath = statePath || STATE_PATH;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ── Intent reader (rich structured) ──────────────────────────────────────────

const INTENT_PATH = path.join(config.neural, 'context', 'current-intent.md');
const VOICE_HISTORY_PATH = path.join(config.neural, '.voice-history.json');

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
      action: fm.action || '',
      contextPrev: fm.context_prev || '',
      nextStep: fm.next_step || '',
      stepCurrent: parseInt(fm.step_current) || 0,
      stepTotal: parseInt(fm.step_total) || 0,
      needsApproval: fm.needs_approval === 'true',
      milestone: fm.milestone === 'true',
      milestoneText: fm.milestone_text || '',
    };
  } catch {
    return null;
  }
}

function markIntentSpoken() {
  try {
    const content = fs.readFileSync(INTENT_PATH, 'utf8');
    const updated = content.replace(/^spoken:\s*false/m, 'spoken: true');
    fs.writeFileSync(INTENT_PATH, updated);
  } catch { }
}

function writeCurrentIntent(fields, sessionId) {
  if (typeof fields === 'string') {
    fields = { action: fields };
  }
  const lines = [
    '---',
    `action: "${fields.action || ''}"`,
    `context_prev: "${fields.context_prev || ''}"`,
    `next_step: "${fields.next_step || ''}"`,
    `step_current: ${fields.step_current || 0}`,
    `step_total: ${fields.step_total || 0}`,
    `needs_approval: ${fields.needs_approval || false}`,
    `milestone: ${fields.milestone || false}`,
    `milestone_text: "${fields.milestone_text || ''}"`,
    `spoken: false`,
    `updated: "${new Date().toISOString()}"`,
    `session: ${sessionId || 'none'}`,
    '---',
  ];
  fs.writeFileSync(INTENT_PATH, lines.join('\n'));
}

function readCurrentIntent() {
  const intent = parseIntent();
  if (!intent) return null;
  return intent.action || null;
}

function loadVoiceHistory() {
  try {
    const raw = fs.readFileSync(VOICE_HISTORY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveVoiceHistory(history) {
  const trimmed = history.slice(-20);
  try { fs.writeFileSync(VOICE_HISTORY_PATH, JSON.stringify(trimmed)); } catch { }
}

// ── AI Voice Generation ───────────────────────────────────────────────────────

// Compact prompt for local small models — fewer prefill tokens = faster first token
const JARVIS_SYSTEM_PROMPT_LOCAL = `You are JARVIS, Iron Man's British AI assistant. Narrate software work in 8-14 words. Say "sir". Never mention tool names, file names, or paths. Output: one spoken line only, no quotes.
Examples: "The system is taking shape, sir." / "Your attention is required, sir." / "As always, sir, a pleasure."`;

// Distills a tool response into a one-line context snippet for JARVIS (maxContextMode).
function extractResponseSummary(toolName, responseText) {
  if (!responseText || typeof responseText !== 'string') return null;
  const lines = responseText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
  if (lines.length === 0) return null;
  // For long output (Bash, Read), prefer the last meaningful line (often the result)
  const snippet = (lines.length > 4 ? lines[lines.length - 1] : lines[0]).substring(0, 100);
  return snippet ? `Output: ${snippet}` : null;
}

// Extracts a brief, human-readable summary of what changed for Edit/Write/Bash calls.
function extractCodeChange(toolName, toolInput) {
  if (!toolInput) return null;
  if (toolName === 'Edit') {
    const firstChanged = (toolInput.old_string || '').split('\n')
      .find(l => l.trim().length > 4 && !l.trim().startsWith('//')) || '';
    const summary = firstChanged.trim().substring(0, 70);
    return summary ? `Modified: ${summary}` : null;
  }
  if (toolName === 'Write') {
    // Pull first meaningful identifier from content
    const match = (toolInput.content || '').match(/(?:function|const|class|async function|def)\s+(\w+)/);
    return match ? `Wrote: ${match[1]}` : null;
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = (toolInput.command || '').replace(/\s+/g, ' ').trim().substring(0, 60);
    return cmd ? `Ran: ${cmd}` : null;
  }
  return null;
}

// Builds a compact, structured prompt for the JARVIS voice AI.
// Auto-compacts to stay within ~150 token budget (600 chars).
function buildVoicePrompts(intent, toolContext, history) {
  const MAX_CHARS = 600;
  const toolInput    = toolContext && toolContext.toolInput;
  const toolName     = toolContext && toolContext.toolName;
  const toolResponse = toolContext && toolContext.toolResponse;

  // Priority-ordered context parts (lower = more important)
  const parts = [];

  if (toolContext && toolContext.isStop) {
    // Build a real completion brief so JARVIS can summarise what actually happened
    const totalOps = toolContext.totalOps || 0;
    const topTools = toolContext.topTools || '';
    const taskAction = toolContext.taskAction || '';
    if (totalOps > 0) {
      parts.push({ pri: 1, text: `Session complete. ${totalOps} operations: ${topTools}.` });
    } else {
      parts.push({ pri: 1, text: 'Session complete.' });
    }
    if (taskAction) parts.push({ pri: 2, text: `Task: ${taskAction.substring(0, 70)}` });
    parts.push({ pri: 3, text: 'Deliver a closing summary. What was accomplished this session?' });
  } else if (intent && intent.needsApproval) {
    parts.push({ pri: 1, text: 'Approval required before proceeding.' });
    if (intent.action) parts.push({ pri: 2, text: `For: ${intent.action.substring(0, 65)}` });
  } else if (intent && intent.action) {
    parts.push({ pri: 2, text: `Task: ${intent.action.substring(0, 70)}` });
    if (intent.stepCurrent > 0 && intent.stepTotal > 0) {
      parts.push({ pri: 4, text: `Step ${intent.stepCurrent} of ${intent.stepTotal}` });
    }
    if (intent.nextStep) {
      parts.push({ pri: 4, text: `Next: ${intent.nextStep.substring(0, 50)}` });
    }
    if (intent.milestone && intent.milestoneText) {
      parts.push({ pri: 3, text: `Milestone: ${intent.milestoneText.substring(0, 60)}` });
    }
  } else {
    parts.push({ pri: 3, text: 'Active session in progress.' });
  }

  const change = extractCodeChange(toolName, toolInput);
  if (change) parts.push({ pri: 3, text: change });

  if (config.maxContextMode && toolResponse) {
    const responseSummary = extractResponseSummary(toolName, toolResponse);
    if (responseSummary) parts.push({ pri: 3, text: responseSummary });
  }

  if (toolContext && toolContext.hasError) {
    parts.push({ pri: 1, text: `Error encountered.` });
  }

  // Last 2 voice lines only — prevent repetition without wasting tokens
  const avoid = history.filter(Boolean).slice(-2);
  if (avoid.length > 0) {
    parts.push({ pri: 5, text: `Do not repeat: ${avoid.map(l => `"${l.substring(0, 35)}"`).join('; ')}` });
  }

  // Build prompt within budget — highest priority parts first
  parts.sort((a, b) => a.pri - b.pri);
  let result = '';
  for (const p of parts) {
    if (result.length + p.text.length + 1 < MAX_CHARS) {
      result += (result ? '\n' : '') + p.text;
    }
  }

  const closing = (toolContext && toolContext.isStop)
    ? '\n\nSummarise this session in one JARVIS line.'
    : '\n\nGenerate the JARVIS line.';
  return result + closing;
}

// Strips quotes, markdown, labels, and extra whitespace from raw model output.
function cleanModelOutput(raw) {
  if (!raw) return null;
  return raw
    .replace(/^["'`]+|["'`]+$/g, '')     // surrounding quotes
    .replace(/^(JARVIS:|Output:|Line:|Response:)\s*/i, '') // leading labels
    .replace(/\*+/g, '')                  // markdown bold/italic
    .replace(/\s+/g, ' ')
    .trim();
}

async function generateViaOllama(userPrompt) {
  if (!config.ollamaUrl || !config.ollamaModel) return null;
  // Derive native Ollama chat endpoint from configured URL
  const base = config.ollamaUrl.replace(/\/v1.*$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: true,
        messages: [
          { role: 'system', content: JARVIS_SYSTEM_PROMPT_LOCAL },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) { clearTimeout(timer); return null; }

    let text = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.message?.content) {
            text += d.message.content;
            // Stop early once we have enough words — no need to wait for full completion
            if (text.split(/\s+/).filter(Boolean).length >= 14) {
              controller.abort();
              reader.cancel().catch(() => {});
              break outer;
            }
          }
          if (d.done) break outer;
        } catch {}
      }
    }
    clearTimeout(timer);
    return cleanModelOutput(text) || null;
  } catch (e) {
    clearTimeout(timer);
    // If we aborted due to word-count cutoff, text may still be valid
    const cleaned = cleanModelOutput(text);
    return cleaned || null;
  }
}

const FALLBACK_STOP_LINES = [
  'As always, sir, a pleasure.',
  'All systems nominal, sir.',
  'Standing by for your next directive, sir.',
  'Task complete. Awaiting further instructions, sir.',
  'That should do it, sir.',
];

const FALLBACK_ACTIVE_LINES = [
  'Working on it, sir.',
  'On it, sir.',
  'Processing, sir.',
  'Right away, sir.',
  'Understood, sir.',
  'I am afraid my language model is currently unreachable, sir. Working in silence.',
];

function rotateFallback(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function staticFallbackLine(toolContext) {
  if (!toolContext) return rotateFallback(FALLBACK_STOP_LINES);
  if (toolContext.isStop) return rotateFallback(FALLBACK_STOP_LINES);
  if (toolContext.hasError) return 'I am afraid an error has surfaced, sir. Flagging for your attention.';
  return rotateFallback(FALLBACK_ACTIVE_LINES);
}

async function generateVoiceLine(intent, toolContext, history) {
  const userPrompt = buildVoicePrompts(intent, toolContext, history);
  const raw = await generateViaOllama(userPrompt);
  if (!raw) return staticFallbackLine(toolContext);
  const words = raw.split(/\s+/);
  if (words.length > 22) return words.slice(0, 20).join(' ');
  return raw;
}

// ── Voice lock ────────────────────────────────────────────────────────────────

const VOICE_LOCK_PATH   = path.join(config.neural, '.voice-lock');
const TTS_ACTIVE_PATH   = path.join(config.neural, '.tts-active'); // set only during actual audio playback
const LOCK_MAX_AGE_MS   = 35000;

function acquireVoiceLock() {
  try {
    if (fs.existsSync(VOICE_LOCK_PATH)) {
      const stat = fs.statSync(VOICE_LOCK_PATH);
      if (Date.now() - stat.mtimeMs > LOCK_MAX_AGE_MS) {
        fs.unlinkSync(VOICE_LOCK_PATH);
      } else {
        return false;
      }
    }
    fs.writeFileSync(VOICE_LOCK_PATH, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseVoiceLock() {
  try { fs.unlinkSync(VOICE_LOCK_PATH); } catch { }
}

// ── Vault writers ─────────────────────────────────────────────────────────────

function appendEntry(toolName, level, narrative, sessionId, ts, links) {
  const linkLine = links && links.length > 0 ? `\n*${links.join(' · ')}*` : '';
  const block = [
    `\n<!-- ENTRY:${ts}:${toolName}:L${level} -->`,
    narrative + linkLine,
    `<!-- /ENTRY -->`,
  ].join('\n');
  fs.appendFileSync(path.join(config.neural, 'current.md'), block + '\n');
}

function writeStatus(toolName, level, narrative, state, awaitingInput) {
  const ts = new Date().toISOString();
  const toolSummary = Object.entries(state.toolCounts)
    .map(([t, n]) => `${t} ×${n}`)
    .join(' · ');
  const content = [
    '---',
    `updated: "${ts}"`,
    `session: ${state.sessionId || 'none'}`,
    `task: active`,
    `level: ${level}`,
    `tools: ${JSON.stringify(state.toolCounts)}`,
    `awaiting_input: ${awaitingInput}`,
    '---',
    '',
    narrative,
    '',
    `**Tools this session:** ${toolSummary || 'none'}`,
  ].join('\n');
  fs.writeFileSync(path.join(config.neural, 'status.md'), content);
}

function appendToolLog(entry) {
  fs.appendFileSync(
    path.join(config.neural, 'tool-log.jsonl'),
    JSON.stringify(entry) + '\n'
  );
}

function writeActiveTask(task, sessionId) {
  const content = [
    '---',
    `updated: "${new Date().toISOString()}"`,
    `session: ${sessionId || 'none'}`,
    '---',
    '',
    task,
  ].join('\n');
  fs.writeFileSync(path.join(config.neural, 'context', 'active-task.md'), content);
}

function appendRecentError(toolName, errorText, sessionId) {
  const entry = `\n- **${new Date().toISOString()}** [${sessionId}] \`${toolName}\`: ${errorText.substring(0, 120)}`;
  const filePath = path.join(config.neural, 'context', 'recent-errors.md');
  let current = '';
  try { current = fs.readFileSync(filePath, 'utf8'); } catch { current = '---\nupdated: ""\ncount: 0\n---\n'; }
  const lines = current.split('\n').filter(l => l.startsWith('- **'));
  const recent = lines.slice(-4);
  const header = current.split('\n- **')[0];
  fs.writeFileSync(filePath, header + '\n' + recent.join('\n') + entry);
}

// ── Cross-vault entity linker ─────────────────────────────────────────────────

const ENTITY_PATTERNS = [
  { pattern: /agents\/(\w+)/, link: (m) => `[[agents/${m[1]}]]` },
  { pattern: /toolkits\/(\w+)/, link: (m) => `[[toolkits/${m[1]}]]` },
  { pattern: /domo-workflows/, link: () => `[[domo-workflows]]` },
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
  const patternDir = path.join(config.neural, 'patterns');
  const patternPath = path.join(patternDir, `${sequenceKey}.json`);

  let patternData = { count: 0, sessions: [] };
  try { patternData = JSON.parse(fs.readFileSync(patternPath, 'utf8')); } catch { }

  if (!patternData.sessions.includes(state.sessionId)) {
    patternData.count++;
    patternData.sessions.push(state.sessionId);
    fs.mkdirSync(patternDir, { recursive: true });
    fs.writeFileSync(patternPath, JSON.stringify(patternData, null, 2));
  }

  if (patternData.count >= config.patternThreshold) {
    const notePath = path.join(patternDir, `${sequenceKey}.md`);
    if (!fs.existsSync(notePath)) {
      const tools = recent.slice(-3);
      const sessionLinks = patternData.sessions.map(s => `[[Neural/sessions/${s}]]`).join('\n- ');
      const noteContent = [
        `---`,
        `pattern: ${sequenceKey}`,
        `count: ${patternData.count}`,
        `detected: "${new Date().toISOString()}"`,
        `---`,
        ``,
        `# Pattern: ${tools.join(' → ')}`,
        ``,
        `Detected ${patternData.count} times across sessions.`,
        ``,
        `## Sessions`,
        `- ${sessionLinks}`,
      ].join('\n');
      fs.writeFileSync(notePath, noteContent);
    }
  }

  // Update hot-paths.md
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
        path.join(config.neural, 'context', 'hot-paths.md'),
        `---\nupdated: "${new Date().toISOString()}"\n---\n\n${hotLines.join('\n')}\n`
      );
    }
  } catch { }
}

// ── Voice ─────────────────────────────────────────────────────────────────────

async function speak(toolContext) {
  if (!acquireVoiceLock()) return;
  try {
    const intent = parseIntent();
    const history = loadVoiceHistory();

    const text = await generateVoiceLine(intent, toolContext, history);
    if (!text) return;

    if (history.length > 0 && history[history.length - 1] === text) return;

    if (intent) markIntentSpoken();
    // Save history first — subtitle appears the moment audio starts
    history.push(text);
    saveVoiceHistory(history);

    await new Promise((resolve) => {
      const proc = spawn(
        config.pythonPath, [config.jarvisSpeakPath, '--path-only', text],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      );
      let wavPath = '';
      let ttsErr = '';
      proc.stdout.on('data', d => { wavPath += d.toString(); });
      proc.stderr.on('data', d => { ttsErr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          try {
            fs.appendFileSync(
              path.join(config.neural, 'context', 'recent-errors.md'),
              `\n- **${new Date().toISOString()}** TTS exit ${code}: ${ttsErr.substring(0, 100)}`
            );
          } catch {}
        }
        const trimmed = wavPath.trim();
        if (trimmed) {
          try {
            fs.writeFileSync(
              path.join(config.neural, '.pending-audio'),
              path.basename(trimmed)
            );
          } catch {}
        }
        releaseVoiceLock();
        resolve();
      });
      proc.on('error', () => {
        releaseVoiceLock();
        resolve();
      });
    });
  } catch {
    releaseVoiceLock();
  }
}

// ── PostToolUse handler ───────────────────────────────────────────────────────

async function handlePostToolUse(input) {
  const toolName = input.tool_name || 'Unknown';
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || 'unknown';
  const responseText = typeof input.tool_response === 'string'
    ? input.tool_response
    : JSON.stringify(input.tool_response || '');
  const hasError = responseText.toLowerCase().includes('error') || responseText.toLowerCase().includes('failed');
  const ts = new Date().toISOString();

  const state = loadSessionState();
  const isFirstCall = state.sessionId !== sessionId;
  const nextState = updateSessionState(state, sessionId, toolName);
  saveSessionState(nextState);

  const score = scoreToolCall(toolName, {
    isFirstCall,
    consecutiveSame: nextState.consecutiveSame,
    hasError,
  });
  const level = hasError ? 4 : scoreToLevel(score);
  const narrative = generateNarrative(toolName, toolInput, level);

  const links = extractEntityLinks(toolInput);
  appendEntry(toolName, level, narrative, sessionId, ts, links);
  writeStatus(toolName, level, narrative, nextState, false);
  appendToolLog({ ts, session: sessionId, tool: toolName, args: toolInput, level, score });

  detectAndWritePattern(toolName, nextState);

  if (isFirstCall) {
    writeActiveTask(`Session ${sessionId} — ${toolName} on ${JSON.stringify(toolInput).substring(0, 60)}`, sessionId);
  }

  if (hasError) {
    appendRecentError(toolName, responseText, sessionId);
  }

  if (level >= config.speakMinLevel) {
    await speak({ toolName, toolCounts: nextState.toolCounts, sessionId, toolInput, toolResponse: responseText, hasError });
  }
}

// ── Stop handler ──────────────────────────────────────────────────────────────

async function handleStopSync(input) {
  const sessionId = input.session_id || 'unknown';
  const ts = new Date().toISOString();

  const state = loadSessionState();
  const recentEntries = Object.entries(state.toolCounts).map(([tool]) => ({ tool }));
  const logLine = generateStopLine(recentEntries, false);

  const block = `\n<!-- STOP:${ts} -->\n${logLine}\n<!-- /STOP -->\n`;
  fs.appendFileSync(path.join(config.neural, 'current.md'), block);

  const toolSummary = Object.entries(state.toolCounts).map(([t, n]) => `${t} ×${n}`).join(' · ');
  const statusContent = [
    '---',
    `updated: "${ts}"`,
    `session: ${state.sessionId || sessionId}`,
    `task: complete`,
    `level: 2`,
    `tools: ${JSON.stringify(state.toolCounts)}`,
    `awaiting_input: false`,
    '---',
    '',
    logLine,
    '',
    `**Tools this session:** ${toolSummary || 'none'}`,
  ].join('\n');
  fs.writeFileSync(path.join(config.neural, 'status.md'), statusContent);

  try { fs.unlinkSync(INTENT_PATH); } catch { }
  try { fs.unlinkSync(VOICE_HISTORY_PATH); } catch { }
}

async function handleStop(input) {
  await handleStopSync(input);
  await speak({ toolName: 'Stop', toolCounts: loadSessionState().toolCounts,
    sessionId: input.session_id || 'unknown', isStop: true });
}

// ── Entry point ───────────────────────────────────────────────────────────────
// The hook must NOT block Claude's tool-call pipeline. Architecture:
//   Main process  → sync file I/O only, spawns detached voice worker, exits fast
//   Voice worker  → Ollama + TTS, runs fully async, never blocks Claude
//   --stop        → blocking OK (Claude is awaiting user input anyway)
//   --worker      → voice-only path called by the detached child

if (require.main === module) {
  const isStop   = process.argv.includes('--stop');
  const isWorker = process.argv.includes('--worker');

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', async () => {
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch { input = {}; }

    if (isStop) {
      // Capture context BEFORE handleStopSync clears the intent and history files
      const stopState  = loadSessionState();
      const stopIntent = parseIntent();
      const totalOps   = Object.values(stopState.toolCounts).reduce((a, b) => a + b, 0);
      const topTools   = Object.entries(stopState.toolCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([t, n]) => `${n} ${t}`).join(', ');
      const taskAction = stopIntent ? (stopIntent.action || '') : '';

      await handleStopSync(input);

      const workerPayload = JSON.stringify({
        ...input,
        _toolCounts: stopState.toolCounts,
        _totalOps:   totalOps,
        _topTools:   topTools,
        _taskAction: taskAction,
      });
      const worker = spawn(process.execPath, [__filename, '--worker-stop'],
        { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
      worker.stdin.write(workerPayload);
      worker.stdin.end();
      worker.unref();
      return;
    }

    if (process.argv.includes('--worker-stop')) {
      await speak({
        toolName:   'Stop',
        toolCounts: input._toolCounts || {},
        sessionId:  input.session_id || 'unknown',
        isStop:     true,
        totalOps:   input._totalOps  || 0,
        topTools:   input._topTools  || '',
        taskAction: input._taskAction || '',
      });
      return;
    }

    if (isWorker) {
      // Detached voice worker: only runs speak(), all file I/O already done by main
      const toolName    = input.tool_name || 'Unknown';
      const toolInput   = input.tool_input || {};
      const sessionId   = input.session_id || 'unknown';
      const responseText = typeof input.tool_response === 'string'
        ? input.tool_response : JSON.stringify(input.tool_response || '');
      const hasError = responseText.toLowerCase().includes('error')
        || responseText.toLowerCase().includes('failed');
      const state = loadSessionState();
      const isFirstCall = state.sessionId !== sessionId;
      const nextState = isFirstCall ? state : state; // already updated by main process
      if (input._level >= config.speakMinLevel) {
        await speak({ toolName, toolCounts: nextState.toolCounts, sessionId,
          toolInput, toolResponse: responseText, hasError });
      }
      return;
    }

    // Main process: all sync file I/O (fast), then spawn detached voice worker
    const toolName    = input.tool_name || 'Unknown';
    const toolInput   = input.tool_input || {};
    const sessionId   = input.session_id || 'unknown';
    const responseText = typeof input.tool_response === 'string'
      ? input.tool_response : JSON.stringify(input.tool_response || '');
    const hasError = responseText.toLowerCase().includes('error')
      || responseText.toLowerCase().includes('failed');
    const ts = new Date().toISOString();

    const state    = loadSessionState();
    const isFirstCall = state.sessionId !== sessionId;
    const nextState = updateSessionState(state, sessionId, toolName);
    saveSessionState(nextState);

    const score    = scoreToolCall(toolName, { isFirstCall, consecutiveSame: nextState.consecutiveSame, hasError });
    const level    = hasError ? 4 : scoreToLevel(score);
    const narrative = generateNarrative(toolName, toolInput, level);
    const links    = extractEntityLinks(toolInput);

    appendEntry(toolName, level, narrative, sessionId, ts, links);
    writeStatus(toolName, level, narrative, nextState, false);
    appendToolLog({ ts, session: sessionId, tool: toolName, args: toolInput, level, score });
    detectAndWritePattern(toolName, nextState);
    if (isFirstCall) writeActiveTask(
      `Session ${sessionId} — ${toolName} on ${JSON.stringify(toolInput).substring(0, 60)}`, sessionId);
    if (hasError) appendRecentError(toolName, responseText, sessionId);

    // Spawn detached voice worker — main process exits immediately after this
    if (level >= config.speakMinLevel) {
      const payload = JSON.stringify({ ...input, _level: level });
      const worker = spawn(process.execPath, [__filename, '--worker'],
        { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
      worker.stdin.write(payload);
      worker.stdin.end();
      worker.unref();
    }
    // Exit immediately — Claude is unblocked
  });
}

module.exports = {
  scoreToolCall, scoreToLevel, generateNarrative, generateStopLine,
  loadSessionState, updateSessionState, saveSessionState,
  appendEntry, writeStatus, appendToolLog, writeActiveTask, appendRecentError,
  readCurrentIntent, writeCurrentIntent, parseIntent, markIntentSpoken,
  extractEntityLinks, detectAndWritePattern,
  generateVoiceLine, speak, handlePostToolUse, handleStopSync, handleStop,
};

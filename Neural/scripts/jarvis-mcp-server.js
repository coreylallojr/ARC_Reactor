'use strict';
// JARVIS MCP Server v4.0.0
// Full Model Context Protocol server over stdio — pure Node.js built-ins only.
// Exposes 6 tools, 4 resources, and 3 prompts to Claude Code and other MCP clients.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const DB_DIR = path.join(os.homedir(), '.claude', 'jarvis-db');

// ---------------------------------------------------------------------------
// Module imports (graceful degradation if not yet initialized)
// ---------------------------------------------------------------------------
let vector = null;
try { vector = require('./jarvis-vector'); } catch (e) {
  process.stderr.write('[JARVIS MCP] jarvis-vector not available: ' + (e.message || e) + '\n');
}

let graph = null;
try { graph = require('./jarvis-graph'); } catch (e) {
  process.stderr.write('[JARVIS MCP] jarvis-graph not available: ' + (e.message || e) + '\n');
}

let memory = null;
try { memory = require('./jarvis-memory'); } catch (e) {
  process.stderr.write('[JARVIS MCP] jarvis-memory not available: ' + (e.message || e) + '\n');
}

// ---------------------------------------------------------------------------
// MCP stdio transport
// ---------------------------------------------------------------------------
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop(); // keep incomplete trailing line
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handleMessage(JSON.parse(line)); } catch (e) {
      process.stderr.write('[JARVIS MCP] Parse error: ' + (e.message || e) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':          return handleInitialize(id, params);
    case 'initialized':         return; // notification — no response
    case 'tools/list':          return handleToolsList(id);
    case 'tools/call':          return handleToolCall(id, params);
    case 'resources/list':      return handleResourcesList(id);
    case 'resources/read':      return handleResourceRead(id, params);
    case 'prompts/list':        return handlePromptsList(id);
    case 'prompts/get':         return handlePromptGet(id, params);
    case 'shutdown':            return process.exit(0);
    case 'exit':                return process.exit(0);
    default:
      if (id !== undefined) sendError(id, -32601, 'Method not found');
  }
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------
function handleInitialize(id, params) {
  sendResult(id, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: 'jarvis', version: '4.0.0' },
  });
}

// ---------------------------------------------------------------------------
// Tools list
// ---------------------------------------------------------------------------
function handleToolsList(id) {
  sendResult(id, {
    tools: [
      {
        name: 'jarvis_recall',
        description: 'Search JARVIS knowledge base — retrieves relevant code, past errors, session history, and learned patterns using semantic + keyword fusion',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            topK:  { type: 'number', description: 'Results to return (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'jarvis_remember',
        description: 'Save a fact, decision, or note to JARVIS permanent memory',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            type: {
              type: 'string',
              enum: ['fact', 'decision', 'error_fix', 'note'],
              default: 'note',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'jarvis_skill_run',
        description: 'Activate a named JARVIS skill — runs an autonomous workflow',
        inputSchema: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Name of the skill to run' },
          },
          required: ['skillName'],
        },
      },
      {
        name: 'jarvis_graph_query',
        description: 'Query the JARVIS knowledge graph — find related files, functions, errors, and their connections',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            depth:  { type: 'number', default: 2 },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'jarvis_context_get',
        description: 'Get JARVIS current session context — active skill, focus file, error streak, git state',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'jarvis_speak',
        description: 'Make JARVIS speak a line via TTS — announces status from within a Claude Code session',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text for JARVIS to speak' },
          },
          required: ['text'],
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tool error helper
// ---------------------------------------------------------------------------
function toolError(toolName, message) {
  return {
    content: [{
      type: 'text',
      text: `JARVIS: ${toolName} encountered an error — ${message}. Proceeding without JARVIS context.`,
    }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// HTTP POST helper (fire-and-collect, no external deps)
// ---------------------------------------------------------------------------
function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    try {
      const url     = new URL(urlStr);
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const options = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + (url.search || ''),
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = http.request(options, res => {
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolJarvisRecall(params) {
  try {
    if (!vector) return toolError('jarvis_recall', 'JARVIS knowledge base not yet initialized');
    const query = params.query;
    const topK  = typeof params.topK === 'number' ? params.topK : 5;
    const results = await vector.search(query, topK);
    if (!results || results.length === 0) {
      return { content: [{ type: 'text', text: 'JARVIS recall: no matching entries found for query.' }] };
    }
    const lines = results.map((r, i) =>
      `Result ${i + 1} [source: ${r.sourcePath}] [type: ${r.chunkType}]:\n${r.content}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (e) {
    return toolError('jarvis_recall', e.message || String(e));
  }
}

function toolJarvisRemember(params) {
  try {
    if (!vector) return toolError('jarvis_remember', 'JARVIS knowledge base not yet initialized');
    const content  = params.content;
    const memType  = params.type || 'note';
    const chunkId  = vector.addChunk('mcp-memory', memType, content);
    if (graph) {
      const nodeId = `mcp-memory::${memType}::${Date.now()}`;
      graph.addNode(nodeId, 'concept', { content: content.slice(0, 200), memType, savedAt: Date.now() });
    }
    return {
      content: [{
        type: 'text',
        text: `JARVIS: memory saved — type=${memType}, id=${chunkId || 'queued'}. Embeddings will be computed in background.`,
      }],
    };
  } catch (e) {
    return toolError('jarvis_remember', e.message || String(e));
  }
}

async function toolJarvisSkillRun(params) {
  const skillName = params.skillName;
  try {
    const result = await httpPost(`http://localhost:7476/v1/skills/${encodeURIComponent(skillName)}/run`, {});
    return {
      content: [{
        type: 'text',
        text: `JARVIS skill "${skillName}" executed.\nStatus: ${result.status}\nResponse: ${typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : result.body}`,
      }],
    };
  } catch (e) {
    // API server unavailable — queue the skill
    try {
      fs.mkdirSync(DB_DIR, { recursive: true });
      const queuePath = path.join(DB_DIR, 'skill-queue.json');
      let queue = [];
      try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch {}
      queue.push({ skillName, queuedAt: Date.now(), status: 'pending' });
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
    } catch (writeErr) {
      process.stderr.write('[JARVIS MCP] skill-queue write error: ' + writeErr.message + '\n');
    }
    return {
      content: [{
        type: 'text',
        text: `Skill "${skillName}" queued — JARVIS will execute when daemon processes it. (API server not available at localhost:7476)`,
      }],
    };
  }
}

function toolJarvisGraphQuery(params) {
  try {
    if (!graph) return toolError('jarvis_graph_query', 'JARVIS knowledge graph not yet initialized');
    const nodeId = params.nodeId;
    const depth  = typeof params.depth === 'number' ? params.depth : 2;
    const root   = graph.getNode(nodeId);
    if (!root) {
      return { content: [{ type: 'text', text: `JARVIS graph: node "${nodeId}" not found.` }] };
    }
    const neighbors = graph.getNeighbors(nodeId, { maxDepth: depth });
    const lines = [
      `Root node: ${nodeId} [type: ${root.type}]`,
      `  data: ${JSON.stringify(root.data)}`,
      '',
      `Connected nodes (depth ${depth}):`,
    ];
    if (neighbors.length === 0) {
      lines.push('  (no connections found)');
    } else {
      for (const { node, edge, depth: d } of neighbors) {
        const direction = edge.from === nodeId ? '→' : '←';
        lines.push(`  depth=${d} ${direction} ${node.id} [type: ${node.type}] via "${edge.type}" (weight=${edge.weight})`);
        if (node.data && Object.keys(node.data).length > 0) {
          lines.push(`    data: ${JSON.stringify(node.data).slice(0, 120)}`);
        }
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return toolError('jarvis_graph_query', e.message || String(e));
  }
}

function toolJarvisContextGet() {
  try {
    const sessionDir = config.neural || path.join(__dirname, '..', 'sessions');
    const sessionPath = path.join(sessionDir, '.session-state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch {}

    if (Object.keys(state).length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'JARVIS session state: no active session found. Session state will be available once JARVIS daemon is running.',
        }],
      };
    }

    const lines = [
      'JARVIS Current Session Context',
      '==============================',
      `Active skill:   ${state.activeSkill     || 'none'}`,
      `Focus file:     ${state.focusFile       || 'none'}`,
      `Error streak:   ${state.errorStreak     ?? 0}`,
      `Git branch:     ${state.gitBranch       || 'unknown'}`,
      `Git status:     ${state.gitStatus       || 'unknown'}`,
      `Session ID:     ${state.sessionId       || 'unknown'}`,
      `Tool calls:     ${state.toolCallCount   ?? 0}`,
      `Started at:     ${state.startedAt ? new Date(state.startedAt).toISOString() : 'unknown'}`,
      `Last updated:   ${state.updatedAt ? new Date(state.updatedAt).toISOString() : 'unknown'}`,
    ];
    if (state.recentTools && Array.isArray(state.recentTools)) {
      lines.push(`Recent tools:   ${state.recentTools.slice(-5).join(', ')}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return toolError('jarvis_context_get', e.message || String(e));
  }
}

async function toolJarvisSpeak(params) {
  const text = params.text;
  try {
    const result = await httpPost('http://localhost:7475/voice/speak', { text });
    return {
      content: [{
        type: 'text',
        text: `JARVIS TTS: "${text}" — sent to voice server (status ${result.status}).`,
      }],
    };
  } catch (e) {
    // Voice server unavailable — write to pending file
    try {
      const pendingPath = path.join(DB_DIR, '.pending-audio-text');
      fs.mkdirSync(DB_DIR, { recursive: true });
      fs.writeFileSync(pendingPath, text, 'utf8');
    } catch (writeErr) {
      process.stderr.write('[JARVIS MCP] pending-audio-text write error: ' + writeErr.message + '\n');
    }
    return {
      content: [{
        type: 'text',
        text: `JARVIS TTS: "${text}" — queued to .pending-audio-text (voice server not available at localhost:7475).`,
      }],
    };
  }
}

// ---------------------------------------------------------------------------
// Tool call dispatcher
// ---------------------------------------------------------------------------
async function handleToolCall(id, params) {
  const name      = params && params.name;
  const toolInput = (params && params.arguments) || {};

  let result;
  try {
    switch (name) {
      case 'jarvis_recall':      result = await toolJarvisRecall(toolInput);      break;
      case 'jarvis_remember':    result =       toolJarvisRemember(toolInput);    break;
      case 'jarvis_skill_run':   result = await toolJarvisSkillRun(toolInput);    break;
      case 'jarvis_graph_query': result =       toolJarvisGraphQuery(toolInput);  break;
      case 'jarvis_context_get': result =       toolJarvisContextGet();           break;
      case 'jarvis_speak':       result = await toolJarvisSpeak(toolInput);       break;
      default:
        return sendError(id, -32601, `Unknown tool: ${name}`);
    }
  } catch (e) {
    result = toolError(name || 'unknown', e.message || String(e));
  }

  sendResult(id, result);
}

// ---------------------------------------------------------------------------
// Resources list
// ---------------------------------------------------------------------------
function handleResourcesList(id) {
  sendResult(id, {
    resources: [
      {
        uri:         'jarvis://session-state',
        name:        'JARVIS Session State',
        description: 'Current session context: active skill, tool counts, error streak, focus file',
        mimeType:    'application/json',
      },
      {
        uri:         'jarvis://skill-registry',
        name:        'JARVIS Skill Registry',
        description: 'All learned and built-in skills with trigger phrases and usage counts',
        mimeType:    'application/json',
      },
      {
        uri:         'jarvis://knowledge-graph',
        name:        'JARVIS Knowledge Graph',
        description: 'Project knowledge graph — files, functions, errors, and their relationships (capped at 200 nodes)',
        mimeType:    'application/json',
      },
      {
        uri:         'jarvis://recent-memory',
        name:        'JARVIS Recent Memory',
        description: 'Last 10 conversation turns and session summary',
        mimeType:    'text/plain',
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Resource read
// ---------------------------------------------------------------------------
function handleResourceRead(id, params) {
  const uri = params && params.uri;

  try {
    switch (uri) {
      case 'jarvis://session-state': {
        const sessionDir  = config.neural || path.join(__dirname, '..', 'sessions');
        const sessionPath = path.join(sessionDir, '.session-state.json');
        let text = '{}';
        try { text = fs.readFileSync(sessionPath, 'utf8'); } catch {}
        return sendResult(id, {
          contents: [{ uri, mimeType: 'application/json', text }],
        });
      }

      case 'jarvis://skill-registry': {
        const skillsPath = path.join(DB_DIR, 'skills.json');
        let text = '[]';
        try { text = fs.readFileSync(skillsPath, 'utf8'); } catch {}
        return sendResult(id, {
          contents: [{ uri, mimeType: 'application/json', text }],
        });
      }

      case 'jarvis://knowledge-graph': {
        if (!graph) {
          return sendResult(id, {
            contents: [{ uri, mimeType: 'application/json', text: '{"nodes":[],"links":[]}' }],
          });
        }
        const d3 = graph.toD3Format();
        // Cap at 200 hottest nodes
        if (d3.nodes.length > 200) {
          // Build a set of hot node ids using graph.getHotNodes
          const hotNodes = graph.getHotNodes(200);
          const hotIds   = new Set(hotNodes.map(n => n.id));
          d3.nodes = d3.nodes.filter(n => hotIds.has(n.id));
          d3.links = d3.links.filter(l => hotIds.has(l.source) && hotIds.has(l.target));
        }
        return sendResult(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(d3) }],
        });
      }

      case 'jarvis://recent-memory': {
        if (!memory) {
          return sendResult(id, {
            contents: [{ uri, mimeType: 'text/plain', text: 'JARVIS memory module not yet initialized.' }],
          });
        }
        const projectPath = config.neural || process.cwd();
        const turns = memory.getConversationHistory(projectPath, 10);
        const lines = ['JARVIS Recent Memory — last 10 turns', '====================================='];
        if (!turns || turns.length === 0) {
          lines.push('(no conversation history for this project)');
        } else {
          for (const t of turns) {
            const ts = t.timestamp ? new Date(t.timestamp).toISOString() : 'unknown';
            lines.push(`[${ts}] [${t.role}] ${(t.content || '').slice(0, 300)}`);
          }
        }
        return sendResult(id, {
          contents: [{ uri, mimeType: 'text/plain', text: lines.join('\n') }],
        });
      }

      default:
        return sendError(id, -32602, `Unknown resource URI: ${uri}`);
    }
  } catch (e) {
    return sendError(id, -32603, `Resource read error: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// Prompts list
// ---------------------------------------------------------------------------
function handlePromptsList(id) {
  sendResult(id, {
    prompts: [
      {
        name:        'jarvis_debug',
        description: 'JARVIS debug mode — systematic error analysis with full context injection',
      },
      {
        name:        'jarvis_architect',
        description: 'JARVIS architecture review mode — evaluates design patterns, coupling, and scalability',
      },
      {
        name:        'jarvis_review',
        description: 'JARVIS code review mode — reviews diff/code for bugs, security, and style issues',
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Prompt context helper
// ---------------------------------------------------------------------------
function getContextSnippet() {
  try {
    const sessionDir  = config.neural || path.join(__dirname, '..', 'sessions');
    const sessionPath = path.join(sessionDir, '.session-state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch {}
    return [
      `Active skill: ${state.activeSkill || 'none'}`,
      `Focus file:   ${state.focusFile   || 'none'}`,
      `Error streak: ${state.errorStreak ?? 0}`,
      `Git branch:   ${state.gitBranch   || 'unknown'}`,
    ].join('\n');
  } catch {
    return 'Session context unavailable.';
  }
}

// ---------------------------------------------------------------------------
// Prompt get
// ---------------------------------------------------------------------------
function handlePromptGet(id, params) {
  const name = params && params.name;
  const ctx  = getContextSnippet();

  switch (name) {
    case 'jarvis_debug':
      return sendResult(id, {
        description: 'JARVIS debug mode prompt',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'You are JARVIS v4 in DEBUG mode.',
                '',
                'Current session context:',
                ctx,
                '',
                'Instructions:',
                '1. Use jarvis_recall to search for related past errors before diagnosing.',
                '2. Identify the root cause — not just symptoms.',
                '3. Check error streak; if > 3 consecutive errors, widen the investigation scope.',
                '4. After fixing, call jarvis_remember with type="error_fix" to capture the solution.',
                '5. Update the knowledge graph via jarvis_graph_query to understand file relationships.',
                '6. Confirm the fix with a minimal reproduction check.',
                '',
                'Begin systematic debug analysis.',
              ].join('\n'),
            },
          },
        ],
      });

    case 'jarvis_architect':
      return sendResult(id, {
        description: 'JARVIS architecture review mode prompt',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'You are JARVIS v4 in ARCHITECT mode.',
                '',
                'Current session context:',
                ctx,
                '',
                'Instructions:',
                '1. Use jarvis_graph_query to explore the project knowledge graph and understand component relationships.',
                '2. Use jarvis_recall to retrieve past architectural decisions and patterns.',
                '3. Evaluate: coupling, cohesion, scalability, and separation of concerns.',
                '4. Identify bottlenecks, circular dependencies, and over-engineered abstractions.',
                '5. Propose concrete refactors with rationale.',
                '6. Save significant decisions via jarvis_remember with type="decision".',
                '',
                'Begin architecture review.',
              ].join('\n'),
            },
          },
        ],
      });

    case 'jarvis_review':
      return sendResult(id, {
        description: 'JARVIS code review mode prompt',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'You are JARVIS v4 in CODE REVIEW mode.',
                '',
                'Current session context:',
                ctx,
                '',
                'Instructions:',
                '1. Use jarvis_recall to check if similar patterns have caused bugs before.',
                '2. Review for: correctness, security vulnerabilities, performance issues, and style consistency.',
                '3. Flag any error handling gaps — especially unhandled promise rejections and missing try/catch.',
                '4. Check for hardcoded secrets, paths, or magic numbers.',
                '5. Evaluate test coverage for new code paths.',
                '6. Use jarvis_remember with type="note" to record recurring issues for future reviews.',
                '',
                'Begin code review.',
              ].join('\n'),
            },
          },
        ],
      });

    default:
      return sendError(id, -32602, `Unknown prompt: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
process.stderr.write('[JARVIS MCP] stdio server online — 6 tools, 4 resources\n');

/*
 * REGISTRATION — add to ~/.claude/mcp.json:
 * {
 *   "mcpServers": {
 *     "jarvis": {
 *       "command": "node",
 *       "args": ["PATH_TO_THIS_FILE"]
 *     }
 *   }
 * }
 * The setup wizard writes this automatically.
 */

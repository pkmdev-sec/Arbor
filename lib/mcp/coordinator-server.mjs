#!/usr/bin/env node

/**
 * Swarm Coordinator MCP Server
 *
 * A minimal stdio MCP server implementing JSON-RPC 2.0.
 * Runs as a subprocess per agent — Claude Code starts it via --mcp-config flag.
 *
 * Protocol: JSON-RPC 2.0 over stdio (line-delimited)
 * State: Written atomically to <SWARM_WORK_DIR>/<SWARM_AGENT_ID>-mcp-state.json
 * Events: Appended to <SWARM_WORK_DIR>/ipc.jsonl for backward compat with TUI
 */

import { createInterface } from 'readline';
import { writeFileSync, appendFileSync, readFileSync, renameSync, copyFileSync, unlinkSync } from 'fs';
import { SWARM_TOOLS } from './tools.mjs';

// Environment variables
const AGENT_ID = process.env.SWARM_AGENT_ID || 'unknown';
const WORK_DIR = process.env.SWARM_WORK_DIR || '/tmp';
const SCOPE = process.env.SWARM_SCOPE || '';
const TASK = process.env.SWARM_TASK || '';
const CONTEXT_FILE = process.env.SWARM_CONTEXT_FILE || '';

// State file paths
const STATE_FILE = `${WORK_DIR}/${AGENT_ID}-mcp-state.json`;
const IPC_LOG = `${WORK_DIR}/ipc.jsonl`;

// In-memory state
const state = {
  agentId: AGENT_ID,
  lastUpdate: Date.now(),
  progress: null,
  result: null,
  files_touched: [],
  logs: []
};

/**
 * Write state atomically to disk
 */
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    try {
      renameSync(tmp, STATE_FILE);
    } catch (renameErr) {
      if (renameErr.code === "EXDEV") {
        copyFileSync(tmp, STATE_FILE);
        unlinkSync(tmp);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    console.error(`[coordinator-server] Failed to save state: ${err.message}`, { stderr: true });
  }
}

/**
 * Append event to IPC log (backward compat with TUI).
 * Normalizes every event to include from/to/content/t fields so the TUI's
 * IPCEvent struct can parse them consistently.
 */
function logEvent(event) {
  const now = Date.now();
  const t = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const normalized = {
    ts: now,
    t,
    from: event.from || AGENT_ID,
    to: event.to || 'orchestrator',
    type: event.type,
    content: event.content || '',
    meta: event.meta || {},
    // Preserve original fields for richer TUI display
    ...(event.agentId && { agentId: event.agentId }),
  };
  // Merge any extra fields into meta for TUI access
  for (const [k, v] of Object.entries(event)) {
    if (!['type', 'from', 'to', 'content', 'meta', 'agentId'].includes(k)) {
      normalized.meta[k] = v;
    }
  }
  try {
    appendFileSync(IPC_LOG, JSON.stringify(normalized) + '\n');
  } catch (err) {
    console.error(`[coordinator-server] Failed to append to IPC log: ${err.message}`, { stderr: true });
  }
}

/**
 * Send JSON-RPC 2.0 response to stdout
 */
function sendResponse(id, result) {
  const response = { jsonrpc: "2.0", id, result };
  console.log(JSON.stringify(response));
}

/**
 * Send JSON-RPC 2.0 error to stdout
 */
function sendError(id, code, message, data = null) {
  const response = {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data && { data }) }
  };
  console.log(JSON.stringify(response));
}

/**
 * Tool handler: swarm_report_progress
 */
function handleReportProgress(params) {
  const { percent, step, files_touched = [] } = params;

  state.progress = { percent, step };
  state.files_touched = [...new Set([...state.files_touched, ...files_touched])];
  state.lastUpdate = Date.now();

  saveState();
  logEvent({ type: 'progress', content: `${percent}% — ${step}`, percent, step, files_touched });

  return { content: [{ type: "text", text: `Progress updated: ${percent}% - ${step}` }] };
}

/**
 * Tool handler: swarm_report_result
 */
function handleReportResult(params) {
  const { status, summary, files_modified = [], issues = [] } = params;

  state.result = { status, summary, files_modified, issues };
  state.lastUpdate = Date.now();

  saveState();
  logEvent({ type: 'result', content: `${status}: ${summary}`, to: 'orchestrator', status, summary, files_modified, issues });

  return { content: [{ type: "text", text: `Result reported: ${status} - ${summary}` }] };
}

/**
 * Tool handler: swarm_get_context
 */
function handleGetContext(params) {
  const { key } = params;

  let value = null;

  switch (key) {
    case 'task':
      value = TASK;
      break;
    case 'scope':
      value = SCOPE;
      break;
    case 'prior_results':
      if (CONTEXT_FILE) {
        try {
          value = readFileSync(CONTEXT_FILE, 'utf-8');
        } catch (err) {
          return { content: [{ type: "text", text: `Error reading context file: ${err.message}` }] };
        }
      } else {
        value = 'No prior results available';
      }
      break;
    case 'config':
      value = JSON.stringify({
        agentId: AGENT_ID,
        workDir: WORK_DIR,
        scope: SCOPE,
        task: TASK
      });
      break;
    default:
      return { content: [{ type: "text", text: `Unknown context key: ${key}` }] };
  }

  return { content: [{ type: "text", text: String(value) }] };
}

/**
 * Tool handler: swarm_log
 */
function handleLog(params) {
  const { level, message } = params;

  const logEntry = { level, message, ts: Date.now() };
  state.logs.push(logEntry);
  state.lastUpdate = Date.now();

  saveState();
  logEvent({ type: 'log', content: `[${level}] ${message}`, level, message });

  return { content: [{ type: "text", text: `Logged: [${level}] ${message}` }] };
}

/**
 * Dispatch tool call to appropriate handler
 */
function dispatchToolCall(name, args) {
  switch (name) {
    case 'swarm_report_progress':
      return handleReportProgress(args);
    case 'swarm_report_result':
      return handleReportResult(args);
    case 'swarm_get_context':
      return handleGetContext(args);
    case 'swarm_log':
      return handleLog(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Handle JSON-RPC 2.0 request
 */
function handleRequest(request) {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "swarm-coordinator",
            version: "1.0.0"
          }
        });
        break;

      case 'notifications/initialized':
        // Notification — no response needed
        break;

      case 'tools/list':
        sendResponse(id, { tools: SWARM_TOOLS });
        break;

      case 'tools/call':
        if (!params || !params.name) {
          sendError(id, -32602, "Invalid params: missing tool name");
          return;
        }

        try {
          const result = dispatchToolCall(params.name, params.arguments || {});
          sendResponse(id, result);
        } catch (err) {
          sendError(id, -32603, `Tool execution error: ${err.message}`);
        }
        break;

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, `Internal error: ${err.message}`);
  }
}

/**
 * Main entry point — set up stdin/stdout communication
 */
function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  // Initialize state file
  saveState();
  logEvent({ type: 'lifecycle', content: `Agent started: ${TASK || 'no task'}`, task: TASK, scope: SCOPE });

  // Handle incoming JSON-RPC requests
  rl.on('line', (line) => {
    try {
      const request = JSON.parse(line);
      handleRequest(request);
    } catch (err) {
      console.error(`[coordinator-server] Malformed JSON: ${line}`, { stderr: true });
      // Don't crash on malformed input — just skip it
    }
  });

  // Cleanup on termination
  const cleanup = () => {
    logEvent({ type: 'lifecycle', content: `Agent shutdown` });
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGPIPE', cleanup);

  // Log startup to stderr
  console.error(`[coordinator-server] Started for agent ${AGENT_ID}`, { stderr: true });
}

// Run the server
main();

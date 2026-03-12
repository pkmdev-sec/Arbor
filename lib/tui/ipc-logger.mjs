/**
 * IPC Logger — JSONL append logger for inter-agent communication.
 *
 * Writes to two files in the swarm work directory:
 *   - ipc.jsonl     — append-only log of ALL messages (permanent record)
 *   - ipc-latest.json — rolling window of last 50 messages (fast reads for TUI)
 *
 * Message types:
 *   task_assign | progress | tool_call | result | verdict | error | decision | lifecycle
 *
 * Usage:
 *   initIpcLogger(workDir);             // once, when workDir is created
 *   logIpc('orchestrator', 'agent-01', 'task_assign', 'Implement auth', { model: 'sonnet' });
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Module-scope reference to work directory
let _workDir = null;
let _messageBuffer = [];
let _pendingLines = [];
let _flushTimer = null;

export function initIpcLogger(workDir) {
  _workDir = workDir;
}

export function logIpc(from, to, type, content, metadata = {}) {
  if (!_workDir) return; // No-op if not initialized

  const msg = {
    ts: Date.now(),
    t: new Date().toISOString().slice(11, 19), // HH:MM:SS
    from,
    to,
    type, // task_assign | progress | tool_call | result | verdict | error | decision | lifecycle
    content: typeof content === 'string' ? content : JSON.stringify(content),
    meta: metadata,
  };

  _messageBuffer.push(msg);
  _pendingLines.push(JSON.stringify(msg));
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flush, 100);
  }

  // Fix buffer sawtooth pattern
  if (_messageBuffer.length > 200) _messageBuffer.splice(0, _messageBuffer.length - 100);

  return msg;
}

async function _flush() {
  _flushTimer = null;
  if (!_pendingLines.length) return;
  const batch = _pendingLines;
  _pendingLines = [];
  try {
    await appendFile(join(_workDir, 'ipc.jsonl'), batch.join('\n') + '\n');
    await writeFile(join(_workDir, 'ipc-latest.json'), JSON.stringify(_messageBuffer.slice(-50)));
  } catch {} // Non-fatal
}

export function getIpcBuffer() {
  return _messageBuffer;
}

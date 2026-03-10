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
import { join } from 'node:path';

// Module-scope reference to work directory
let _workDir = null;
let _messageBuffer = [];

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

  try {
    appendFileSync(join(_workDir, 'ipc.jsonl'), JSON.stringify(msg) + '\n');
  } catch {} // Non-blocking, never fail

  // Also maintain latest buffer for quick reads
  _messageBuffer.push(msg);
  if (_messageBuffer.length > 200) _messageBuffer = _messageBuffer.slice(-100);

  try {
    writeFileSync(join(_workDir, 'ipc-latest.json'), JSON.stringify(_messageBuffer.slice(-50)), 'utf-8');
  } catch {} // Non-blocking
}

export function getIpcBuffer() {
  return _messageBuffer;
}

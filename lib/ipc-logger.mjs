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

import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Module-scope reference to work directory
let _workDir = null;
let _messageBuffer = [];
let _pendingLatestWrite = false;
let _lastLogError = 0;

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

  // Async append to JSONL (non-blocking)
  appendFile(join(_workDir, 'ipc.jsonl'), JSON.stringify(msg) + '\n').catch((err) => {
    if (Date.now() - _lastLogError > 30000) {
      _lastLogError = Date.now();
      process.stderr.write("[ipc-logger] Write failed: " + err.message + "\n");
    }
  });

  // Also maintain latest buffer for quick reads
  _messageBuffer.push(msg);
  if (_messageBuffer.length > 200) _messageBuffer = _messageBuffer.slice(-100);

  // Debounced write of latest buffer (1-second interval)
  if (!_pendingLatestWrite) {
    _pendingLatestWrite = true;
    setTimeout(() => {
      _pendingLatestWrite = false;
      writeFile(join(_workDir, 'ipc-latest.json'), JSON.stringify(_messageBuffer.slice(-50)), 'utf-8').catch((err) => {
        if (Date.now() - _lastLogError > 30000) {
          _lastLogError = Date.now();
          process.stderr.write("[ipc-logger] Write failed: " + err.message + "\n");
        }
      });
    }, 1000).unref();
  }
}

export function getIpcBuffer() {
  return _messageBuffer;
}

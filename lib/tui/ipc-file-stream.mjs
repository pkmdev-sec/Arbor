/**
 * IPC File Stream — File-based JSONL tail for IPC messages.
 *
 * Polls ipc.jsonl every 500ms and emits new messages.
 * Extracted from ipc-stream.mjs to break circular dependency with ipc-monitor-client.mjs.
 *
 * @module tui/ipc-file-stream
 */

import { EventEmitter } from 'node:events';
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create a file-based JSONL stream.
 *
 * Polls ipc.jsonl every 500ms and emits new messages.
 *
 * @param {string} workDir - Swarm work directory containing ipc.jsonl
 * @returns {EventEmitter & { stop: Function, getMessages: Function, getMessagesFrom: Function, getMessagesByType: Function }}
 */
export function createIpcStream(workDir) {
  const emitter = new EventEmitter();
  const ipcFile = join(workDir, 'ipc.jsonl');
  let lastSize = 0;
  let messages = [];

  function readNewMessages() {
    try {
      if (!existsSync(ipcFile)) return;
      const fd = openSync(ipcFile, 'r');
      try {
        const stat = fstatSync(fd);
        if (stat.size <= lastSize) return;
        const buf = Buffer.alloc(stat.size - lastSize);
        readSync(fd, buf, 0, buf.length, lastSize);
        lastSize = stat.size;
        const newContent = buf.toString('utf-8');
        for (const line of newContent.split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            messages.push(msg);
            if (messages.length > 5000) messages = messages.slice(-2500);
            emitter.emit('message', msg);
          } catch {}
        }
      } finally {
        closeSync(fd);
      }
    } catch {} // Non-fatal
  }

  // Poll every 500ms (more responsive than watchFile for JSONL)
  const interval = setInterval(readNewMessages, 500);

  // Also do initial read
  readNewMessages();

  emitter.stop = () => { clearInterval(interval); };
  emitter.getMessages = () => [...messages];
  emitter.getMessagesFrom = (from) => messages.filter(m => m.from === from);
  emitter.getMessagesByType = (type) => messages.filter(m => m.type === type);

  return emitter;
}

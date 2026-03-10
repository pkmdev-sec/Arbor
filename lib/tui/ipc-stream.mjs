/**
 * IPC Stream — Unified message stream with socket-first, JSONL-fallback.
 *
 * Two modes of operation:
 *   1. createIpcStream(workDir) — File-based JSONL tail (original, backward-compatible)
 *   2. createUnifiedStream({ socketPath, workDir }) — Socket-first with JSONL fallback
 *
 * Both return EventEmitters that emit 'message' events. The unified stream also
 * emits 'source' events ('socket' | 'file') to indicate which transport is active.
 *
 * Usage:
 *   // File-only (backward compat)
 *   const stream = createIpcStream('/tmp/swarm/abc123');
 *   stream.on('message', msg => console.log(msg.from, '→', msg.to, msg.content));
 *   stream.stop();
 *
 *   // Unified (socket preferred)
 *   const stream = createUnifiedStream({ workDir: '/tmp/swarm/abc123' });
 *   stream.on('source', src => console.log('Using:', src));
 *   stream.on('message', msg => console.log(msg.from, msg.content));
 *   stream.stop();
 *
 * @module tui/ipc-stream
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create a file-based JSONL stream (original implementation).
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
      const stat = statSync(ipcFile);
      if (stat.size <= lastSize) return;

      const content = readFileSync(ipcFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      // Only process new lines
      const newLines = lines.slice(messages.length);
      for (const line of newLines) {
        try {
          const msg = JSON.parse(line);
          messages.push(msg);
          emitter.emit('message', msg);
        } catch {} // Skip malformed lines
      }
      lastSize = stat.size;
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

/**
 * Create a unified stream that tries socket first, then falls back to JSONL.
 *
 * Uses IpcMonitorClient for socket connectivity with automatic fallback.
 * Defers the import to avoid circular dependencies (ipc-monitor-client imports
 * this module for file-based fallback).
 *
 * @param {object} options
 * @param {string} [options.socketPath] - IPC bus socket path
 * @param {string} [options.workDir]    - Swarm work directory for JSONL fallback
 * @returns {Promise<EventEmitter & { stop: Function, source: string }>}
 */
export async function createUnifiedStream({ socketPath, workDir } = {}) {
  // Dynamic import to break the circular dependency:
  // ipc-stream.mjs <-- ipc-monitor-client.mjs (imports createIpcStream)
  const { IpcMonitorClient } = await import('./ipc-monitor-client.mjs');

  const monitor = new IpcMonitorClient({ socketPath, workDir });

  await monitor.start();

  return monitor;
}

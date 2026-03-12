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

import { IpcMonitorClient } from './ipc-monitor-client.mjs';

// Re-export createIpcStream for backward compatibility
export { createIpcStream } from './ipc-file-stream.mjs';

/**
 * Create a unified stream that tries socket first, then falls back to JSONL.
 *
 * Uses IpcMonitorClient for socket connectivity with automatic fallback.
 *
 * @param {object} options
 * @param {string} [options.socketPath] - IPC bus socket path
 * @param {string} [options.workDir]    - Swarm work directory for JSONL fallback
 * @returns {Promise<EventEmitter & { stop: Function, source: string }>}
 */
export async function createUnifiedStream({ socketPath, workDir } = {}) {
  const monitor = new IpcMonitorClient({ socketPath, workDir });

  await monitor.start();

  return monitor;
}

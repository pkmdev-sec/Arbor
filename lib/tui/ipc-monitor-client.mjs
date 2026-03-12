/**
 * IPC Monitor Client — Read-only Unix socket subscriber for the IPC message bus.
 *
 * Connects to the message bus as a passive observer, subscribes to all known
 * topics, and normalizes protocol messages into the JSONL display format used
 * by the chat panel.
 *
 * Falls back to JSONL file polling when the socket bus isn't running.
 *
 * Events:
 *   'message'  — Normalized message: { ts, t, from, to, type, content, meta }
 *   'source'   — Connection source changed: 'socket' | 'file' | 'none'
 *   'connected' / 'disconnected'
 *
 * Usage:
 *   const monitor = new IpcMonitorClient({ workDir: '/tmp/swarm/abc' });
 *   monitor.on('message', msg => console.log(msg.from, msg.type, msg.content));
 *   await monitor.start();
 *   // later:
 *   monitor.stop();
 *
 * @module tui/ipc-monitor-client
 */

import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  MessageType,
  MessageParser,
  createMessage,
  serializeMessage,
} from '../ipc/protocol.mjs';
import { createIpcStream } from './ipc-file-stream.mjs';

const DEFAULT_SOCKET_PATH = '/tmp/claude-ipc-bus.sock';

/** Topics to subscribe to for broad message coverage */
const MONITOR_TOPICS = [
  'progress', 'status', 'control', 'task', 'result',
  'lifecycle', 'error', 'verdict', 'tool_call', 'decision',
];

/** How long to wait for socket before falling back to JSONL */
const SOCKET_TIMEOUT_MS = 3000;

/** Reconnect delay after socket disconnect */
const RECONNECT_DELAY_MS = 2000;

/**
 * Map a protocol MessageType to a display type string for the chat panel.
 *
 * Protocol types (PUBLISH, DIRECT_SEND, REQUEST, etc.) are envelope types.
 * The display type comes from the payload when available, otherwise we derive
 * a readable type from the protocol message type.
 */
function deriveDisplayType(msg) {
  // If the payload carries a 'type' field (common for JSONL-style messages
  // relayed through the bus), prefer it.
  if (msg.payload?.type && typeof msg.payload.type === 'string') {
    // Skip internal envelope types that aren't useful for display
    if (msg.payload.type !== 'monitor_message') {
      return msg.payload.type;
    }
  }

  // Fall back to mapping protocol MessageType → display type
  switch (msg.type) {
    case MessageType.PUBLISH:    return msg.payload?.type || 'publish';
    case MessageType.DIRECT_SEND: return 'direct';
    case MessageType.REQUEST:    return 'request';
    case MessageType.RESPONSE:   return 'response';
    case MessageType.REGISTER:   return 'lifecycle';
    case MessageType.UNREGISTER: return 'lifecycle';
    case MessageType.HEARTBEAT:  return 'heartbeat';
    case MessageType.ERROR:      return 'error';
    default:                     return 'unknown';
  }
}

/**
 * Extract human-readable content from a protocol message payload.
 */
function deriveContent(msg) {
  const p = msg.payload;
  if (!p) return '';

  // Monitor-forwarded messages: unwrap the original
  if (p.type === 'monitor_message' && p.originalMessage) {
    return deriveContent(p.originalMessage);
  }

  // String payload
  if (typeof p === 'string') return p;

  // Common payload fields
  if (p.content) return String(p.content);
  if (p.message) return String(p.message);
  if (p.task)    return String(p.task);
  if (p.result)  return String(p.result);
  if (p.error)   return String(p.error);

  // Compact JSON for small payloads
  const json = JSON.stringify(p);
  return json.length <= 120 ? json : json.slice(0, 117) + '...';
}

/**
 * Normalize a protocol message into the JSONL display format.
 *
 * @param {import('../ipc/protocol.mjs').Message} msg - Protocol message
 * @returns {{ ts: number, t: string, from: string, to: string, type: string, content: string, meta: object }}
 */
function normalizeProtocolMessage(msg, depth = 0) {
  if (depth > 5) return msg; // Prevent stack overflow from malformed messages
  // Unwrap monitor-forwarded messages for cleaner display
  if (msg.payload?.type === 'monitor_message' && msg.payload?.originalMessage) {
    const original = msg.payload.originalMessage;
    return normalizeProtocolMessage(original, depth + 1);
  }

  return {
    ts: msg.timestamp,
    t: new Date(msg.timestamp).toISOString().slice(11, 19),
    from: msg.from || 'unknown',
    to: msg.to || msg.topic || '*',
    type: deriveDisplayType(msg),
    content: deriveContent(msg),
    meta: {
      msgType: msg.type,
      topic: msg.topic,
      correlationId: msg.correlationId,
      priority: msg.priority,
      id: msg.id,
    },
  };
}

export class IpcMonitorClient extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.socketPath] - Unix socket path (default: CLAUDE_IPC_SOCKET or /tmp/claude-ipc-bus.sock)
   * @param {string} [options.workDir]    - Swarm work directory for JSONL fallback
   */
  constructor(options = {}) {
    super();
    this.socketPath = options.socketPath
      || process.env.CLAUDE_IPC_SOCKET
      || DEFAULT_SOCKET_PATH;
    this.workDir = options.workDir || null;
    this.agentId = `tui-monitor-${process.pid}`;

    /** @type {import('node:net').Socket|null} */
    this.socket = null;
    /** @type {MessageParser|null} */
    this.parser = null;
    /** @type {EventEmitter|null} */
    this.fileStream = null;

    this.connected = false;
    this.source = 'none';
    this.stopped = false;
    this.reconnectTimer = null;
  }

  /**
   * Start the monitor. Tries socket first, falls back to JSONL after timeout.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.stopped) return;

    try {
      await this._connectSocket();
    } catch {
      // Socket unavailable — fall back to file-based stream
      this._startFileStream();
    }
  }

  /**
   * Stop the monitor and clean up all resources.
   */
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.parser = null;
    this.connected = false;

    if (this.fileStream) {
      this.fileStream.stop();
      this.fileStream = null;
    }

    this._setSource('none');
  }

  /**
   * Whether the monitor has an active connection.
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  // ── Socket connection ──────────────────────────────────────────

  /**
   * Connect to the IPC message bus via Unix domain socket.
   * @returns {Promise<void>}
   * @private
   */
  _connectSocket() {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('Monitor stopped'));
        return;
      }

      const timeout = setTimeout(() => {
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.destroy();
          this.socket = null;
        }
        reject(new Error('Socket connection timeout'));
      }, SOCKET_TIMEOUT_MS);

      this.parser = new MessageParser();
      this.socket = createConnection({ path: this.socketPath });

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.connected = true;
        this._setSource('socket');
        this.emit('connected');

        // Register as a read-only monitor
        this._sendFrame(createMessage(
          MessageType.REGISTER,
          this.agentId,
          { agentId: this.agentId, role: 'monitor', pid: process.pid }
        ));

        // Subscribe to all known topics for broad coverage
        for (const topic of MONITOR_TOPICS) {
          this._sendFrame(createMessage(
            MessageType.SUBSCRIBE,
            this.agentId,
            null,
            { topic }
          ));
        }

        resolve();
      });

      this.socket.on('data', (chunk) => {
        if (!this.parser) return;
        let messages;
        try {
          messages = this.parser.feed(chunk);
        } catch {
          this.parser.reset();
          return;
        }
        for (const msg of messages) {
          this._handleProtocolMessage(msg);
        }
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(err);
        } else {
          this._handleSocketDisconnect();
        }
      });

      this.socket.on('close', () => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new Error('Socket closed before connect'));
        } else {
          this._handleSocketDisconnect();
        }
      });
    });
  }

  /**
   * Handle a parsed protocol message — normalize and emit.
   * @private
   */
  _handleProtocolMessage(msg) {
    // Skip heartbeats — they're noisy and not useful for display
    if (msg.type === MessageType.HEARTBEAT) return;

    const normalized = normalizeProtocolMessage(msg);
    this.emit('message', normalized);
  }

  /**
   * Handle socket disconnect — attempt reconnect or fall back to file.
   * @private
   */
  _handleSocketDisconnect() {
    if (!this.connected) return;

    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (this.parser) {
      this.parser.reset();
    }

    this.emit('disconnected');

    if (this.stopped) return;

    // Try reconnecting; if that fails, fall back to file
    this.reconnectTimer = setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this._connectSocket();
      } catch {
        // Socket still down — switch to file fallback
        this._startFileStream();
      }
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Send a length-prefixed protocol frame to the bus.
   * @private
   */
  _sendFrame(message) {
    if (!this.socket || !this.connected) return;
    try {
      this.socket.write(serializeMessage(message));
    } catch {
      // Swallow write errors — we're read-only, send failures aren't critical
    }
  }

  // ── JSONL file fallback ────────────────────────────────────────

  /**
   * Start file-based polling as a fallback when socket is unavailable.
   * @private
   */
  _startFileStream() {
    if (this.stopped || this.fileStream) return;
    if (!this.workDir) {
      // No work directory — nothing to fall back to
      this._setSource('none');
      return;
    }

    this.fileStream = createIpcStream(this.workDir);
    this._setSource('file');

    this.fileStream.on('message', (msg) => {
      this.emit('message', msg);
    });
  }

  /**
   * Update and emit the current source.
   * @private
   */
  _setSource(src) {
    if (src !== this.source) {
      this.source = src;
      this.emit('source', src);
    }
  }
}

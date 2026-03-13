/**
 * Agent Channel: Agent-side Unix domain socket client for IPC message bus
 *
 * Provides agent-to-agent and agent-to-orchestrator communication via Unix domain socket.
 * Protocol: 4-byte big-endian length prefix + UTF-8 JSON message body (protocol.mjs).
 *
 * Features:
 * - Uses shared protocol module for message creation, serialization, and parsing
 * - Auto-reconnect with exponential backoff (max 5 retries)
 * - Heartbeat using MessageType.HEARTBEAT every 30s
 * - Graceful shutdown on SIGTERM/SIGINT (once listeners, properly cleaned up)
 * - Request/response with correlation ID tracking (protocol.mjs correlationId)
 * - Pub/sub topic-based messaging
 * - Pending requests rejected on close
 * - Single atomic write per frame (no header/body split)
 * - Max message size enforcement via MessageParser
 *
 * @module agent-channel
 */

import net from "net";
import { EventEmitter } from "events";
import {
  MessageType,
  MessageParser,
  createMessage,
  serializeMessage,
} from "./protocol.mjs";

const DEFAULT_SOCKET_PATH = "/tmp/claude-ipc-bus.sock";
const HEARTBEAT_INTERVAL_MS = 30000;
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Agent-side IPC channel client
 *
 * @example
 * const channel = new AgentChannel("agent-01");
 * await channel.connect();
 *
 * // Send direct message
 * await channel.send("agent-02", { type: "task_update", data: {...} });
 *
 * // Publish to topic
 * await channel.publish("progress", { agentId: "agent-01", progress: 0.5 });
 *
 * // Subscribe to topic
 * channel.subscribe("task_assign", (msg) => {
 *   console.log("Received task:", msg);
 * });
 *
 * // Request-response pattern
 * const response = await channel.request("orchestrator", { type: "get_config" }, 2000);
 *
 * // Handle all messages
 * channel.onMessage((msg) => {
 *   console.log("Received message:", msg);
 * });
 *
 * await channel.close();
 */
export class AgentChannel extends EventEmitter {
  /**
   * @param {string} agentId - Unique identifier for this agent
   * @param {object} [options] - Configuration options
   * @param {string} [options.socketPath] - Unix socket path (default: from CLAUDE_IPC_SOCKET env or /tmp/claude-ipc-bus.sock)
   * @param {boolean} [options.autoReconnect=true] - Enable auto-reconnect on connection loss
   * @param {number} [options.heartbeatInterval=30000] - Heartbeat interval in ms
   */
  constructor(agentId, options = {}) {
    super();
    this.agentId = agentId;
    this.socketPath = options.socketPath || process.env.CLAUDE_IPC_SOCKET || DEFAULT_SOCKET_PATH;
    this.autoReconnect = options.autoReconnect !== false;
    this.heartbeatInterval = options.heartbeatInterval || HEARTBEAT_INTERVAL_MS;

    this.socket = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.shutdownRequested = false;

    /** @type {MessageParser} Protocol-aware streaming frame parser */
    this.parser = new MessageParser();

    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pendingRequests = new Map();

    // Message handlers (EventEmitter-based, supports multiple listeners via onMessage)
    /** @type {Map<string, Function[]>} */
    this.topicHandlers = new Map();

    // Bind signal handlers for graceful shutdown (use `once` to avoid accumulation)
    this._boundShutdown = this._shutdown.bind(this);
    process.once("SIGTERM", this._boundShutdown);
    process.once("SIGINT", this._boundShutdown);
  }

  /**
   * Connect to the IPC bus
   *
   * @returns {Promise<void>}
   * @throws {Error} If connection fails after max retries
   */
  async connect() {
    if (this.connected) {
      return;
    }

    // Remove any existing signal handlers before registering to prevent accumulation on reconnect
    process.removeListener("SIGTERM", this._boundShutdown);
    process.removeListener("SIGINT", this._boundShutdown);
    process.once("SIGTERM", this._boundShutdown);
    process.once("SIGINT", this._boundShutdown);

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ path: this.socketPath }, () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

        // Reset parser state for fresh connection
        this.parser.reset();

        // Send registration message using protocol
        const regMsg = createMessage(MessageType.REGISTER, this.agentId, {
          agentId: this.agentId,
          pid: process.pid,
        });
        this._sendFrame(regMsg);

        // Start heartbeat
        this._startHeartbeat();

        this.emit("connected");
        resolve();
      });

      this.socket.on("data", (chunk) => {
        this._handleIncomingData(chunk);
      });

      this.socket.on("error", (err) => {
        this.emit("error", err);
        if (!this.connected) {
          reject(err);
        } else {
          this._handleDisconnect();
        }
      });

      this.socket.on("close", () => {
        this._handleDisconnect();
      });

      this.socket.on("end", () => {
        this._handleDisconnect();
      });

      // Connection timeout
      this.socket.setTimeout(5000, () => {
        if (!this.connected) {
          reject(new Error("Connection timeout"));
          this.socket.destroy();
        }
      });
    });
  }

  /**
   * Send a message to a specific agent
   *
   * @param {string} targetAgentId - Recipient agent ID ("orchestrator" for orchestrator)
   * @param {object} message - Message payload
   * @returns {Promise<void>}
   */
  async send(targetAgentId, message) {
    if (!this.connected) {
      throw new Error("Not connected to IPC bus");
    }

    const msg = createMessage(MessageType.DIRECT_SEND, this.agentId, message, {
      to: targetAgentId,
    });
    this._sendFrame(msg);
  }

  /**
   * Publish a message to a topic
   *
   * @param {string} topic - Topic name
   * @param {object} message - Message payload
   * @returns {Promise<void>}
   */
  async publish(topic, message) {
    if (!this.connected) {
      throw new Error("Not connected to IPC bus");
    }

    const msg = createMessage(MessageType.PUBLISH, this.agentId, message, {
      topic,
    });
    this._sendFrame(msg);
  }

  /**
   * Subscribe to a topic
   *
   * @param {string} topic - Topic name
   * @param {function(object): void} handler - Message handler
   */
  subscribe(topic, handler) {
    if (!this.topicHandlers.has(topic)) {
      this.topicHandlers.set(topic, []);

      // Send subscription message to bus
      if (this.connected) {
        const msg = createMessage(MessageType.SUBSCRIBE, this.agentId, null, {
          topic,
        });
        this._sendFrame(msg);
      }
    }

    this.topicHandlers.get(topic).push(handler);
  }

  /**
   * Unsubscribe from a topic
   *
   * @param {string} topic - Topic name
   * @param {function} [handler] - Specific handler to remove (or all if omitted)
   */
  unsubscribe(topic, handler = null) {
    if (!this.topicHandlers.has(topic)) {
      return;
    }

    if (handler) {
      const handlers = this.topicHandlers.get(topic);
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
      if (handlers.length === 0) {
        this.topicHandlers.delete(topic);
        this._sendUnsubscribe(topic);
      }
    } else {
      this.topicHandlers.delete(topic);
      this._sendUnsubscribe(topic);
    }
  }

  /**
   * Send a request and wait for response
   *
   * Uses the protocol's message id as the correlation key:
   * - REQUEST is sent with a unique msg.id
   * - The responder sends a RESPONSE with correlationId = msg.id
   *
   * @param {string} targetAgentId - Recipient agent ID
   * @param {object} message - Request message
   * @param {number} [timeoutMs=5000] - Timeout in milliseconds
   * @returns {Promise<object>} Response payload
   * @throws {Error} If request times out or fails
   */
  async request(targetAgentId, message, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.connected) {
      throw new Error("Not connected to IPC bus");
    }

    const msg = createMessage(MessageType.REQUEST, this.agentId, message, {
      to: targetAgentId,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(msg.id, { resolve, reject, timer });
      this._sendFrame(msg);
    });
  }

  /**
   * Send a response to a REQUEST message
   *
   * @param {object} requestMessage - The original REQUEST message to respond to
   * @param {object} responsePayload - Response payload
   * @returns {Promise<void>}
   */
  async respond(requestMessage, responsePayload) {
    if (!this.connected) {
      throw new Error("Not connected to IPC bus");
    }

    if (!requestMessage.id || !requestMessage.from) {
      throw new Error("Invalid request message: missing id or from fields");
    }

    const msg = createMessage(MessageType.RESPONSE, this.agentId, responsePayload, {
      to: requestMessage.from,
      correlationId: requestMessage.id,
    });
    this._sendFrame(msg);
  }

  /**
   * Register a global message handler
   *
   * @param {function(object): void} handler - Handler that receives all messages
   */
  onMessage(handler) {
    this.on("message", handler);
  }

  /**
   * Close the connection gracefully
   *
   * Rejects all pending requests, sends UNREGISTER, and closes the socket.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.shutdownRequested = true;
    this._stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error("Channel closed"));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      // Send unregister message
      if (this.connected) {
        const msg = createMessage(MessageType.UNREGISTER, this.agentId, {
          agentId: this.agentId,
        });
        this._sendFrame(msg);
      }

      return new Promise((resolve) => {
        this.socket.end(() => {
          this.connected = false;
          this.socket = null;
          resolve();
        });
      });
    }
  }

  /**
   * Send a protocol message as a length-prefixed frame (atomic single write)
   *
   * @private
   * @param {import("./protocol.mjs").Message} message - Protocol message object
   */
  _sendFrame(message) {
    if (!this.socket || !this.connected) {
      return;
    }

    try {
      const buffer = serializeMessage(message);
      this.socket.write(buffer);
    } catch (err) {
      this.emit("error", new Error(`Failed to send frame: ${err.message}`));
    }
  }

  /**
   * Handle incoming data using the protocol's MessageParser
   *
   * @private
   * @param {Buffer} chunk - Incoming data chunk
   */
  _handleIncomingData(chunk) {
    let messages;
    try {
      messages = this.parser.feed(chunk);
    } catch (err) {
      // Oversized message or fatal parse error
      this.emit("error", new Error(`Parser error: ${err.message}`));
      this.parser.reset();
      return;
    }

    for (const msg of messages) {
      this._handleMessage(msg);
    }
  }

  /**
   * Handle a parsed protocol message
   *
   * @private
   * @param {import("./protocol.mjs").Message} message - Parsed message
   */
  _handleMessage(message) {
    const type = message.type;

    // Handle responses to pending requests (match on correlationId)
    if (type === MessageType.RESPONSE && message.correlationId) {
      const pending = this.pendingRequests.get(message.correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.correlationId);
        if (message.payload?.error) {
          pending.reject(new Error(message.payload.error));
        } else {
          pending.resolve(message.payload);
        }
        return;
      }
    }

    // Handle topic messages (PUBLISH)
    if (type === MessageType.PUBLISH && message.topic) {
      const handlers = this.topicHandlers.get(message.topic);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.payload);
          } catch (err) {
            this.emit("error", new Error(`Topic handler error: ${err.message}`));
          }
        }
      }
    }

    // Emit to all registered message handlers (supports multiple listeners)
    this.emit("message", message);
  }

  /**
   * Handle connection loss
   *
   * Cleans up old socket listeners before reconnecting to prevent
   * stale event handlers from triggering double disconnects.
   *
   * @private
   */
  _handleDisconnect() {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    this._stopHeartbeat();

    // Remove old socket listeners to prevent stale events on reconnect
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket = null;
    }

    // Reset parser state for clean reconnect
    this.parser.reset();

    this.emit("disconnected");

    // Auto-reconnect if enabled
    if (this.autoReconnect && !this.shutdownRequested) {
      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        this.emit("reconnecting", this.reconnectAttempts);

        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err) => {
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
            this.emit("error", new Error(`Reconnect failed: ${err.message}`));
          });
        }, this.reconnectDelay);
      } else {
        this.emit("error", new Error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`));
      }
    }
  }

  /**
   * Start heartbeat timer using protocol HEARTBEAT type
   *
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const msg = createMessage(MessageType.HEARTBEAT, this.agentId, {
        agentId: this.agentId,
      });
      this._sendFrame(msg);
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref();
  }

  /**
   * Stop heartbeat timer
   *
   * @private
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send unsubscribe message using protocol
   *
   * @private
   * @param {string} topic - Topic name
   */
  _sendUnsubscribe(topic) {
    if (this.connected) {
      const msg = createMessage(MessageType.UNSUBSCRIBE, this.agentId, null, {
        topic,
      });
      this._sendFrame(msg);
    }
  }

  /**
   * Graceful shutdown handler
   *
   * @private
   */
  async _shutdown() {
    if (this.shutdownRequested) {
      return;
    }

    this.emit("shutdown");
    await this.close();

    // Remove signal handlers
    process.removeListener("SIGTERM", this._boundShutdown);
    process.removeListener("SIGINT", this._boundShutdown);
  }
}

/**
 * Create and connect a new agent channel
 *
 * @param {string} agentId - Unique agent identifier
 * @param {object} [options] - Channel options
 * @returns {Promise<AgentChannel>} Connected channel
 */
export async function createAgentChannel(agentId, options = {}) {
  const channel = new AgentChannel(agentId, options);
  await channel.connect();
  return channel;
}

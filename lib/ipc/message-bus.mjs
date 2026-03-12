/**
 * Unix Domain Socket Message Bus
 *
 * Central broker server that manages agent connections, topic subscriptions,
 * and message routing. Provides publish/subscribe, direct messaging, and
 * request-response patterns over Unix domain sockets.
 *
 * The broker runs in the swarm orchestrator process and agents connect as
 * clients. All communication is asynchronous and non-blocking.
 *
 * Key features:
 * - Topic-based pub/sub for event distribution
 * - Direct agent-to-agent messaging
 * - Request-response with correlation ID tracking
 * - Master orchestrator hooks for message interception/injection
 * - Backpressure handling via socket.write() return values
 * - Structured logging with JSON output
 * - Metrics tracking (messages routed, errors, client count)
 * - Graceful shutdown on SIGTERM/SIGINT
 *
 * @module ipc/message-bus
 */

import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  MessageType,
  MessageParser,
  serializeMessage,
  createMessage,
  Priority,
} from "./protocol.mjs";

/**
 * Message bus server for agent communication
 */
export class MessageBus {
  /**
   * Create a new message bus instance
   *
   * @param {Object} [options] - Configuration options
   * @param {string} [options.socketPath] - Unix socket path (default: from CLAUDE_IPC_SOCKET or /tmp/claude-ipc-bus.sock)
   * @param {boolean} [options.enableLogging] - Enable structured logging (default: true)
   * @param {Function} [options.logger] - Custom logger function (default: console.error)
   */
  constructor(options = {}) {
    this.socketPath = options.socketPath || process.env.CLAUDE_IPC_SOCKET || "/tmp/claude-ipc-bus.sock";
    this.enableLogging = options.enableLogging !== false;
    this.logger = options.logger || console.error;

    /**
     * Orchestrator authentication token. Pass to the orchestrator process
     * so it can prove identity during registration.
     * @type {string}
     */
    this.orchestratorToken = options.orchestratorToken || randomUUID();

    /** @type {import("net").Server} */
    this.server = null;

    /** @type {Map<string, import("net").Socket>} Map of agent ID → socket */
    this.clients = new Map();

    /** @type {Map<import("net").Socket, MessageParser>} Socket → parser instance */
    this.parsers = new Map();

    /** @type {Map<string, Set<string>>} Topic → Set of subscribed agent IDs */
    this.subscriptions = new Map();

    /** @type {Map<string, Set<string>>} Wildcard pattern → Set of subscribed agent IDs */
    this.wildcardSubscriptions = new Map();

    /** @type {Map<string, Set<string>>} Cache: Topic → Set of matched agent IDs (exact + wildcard) */
    this.routingCache = new Map();

    /** @type {Map<string, {from: string, timestamp: number}>} Correlation ID → request metadata */
    this.pendingRequests = new Map();

    /** @type {Map<import("net").Socket, string>} Socket → agent ID (reverse lookup) */
    this.socketToAgent = new Map();

    /** @type {boolean} Whether monitoring is enabled for the orchestrator */
    this.monitoringEnabled = false;

    /** @type {Set<string>} Agent IDs whose message flow is paused */
    this.pausedAgents = new Set();

    /** @type {Map<string, any[]>} Agent ID → queued messages for paused agents */
    this.pausedQueues = new Map();

    /** @type {Map<string, number>} Agent ID → last heartbeat timestamp */
    this.agentLastSeen = new Map();

    /** @type {Map<string, number>} Agent ID → rate limit (msgs/sec, 0 = unlimited) */
    this.rateLimits = new Map();

    /** @type {Map<string, number[]>} Agent ID → recent message timestamps for rate limiting */
    this.rateLimitWindows = new Map();

    /**
     * Master orchestrator hooks
     * @type {{onMessageReceived?: Function, onMessageRouted?: Function, onAgentConnected?: Function, onAgentDisconnected?: Function}}
     */
    this.hooks = {
      onMessageReceived: null,
      onMessageRouted: null,
      onAgentConnected: null,
      onAgentDisconnected: null,
    };

    /** Metrics counters */
    this.metrics = {
      messagesRouted: 0,
      messagesBlocked: 0,
      errorsEncountered: 0,
      connectedClients: 0,
      bytesReceived: 0,
      bytesSent: 0,
    };

    this.running = false;
  }

  /**
   * Start the message bus server
   *
   * @returns {Promise<void>}
   * @throws {Error} If socket path already in use or server fails to start
   */
  async start() {
    if (this.running) {
      throw new Error("Message bus already running");
    }

    // Remove stale socket file if present
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
        this._log("info", "Removed stale socket file", { path: this.socketPath });
      } catch (err) {
        throw new Error(`Failed to remove stale socket: ${err.message}`);
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this._handleConnection(socket));

      this.server.on("error", (err) => {
        this._log("error", "Server error", { error: err.message });
        this.metrics.errorsEncountered++;
        if (!this.running) {
          reject(err);
        }
      });

      this.server.listen(this.socketPath, () => {
        this.running = true;
        // Periodic cleanup of stale pending requests (W-19)
        this._pendingCleanupTimer = setInterval(() => {
          const cutoff = Date.now() - 30000;
          for (const [id, req] of this.pendingRequests) {
            if (req.timestamp < cutoff) this.pendingRequests.delete(id);
          }
        }, 60000);
        this._log("info", "Message bus started", { socketPath: this.socketPath });
        resolve();
      });
    });
  }

  /**
   * Stop the message bus server gracefully
   *
   * Closes all client connections, clears subscriptions, and removes the socket file.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.running) {
      return;
    }

    this._log("info", "Shutting down message bus...");

    if (this._pendingCleanupTimer) {
      clearInterval(this._pendingCleanupTimer);
      this._pendingCleanupTimer = null;
    }

    // Close all client connections
    for (const [agentId, socket] of this.clients.entries()) {
      try {
        socket.end();
      } catch (err) {
        this._log("warn", "Error closing client socket", { agentId, error: err.message });
      }
    }

    // Close server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.running = false;

          // Clear all state to allow GC
          this.clients.clear();
          this.parsers.clear();
          this.subscriptions.clear();
          this.wildcardSubscriptions.clear();
          this.routingCache.clear();
          this.socketToAgent.clear();
          this.pendingRequests.clear();
          this.pausedAgents.clear();
          this.pausedQueues.clear();
          this.rateLimits.clear();
          this.rateLimitWindows.clear();

          // Cleanup socket file
          if (existsSync(this.socketPath)) {
            try {
              unlinkSync(this.socketPath);
            } catch (err) {
              this._log("warn", "Failed to remove socket file", { error: err.message });
            }
          }

          this._log("info", "Message bus stopped", { metrics: this.metrics });
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Register a hook function for orchestrator interception
   *
   * @param {string} hookName - Hook name (onMessageReceived, onMessageRouted, onAgentConnected, onAgentDisconnected)
   * @param {Function} handler - Hook handler function
   */
  registerHook(hookName, handler) {
    if (!(hookName in this.hooks)) {
      throw new Error(`Unknown hook: ${hookName}`);
    }
    this.hooks[hookName] = handler;
  }

  /**
   * Broadcast a message to all subscribers of a topic
   *
   * @param {string} topic - Topic name
   * @param {string} from - Sender agent ID
   * @param {any} payload - Message payload
   * @param {Priority} [priority] - Message priority
   * @returns {number} Number of agents that received the message
   */
  publish(topic, from, payload, priority = Priority.NORMAL) {
    const message = createMessage(MessageType.PUBLISH, from, payload, { topic, priority });
    return this._routeToSubscribers(topic, message);
  }

  /**
   * Send a direct message to a specific agent
   *
   * @param {string} to - Recipient agent ID
   * @param {string} from - Sender agent ID
   * @param {any} payload - Message payload
   * @param {Priority} [priority] - Message priority
   * @returns {boolean} True if message was delivered, false if recipient not connected
   */
  directSend(to, from, payload, priority = Priority.NORMAL) {
    const message = createMessage(MessageType.DIRECT_SEND, from, payload, { to, priority });
    return this._sendToClient(to, message);
  }

  /**
   * Send a request and register for response tracking
   *
   * @param {string} to - Recipient agent ID
   * @param {string} from - Sender agent ID
   * @param {any} payload - Request payload
   * @param {Priority} [priority] - Message priority
   * @returns {{correlationId: string, sent: boolean}} Correlation ID for tracking response
   */
  request(to, from, payload, priority = Priority.NORMAL) {
    const message = createMessage(MessageType.REQUEST, from, payload, { to, priority });

    // Track pending request
    this.pendingRequests.set(message.id, {
      from,
      timestamp: message.timestamp,
    });

    const sent = this._sendToClient(to, message);
    return { correlationId: message.id, sent };
  }

  /**
   * Get current metrics
   *
   * @returns {Object} Metrics object with counters
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeConnections: this.clients.size,
      activeSubscriptions: this.subscriptions.size,
      pendingRequests: this.pendingRequests.size,
    };
  }

  /**
   * Get list of connected agent IDs
   *
   * @returns {string[]} Array of agent IDs
   */
  getConnectedAgents() {
    return Array.from(this.clients.keys());
  }

  /**
   * Get subscribers for a topic
   *
   * @param {string} topic - Topic name
   * @returns {string[]} Array of subscribed agent IDs
   */
  getSubscribers(topic) {
    const subs = this.subscriptions.get(topic);
    return subs ? Array.from(subs) : [];
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handle new client connection
   * @private
   */
  _handleConnection(socket) {
    const parser = new MessageParser();
    this.parsers.set(socket, parser);

    this._log("debug", "Client connected", { remoteAddress: socket.remoteAddress });

    socket.on("data", (chunk) => {
      this.metrics.bytesReceived += chunk.length;

      let messages;
      try {
        messages = parser.feed(chunk);
      } catch (err) {
        this._log("error", "Failed to parse message", { error: err.message });
        this.metrics.errorsEncountered++;
        socket.destroy();
        return;
      }

      for (const msg of messages) {
        this._handleMessage(msg, socket);
      }
    });

    socket.on("error", (err) => {
      this._log("error", "Socket error", { error: err.message });
      this.metrics.errorsEncountered++;
    });

    socket.on("close", () => {
      const agentId = this.socketToAgent.get(socket);
      if (agentId) {
        this._handleDisconnect(agentId, socket, "client closed connection");
      }
      this.parsers.delete(socket);
    });
  }

  /**
   * Check if a topic matches a wildcard pattern
   * @private
   * @param {string} pattern - Wildcard pattern (* matches one segment, ** matches multiple)
   * @param {string} topic - Topic to test
   * @returns {boolean} True if topic matches pattern
   */
  _matchesWildcard(pattern, topic) {
    // Exact match (no wildcards)
    if (!pattern.includes('*')) {
      return pattern === topic;
    }

    // Convert glob pattern to regex
    // ** matches multiple segments (one or more), * matches exactly one segment
    let regexPattern = pattern
      .replace(/\./g, '\\.') // Escape dots
      .replace(/\*\*/g, '##MULTI##') // Temporarily replace **
      .replace(/\*/g, '[^.]+') // * matches one segment (non-dot characters)
      .replace(/##MULTI##/g, '.+'); // ** matches multiple segments (any characters including dots)

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(topic);
  }

  /**
   * Check if agent exceeds rate limit (sliding window algorithm)
   * @private
   * @param {string} agentId - Agent ID to check
   * @returns {boolean} True if rate limit exceeded, false otherwise
   */
  _checkRateLimit(agentId) {
    const limit = this.rateLimits.get(agentId);
    if (!limit || limit === 0) {
      return false; // No limit or unlimited
    }

    const now = Date.now();
    const windowMs = 1000; // 1 second window

    // Get or initialize timestamp window for this agent
    if (!this.rateLimitWindows.has(agentId)) {
      this.rateLimitWindows.set(agentId, []);
    }
    const window = this.rateLimitWindows.get(agentId);

    // Remove timestamps outside the window (sliding window)
    const cutoff = now - windowMs;
    while (window.length > 0 && window[0] < cutoff) {
      window.shift();
    }

    // Check if limit exceeded
    if (window.length >= limit) {
      return true; // Rate limit exceeded
    }

    // Add current timestamp to window
    window.push(now);
    return false;
  }

  /**
   * Handle incoming message from a client
   * @private
   */
  _handleMessage(msg, socket) {
    // Validate sender identity — override claimed `from` with registered identity
    const registeredId = this.socketToAgent.get(socket);
    if (registeredId && msg.from !== registeredId) {
      this._log("warn", "Sender identity mismatch", {
        claimed: msg.from, actual: registeredId,
      });
      msg.from = registeredId;
    }

    // Check rate limit
    if (registeredId && this._checkRateLimit(registeredId)) {
      this._log("warn", "Rate limit exceeded", { agentId: registeredId, messageType: msg.type });
      const errorMsg = createMessage(
        MessageType.ERROR,
        "message-bus",
        { error: "Rate limit exceeded", code: "RATE_LIMIT" },
        { to: registeredId, correlationId: msg.id }
      );
      this._sendToSocket(socket, errorMsg);
      return;
    }

    // Route bus-targeted messages to the control plane handler
    if (msg.to === "message-bus" || msg.to === "bus") {
      this._handleBusCommand(msg, socket);
      return;
    }

    // Run interception hook
    if (this.hooks.onMessageReceived) {
      try {
        const result = this.hooks.onMessageReceived(msg, socket);
        if (result === false) {
          this.metrics.messagesBlocked++;
          this._log("debug", "Message blocked by hook", { messageId: msg.id, type: msg.type });
          return;
        }
      } catch (err) {
        this._log("error", "Hook error in onMessageReceived", { error: err.message });
        this.metrics.errorsEncountered++;
      }
    }

    // Forward to orchestrator monitor if monitoring is enabled
    if (this.monitoringEnabled) {
      const orchestratorSocket = this.clients.get("orchestrator");
      if (orchestratorSocket && orchestratorSocket !== socket) {
        const monitorMsg = createMessage(MessageType.PUBLISH, "message-bus", {
          type: "monitor_message",
          originalMessage: msg,
        }, { topic: "control" });
        this._sendToSocket(orchestratorSocket, monitorMsg);
      }
    }

    switch (msg.type) {
      case MessageType.REGISTER:
        this._handleRegister(msg, socket);
        break;

      case MessageType.UNREGISTER:
        this._handleUnregister(msg, socket);
        break;

      case MessageType.SUBSCRIBE:
        this._handleSubscribe(msg);
        break;

      case MessageType.UNSUBSCRIBE:
        this._handleUnsubscribe(msg);
        break;

      case MessageType.PUBLISH:
        this._handlePublish(msg);
        break;

      case MessageType.DIRECT_SEND:
        this._handleDirectSend(msg);
        break;

      case MessageType.REQUEST:
        this._handleRequest(msg);
        break;

      case MessageType.RESPONSE:
        this._handleResponse(msg);
        break;

      case MessageType.HEARTBEAT:
        this._handleHeartbeat(msg, socket);
        break;

      default:
        this._log("warn", "Unknown message type", { type: msg.type, from: msg.from });
    }
  }

  /**
   * Handle agent registration
   * @private
   */
  _handleRegister(msg, socket) {
    const agentId = msg.from;

    // Check for duplicate registration
    if (this.clients.has(agentId)) {
      this._log("warn", "Agent already registered", { agentId });
      const oldSocket = this.clients.get(agentId);
      oldSocket.destroy();
      this.socketToAgent.delete(oldSocket);
    }

    this.clients.set(agentId, socket);
    this.socketToAgent.set(socket, agentId);
    this.metrics.connectedClients = this.clients.size;

    this._log("info", "Agent registered", { agentId, metadata: msg.payload });

    // Run hook
    if (this.hooks.onAgentConnected) {
      try {
        this.hooks.onAgentConnected(agentId, socket);
      } catch (err) {
        this._log("error", "Hook error in onAgentConnected", { error: err.message });
        this.metrics.errorsEncountered++;
      }
    }
  }

  /**
   * Handle agent unregistration
   * @private
   */
  _handleUnregister(msg, socket) {
    this._handleDisconnect(msg.from, socket, "client unregistered");
  }

  /**
   * Handle topic subscription
   * @private
   */
  _handleSubscribe(msg) {
    const { topic, from } = msg;

    // Check if this is a wildcard subscription
    if (topic.includes('*')) {
      // Store in wildcard subscriptions
      if (!this.wildcardSubscriptions.has(topic)) {
        this.wildcardSubscriptions.set(topic, new Set());
      }
      this.wildcardSubscriptions.get(topic).add(from);
      this._log("debug", "Agent subscribed to wildcard pattern", { agentId: from, pattern: topic });
    } else {
      // Exact topic subscription
      if (!this.subscriptions.has(topic)) {
        this.subscriptions.set(topic, new Set());
      }
      this.subscriptions.get(topic).add(from);
      this._log("debug", "Agent subscribed", { agentId: from, topic });
    }

    // Invalidate routing cache
    this.routingCache.clear();
  }

  /**
   * Handle topic unsubscription
   * @private
   */
  _handleUnsubscribe(msg) {
    const { topic, from } = msg;

    // Remove from exact subscriptions
    if (this.subscriptions.has(topic)) {
      this.subscriptions.get(topic).delete(from);
      if (this.subscriptions.get(topic).size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    // Remove from wildcard subscriptions
    if (this.wildcardSubscriptions.has(topic)) {
      this.wildcardSubscriptions.get(topic).delete(from);
      if (this.wildcardSubscriptions.get(topic).size === 0) {
        this.wildcardSubscriptions.delete(topic);
      }
    }

    // Invalidate routing cache
    this.routingCache.clear();

    this._log("debug", "Agent unsubscribed", { agentId: from, topic });
  }

  /**
   * Handle publish message
   * @private
   */
  _handlePublish(msg) {
    const count = this._routeToSubscribers(msg.topic, msg);
    this._log("debug", "Message published", { topic: msg.topic, from: msg.from, subscribers: count });
  }

  /**
   * Handle direct send message
   * @private
   */
  _handleDirectSend(msg) {
    const delivered = this._sendToClient(msg.to, msg);
    if (!delivered) {
      this._log("warn", "Failed to deliver direct message", { to: msg.to, from: msg.from });
    }
  }

  /**
   * Handle request message
   * @private
   */
  _handleRequest(msg) {
    // Track pending request
    this.pendingRequests.set(msg.id, {
      from: msg.from,
      timestamp: msg.timestamp,
    });

    const delivered = this._sendToClient(msg.to, msg);
    if (!delivered) {
      this._log("warn", "Failed to deliver request", { to: msg.to, from: msg.from });
      this.pendingRequests.delete(msg.id);
    }
  }

  /**
   * Handle response message
   * @private
   */
  _handleResponse(msg) {
    // Check if this is a response to a known request
    const request = this.pendingRequests.get(msg.correlationId);
    if (request) {
      this.pendingRequests.delete(msg.correlationId);
      this._log("debug", "Response received", { correlationId: msg.correlationId, latencyMs: Date.now() - request.timestamp });
    }

    const delivered = this._sendToClient(msg.to, msg);
    if (!delivered) {
      this._log("warn", "Failed to deliver response", { to: msg.to, from: msg.from, correlationId: msg.correlationId });
    }
  }

  /**
   * Handle heartbeat message — update lastSeen, no echo (reduces 2× message overhead)
   * @private
   */
  _handleHeartbeat(msg, socket) {
    this.agentLastSeen.set(msg.from, Date.now());
  }

  /**
   * Handle client disconnect
   * @private
   */
  _handleDisconnect(agentId, socket, reason) {
    // Remove from clients
    this.clients.delete(agentId);
    this.socketToAgent.delete(socket);
    this.metrics.connectedClients = this.clients.size;

    // Remove from all exact subscriptions
    for (const [topic, subscribers] of this.subscriptions.entries()) {
      subscribers.delete(agentId);
      if (subscribers.size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    // Remove from all wildcard subscriptions
    for (const [pattern, subscribers] of this.wildcardSubscriptions.entries()) {
      subscribers.delete(agentId);
      if (subscribers.size === 0) {
        this.wildcardSubscriptions.delete(pattern);
      }
    }

    // Invalidate routing cache
    this.routingCache.clear();

    this._log("info", "Agent disconnected", { agentId, reason });

    // Run hook
    if (this.hooks.onAgentDisconnected) {
      try {
        this.hooks.onAgentDisconnected(agentId, reason);
      } catch (err) {
        this._log("error", "Hook error in onAgentDisconnected", { error: err.message });
        this.metrics.errorsEncountered++;
      }
    }
  }

  /**
   * Route message to all subscribers of a topic
   * @private
   * @returns {number} Number of recipients
   */
  _routeToSubscribers(topic, msg) {
    // Check cache first
    let allSubscribers = this.routingCache.get(topic);

    if (!allSubscribers) {
      // Build subscriber set: exact matches + wildcard matches
      allSubscribers = new Set();

      // Add exact topic subscribers
      const exactSubscribers = this.subscriptions.get(topic);
      if (exactSubscribers) {
        for (const agentId of exactSubscribers) {
          allSubscribers.add(agentId);
        }
      }

      // Add wildcard subscribers (check all wildcard patterns)
      for (const [pattern, subscribers] of this.wildcardSubscriptions.entries()) {
        if (this._matchesWildcard(pattern, topic)) {
          for (const agentId of subscribers) {
            allSubscribers.add(agentId);
          }
        }
      }

      // Cache the result
      this.routingCache.set(topic, allSubscribers);
    }

    if (allSubscribers.size === 0) {
      return 0;
    }

    let count = 0;
    for (const agentId of allSubscribers) {
      if (this._sendToClient(agentId, msg)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Send message to a specific client by agent ID
   * @private
   * @returns {boolean} True if sent, false if client not found
   */
  _sendToClient(agentId, msg) {
    const socket = this.clients.get(agentId);
    if (!socket) {
      return false;
    }

    // If agent is paused, queue the message
    if (this.pausedAgents.has(agentId)) {
      if (!this.pausedQueues.has(agentId)) {
        this.pausedQueues.set(agentId, []);
      }
      const queue = this.pausedQueues.get(agentId);

      // Cap at 1000 messages, drop oldest
      if (queue.length >= 1000) {
        queue.shift();
        this._log("warn", "Paused agent queue full, dropping oldest message", { agentId });
      }

      queue.push(msg);
      this._log("debug", "Message queued for paused agent", { agentId, queueSize: queue.length });
      return true;
    }

    return this._sendToSocket(socket, msg);
  }

  /**
   * Send message to a socket with backpressure handling
   * @private
   * @returns {boolean} True if sent, false if backpressure blocked
   */
  _sendToSocket(socket, msg) {
    try {
      const buffer = serializeMessage(msg);
      const flushed = socket.write(buffer);

      this.metrics.bytesSent += buffer.length;
      this.metrics.messagesRouted++;

      if (!flushed) {
        this._log("debug", "Backpressure: write buffer full", { to: this.socketToAgent.get(socket) });
      }

      // Run routing hook
      if (this.hooks.onMessageRouted) {
        try {
          this.hooks.onMessageRouted(msg, socket);
        } catch (err) {
          this._log("error", "Hook error in onMessageRouted", { error: err.message });
          this.metrics.errorsEncountered++;
        }
      }

      return true;
    } catch (err) {
      this._log("error", "Failed to send message", { error: err.message });
      this.metrics.errorsEncountered++;
      return false;
    }
  }

  /**
   * Structured logging
   * @private
   */
  _log(level, message, context = {}) {
    if (!this.enableLogging) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: "message-bus",
      message,
      ...context,
    };

    this.logger(JSON.stringify(logEntry));
  }

  /**
   * Handle control-plane commands sent to "bus" or "message-bus"
   *
   * Dispatches OrchestratorControl commands: enable_privileged, enable_monitor,
   * disable_monitor, query_state, pause_agent, resume_agent, set_rate_limit,
   * get_rate_limit, get_bus_stats, get_agent_stats, disconnect_agent, inject_message.
   *
   * @private
   * @param {import("./protocol.mjs").Message} msg - Incoming message
   * @param {import("net").Socket} socket - Sender's socket
   */
  _handleBusCommand(msg, socket) {
    const cmd = msg.payload?.type;
    const senderId = this.socketToAgent.get(socket);

    switch (cmd) {
      case "enable_privileged":
        if (senderId !== "orchestrator" || msg.payload?.token !== this.orchestratorToken) {
          this._log("warn", "Unauthorized privileged mode attempt", { from: senderId });
          socket.destroy();
          return;
        }
        this._log("info", "Privileged mode enabled for orchestrator");
        break;

      case "enable_monitor":
        if (senderId !== "orchestrator") {
          this._log("warn", "Non-orchestrator attempted enable_monitor", { from: senderId });
          return;
        }
        this.monitoringEnabled = true;
        this._log("info", "Message monitoring enabled");
        break;

      case "disable_monitor":
        if (senderId !== "orchestrator") return;
        this.monitoringEnabled = false;
        this._log("info", "Message monitoring disabled");
        break;

      case "query_state": {
        const state = {
          agents: this.getConnectedAgents(),
          stats: this.getMetrics(),
          topics: Array.from(this.subscriptions.keys()),
          pausedAgents: Array.from(this.pausedAgents),
        };
        const response = createMessage(
          MessageType.RESPONSE, "message-bus", state,
          { to: msg.from, correlationId: msg.id }
        );
        this._sendToSocket(socket, response);
        break;
      }

      case "pause_agent": {
        const targetId = msg.payload?.targetAgentId;
        if (targetId) {
          this.pausedAgents.add(targetId);
          this._log("info", "Agent paused", { agentId: targetId, pausedBy: senderId });
        }
        break;
      }

      case "resume_agent": {
        const targetId = msg.payload?.targetAgentId;
        if (targetId) {
          this.pausedAgents.delete(targetId);

          // Drain queued messages
          const queue = this.pausedQueues.get(targetId);
          if (queue && queue.length > 0) {
            this._log("info", "Draining paused agent queue", { agentId: targetId, queueSize: queue.length });
            for (const queuedMsg of queue) {
              this._sendToClient(targetId, queuedMsg);
            }
            this.pausedQueues.delete(targetId);
          }

          this._log("info", "Agent resumed", { agentId: targetId, resumedBy: senderId });
        }
        break;
      }

      case "set_rate_limit": {
        const targetId = msg.payload?.targetAgentId;
        const limit = msg.payload?.msgsPerSec;
        if (targetId && typeof limit === "number") {
          if (limit === 0) {
            this.rateLimits.delete(targetId);
          } else {
            this.rateLimits.set(targetId, limit);
          }
          this._log("info", "Rate limit set", { agentId: targetId, msgsPerSec: limit });
        }
        break;
      }

      case "get_rate_limit": {
        const targetId = msg.payload?.targetAgentId;
        const limit = this.rateLimits.get(targetId) || 0;
        const response = createMessage(
          MessageType.RESPONSE, "message-bus", { msgsPerSec: limit },
          { to: msg.from, correlationId: msg.id }
        );
        this._sendToSocket(socket, response);
        break;
      }

      case "get_bus_stats": {
        const response = createMessage(
          MessageType.RESPONSE, "message-bus", this.getMetrics(),
          { to: msg.from, correlationId: msg.id }
        );
        this._sendToSocket(socket, response);
        break;
      }

      case "get_agent_stats": {
        const targetId = msg.payload?.targetAgentId;
        const targetSocket = this.clients.get(targetId);
        const response = createMessage(
          MessageType.RESPONSE, "message-bus", {
            agentId: targetId,
            connected: !!targetSocket,
            paused: this.pausedAgents.has(targetId),
            rateLimit: this.rateLimits.get(targetId) || 0,
          },
          { to: msg.from, correlationId: msg.id }
        );
        this._sendToSocket(socket, response);
        break;
      }

      case "disconnect_agent": {
        const targetId = msg.payload?.targetAgentId;
        const reason = msg.payload?.reason || "Disconnected by orchestrator";
        const targetSocket = this.clients.get(targetId);
        if (targetSocket) {
          this._handleDisconnect(targetId, targetSocket, reason);
          targetSocket.destroy();
        }
        break;
      }

      case "inject_message": {
        const injectedMsg = msg.payload?.message;
        if (injectedMsg) {
          this._log("info", "Message injected by orchestrator", { type: injectedMsg.type });
          // Route the injected message as if it came from a client
          this._handleMessage(injectedMsg, socket);
        }
        break;
      }

      case "add_filter":
      case "remove_filter":
        // Filters are managed client-side in OrchestratorControl
        // Bus just acknowledges
        break;

      default:
        this._log("warn", "Unknown bus command", { cmd, from: senderId });
    }
  }
}

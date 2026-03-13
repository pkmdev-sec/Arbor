/**
 * Scoped Message Bus for Hierarchical Agent Coordination
 *
 * Provides a hierarchical topic scoping wrapper around AgentChannel for
 * multi-level agent coordination. Enables parent-child communication with
 * isolated topic namespaces.
 *
 * Topic naming convention:
 *   swarm.L{level}.{scope}.{event}
 *   Examples:
 *     swarm.L0.orchestrator.status
 *     swarm.L1.auth.progress
 *     swarm.L2.auth.middleware.merge
 *
 * @module hierarchy/scoped-bus
 */

import { AgentChannel } from "../ipc/agent-channel.mjs";
import { MessageType } from "../ipc/protocol.mjs";

/**
 * Predefined hierarchical event topics
 * @enum {string}
 */
export const HierarchicalTopics = {
  /** Agent lifecycle events (online, offline, crash) */
  STATUS: "status",

  /** Progress updates (percent, current step) */
  PROGRESS: "progress",

  /** Merge operations (file conflicts, resolution) */
  MERGE: "merge",

  /** Error notifications */
  ERROR: "error",

  /** Control commands (pause, resume, cancel) */
  CONTROL: "control",

  /** Heartbeat pings */
  HEARTBEAT: "heartbeat",

  /** Result delivery */
  RESULT: "result",
};

/**
 * Scoped message bus wrapping AgentChannel with hierarchical topic namespacing
 *
 * @example
 * const bus = new ScopedBus("agent-01", { level: 1, scope: "auth" });
 * await bus.connect();
 *
 * // Publish to swarm.L1.auth.progress
 * await bus.publish(HierarchicalTopics.PROGRESS, { percent: 0.5 });
 *
 * // Publish to parent (L0)
 * await bus.publishUp(HierarchicalTopics.STATUS, { status: "completed" });
 *
 * // Subscribe to children (L2.auth.*)
 * bus.subscribeDown(HierarchicalTopics.STATUS, (msg) => {
 *   console.log("Child status:", msg);
 * });
 */
export class ScopedBus {
  /**
   * Create a scoped message bus
   *
   * @param {string} agentId - Unique agent identifier
   * @param {Object} options - Configuration options
   * @param {number} options.level - Hierarchy level (0 = orchestrator, 1 = sub-coordinator, 2+ = workers)
   * @param {string} options.scope - Scope identifier (e.g., "auth", "api", "orchestrator")
   * @param {string} [options.socketPath] - Unix socket path (default: from env or /tmp/claude-ipc-bus.sock)
   * @param {boolean} [options.autoReconnect=true] - Enable auto-reconnect on connection loss
   * @param {boolean} [options.enableLogging=true] - Enable JSON structured logging
   */
  constructor(agentId, options = {}) {
    if (!agentId || typeof agentId !== "string") {
      throw new TypeError("agentId must be a non-empty string");
    }
    if (typeof options.level !== "number" || options.level < 0) {
      throw new TypeError("options.level must be a non-negative number");
    }
    if (!options.scope || typeof options.scope !== "string") {
      throw new TypeError("options.scope must be a non-empty string");
    }

    this.agentId = agentId;
    this.level = options.level;
    this.scope = options.scope;
    this.enableLogging = options.enableLogging !== false;

    /** @type {string} Scope prefix for all topics: swarm.L{level}.{scope} */
    this.scopePrefix = `swarm.L${this.level}.${this.scope}`;

    /** @type {AgentChannel} Underlying IPC channel */
    this.channel = new AgentChannel(agentId, {
      socketPath: options.socketPath,
      autoReconnect: options.autoReconnect !== false,
    });

    /** @type {Map<string, Function[]>} Local topic subscriptions (scoped topic → handlers) */
    this.localSubscriptions = new Map();

    /** @type {Map<string, Function[]>} Pattern-based subscriptions (pattern → handlers) */
    this.patternSubscriptions = new Map();

    /** @type {boolean} Connection state */
    this.connected = false;

    // Forward channel events
    this.channel.on("connected", () => {
      this.connected = true;
      this._log("info", "Scoped bus connected", { level: this.level, scope: this.scope });
    });

    this.channel.on("disconnected", () => {
      this.connected = false;
      this._log("warn", "Scoped bus disconnected", { level: this.level, scope: this.scope });
    });

    this.channel.on("error", (err) => {
      this._log("error", "Scoped bus error", { error: err.message });
    });
  }

  /**
   * Connect to the IPC message bus
   *
   * @returns {Promise<void>}
   * @throws {Error} If connection fails
   */
  async connect() {
    try {
      await this.channel.connect();
      this.connected = true;
      this._log("info", "Connected to message bus", { agentId: this.agentId, scopePrefix: this.scopePrefix });
    } catch (err) {
      this._log("error", "Failed to connect to message bus", { error: err.message });
      throw new Error(`ScopedBus connect failed: ${err.message}`);
    }
  }

  /**
   * Publish a message to this scope's topic
   *
   * Full topic: swarm.L{level}.{scope}.{eventType}
   *
   * @param {string} eventType - Event type (e.g., HierarchicalTopics.PROGRESS)
   * @param {any} payload - Message payload
   * @returns {Promise<void>}
   */
  async publish(eventType, payload) {
    const fullTopic = this.getFullTopic(eventType);
    try {
      await this.channel.publish(fullTopic, payload);
      this._log("debug", "Published to scoped topic", { topic: fullTopic, payloadSize: JSON.stringify(payload).length });
    } catch (err) {
      this._log("error", "Failed to publish", { topic: fullTopic, error: err.message });
      throw new Error(`ScopedBus publish failed: ${err.message}`);
    }
  }

  /**
   * Subscribe to a topic within this scope
   *
   * Supports wildcard patterns:
   * - "*" matches exactly one segment
   * - "**" matches one or more segments
   *
   * @param {string} eventType - Event type to subscribe to (may contain wildcards)
   * @param {function(any): void} handler - Message handler
   *
   * @example
   * bus.subscribe("progress", handler) // exact match
   * bus.subscribe("*", handler) // matches any single-segment event
   * bus.subscribe("auth.*", handler) // matches auth.progress, auth.status, etc.
   */
  subscribe(eventType, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("handler must be a function");
    }

    const fullTopic = this.getFullTopic(eventType);
    const hasWildcard = fullTopic.includes("*");

    try {
      if (hasWildcard) {
        // Pattern subscription - store locally and filter all messages
        if (!this.patternSubscriptions.has(fullTopic)) {
          this.patternSubscriptions.set(fullTopic, []);

          // Set up global message interceptor for this pattern (only once)
          if (this.patternSubscriptions.size === 1) {
            this.channel.onMessage((msg) => {
              // Check all pattern subscriptions
              for (const [pattern, handlers] of this.patternSubscriptions.entries()) {
                if (msg.type === "publish" && this._matchTopic(pattern, msg.topic)) {
                  for (const h of handlers) {
                    try {
                      h(msg);
                    } catch (err) {
                      this._log("error", "Pattern subscription handler error", { pattern, topic: msg.topic, error: err.message });
                    }
                  }
                }
              }
            });
          }
        }

        this.patternSubscriptions.get(fullTopic).push(handler);
        this._log("debug", "Subscribed to pattern", { pattern: fullTopic });
      } else {
        // Exact subscription - use existing logic
        if (!this.localSubscriptions.has(fullTopic)) {
          this.localSubscriptions.set(fullTopic, []);

          // Subscribe to the full topic via channel
          this.channel.subscribe(fullTopic, (msg) => {
            const handlers = this.localSubscriptions.get(fullTopic);
            if (handlers) {
              for (const h of handlers) {
                try {
                  h(msg);
                } catch (err) {
                  this._log("error", "Subscription handler error", { topic: fullTopic, error: err.message });
                }
              }
            }
          });
        }

        this.localSubscriptions.get(fullTopic).push(handler);
        this._log("debug", "Subscribed to scoped topic", { topic: fullTopic });
      }
    } catch (err) {
      this._log("error", "Failed to subscribe", { topic: fullTopic, error: err.message });
      throw new Error(`ScopedBus subscribe failed: ${err.message}`);
    }
  }

  /**
   * Publish a message to parent scope (one level up)
   *
   * Target topic: swarm.L{level-1}.{parentScope}.{eventType}
   *
   * @param {string} eventType - Event type
   * @param {any} payload - Message payload
   * @param {string} [parentScope] - Parent scope (default: inferred from current scope)
   * @returns {Promise<void>}
   */
  async publishUp(eventType, payload, parentScope = null) {
    if (this.level === 0) {
      this._log("warn", "Cannot publish up from level 0", { eventType });
      return;
    }

    const targetLevel = this.level - 1;
    const targetScope = parentScope || this._inferParentScope();
    const fullTopic = `swarm.L${targetLevel}.${targetScope}.${eventType}`;

    try {
      await this.channel.publish(fullTopic, payload);
      this._log("debug", "Published to parent", { topic: fullTopic, payloadSize: JSON.stringify(payload).length });
    } catch (err) {
      this._log("error", "Failed to publish up", { topic: fullTopic, error: err.message });
      throw new Error(`ScopedBus publishUp failed: ${err.message}`);
    }
  }

  /**
   * Subscribe to child scope topics (one or more levels down)
   *
   * Subscribes to: swarm.L{level+1}.{scope}.**.{eventType}
   * Uses "**" wildcard to match all nested child subscopes
   *
   * @param {string} eventType - Event type to subscribe to
   * @param {function(any): void} handler - Message handler
   *
   * @example
   * // At L1 with scope "auth", subscribe to all child progress events:
   * bus.subscribeDown("progress", handler)
   * // Matches: swarm.L2.auth.middleware.progress
   * // Matches: swarm.L2.auth.routes.api.progress
   * // Matches: any nested child under auth.* at L2
   */
  subscribeDown(eventType, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("handler must be a function");
    }

    const childLevel = this.level + 1;
    const wildcardPattern = `swarm.L${childLevel}.${this.scope}.**.${eventType}`;

    try {
      // Store as pattern subscription and use _matchTopic for filtering
      if (!this.patternSubscriptions.has(wildcardPattern)) {
        this.patternSubscriptions.set(wildcardPattern, []);

        // Set up global message interceptor if this is the first pattern
        if (this.patternSubscriptions.size === 1 && this.localSubscriptions.size === 0) {
          this.channel.onMessage((msg) => {
            // Check all pattern subscriptions
            for (const [pattern, handlers] of this.patternSubscriptions.entries()) {
              if (msg.type === "publish" && this._matchTopic(pattern, msg.topic)) {
                for (const h of handlers) {
                  try {
                    h(msg);
                  } catch (err) {
                    this._log("error", "Pattern subscription handler error", { pattern, topic: msg.topic, error: err.message });
                  }
                }
              }
            }
          });
        }
      }

      this.patternSubscriptions.get(wildcardPattern).push(handler);
      this._log("debug", "Subscribed to child topics with pattern", { pattern: wildcardPattern });
    } catch (err) {
      this._log("error", "Failed to subscribe down", { pattern: wildcardPattern, error: err.message });
      throw new Error(`ScopedBus subscribeDown failed: ${err.message}`);
    }
  }

  /**
   * Get the fully qualified topic name for an event type
   *
   * @param {string} eventType - Event type
   * @returns {string} Full topic (swarm.L{level}.{scope}.{eventType})
   */
  getFullTopic(eventType) {
    if (!eventType || typeof eventType !== "string") {
      throw new TypeError("eventType must be a non-empty string");
    }
    return `${this.scopePrefix}.${eventType}`;
  }

  /**
   * Send a direct message to a specific agent
   *
   * @param {string} targetAgentId - Recipient agent ID
   * @param {any} message - Message payload
   * @returns {Promise<void>}
   */
  async send(targetAgentId, message) {
    try {
      await this.channel.send(targetAgentId, message);
      this._log("debug", "Sent direct message", { to: targetAgentId, payloadSize: JSON.stringify(message).length });
    } catch (err) {
      this._log("error", "Failed to send direct message", { to: targetAgentId, error: err.message });
      throw new Error(`ScopedBus send failed: ${err.message}`);
    }
  }

  /**
   * Send a request and wait for response
   *
   * @param {string} targetAgentId - Recipient agent ID
   * @param {any} message - Request message
   * @param {number} [timeoutMs=5000] - Timeout in milliseconds
   * @returns {Promise<any>} Response payload
   */
  async request(targetAgentId, message, timeoutMs = 5000) {
    try {
      const response = await this.channel.request(targetAgentId, message, timeoutMs);
      this._log("debug", "Request completed", { to: targetAgentId, timeoutMs });
      return response;
    } catch (err) {
      this._log("error", "Request failed", { to: targetAgentId, error: err.message });
      throw new Error(`ScopedBus request failed: ${err.message}`);
    }
  }

  /**
   * Register a global message handler
   *
   * @param {function(any): void} handler - Handler that receives all messages
   */
  onMessage(handler) {
    try {
      this.channel.onMessage(handler);
    } catch (err) {
      this._log("error", "Failed to register message handler", { error: err.message });
      throw new Error(`ScopedBus onMessage failed: ${err.message}`);
    }
  }

  /**
   * Close the connection gracefully
   *
   * @returns {Promise<void>}
   */
  async close() {
    try {
      this.connected = false;
      this.localSubscriptions.clear();
      this.patternSubscriptions.clear();
      await this.channel.close();
      this._log("info", "Scoped bus closed", { agentId: this.agentId });
    } catch (err) {
      this._log("error", "Failed to close scoped bus", { error: err.message });
      throw new Error(`ScopedBus close failed: ${err.message}`);
    }
  }

  /**
   * Match a topic pattern against a concrete topic
   *
   * Supports wildcard patterns:
   * - "*" matches exactly one segment
   * - "**" matches one or more segments (greedy)
   *
   * @private
   * @param {string} pattern - Topic pattern (e.g., "swarm.L1.*", "swarm.L1.**")
   * @param {string} topic - Concrete topic (e.g., "swarm.L1.auth")
   * @returns {boolean} True if topic matches pattern
   *
   * @example
   * _matchTopic("swarm.L1.*", "swarm.L1.auth") // true
   * _matchTopic("swarm.L1.*", "swarm.L1.auth.progress") // false
   * _matchTopic("swarm.L1.**", "swarm.L1.auth") // true
   * _matchTopic("swarm.L1.**", "swarm.L1.auth.progress") // true
   * _matchTopic("swarm.*.auth", "swarm.L1.auth") // true
   */
  _matchTopic(pattern, topic) {
    const patternSegments = pattern.split(".");
    const topicSegments = topic.split(".");

    let patternIdx = 0;
    let topicIdx = 0;

    while (patternIdx < patternSegments.length) {
      const patternSeg = patternSegments[patternIdx];

      if (patternSeg === "**") {
        // Greedy wildcard: match one or more remaining segments
        // Try to match remaining pattern against remaining topic at different positions
        patternIdx++;

        if (patternIdx >= patternSegments.length) {
          // "**" at end of pattern - matches all remaining topic segments
          return topicIdx < topicSegments.length;
        }

        // Try to find a position where the remaining pattern matches
        while (topicIdx < topicSegments.length) {
          if (this._matchTopic(
            patternSegments.slice(patternIdx).join("."),
            topicSegments.slice(topicIdx).join(".")
          )) {
            return true;
          }
          topicIdx++;
        }

        return false;
      } else if (patternSeg === "*") {
        // Single wildcard: match exactly one segment
        if (topicIdx >= topicSegments.length) {
          return false;
        }
        patternIdx++;
        topicIdx++;
      } else {
        // Exact match required
        if (topicIdx >= topicSegments.length || patternSeg !== topicSegments[topicIdx]) {
          return false;
        }
        patternIdx++;
        topicIdx++;
      }
    }

    // Both must be fully consumed
    return topicIdx === topicSegments.length;
  }

  /**
   * Infer parent scope from current scope
   * (removes last segment after last dot)
   *
   * @private
   * @returns {string} Parent scope
   */
  _inferParentScope() {
    const parts = this.scope.split(".");
    if (parts.length > 1) {
      parts.pop();
      return parts.join(".");
    }
    return "orchestrator";
  }

  /**
   * Structured JSON logging
   *
   * @private
   * @param {string} level - Log level (debug, info, warn, error)
   * @param {string} message - Log message
   * @param {Object} [context] - Additional context
   */
  _log(level, message, context = {}) {
    if (!this.enableLogging) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: "scoped-bus",
      agentId: this.agentId,
      scope: this.scope,
      hierarchyLevel: this.level,
      message,
      ...context,
    };

    process.stderr.write(JSON.stringify(logEntry) + "\n");
  }
}

/**
 * Create a child scope from a parent scope
 *
 * @param {string} parentScope - Parent scope identifier
 * @param {string} childName - Child scope name
 * @returns {string} Child scope identifier (parentScope.childName)
 *
 * @example
 * createChildScope("auth", "middleware") // returns "auth.middleware"
 * createChildScope("api", "routes") // returns "api.routes"
 */
export function createChildScope(parentScope, childName) {
  if (!parentScope || typeof parentScope !== "string") {
    throw new TypeError("parentScope must be a non-empty string");
  }
  if (!childName || typeof childName !== "string") {
    throw new TypeError("childName must be a non-empty string");
  }

  return `${parentScope}.${childName}`;
}

/**
 * Aggregate progress from multiple scoped buses
 *
 * Collects progress reports from child scoped buses and computes aggregate progress.
 *
 * @param {ScopedBus[]} scopedBuses - Array of scoped bus instances
 * @returns {Promise<AggregatedProgress>} Aggregated progress data
 *
 * @typedef {Object} AggregatedProgress
 * @property {number} overallPercent - Overall progress percentage (0-100)
 * @property {number} totalAgents - Total number of agents
 * @property {number} completedAgents - Number of completed agents
 * @property {number} activeAgents - Number of active agents
 * @property {Object[]} agentProgress - Per-agent progress details
 * @property {string} agentProgress[].agentId - Agent ID
 * @property {string} agentProgress[].scope - Agent scope
 * @property {number} agentProgress[].level - Hierarchy level
 * @property {number} agentProgress[].percent - Agent progress percentage
 * @property {string} agentProgress[].status - Agent status (active, completed, failed)
 */
export async function aggregateProgress(scopedBuses) {
  if (!Array.isArray(scopedBuses)) {
    throw new TypeError("scopedBuses must be an array");
  }

  const agentProgress = [];
  let totalPercent = 0;
  let completedCount = 0;
  let activeCount = 0;

  // Request progress from all buses in parallel using Promise.allSettled
  const progressPromises = scopedBuses.map(bus => {
    if (!(bus instanceof ScopedBus)) {
      return Promise.resolve({ status: 'rejected', reason: 'Not a ScopedBus instance', bus });
    }

    // Request progress from each bus with 2000ms timeout
    return bus.request(bus.agentId, { type: "get_progress" }, 2000)
      .then(progress => ({ status: 'fulfilled', value: progress, bus }))
      .catch(error => ({ status: 'rejected', reason: error, bus }));
  });

  // Wait for all progress requests to complete (max 2s total)
  const results = await Promise.allSettled(progressPromises);

  // Process results
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
      const { value: progress, bus } = result.value;
      const percent = progress.percent || 0;
      const status = progress.status || "active";

      agentProgress.push({
        agentId: bus.agentId,
        scope: bus.scope,
        level: bus.level,
        percent,
        status,
      });

      totalPercent += percent;
      if (status === "completed") {
        completedCount++;
      } else if (status === "active") {
        activeCount++;
      }
    } else if (result.status === 'fulfilled' && result.value.status === 'rejected') {
      // Progress query failed, assume agent is active at 0%
      const { bus, reason } = result.value;
      if (bus && bus instanceof ScopedBus) {
        agentProgress.push({
          agentId: bus.agentId,
          scope: bus.scope,
          level: bus.level,
          percent: 0,
          status: "active",
        });
        activeCount++;

        // Log error
        process.stderr.write(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          component: "aggregate-progress",
          message: "Failed to query agent progress",
          agentId: bus.agentId,
          error: reason?.message || String(reason),
        }) + "\n");
      }
    }
  }

  const totalAgents = scopedBuses.length;
  const overallPercent = totalAgents > 0 ? totalPercent / totalAgents : 0;

  return {
    overallPercent,
    totalAgents,
    completedAgents: completedCount,
    activeAgents: activeCount,
    agentProgress,
  };
}

/**
 * Create a scoped bus instance and connect
 *
 * @param {string} agentId - Agent identifier
 * @param {Object} options - Configuration options
 * @returns {Promise<ScopedBus>} Connected scoped bus
 */
export async function createScopedBus(agentId, options) {
  try {
    const bus = new ScopedBus(agentId, options);
    await bus.connect();
    return bus;
  } catch (err) {
    throw new Error(`Failed to create scoped bus: ${err.message}`);
  }
}

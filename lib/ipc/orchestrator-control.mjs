/**
 * Orchestrator Control: Privileged bus connection for master orchestrator
 *
 * Provides control-plane operations for the orchestrator to manage agent communication:
 * - Monitor all bus messages (wiretap/audit)
 * - Filter/block messages based on predicates
 * - Inject synthetic messages for testing/orchestration
 * - Pause/resume agent message flow
 * - Query bus state (connected agents, stats)
 * - Set per-agent rate limits
 *
 * This is a privileged channel that should only be used by the swarm orchestrator,
 * not by individual agents.
 *
 * @module orchestrator-control
 */

import { AgentChannel } from "./agent-channel.mjs";

/**
 * Privileged orchestrator control channel
 *
 * @example
 * const control = new OrchestratorControl();
 * await control.connect();
 *
 * // Monitor all messages
 * control.monitorAll((msg) => {
 *   console.log("Bus message:", msg.type, msg.from, "->", msg.to);
 * });
 *
 * // Block messages from agent-02
 * control.filterMessages((msg) => msg.from === "agent-02" && msg.type === "publish");
 *
 * // Pause agent-03's message flow
 * await control.pauseAgent("agent-03");
 *
 * // Query bus state
 * const state = await control.queryBusState();
 * console.log("Connected agents:", state.agents);
 *
 * // Set rate limit
 * await control.setRateLimit("agent-01", 100); // 100 msg/sec
 *
 * await control.close();
 */
export class OrchestratorControl extends AgentChannel {
  /**
   * @param {object} [options] - Configuration options (passed to AgentChannel)
   */
  /**
   * @param {object} [options] - Configuration options (passed to AgentChannel)
   * @param {string} [options.orchestratorToken] - Authentication token for bus registration
   */
  constructor(options = {}) {
    super("orchestrator", options);

    /** @type {string|undefined} Token for authenticating with the bus */
    this.orchestratorToken = options.orchestratorToken;

    // Monitoring and filtering
    this.monitorHandler = null;
    this.filterPredicates = [];

    // Paused agents
    this.pausedAgents = new Set();

    // Subscribe to control topic for bus responses
    this.subscribe("control", (msg) => {
      this._handleControlMessage(msg);
    });
  }

  /**
   * Connect to the bus and enable privileged mode.
   * Overrides the REGISTER payload to include the orchestrator auth token.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    // The parent connect() sends REGISTER automatically. We need to override
    // the registration message to include the token. We do this by connecting
    // then immediately sending the privileged mode request.
    await super.connect();

    // Request privileged mode
    await this.send("bus", {
      type: "enable_privileged",
      token: this.orchestratorToken,
      requestedCapabilities: [
        "monitor",
        "filter",
        "inject",
        "pause",
        "query",
        "rate_limit",
      ],
    });
  }

  /**
   * Monitor all messages on the bus (wiretap/audit mode)
   *
   * @param {function(object): void} handler - Handler that receives all bus messages
   * @returns {Promise<void>}
   */
  async monitorAll(handler) {
    this.monitorHandler = handler;

    // Enable monitoring on the bus
    await this.send("bus", {
      type: "enable_monitor",
      agentId: this.agentId
    });
  }

  /**
   * Stop monitoring all messages
   *
   * @returns {Promise<void>}
   */
  async stopMonitoring() {
    this.monitorHandler = null;

    await this.send("bus", {
      type: "disable_monitor",
      agentId: this.agentId
    });
  }

  /**
   * Filter messages based on predicate
   *
   * Messages matching the predicate will be blocked.
   *
   * @param {function(object): boolean} predicate - Returns true to block message
   * @returns {string} Filter ID (for later removal)
   */
  filterMessages(predicate) {
    const filterId = `filter-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.filterPredicates.push({ id: filterId, predicate });

    // Notify bus of filter
    this.send("bus", {
      type: "add_filter",
      filterId: filterId,
      // Note: predicate function cannot be serialized, so the orchestrator
      // must handle filtering locally and instruct the bus to drop messages
      // This is a client-side filter for the orchestrator's own processing
    }).catch(() => {});

    return filterId;
  }

  /**
   * Remove a message filter
   *
   * @param {string} filterId - Filter ID returned by filterMessages()
   * @returns {Promise<void>}
   */
  async removeFilter(filterId) {
    const index = this.filterPredicates.findIndex(f => f.id === filterId);
    if (index !== -1) {
      this.filterPredicates.splice(index, 1);
    }

    await this.send("bus", {
      type: "remove_filter",
      filterId: filterId
    });
  }

  /**
   * Inject a synthetic message into the bus
   *
   * Useful for testing, orchestration, or simulating agent behavior.
   *
   * @param {object} message - Message to inject (must have type, from, to/topic)
   * @returns {Promise<void>}
   */
  async injectMessage(message) {
    if (!message.type || !message.from) {
      throw new Error("Injected message must have type and from fields");
    }

    await this.send("bus", {
      type: "inject_message",
      message: message,
      injectedBy: this.agentId,
      timestamp: Date.now()
    });
  }

  /**
   * Pause an agent's message flow
   *
   * Messages from the paused agent will be queued by the bus but not delivered
   * until resumed.
   *
   * @param {string} agentId - Agent to pause
   * @returns {Promise<void>}
   */
  async pauseAgent(agentId) {
    this.pausedAgents.add(agentId);

    await this.send("bus", {
      type: "pause_agent",
      targetAgentId: agentId,
      pausedBy: this.agentId,
      timestamp: Date.now()
    });
  }

  /**
   * Resume a paused agent's message flow
   *
   * Queued messages will be delivered.
   *
   * @param {string} agentId - Agent to resume
   * @returns {Promise<void>}
   */
  async resumeAgent(agentId) {
    this.pausedAgents.delete(agentId);

    await this.send("bus", {
      type: "resume_agent",
      targetAgentId: agentId,
      resumedBy: this.agentId,
      timestamp: Date.now()
    });
  }

  /**
   * Query current bus state
   *
   * @returns {Promise<object>} Bus state: { agents: [...], stats: {...}, topics: [...] }
   */
  async queryBusState() {
    return await this.request("bus", {
      type: "query_state"
    }, 5000);
  }

  /**
   * Set per-agent rate limit
   *
   * @param {string} agentId - Agent to limit
   * @param {number} msgsPerSec - Messages per second limit (0 = unlimited)
   * @returns {Promise<void>}
   */
  async setRateLimit(agentId, msgsPerSec) {
    if (msgsPerSec < 0) {
      throw new Error("Rate limit must be >= 0");
    }

    await this.send("bus", {
      type: "set_rate_limit",
      targetAgentId: agentId,
      msgsPerSec: msgsPerSec,
      setBy: this.agentId,
      timestamp: Date.now()
    });
  }

  /**
   * Get per-agent rate limit
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<number>} Current rate limit (msgs/sec)
   */
  async getRateLimit(agentId) {
    const response = await this.request("bus", {
      type: "get_rate_limit",
      targetAgentId: agentId
    }, 2000);

    return response.msgsPerSec;
  }

  /**
   * Broadcast a control message to all agents
   *
   * @param {object} message - Message payload
   * @returns {Promise<void>}
   */
  async broadcastControl(message) {
    await this.publish("control", {
      ...message,
      from: this.agentId,
      timestamp: Date.now()
    });
  }

  /**
   * Get message statistics for an agent
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<object>} Stats: { sent: N, received: N, dropped: N, rateLimited: N }
   */
  async getAgentStats(agentId) {
    return await this.request("bus", {
      type: "get_agent_stats",
      targetAgentId: agentId
    }, 2000);
  }

  /**
   * Get global bus statistics
   *
   * @returns {Promise<object>} Stats: { totalMessages: N, connectedAgents: N, uptime: ms }
   */
  async getBusStats() {
    return await this.request("bus", {
      type: "get_bus_stats"
    }, 2000);
  }

  /**
   * Force disconnect an agent from the bus
   *
   * @param {string} agentId - Agent to disconnect
   * @param {string} [reason] - Optional reason for disconnection
   * @returns {Promise<void>}
   */
  async disconnectAgent(agentId, reason = "Disconnected by orchestrator") {
    await this.send("bus", {
      type: "disconnect_agent",
      targetAgentId: agentId,
      reason: reason,
      disconnectedBy: this.agentId,
      timestamp: Date.now()
    });
  }

  /**
   * Handle control messages from the bus (internal)
   *
   * @private
   * @param {object} message - Control message
   */
  _handleControlMessage(message) {
    switch (message.type) {
      case "monitor_message":
        if (this.monitorHandler && message.originalMessage) {
          this.monitorHandler(message.originalMessage);
        }
        break;

      case "bus_state":
        // Handled by request-response mechanism
        break;

      case "agent_connected":
        this.emit("agent_connected", {
          agentId: message.agentId,
          timestamp: message.timestamp
        });
        break;

      case "agent_disconnected":
        this.emit("agent_disconnected", {
          agentId: message.agentId,
          reason: message.reason,
          timestamp: message.timestamp
        });
        break;

      case "agent_paused":
        this.emit("agent_paused", {
          agentId: message.agentId,
          timestamp: message.timestamp
        });
        break;

      case "agent_resumed":
        this.emit("agent_resumed", {
          agentId: message.agentId,
          queuedMessages: message.queuedMessages,
          timestamp: message.timestamp
        });
        break;

      case "rate_limit_hit":
        this.emit("rate_limit_hit", {
          agentId: message.agentId,
          dropped: message.dropped,
          timestamp: message.timestamp
        });
        break;

      default:
        // Unknown control message type
        this.emit("unknown_control_message", message);
    }
  }

  /**
   * Override message handler to apply filters
   *
   * @private
   * @param {object} message - Incoming message
   */
  _handleMessage(message) {
    // Always process RESPONSE messages — they resolve pending requests, not filterable
    if (message.type === "RESPONSE") {
      super._handleMessage(message);
      return;
    }

    // Apply filters to non-response messages
    for (const { predicate } of this.filterPredicates) {
      try {
        if (predicate(message)) {
          this.emit("message_filtered", message);
          return;
        }
      } catch (err) {
        this.emit("error", new Error(`Filter error: ${err.message}`));
      }
    }

    super._handleMessage(message);
  }
}

/**
 * Create and connect a new orchestrator control channel
 *
 * @param {object} [options] - Channel options
 * @returns {Promise<OrchestratorControl>} Connected control channel
 */
export async function createOrchestratorControl(options = {}) {
  const control = new OrchestratorControl(options);
  await control.connect();
  return control;
}

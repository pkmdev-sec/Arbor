/**
 * Agent Registry
 *
 * Maintains a registry of all active agents with their capabilities,
 * health status, and message statistics. Integrates with MessageBus
 * to automatically update registry on connect/disconnect events.
 *
 * Key features:
 * - Agent capability tracking
 * - Health status monitoring (HEALTHY/DEGRADED/OFFLINE)
 * - Message statistics (sent/received counts)
 * - Discovery methods (by role, capability, status)
 * - Automatic last-seen timestamp updates
 *
 * @module ipc/registry
 */

import { HealthStatus } from "./protocol.mjs";

/**
 * Agent registry for tracking connected agents
 */
export class AgentRegistry {
  /**
   * Create a new agent registry
   *
   * @param {Object} [options] - Configuration options
   * @param {import("./message-bus.mjs").MessageBus} [options.messageBus] - Message bus instance for integration
   */
  constructor(options = {}) {
    /** @type {Map<string, AgentRegistryEntry>} Agent ID → metadata */
    this.agents = new Map();

    /** @type {Map<string, Set<string>>} Secondary index: role → Set of agent IDs */
    this.roleIndex = new Map();

    /** @type {Map<string, Set<string>>} Secondary index: capability → Set of agent IDs */
    this.capabilityIndex = new Map();

    // Optional integration with message bus
    if (options.messageBus) {
      this._integrateWithMessageBus(options.messageBus);
    }
  }

  /**
   * Register a new agent
   *
   * @param {string} agentId - Unique agent identifier
   * @param {Object} metadata - Agent metadata
   * @param {string[]} [metadata.capabilities] - List of capabilities (e.g., ["code-review", "testing"])
   * @param {string} [metadata.role] - Agent role (e.g., "worker", "verifier")
   * @param {string} [metadata.model] - Model identifier (e.g., "sonnet[1m]")
   * @param {string} [metadata.worktreePath] - Absolute path to agent's worktree
   * @param {number} [metadata.pid] - Process ID
   * @returns {boolean} True if registered successfully
   */
  register(agentId, metadata = {}) {
    if (!agentId || typeof agentId !== "string") {
      return false;
    }

    const entry = {
      agentId,
      capabilities: Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
      role: metadata.role || "worker",
      model: metadata.model || "sonnet[1m]",
      worktreePath: metadata.worktreePath || null,
      pid: metadata.pid || null,
      healthStatus: HealthStatus.HEALTHY,
      lastSeen: Date.now(),
      registeredAt: Date.now(),
      messageStats: {
        sent: 0,
        received: 0,
      },
    };

    this.agents.set(agentId, entry);

    // Update secondary indexes
    // Add to role index
    if (!this.roleIndex.has(entry.role)) {
      this.roleIndex.set(entry.role, new Set());
    }
    this.roleIndex.get(entry.role).add(agentId);

    // Add to capability index
    for (const cap of entry.capabilities) {
      if (!this.capabilityIndex.has(cap)) {
        this.capabilityIndex.set(cap, new Set());
      }
      this.capabilityIndex.get(cap).add(agentId);
    }

    return true;
  }

  /**
   * Deregister an agent
   *
   * @param {string} agentId - Agent identifier
   * @returns {boolean} True if deregistered successfully
   */
  deregister(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    // Remove from secondary indexes
    // Remove from role index
    const roleSet = this.roleIndex.get(agent.role);
    if (roleSet) {
      roleSet.delete(agentId);
      if (roleSet.size === 0) {
        this.roleIndex.delete(agent.role);
      }
    }

    // Remove from capability index
    for (const cap of agent.capabilities) {
      const capSet = this.capabilityIndex.get(cap);
      if (capSet) {
        capSet.delete(agentId);
        if (capSet.size === 0) {
          this.capabilityIndex.delete(cap);
        }
      }
    }

    return this.agents.delete(agentId);
  }

  /**
   * Update agent health status
   *
   * @param {string} agentId - Agent identifier
   * @param {HealthStatus} healthStatus - New health status
   * @returns {boolean} True if updated successfully
   */
  updateHealth(agentId, healthStatus) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    agent.healthStatus = healthStatus;
    agent.lastSeen = Date.now();
    return true;
  }

  /**
   * Update last-seen timestamp
   *
   * @param {string} agentId - Agent identifier
   * @returns {boolean} True if updated successfully
   */
  updateLastSeen(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    agent.lastSeen = Date.now();
    return true;
  }

  /**
   * Increment message sent counter
   *
   * @param {string} agentId - Agent identifier
   * @param {number} [count] - Number of messages (default: 1)
   * @returns {boolean} True if updated successfully
   */
  incrementSent(agentId, count = 1) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    agent.messageStats.sent += count;
    agent.lastSeen = Date.now();
    return true;
  }

  /**
   * Increment message received counter
   *
   * @param {string} agentId - Agent identifier
   * @param {number} [count] - Number of messages (default: 1)
   * @returns {boolean} True if updated successfully
   */
  incrementReceived(agentId, count = 1) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    agent.messageStats.received += count;
    agent.lastSeen = Date.now();
    return true;
  }

  /**
   * Get agent entry
   *
   * @param {string} agentId - Agent identifier
   * @returns {AgentRegistryEntry|null} Agent entry or null if not found
   */
  get(agentId) {
    return this.agents.get(agentId) || null;
  }

  /**
   * List all agents
   *
   * @returns {AgentRegistryEntry[]} Array of all agent entries
   */
  listAll() {
    return Array.from(this.agents.values());
  }

  /**
   * Find agents by role (O(1) lookup using secondary index)
   *
   * @param {string} role - Agent role (e.g., "worker", "verifier")
   * @returns {AgentRegistryEntry[]} Array of matching agents
   */
  findByRole(role) {
    const agentIds = this.roleIndex.get(role);
    if (!agentIds) {
      return [];
    }
    return Array.from(agentIds).map(id => this.agents.get(id)).filter(Boolean);
  }

  /**
   * Find agents by capability (O(1) lookup using secondary index)
   *
   * @param {string} capability - Capability name (e.g., "code-review", "testing")
   * @returns {AgentRegistryEntry[]} Array of agents with the specified capability
   */
  findByCapability(capability) {
    const agentIds = this.capabilityIndex.get(capability);
    if (!agentIds) {
      return [];
    }
    return Array.from(agentIds).map(id => this.agents.get(id)).filter(Boolean);
  }

  /**
   * Find agents by health status
   *
   * @param {HealthStatus} healthStatus - Health status
   * @returns {AgentRegistryEntry[]} Array of agents with the specified health status
   */
  findByHealth(healthStatus) {
    return this.listAll().filter(agent => agent.healthStatus === healthStatus);
  }

  /**
   * Get agents that haven't sent heartbeat recently (stale detection)
   *
   * @param {number} [thresholdMs] - Threshold in milliseconds (default: 60000 = 1 minute)
   * @returns {AgentRegistryEntry[]} Array of stale agents
   */
  getStaleAgents(thresholdMs = 60000) {
    const now = Date.now();
    return this.listAll().filter(agent => now - agent.lastSeen > thresholdMs);
  }

  /**
   * Clear all agents
   */
  clear() {
    this.agents.clear();
    this.roleIndex.clear();
    this.capabilityIndex.clear();
  }

  /**
   * Get registry statistics
   *
   * @returns {Object} Statistics summary
   */
  getStats() {
    const all = this.listAll();

    const byHealth = {
      [HealthStatus.HEALTHY]: 0,
      [HealthStatus.DEGRADED]: 0,
      [HealthStatus.OFFLINE]: 0,
    };

    const byRole = {};
    const byModel = {};
    let totalSent = 0;
    let totalReceived = 0;

    for (const agent of all) {
      byHealth[agent.healthStatus]++;

      byRole[agent.role] = (byRole[agent.role] || 0) + 1;
      byModel[agent.model] = (byModel[agent.model] || 0) + 1;

      totalSent += agent.messageStats.sent;
      totalReceived += agent.messageStats.received;
    }

    return {
      totalAgents: all.length,
      byHealth,
      byRole,
      byModel,
      messageStats: {
        totalSent,
        totalReceived,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Integrate with message bus for automatic registry updates
   * @private
   */
  _integrateWithMessageBus(messageBus) {
    // Update registry on agent connect
    messageBus.registerHook("onAgentConnected", (agentId, socket) => {
      // If not already registered, create a basic entry
      if (!this.agents.has(agentId)) {
        this.register(agentId, {});
      }
      this.updateLastSeen(agentId);
    });

    // Update registry on agent disconnect
    messageBus.registerHook("onAgentDisconnected", (agentId, reason) => {
      this.updateHealth(agentId, HealthStatus.OFFLINE);
    });

    // Update message statistics on routing
    messageBus.registerHook("onMessageRouted", (msg, targetSocket) => {
      // Increment sent for sender
      if (msg.from) {
        this.incrementSent(msg.from);
      }

      // Increment received for recipient(s)
      if (msg.to) {
        this.incrementReceived(msg.to);
      } else if (msg.topic) {
        // For PUBLISH messages, increment for all subscribers
        const subscribers = messageBus.getSubscribers(msg.topic);
        for (const subscriberId of subscribers) {
          this.incrementReceived(subscriberId);
        }
      }
    });
  }
}

/**
 * Agent registry entry
 * @typedef {Object} AgentRegistryEntry
 * @property {string} agentId - Unique agent identifier
 * @property {string[]} capabilities - List of capabilities
 * @property {string} role - Agent role
 * @property {string} model - Model identifier
 * @property {string|null} worktreePath - Absolute path to agent's worktree
 * @property {number|null} pid - Process ID
 * @property {HealthStatus} healthStatus - Health status
 * @property {number} lastSeen - Last-seen timestamp (milliseconds since epoch)
 * @property {number} registeredAt - Registration timestamp (milliseconds since epoch)
 * @property {Object} messageStats - Message statistics
 * @property {number} messageStats.sent - Number of messages sent
 * @property {number} messageStats.received - Number of messages received
 */

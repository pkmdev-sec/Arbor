/**
 * Discovery Bus: Real-time finding propagation via IPC Pub/Sub
 *
 * REQ-029: Shared Findings via IPC Pub/Sub
 *
 * Wraps AgentChannel + DiscoveryChannel to share findings between agents in
 * real-time via the message bus pub/sub system. Supports local recording with
 * pub, remote subscription with deduplication, and context injection.
 *
 * Usage:
 *   const channel = await createAgentChannel('agent-01');
 *   const bus = new DiscoveryBus(channel, { maxDiscoveries: 5, minSeverity: 'high' });
 *   await bus.start();
 *
 *   // Record local discovery - automatically publishes to other agents
 *   bus.record('agent-01', { type: 'bug', severity: 'critical', summary: '...', files: [...] });
 *
 *   // Listen for all discoveries (local + remote)
 *   const unsubscribe = bus.onDiscovery((agentId, discovery) => {
 *     console.log(`Discovery from ${agentId}:`, discovery);
 *   });
 *
 *   // Get context injection for agent prompt
 *   const contextText = bus.getContextInjection();
 *
 *   await bus.stop();
 *
 * @module discovery-bus
 */

import { DiscoveryChannel } from '../discoveries.mjs';

/**
 * Discovery Bus - IPC-enabled shared findings channel
 */
export class DiscoveryBus {
  /**
   * @param {import('./agent-channel.mjs').AgentChannel} agentChannel - Connected AgentChannel instance
   * @param {object} options - Configuration
   * @param {number} options.maxDiscoveries - Maximum discoveries to retain (default: 5)
   * @param {string} options.minSeverity - Minimum severity threshold (default: 'high')
   */
  constructor(agentChannel, options = {}) {
    if (!agentChannel) {
      throw new Error('AgentChannel instance is required');
    }

    this.agentChannel = agentChannel;
    this.discoveryChannel = new DiscoveryChannel({
      maxDiscoveries: options.maxDiscoveries ?? 5,
      minSeverity: options.minSeverity ?? 'high',
    });

    this._subscribed = false;
    this._handlers = [];
    this._boundHandler = null;
  }

  /**
   * Start the discovery bus - subscribe to discovery topics on IPC bus
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._subscribed) {
      return;
    }

    // Subscribe to wildcard topic to catch all severity levels
    // (discoveries.critical, discoveries.high, discoveries.medium, discoveries.low)
    this._boundHandler = (msg) => this._handleIncoming(msg);
    this.agentChannel.subscribe('discoveries.*', this._boundHandler);

    this._subscribed = true;
  }

  /**
   * Record a discovery locally and publish to other agents
   *
   * @param {string} agentId - Agent that made the discovery
   * @param {object} discovery - { type, severity, summary, files, details }
   * @returns {boolean} Whether it was recorded (not duplicate, meets severity threshold)
   */
  record(agentId, discovery) {
    // Record locally first (handles dedup, severity filtering, sorting)
    const recorded = this.discoveryChannel.record(agentId, discovery);

    // If successfully recorded, publish to IPC bus so other agents receive it
    if (recorded && this._subscribed) {
      const topic = `discoveries.${discovery.severity}`;
      this.agentChannel.publish(topic, {
        agentId,
        discovery,
        timestamp: Date.now(),
      }).catch((err) => {
        // Non-blocking publish error (agent continues with local discovery)
        console.error(`[DiscoveryBus] Failed to publish discovery: ${err.message}`);
      });

      // Notify local handlers
      this._notifyHandlers(agentId, discovery);
    }

    return recorded;
  }

  /**
   * Handle incoming discovery from IPC bus
   *
   * @private
   * @param {object} msg - Message from AgentChannel (msg.payload or msg.data)
   */
  _handleIncoming(msg) {
    // Extract payload (AgentChannel uses msg.payload for PUBLISH messages)
    const data = msg.payload || msg.data || msg;
    const { agentId, discovery } = data;

    if (!agentId || !discovery) {
      return;
    }

    // Feed into local DiscoveryChannel for dedup and storage
    const recorded = this.discoveryChannel.record(agentId, discovery);

    // Only notify handlers if it was a new discovery (not duplicate)
    if (recorded) {
      this._notifyHandlers(agentId, discovery);
    }
  }

  /**
   * Notify all registered handlers of a new discovery
   *
   * @private
   * @param {string} agentId - Agent that made the discovery
   * @param {object} discovery - Discovery object
   */
  _notifyHandlers(agentId, discovery) {
    for (const handler of this._handlers) {
      try {
        handler(agentId, discovery);
      } catch (err) {
        console.error(`[DiscoveryBus] Handler error: ${err.message}`);
      }
    }
  }

  /**
   * Register a handler for new discoveries (both local and remote)
   *
   * @param {function(string, object): void} handler - Called with (agentId, discovery)
   * @returns {function(): void} Unsubscribe function
   */
  onDiscovery(handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    this._handlers.push(handler);

    // Return unsubscribe function
    return () => {
      const index = this._handlers.indexOf(handler);
      if (index !== -1) {
        this._handlers.splice(index, 1);
      }
    };
  }

  /**
   * Get formatted discoveries for agent context injection
   *
   * @returns {string} Formatted discoveries text
   */
  getContextInjection() {
    return this.discoveryChannel.getContextInjection();
  }

  /**
   * Get all discoveries
   *
   * @returns {Array} Raw discoveries array
   */
  getAll() {
    return this.discoveryChannel.getAll();
  }

  /**
   * Stop the discovery bus - unsubscribe from IPC topics
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._subscribed) {
      return;
    }

    // Unsubscribe from wildcard topic
    if (this._boundHandler) {
      this.agentChannel.unsubscribe('discoveries.*', this._boundHandler);
      this._boundHandler = null;
    }

    this._subscribed = false;
  }
}

/**
 * Create and start a DiscoveryBus
 *
 * @param {import('./agent-channel.mjs').AgentChannel} agentChannel - Connected AgentChannel instance
 * @param {object} options - Configuration options
 * @returns {Promise<DiscoveryBus>} Started DiscoveryBus instance
 */
export async function createDiscoveryBus(agentChannel, options = {}) {
  const bus = new DiscoveryBus(agentChannel, options);
  await bus.start();
  return bus;
}

export default DiscoveryBus;

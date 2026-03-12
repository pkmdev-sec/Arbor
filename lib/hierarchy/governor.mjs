/**
 * Resource Governor for Hierarchical Swarm Coordination
 *
 * Centralized resource management for multi-level agent swarms. Enforces
 * hard limits on agent counts, worktree usage, memory, and cost. Provides
 * budget allocation with partial grants and real-time utilization tracking.
 *
 * The governor operates as a control-plane singleton alongside the orchestrator,
 * publishing events to the IPC bus and integrating with the agent registry for
 * lifecycle tracking.
 *
 * ## Resource Model
 *
 * ```
 * ┌─────────────────────────────────────────────────────┐
 * │                  Resource Governor                   │
 * │                                                     │
 * │  maxTotalAgents ──── total spawnable (lifetime)     │
 * │  maxConcurrentAgents ── active at any moment        │
 * │  maxWorktrees ──── git worktrees on disk            │
 * │  maxMemoryMB ──── estimated process memory ceiling  │
 * │  costPerAgentTurn ── USD per agent turn             │
 * │                                                     │
 * │  ┌───────────┐   ┌──────────┐   ┌──────────────┐   │
 * │  │ Budget    │   │ Agent    │   │ Utilization  │   │
 * │  │ Tracker   │   │ Registry │   │ Reporter     │   │
 * │  └───────────┘   └──────────┘   └──────────────┘   │
 * └─────────────────────────────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * ```javascript
 * import { ResourceGovernor } from './hierarchy/governor.mjs';
 *
 * const governor = new ResourceGovernor({
 *   maxTotalAgents: 20,
 *   maxConcurrentAgents: 10,
 *   maxWorktrees: 15,
 *   maxMemoryMB: 4096,
 *   costPerAgentTurn: 0.03,
 * });
 *
 * await governor.connectBus(busAddress, 'orchestrator');
 *
 * const budget = governor.requestBudget('sub-coord-01', 3, 1);
 * if (budget.approved) {
 *   // spawn agents...
 * }
 *
 * await governor.cleanup();
 * ```
 *
 * @module hierarchy/governor
 */

import { existsSync, rmSync } from "node:fs";
import { ScopedBus, HierarchicalTopics } from "./scoped-bus.mjs";

// ── Type Definitions (JSDoc) ─────────────────────────────────────────

/**
 * @typedef {Object} GovernorConfig
 * @property {number} maxTotalAgents - Maximum total agents spawnable over lifetime
 * @property {number} maxConcurrentAgents - Maximum agents active simultaneously
 * @property {number} maxWorktrees - Maximum git worktrees on disk
 * @property {number} maxMemoryMB - Estimated memory ceiling in megabytes
 * @property {number} costPerAgentTurn - Estimated USD cost per agent turn
 */

/**
 * @typedef {Object} AgentInfo
 * @property {string} id - Agent identifier
 * @property {number} level - Hierarchy level (0=orchestrator, 1=sub-coord, 2+=worker)
 * @property {string} scope - Scope identifier (module/subsystem)
 * @property {number} spawnTime - Spawn timestamp (ms since epoch)
 * @property {string} status - Current status: "active" | "completed" | "failed"
 * @property {string|null} worktreePath - Git worktree path if agent owns one
 * @property {string|null} parentId - Parent coordinator ID
 * @property {number} turns - Turns consumed so far
 */

/**
 * @typedef {Object} BudgetResponse
 * @property {boolean} approved - Whether the request was approved (fully or partially)
 * @property {number} granted - Number of agent slots granted
 * @property {number} remaining - Remaining concurrent agent slots after grant
 * @property {boolean} [reduced] - True if grant was reduced from requested amount
 * @property {string} [reason] - Reason for denial
 * @property {string} [suggestion] - Suggested action on denial
 */

/**
 * @typedef {Object} UtilizationSnapshot
 * @property {number} activeAgents - Currently active agent count
 * @property {number} totalSpawned - Total agents spawned (lifetime)
 * @property {number} totalCompleted - Total agents that completed successfully
 * @property {number} totalFailed - Total agents that failed or crashed
 * @property {number} worktreesInUse - Current worktree count
 * @property {number} estimatedMemoryMB - Estimated memory usage in MB
 * @property {number} estimatedCost - Estimated total USD cost so far
 * @property {Map<number, LevelStats>} byLevel - Per-level statistics
 */

/**
 * @typedef {Object} LevelStats
 * @property {number} active - Active agents at this level
 * @property {number} completed - Completed agents at this level
 * @property {number} failed - Failed agents at this level
 */

/**
 * @typedef {Object} CostEstimate
 * @property {number} estimatedAgents - Total estimated agents in tree
 * @property {number} estimatedTurns - Total estimated turns across all agents
 * @property {number} estimatedCost - Estimated total USD cost
 * @property {CostBreakdown} breakdown - Cost breakdown by role
 */

/**
 * @typedef {Object} CostBreakdown
 * @property {number} workers - Estimated worker agent count
 * @property {number} subCoordinators - Estimated sub-coordinator count
 * @property {number} verification - Estimated verification cost in USD
 */

/**
 * @typedef {Object} BudgetReservation
 * @property {string} requesterId - ID of the requester
 * @property {number} reserved - Number of slots reserved
 * @property {number} timestamp - Reservation timestamp
 */

// ── Constants ────────────────────────────────────────────────────────

/** Default governor configuration */
const DEFAULT_CONFIG = {
  maxTotalAgents: 20,
  maxConcurrentAgents: 10,
  maxWorktrees: 15,
  maxMemoryMB: 4096,
  costPerAgentTurn: 0.03,
};

/** Estimated memory per agent in MB */
const ESTIMATED_MEMORY_PER_AGENT_MB = 256;

/** Governor event topic prefix */
const GOVERNOR_TOPIC_PREFIX = "governor";

// ── Custom Error ─────────────────────────────────────────────────────

/**
 * Error thrown when a governor resource limit is exceeded
 *
 * @extends Error
 */
export class GovernorLimitError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} limitType - Which limit was exceeded ("agents" | "concurrent" | "worktrees" | "memory" | "cost")
   * @param {number} current - Current usage value
   * @param {number} maximum - Maximum allowed value
   */
  constructor(message, limitType, current, maximum) {
    super(message);
    this.name = "GovernorLimitError";
    /** @type {string} Which limit was exceeded */
    this.limitType = limitType;
    /** @type {number} Current usage when limit was hit */
    this.current = current;
    /** @type {number} Maximum allowed */
    this.maximum = maximum;
  }
}

// ── ResourceGovernor Class ───────────────────────────────────────────

/**
 * Centralized resource governor for hierarchical agent swarms
 *
 * Tracks agent lifecycles, enforces resource limits, manages budget
 * allocation, and publishes utilization events to the IPC bus.
 *
 * @example
 * const governor = new ResourceGovernor({ maxTotalAgents: 20 });
 * await governor.connectBus('/tmp/ipc.sock', 'orchestrator');
 *
 * // Request budget before spawning
 * const budget = governor.requestBudget('sub-coord-01', 3, 1);
 * if (budget.approved) {
 *   for (let i = 0; i < budget.granted; i++) {
 *     governor.registerAgent({ id: `worker-${i}`, level: 2, scope: 'auth', ... });
 *   }
 * }
 *
 * // Query utilization
 * const util = governor.getUtilization();
 *
 * // Cleanup on exit
 * await governor.cleanup();
 */
export class ResourceGovernor {
  /**
   * Create a resource governor
   *
   * @param {GovernorConfig} [config] - Configuration overrides
   */
  constructor(config = {}) {
    /** @type {GovernorConfig} Merged configuration */
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {Map<string, AgentInfo>} Active agents indexed by ID */
    this.activeAgents = new Map();

    /** @type {Set<string>} Worktree paths currently in use */
    this.worktrees = new Set();

    /** @type {Map<string, BudgetReservation>} Budget reservations by requester ID */
    this.reservations = new Map();

    /** @type {number} Total agents spawned over lifetime */
    this.totalSpawned = 0;

    /** @type {number} Total agents that completed successfully */
    this.totalCompleted = 0;

    /** @type {number} Total agents that failed or crashed */
    this.totalFailed = 0;

    /** @type {number} Estimated total USD cost accumulated */
    this.totalCost = 0;

    /** @type {ScopedBus|null} IPC bus connection for event publishing */
    this.bus = null;

    /** @type {boolean} Whether the governor is active */
    this.active = false;

    /** @type {number} Creation timestamp */
    this.createdAt = Date.now();

    this._log("info", "Resource governor created", {
      config: this.config,
    });
  }

  // ── Bus Integration ──────────────────────────────────────────────

  /**
   * Connect to the IPC message bus for event publishing and lifecycle tracking
   *
   * Establishes a ScopedBus connection at level 0 (orchestrator level) and
   * subscribes to agent lifecycle events from child coordinators.
   *
   * @param {string} socketPath - Unix socket path for the IPC bus
   * @param {string} [scope="orchestrator"] - Scope identifier for bus topics
   * @returns {Promise<void>}
   * @throws {Error} If connection fails
   */
  async connectBus(socketPath, scope = "orchestrator") {
    if (!socketPath || typeof socketPath !== "string") {
      throw new TypeError("socketPath must be a non-empty string");
    }

    try {
      this.bus = new ScopedBus(`governor-${scope}`, {
        level: 0,
        scope,
        socketPath,
        autoReconnect: true,
        enableLogging: true,
      });

      await this.bus.connect();
      this.active = true;

      // Subscribe to child status events for automatic tracking
      this.bus.subscribeDown(HierarchicalTopics.STATUS, (msg) => {
        this._handleChildStatus(msg);
      });

      this._log("info", "Governor connected to IPC bus", { socketPath, scope });
    } catch (err) {
      this._log("error", "Failed to connect governor to IPC bus", {
        error: err.message,
        stack: err.stack,
      });
      throw new Error(`Governor bus connection failed: ${err.message}`);
    }
  }

  // ── Budget Management ────────────────────────────────────────────

  /**
   * Request agent budget allocation from the governor
   *
   * Called by sub-coordinators before spawning child agents. The governor
   * checks all resource limits and either approves fully, partially, or
   * denies the request.
   *
   * Partial approval: if 5 agents are requested but only 3 slots remain,
   * the governor grants 3 with `reduced: true`.
   *
   * @param {string} requesterId - ID of the requesting sub-coordinator
   * @param {number} agentCount - Number of agent slots requested
   * @param {number} level - Hierarchy level of the requesting coordinator
   * @returns {BudgetResponse} Budget allocation response
   */
  requestBudget(requesterId, agentCount, level) {
    if (!requesterId || typeof requesterId !== "string") {
      throw new TypeError("requesterId must be a non-empty string");
    }
    if (typeof agentCount !== "number" || agentCount < 1) {
      throw new TypeError("agentCount must be a positive number");
    }
    if (typeof level !== "number" || level < 0) {
      throw new TypeError("level must be a non-negative number");
    }

    this._log("info", "Budget request received", { requesterId, agentCount, level });

    const currentActive = this.activeAgents.size;
    const currentReserved = this._getTotalReserved();
    const effectiveConcurrent = currentActive + currentReserved;

    // Check 1: Would total spawned exceed maxTotalAgents?
    const lifetimeRemaining = this.config.maxTotalAgents - this.totalSpawned;
    if (lifetimeRemaining <= 0) {
      this._log("warn", "Budget denied: total agent limit reached", {
        requesterId,
        totalSpawned: this.totalSpawned,
        maxTotal: this.config.maxTotalAgents,
      });
      this._publishEvent("budget.denied", { requesterId, reason: "total_agent_limit" });
      return {
        approved: false,
        granted: 0,
        remaining: 0,
        reason: `Total agent limit reached (${this.totalSpawned}/${this.config.maxTotalAgents} spawned)`,
        suggestion: "reduce fan-out or increase depth",
      };
    }

    // Check 2: Would concurrent exceed maxConcurrentAgents?
    const concurrentRemaining = this.config.maxConcurrentAgents - effectiveConcurrent;
    if (concurrentRemaining <= 0) {
      this._log("warn", "Budget denied: concurrent agent limit reached", {
        requesterId,
        currentActive,
        currentReserved,
        maxConcurrent: this.config.maxConcurrentAgents,
      });
      this._publishEvent("budget.denied", { requesterId, reason: "concurrent_limit" });
      return {
        approved: false,
        granted: 0,
        remaining: 0,
        reason: `Concurrent agent limit reached (${effectiveConcurrent}/${this.config.maxConcurrentAgents} active+reserved)`,
        suggestion: "wait for running agents to complete before spawning more",
      };
    }

    // Check 3: Would worktrees exceed maxWorktrees?
    const worktreeRemaining = this.config.maxWorktrees - this.worktrees.size;
    if (worktreeRemaining <= 0) {
      this._log("warn", "Budget denied: worktree limit reached", {
        requesterId,
        worktreesInUse: this.worktrees.size,
        maxWorktrees: this.config.maxWorktrees,
      });
      this._publishEvent("budget.denied", { requesterId, reason: "worktree_limit" });
      return {
        approved: false,
        granted: 0,
        remaining: 0,
        reason: `Worktree limit reached (${this.worktrees.size}/${this.config.maxWorktrees} in use)`,
        suggestion: "reduce fan-out or increase depth",
      };
    }

    // Determine how many we can grant (minimum of all constraints)
    const grantable = Math.min(
      agentCount,
      lifetimeRemaining,
      concurrentRemaining,
      worktreeRemaining
    );

    const isPartial = grantable < agentCount;

    // Reserve the slots
    const existingReservation = this.reservations.get(requesterId);
    const previousReserved = existingReservation ? existingReservation.reserved : 0;
    this.reservations.set(requesterId, {
      requesterId,
      reserved: previousReserved + grantable,
      timestamp: Date.now(),
    });

    const remainingConcurrent = this.config.maxConcurrentAgents - effectiveConcurrent - grantable;

    this._log("info", "Budget approved", {
      requesterId,
      requested: agentCount,
      granted: grantable,
      partial: isPartial,
      remainingConcurrent,
    });

    this._publishEvent("budget.approved", {
      requesterId,
      granted: grantable,
      remaining: remainingConcurrent,
      reduced: isPartial,
    });

    const response = {
      approved: true,
      granted: grantable,
      remaining: remainingConcurrent,
    };

    if (isPartial) {
      response.reduced = true;
    }

    return response;
  }

  /**
   * Release previously allocated budget slots
   *
   * Called when a sub-coordinator's children complete execution. Frees
   * the reserved slots so they can be re-allocated.
   *
   * @param {string} requesterId - ID of the requester releasing budget
   * @param {number} agentCount - Number of agent slots to release
   */
  releaseBudget(requesterId, agentCount) {
    if (!requesterId || typeof requesterId !== "string") {
      throw new TypeError("requesterId must be a non-empty string");
    }
    if (typeof agentCount !== "number" || agentCount < 1) {
      throw new TypeError("agentCount must be a positive number");
    }

    const reservation = this.reservations.get(requesterId);
    if (!reservation) {
      this._log("warn", "Release budget: no reservation found", { requesterId });
      return;
    }

    const newReserved = Math.max(0, reservation.reserved - agentCount);
    if (newReserved === 0) {
      this.reservations.delete(requesterId);
    } else {
      reservation.reserved = newReserved;
    }

    this._log("info", "Budget released", {
      requesterId,
      released: agentCount,
      remainingReservation: newReserved,
    });

    this._publishEvent("budget.released", {
      requesterId,
      released: agentCount,
      remainingReservation: newReserved,
    });
  }

  // ── Agent Lifecycle ──────────────────────────────────────────────

  /**
   * Register an agent as active in the governor
   *
   * Called when an agent is spawned. Tracks the agent's metadata for
   * utilization reporting and resource accounting.
   *
   * @param {Object} agentInfo - Agent information
   * @param {string} agentInfo.id - Unique agent identifier
   * @param {number} agentInfo.level - Hierarchy level
   * @param {string} agentInfo.scope - Scope identifier
   * @param {string|null} [agentInfo.worktreePath] - Worktree path if allocated
   * @param {string|null} [agentInfo.parentId] - Parent coordinator ID
   * @throws {GovernorLimitError} If registering would exceed hard limits
   */
  registerAgent(agentInfo) {
    if (!agentInfo || !agentInfo.id || typeof agentInfo.id !== "string") {
      throw new TypeError("agentInfo.id must be a non-empty string");
    }
    if (typeof agentInfo.level !== "number" || agentInfo.level < 0) {
      throw new TypeError("agentInfo.level must be a non-negative number");
    }
    if (!agentInfo.scope || typeof agentInfo.scope !== "string") {
      throw new TypeError("agentInfo.scope must be a non-empty string");
    }

    // Build tracked agent record
    const tracked = {
      id: agentInfo.id,
      level: agentInfo.level,
      scope: agentInfo.scope,
      spawnTime: Date.now(),
      status: "active",
      worktreePath: agentInfo.worktreePath || null,
      parentId: agentInfo.parentId || null,
      turns: 0,
    };

    this.activeAgents.set(tracked.id, tracked);
    this.totalSpawned++;

    // Track worktree if present
    if (tracked.worktreePath) {
      this.worktrees.add(tracked.worktreePath);
    }

    // Consume from parent's reservation
    if (tracked.parentId && this.reservations.has(tracked.parentId)) {
      const reservation = this.reservations.get(tracked.parentId);
      reservation.reserved = Math.max(0, reservation.reserved - 1);
      if (reservation.reserved === 0) {
        this.reservations.delete(tracked.parentId);
      }
    }

    this._log("info", "Agent registered", {
      agentId: tracked.id,
      level: tracked.level,
      scope: tracked.scope,
      worktree: !!tracked.worktreePath,
      totalActive: this.activeAgents.size,
      totalSpawned: this.totalSpawned,
    });

    this._publishEvent("agent.registered", {
      agentId: tracked.id,
      level: tracked.level,
      scope: tracked.scope,
      totalActive: this.activeAgents.size,
    });
  }

  /**
   * Deregister an agent and update statistics
   *
   * Called when an agent completes or fails. Marks the agent as no longer
   * active, updates lifetime counters, cleans up the worktree if owned,
   * and accumulates cost based on turns consumed.
   *
   * @param {string} agentId - Agent identifier to deregister
   * @param {Object} [result] - Optional result metadata
   * @param {string} [result.status="completed"] - Final status ("completed" | "failed")
   * @param {number} [result.turns=0] - Turns consumed during execution
   */
  deregisterAgent(agentId, result = {}) {
    if (!agentId || typeof agentId !== "string") {
      throw new TypeError("agentId must be a non-empty string");
    }

    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      this._log("warn", "Deregister: agent not found", { agentId });
      return;
    }

    const finalStatus = result.status || "completed";
    const turns = result.turns || 0;

    // Update counters
    if (finalStatus === "completed") {
      this.totalCompleted++;
    } else {
      this.totalFailed++;
    }

    // Accumulate cost
    const agentCost = turns * this.config.costPerAgentTurn;
    this.totalCost += agentCost;

    // Clean up worktree
    if (agent.worktreePath) {
      this._cleanupWorktree(agent.worktreePath);
      this.worktrees.delete(agent.worktreePath);
    }

    // Update agent record before removal
    agent.status = finalStatus;
    agent.turns = turns;

    this.activeAgents.delete(agentId);

    this._log("info", "Agent deregistered", {
      agentId,
      status: finalStatus,
      turns,
      cost: agentCost.toFixed(4),
      totalActive: this.activeAgents.size,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
    });

    this._publishEvent("agent.deregistered", {
      agentId,
      status: finalStatus,
      turns,
      cost: agentCost,
      totalActive: this.activeAgents.size,
    });
  }

  // ── Utilization & Cost ───────────────────────────────────────────

  /**
   * Get a snapshot of current resource utilization
   *
   * Returns a point-in-time view of all governor-tracked metrics including
   * per-level breakdowns for hierarchical analysis.
   *
   * @returns {UtilizationSnapshot} Current utilization metrics
   */
  getUtilization() {
    const byLevel = new Map();

    // Initialize level stats from active agents
    for (const agent of this.activeAgents.values()) {
      if (!byLevel.has(agent.level)) {
        byLevel.set(agent.level, { active: 0, completed: 0, failed: 0 });
      }
      byLevel.get(agent.level).active++;
    }

    // Estimate memory: each active agent uses ~256MB
    const estimatedMemoryMB = this.activeAgents.size * ESTIMATED_MEMORY_PER_AGENT_MB;

    const snapshot = {
      activeAgents: this.activeAgents.size,
      totalSpawned: this.totalSpawned,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      worktreesInUse: this.worktrees.size,
      estimatedMemoryMB,
      estimatedCost: parseFloat(this.totalCost.toFixed(4)),
      byLevel,
    };

    this._log("debug", "Utilization snapshot", {
      active: snapshot.activeAgents,
      spawned: snapshot.totalSpawned,
      worktrees: snapshot.worktreesInUse,
      memoryMB: snapshot.estimatedMemoryMB,
      cost: snapshot.estimatedCost,
    });

    return snapshot;
  }

  /**
   * Estimate the cost of executing a decomposition tree
   *
   * Walks the decomposition tree counting leaf nodes (workers) and internal
   * nodes (sub-coordinators), then estimates total turns and USD cost.
   *
   * @param {Object} decompositionTree - Tree from decomposeHierarchically()
   * @param {Object} decompositionTree.root - Root node of the decomposition
   * @returns {CostEstimate} Estimated cost breakdown
   */
  estimateCost(decompositionTree) {
    if (!decompositionTree || !decompositionTree.root) {
      throw new TypeError("decompositionTree must have a root node");
    }

    let workers = 0;
    let subCoordinators = 0;
    let totalTurns = 0;

    /**
     * Recursively walk the decomposition tree
     * @param {Object} node - Current node
     */
    function walkTree(node) {
      if (!node) return;

      const nodeTurns = node.turns || 10;

      if (node.type === "worker" || !node.children || node.children.length === 0) {
        workers++;
        totalTurns += nodeTurns;
      } else {
        subCoordinators++;
        // Sub-coordinators use fewer turns (orchestration overhead)
        totalTurns += Math.min(nodeTurns, 5);

        for (const child of node.children) {
          walkTree(child);
        }
      }
    }

    walkTree(decompositionTree.root);

    const estimatedAgents = workers + subCoordinators;
    const agentCost = totalTurns * this.config.costPerAgentTurn;
    // Verification costs: one verifier run at ~10 turns per sub-coordinator group
    const verificationTurns = Math.max(1, subCoordinators) * 10;
    const verificationCost = verificationTurns * this.config.costPerAgentTurn;
    const estimatedCost = parseFloat((agentCost + verificationCost).toFixed(4));

    const estimate = {
      estimatedAgents,
      estimatedTurns: totalTurns + verificationTurns,
      estimatedCost,
      breakdown: {
        workers,
        subCoordinators,
        verification: parseFloat(verificationCost.toFixed(4)),
      },
    };

    this._log("info", "Cost estimate computed", {
      agents: estimatedAgents,
      turns: estimate.estimatedTurns,
      cost: estimatedCost,
      workers,
      subCoordinators,
    });

    return estimate;
  }

  // ── Limit Enforcement ────────────────────────────────────────────

  /**
   * Enforce resource limits before a spawn operation
   *
   * Checks all governor limits and throws GovernorLimitError if any hard
   * limit would be exceeded. Logs warnings for soft limit proximity.
   *
   * Should be called before every agent spawn as a final safety gate.
   *
   * @param {string} action - Description of the intended action (for error messages)
   * @throws {GovernorLimitError} If any hard limit is exceeded
   */
  enforceLimit(action) {
    if (!action || typeof action !== "string") {
      throw new TypeError("action must be a non-empty string");
    }

    const currentActive = this.activeAgents.size;
    const currentReserved = this._getTotalReserved();
    const effectiveConcurrent = currentActive + currentReserved;

    // Hard limit: total agents lifetime
    if (this.totalSpawned >= this.config.maxTotalAgents) {
      throw new GovernorLimitError(
        `Cannot ${action}: total agent limit reached (${this.totalSpawned}/${this.config.maxTotalAgents})`,
        "agents",
        this.totalSpawned,
        this.config.maxTotalAgents
      );
    }

    // Hard limit: concurrent agents
    if (effectiveConcurrent >= this.config.maxConcurrentAgents) {
      throw new GovernorLimitError(
        `Cannot ${action}: concurrent agent limit reached (${effectiveConcurrent}/${this.config.maxConcurrentAgents})`,
        "concurrent",
        effectiveConcurrent,
        this.config.maxConcurrentAgents
      );
    }

    // Hard limit: worktrees
    if (this.worktrees.size >= this.config.maxWorktrees) {
      throw new GovernorLimitError(
        `Cannot ${action}: worktree limit reached (${this.worktrees.size}/${this.config.maxWorktrees})`,
        "worktrees",
        this.worktrees.size,
        this.config.maxWorktrees
      );
    }

    // Hard limit: estimated memory
    const estimatedMemory = (currentActive + 1) * ESTIMATED_MEMORY_PER_AGENT_MB;
    if (estimatedMemory > this.config.maxMemoryMB) {
      throw new GovernorLimitError(
        `Cannot ${action}: estimated memory would exceed limit (${estimatedMemory}MB/${this.config.maxMemoryMB}MB)`,
        "memory",
        estimatedMemory,
        this.config.maxMemoryMB
      );
    }

    // Soft limit warnings (80% thresholds)
    const agentUtilization = this.totalSpawned / this.config.maxTotalAgents;
    if (agentUtilization >= 0.8) {
      this._log("warn", "Soft limit: approaching total agent limit", {
        action,
        utilization: `${(agentUtilization * 100).toFixed(0)}%`,
        spawned: this.totalSpawned,
        max: this.config.maxTotalAgents,
      });
      this._publishEvent("limit.warning", {
        type: "agents",
        utilization: agentUtilization,
        current: this.totalSpawned,
        max: this.config.maxTotalAgents,
      });
    }

    const concurrentUtilization = effectiveConcurrent / this.config.maxConcurrentAgents;
    if (concurrentUtilization >= 0.8) {
      this._log("warn", "Soft limit: approaching concurrent agent limit", {
        action,
        utilization: `${(concurrentUtilization * 100).toFixed(0)}%`,
        concurrent: effectiveConcurrent,
        max: this.config.maxConcurrentAgents,
      });
      this._publishEvent("limit.warning", {
        type: "concurrent",
        utilization: concurrentUtilization,
        current: effectiveConcurrent,
        max: this.config.maxConcurrentAgents,
      });
    }

    const worktreeUtilization = this.worktrees.size / this.config.maxWorktrees;
    if (worktreeUtilization >= 0.8) {
      this._log("warn", "Soft limit: approaching worktree limit", {
        action,
        utilization: `${(worktreeUtilization * 100).toFixed(0)}%`,
        inUse: this.worktrees.size,
        max: this.config.maxWorktrees,
      });
      this._publishEvent("limit.warning", {
        type: "worktrees",
        utilization: worktreeUtilization,
        current: this.worktrees.size,
        max: this.config.maxWorktrees,
      });
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  /**
   * Perform full governor cleanup
   *
   * Cleans up all tracked worktrees, deregisters all agents, closes
   * the IPC bus connection, and produces a final cost report.
   *
   * @returns {Promise<Object>} Final report with cost and agent statistics
   */
  async cleanup() {
    this._log("info", "Governor cleanup starting", {
      activeAgents: this.activeAgents.size,
      worktrees: this.worktrees.size,
    });

    // Deregister all remaining active agents
    const agentIds = Array.from(this.activeAgents.keys());
    for (const agentId of agentIds) {
      try {
        this.deregisterAgent(agentId, { status: "failed", turns: 0 });
      } catch (err) {
        this._log("warn", "Failed to deregister agent during cleanup", {
          agentId,
          error: err.message,
        });
      }
    }

    // Clean up any remaining tracked worktrees
    const worktreePaths = Array.from(this.worktrees);
    for (const wtPath of worktreePaths) {
      this._cleanupWorktree(wtPath);
    }
    this.worktrees.clear();

    // Clear all reservations
    this.reservations.clear();

    // Build final report
    const finalReport = {
      totalSpawned: this.totalSpawned,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalCost: parseFloat(this.totalCost.toFixed(4)),
      durationMs: Date.now() - this.createdAt,
    };

    this._log("info", "Governor final report", finalReport);

    // Publish final report before closing bus
    this._publishEvent("final.report", finalReport);

    // Close IPC connection
    if (this.bus) {
      try {
        await this.bus.close();
      } catch (err) {
        this._log("warn", "Failed to close governor bus", { error: err.message });
      }
      this.bus = null;
    }

    this.active = false;

    this._log("info", "Governor cleanup complete");

    return finalReport;
  }

  // ── Query Methods ────────────────────────────────────────────────

  /**
   * Get a list of all currently active agents
   *
   * @returns {AgentInfo[]} Array of active agent info objects
   */
  getActiveAgents() {
    return Array.from(this.activeAgents.values());
  }

  /**
   * Get agent info by ID
   *
   * @param {string} agentId - Agent identifier
   * @returns {AgentInfo|null} Agent info or null if not found
   */
  getAgent(agentId) {
    return this.activeAgents.get(agentId) || null;
  }

  /**
   * Get agents filtered by hierarchy level
   *
   * @param {number} level - Hierarchy level to filter by
   * @returns {AgentInfo[]} Agents at the specified level
   */
  getAgentsByLevel(level) {
    return Array.from(this.activeAgents.values()).filter(a => a.level === level);
  }

  /**
   * Get agents filtered by parent coordinator ID
   *
   * @param {string} parentId - Parent coordinator ID
   * @returns {AgentInfo[]} Child agents of the specified parent
   */
  getAgentsByParent(parentId) {
    return Array.from(this.activeAgents.values()).filter(a => a.parentId === parentId);
  }

  /**
   * Check whether the governor has capacity for additional agents
   *
   * @returns {boolean} True if at least one more agent can be spawned
   */
  hasCapacity() {
    const effectiveConcurrent = this.activeAgents.size + this._getTotalReserved();
    return (
      this.totalSpawned < this.config.maxTotalAgents &&
      effectiveConcurrent < this.config.maxConcurrentAgents &&
      this.worktrees.size < this.config.maxWorktrees
    );
  }

  /**
   * Update the turn count for an active agent
   *
   * Called periodically to keep cost tracking accurate as agents consume turns.
   *
   * @param {string} agentId - Agent identifier
   * @param {number} turns - New total turn count
   * @returns {boolean} True if updated successfully
   */
  updateAgentTurns(agentId, turns) {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      return false;
    }

    const previousTurns = agent.turns;
    agent.turns = turns;

    // Accumulate cost delta
    const delta = Math.max(0, turns - previousTurns);
    this.totalCost += delta * this.config.costPerAgentTurn;

    return true;
  }

  // ── Private Methods ──────────────────────────────────────────────

  /**
   * Get total reserved slots across all reservations
   * @private
   * @returns {number} Total reserved agent count
   */
  _getTotalReserved() {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      total += reservation.reserved;
    }
    return total;
  }

  /**
   * Handle child status events from the IPC bus
   *
   * Automatically updates agent tracking when child coordinators
   * report status changes (online, completed, offline).
   *
   * @private
   * @param {Object} msg - Status message from child
   */
  _handleChildStatus(msg) {
    if (!msg || !msg.coordinatorId) return;

    try {
      const { coordinatorId, status, level, scope } = msg;

      if (status === "online" && !this.activeAgents.has(coordinatorId)) {
        // Auto-register newly discovered child coordinators
        this.registerAgent({
          id: coordinatorId,
          level: level || 1,
          scope: scope || "unknown",
        });
      } else if (status === "completed" || status === "offline") {
        if (this.activeAgents.has(coordinatorId)) {
          this.deregisterAgent(coordinatorId, {
            status: status === "completed" ? "completed" : "failed",
          });
        }
      }
    } catch (err) {
      this._log("error", "Failed to handle child status", {
        error: err.message,
        msg: JSON.stringify(msg).slice(0, 200),
      });
    }
  }

  /**
   * Clean up a single worktree path
   *
   * Removes the worktree directory if it exists. Logs but does not throw
   * on failure to ensure cleanup continues for other resources.
   *
   * @private
   * @param {string} wtPath - Worktree directory path
   */
  _cleanupWorktree(wtPath) {
    try {
      if (existsSync(wtPath)) {
        rmSync(wtPath, { recursive: true, force: true });
        this._log("info", "Worktree cleaned up", { path: wtPath });
      }
    } catch (err) {
      this._log("warn", "Failed to cleanup worktree", {
        path: wtPath,
        error: err.message,
      });
    }
  }

  /**
   * Publish a governor event to the IPC bus
   *
   * Prefixes the event with "governor." for topic namespacing.
   * Non-throwing: logs errors but never propagates them.
   *
   * @private
   * @param {string} event - Event name (e.g., "budget.approved", "agent.registered")
   * @param {Object} data - Event payload
   */
  _publishEvent(event, data) {
    if (!this.bus || !this.bus.connected) return;

    try {
      // Fire-and-forget: don't await, don't block on IPC failures
      this.bus.publish(`${GOVERNOR_TOPIC_PREFIX}.${event}`, {
        ...data,
        timestamp: Date.now(),
      }).catch((err) => {
        this._log("warn", "Failed to publish governor event", {
          event,
          error: err.message,
        });
      });
    } catch (err) {
      this._log("warn", "Failed to publish governor event", {
        event,
        error: err.message,
      });
    }
  }

  /**
   * Structured JSON logging to stderr
   *
   * @private
   * @param {string} level - Log level (debug, info, warn, error)
   * @param {string} message - Log message
   * @param {Object} [context] - Additional structured context
   */
  _log(level, message, context = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: "governor",
      message,
      ...context,
    };

    process.stderr.write(JSON.stringify(logEntry) + "\n");
  }
}

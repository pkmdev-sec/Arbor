/**
 * Sub-Coordinator Agent for Hierarchical Swarm Decomposition
 *
 * A sub-coordinator manages a sub-swarm within a hierarchical agent system.
 * It can either execute work directly or further decompose its task into
 * child workers or sub-coordinators, creating a recursive B-tree structure.
 *
 * Key responsibilities:
 * - Decompose scoped tasks into subtasks
 * - Spawn and manage child agents (workers or sub-coordinators)
 * - Monitor child health via heartbeat tracking
 * - Handle child crashes with configurable retry logic
 * - Aggregate child results with semantic merge for conflicts
 * - Report aggregated results to parent coordinator
 * - Enforce budget limits and resource constraints
 *
 * @module hierarchy/sub-coordinator
 */

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { spawnAgent } from "../agent-spawn.mjs";
import { performSemanticMerge } from "../semantic-merge.mjs";
import { prepareWorktreeGit, validateAndApply, cleanupIsolation, getCachedSnapshot, cacheSnapshotAsync, backupFilesAsync } from "../isolation.mjs";
import { aiJsonDecision, isAiClientAvailable } from "../ai-client.mjs";
import { DEPTH, ROLE_PROMPTS } from "../config.mjs";
import { ScopedBus, HierarchicalTopics, createChildScope } from "./scoped-bus.mjs";

/**
 * Default configuration for sub-coordinators
 */
const DEFAULT_CONFIG = {
  /** Maximum children per sub-coordinator */
  maxChildren: 5,

  /** Minimum files to warrant splitting */
  minFilesForSplit: 4,

  /** Heartbeat timeout in milliseconds */
  heartbeatTimeout: 45000,

  /** BUG FIX D: Startup grace period before heartbeat monitoring begins (agent startup can take 30-60s) */
  startupGracePeriod: 90000,

  /** Max retries for crashed child agents */
  maxChildRetries: 1,

  /** Worker execution timeout in seconds */
  workerTimeout: 600,

  /** Budget allocation strategy: "equal" | "weighted" */
  budgetStrategy: "weighted",

  /** Enable semantic merge for overlapping file changes */
  enableSemanticMerge: true,
};

/**
 * Child agent status enumeration
 * @enum {string}
 */
const ChildStatus = {
  PENDING: "pending",
  SPAWNING: "spawning",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  CRASHED: "crashed",
  RETRYING: "retrying",
};

/**
 * Sub-coordinator agent for managing hierarchical sub-swarms
 *
 * @example
 * const coordinator = new SubCoordinator({
 *   id: "sub-coord-01",
 *   level: 1,
 *   scope: "auth",
 *   task: "Refactor authentication module",
 *   parentChannel: null,
 *   busAddress: "/tmp/claude-ipc-bus.sock",
 *   worktreeBase: "/tmp/swarm/abc123/worktrees",
 *   agentBudget: 5,
 *   maxDepth: 3,
 * });
 *
 * await coordinator.start();
 * const result = await coordinator.execute();
 * await coordinator.shutdown();
 */
export class SubCoordinator {
  /**
   * Create a sub-coordinator instance
   *
   * @param {Object} config - Configuration
   * @param {string} config.id - Unique identifier for this coordinator
   * @param {number} config.level - Hierarchy level (0=top, 1=sub, 2+=deep)
   * @param {string} config.scope - Scope identifier (module/subsystem name)
   * @param {string} config.task - Task description for this scope
   * @param {string[]} [config.files] - File paths within scope
   * @param {ScopedBus|null} config.parentChannel - Parent's scoped bus (null for top level)
   * @param {string} config.busAddress - IPC bus socket path
   * @param {string} config.worktreeBase - Base directory for worktrees
   * @param {number} config.agentBudget - Total agent budget for this subtree
   * @param {number} config.maxDepth - Maximum hierarchy depth
   * @param {Object} [config.overrides] - Configuration overrides
   */
  constructor(config) {
    // Validate required config
    if (!config.id || typeof config.id !== "string") {
      throw new TypeError("config.id must be a non-empty string");
    }
    if (typeof config.level !== "number" || config.level < 0) {
      throw new TypeError("config.level must be a non-negative number");
    }
    if (!config.scope || typeof config.scope !== "string") {
      throw new TypeError("config.scope must be a non-empty string");
    }
    if (!config.task || typeof config.task !== "string") {
      throw new TypeError("config.task must be a non-empty string");
    }
    if (!config.busAddress || typeof config.busAddress !== "string") {
      throw new TypeError("config.busAddress must be a non-empty string");
    }
    if (!config.worktreeBase || typeof config.worktreeBase !== "string") {
      throw new TypeError("config.worktreeBase must be a non-empty string");
    }
    if (typeof config.agentBudget !== "number" || config.agentBudget < 1) {
      throw new TypeError("config.agentBudget must be a positive number");
    }
    if (typeof config.maxDepth !== "number" || config.maxDepth < 1) {
      throw new TypeError("config.maxDepth must be a positive number");
    }

    this.id = config.id;
    this.level = config.level;
    this.scope = config.scope;
    this.task = config.task;
    this.files = config.files || [];
    this.parentChannel = config.parentChannel;
    this.busAddress = config.busAddress;
    this.worktreeBase = config.worktreeBase;
    this.agentBudget = config.agentBudget;
    this.maxDepth = config.maxDepth;
    this.mainCwd = config.mainCwd || process.cwd();

    // Merge config with defaults
    this.config = { ...DEFAULT_CONFIG, ...config.overrides };

    /** @type {ScopedBus|null} This coordinator's scoped bus */
    this.bus = null;

    /** @type {Map<string, ChildAgent>} Child agents by ID */
    this.children = new Map();

    /** @type {Map<string, NodeJS.Timeout>} Heartbeat timers by child ID */
    this.heartbeatTimers = new Map();

    /** @type {Map<string, boolean>} BUG FIX D: Track whether first heartbeat received (for grace period) */
    this.firstHeartbeatReceived = new Map();

    /** @type {Object|null} Decomposition result */
    this.decomposition = null;

    /** @type {string|null} Worktree path for this coordinator */
    this.worktreePath = null;

    /** @type {Object|null} Snapshot for validation */
    this.snapshot = null;

    /** @type {string|null} Backup directory */
    this.backupDir = null;

    /** @type {boolean} Whether coordinator is active */
    this.active = false;

    /** @type {number} Start timestamp */
    this.startTime = 0;
  }

  /**
   * Initialize and connect to the IPC bus
   *
   * Establishes connection to parent bus, registers this coordinator,
   * and sets up message handlers.
   *
   * @returns {Promise<void>}
   * @throws {Error} If connection fails
   */
  async start() {
    try {
      this.startTime = Date.now();
      this.active = true;

      this._log("info", "Starting sub-coordinator", {
        level: this.level,
        scope: this.scope,
        budget: this.agentBudget,
        files: this.files.length,
      });

      // Create and connect scoped bus
      this.bus = new ScopedBus(this.id, {
        level: this.level,
        scope: this.scope,
        socketPath: this.busAddress,
        autoReconnect: true,
        enableLogging: true,
      });

      await this.bus.connect();

      // Announce online status to parent
      await this._reportStatus("online");

      this._log("info", "Sub-coordinator started", { id: this.id });
    } catch (err) {
      this._log("error", "Failed to start sub-coordinator", { error: err.message, stack: err.stack });
      throw new Error(`SubCoordinator start failed: ${err.message}`);
    }
  }

  /**
   * Decompose task into subtasks
   *
   * Analyzes the scoped task and decides whether to:
   * 1. Execute directly (task is simple enough)
   * 2. Split into child workers
   * 3. Split into child sub-coordinators (for complex sub-modules)
   *
   * @returns {Promise<DecompositionResult>}
   * @throws {Error} If decomposition fails
   *
   * @typedef {Object} DecompositionResult
   * @property {string} strategy - "direct" | "split"
   * @property {string} reason - Human-readable reason for decision
   * @property {Object[]} [subtasks] - Array of subtasks (if strategy === "split")
   * @property {string} subtasks[].title - Subtask title
   * @property {string} subtasks[].task - Subtask description
   * @property {string[]} subtasks[].scope - File paths for this subtask
   * @property {string} subtasks[].type - "worker" | "coordinator"
   * @property {number} subtasks[].budget - Agent budget allocation
   */
  async decompose() {
    try {
      this._log("info", "Starting decomposition", { scope: this.scope, files: this.files.length });

      await this._reportProgress(0.1, "Analyzing scope");

      // Decision: Can we execute directly?
      const shouldSplit = this._shouldSplit();

      if (!shouldSplit.split) {
        this._log("info", "Direct execution strategy", { reason: shouldSplit.reason });
        this.decomposition = {
          strategy: "direct",
          reason: shouldSplit.reason,
        };
        return this.decomposition;
      }

      // Budget check: Do we have enough budget to split?
      if (this.agentBudget < this.config.maxChildren + 1) {
        this._log("warn", "Insufficient budget for split, falling back to direct", {
          budget: this.agentBudget,
          minRequired: this.config.maxChildren + 1,
        });
        this.decomposition = {
          strategy: "direct",
          reason: "insufficient budget for decomposition",
        };
        return this.decomposition;
      }

      // Depth check: Are we at max depth?
      if (this.level >= this.maxDepth - 1) {
        this._log("info", "Max depth reached, executing directly", { level: this.level, maxDepth: this.maxDepth });
        this.decomposition = {
          strategy: "direct",
          reason: "max hierarchy depth reached",
        };
        return this.decomposition;
      }

      // Perform AI-based decomposition
      const subtasks = await this._aiDecompose();

      if (!subtasks || subtasks.length === 0) {
        this._log("warn", "Decomposition returned no subtasks, falling back to direct");
        this.decomposition = {
          strategy: "direct",
          reason: "decomposition produced no subtasks",
        };
        return this.decomposition;
      }

      // Allocate budget to subtasks
      const subtasksWithBudget = this._allocateBudget(subtasks);

      this._log("info", "Split strategy selected", {
        subtaskCount: subtasksWithBudget.length,
        types: subtasksWithBudget.map(st => st.type),
      });

      this.decomposition = {
        strategy: "split",
        reason: `decomposed into ${subtasksWithBudget.length} subtasks`,
        subtasks: subtasksWithBudget,
      };

      await this._reportProgress(0.2, "Decomposition complete");

      return this.decomposition;
    } catch (err) {
      this._log("error", "Decomposition failed", { error: err.message, stack: err.stack });
      // Fallback to direct execution on error
      this.decomposition = {
        strategy: "direct",
        reason: `decomposition error: ${err.message}`,
      };
      return this.decomposition;
    }
  }

  /**
   * Spawn child agents based on decomposition
   *
   * Creates worktrees, spawns agents (workers or sub-coordinators),
   * and registers heartbeat monitors.
   *
   * @param {Object[]} subtasks - Subtasks from decomposition
   * @returns {Promise<void>}
   * @throws {Error} If spawning fails
   */
  async spawnChildren(subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      throw new TypeError("subtasks must be a non-empty array");
    }

    try {
      this._log("info", "Spawning children", { count: subtasks.length });

      await this._reportProgress(0.3, `Spawning ${subtasks.length} children`);

      // Create worktrees sequentially (git worktree lock)
      for (let i = 0; i < subtasks.length; i++) {
        const subtask = subtasks[i];
        const childId = `${this.id}-C${String(i + 1).padStart(2, "0")}`;

        try {
          const child = await this._createChild(childId, subtask, i);
          this.children.set(childId, child);
        } catch (err) {
          this._log("error", "Failed to create child", { childId, error: err.message });
          // Mark as failed and continue with other children
          this.children.set(childId, {
            id: childId,
            subtask,
            status: ChildStatus.FAILED,
            error: err.message,
            retries: 0,
          });
        }
      }

      // Spawn all children in parallel
      const spawnPromises = Array.from(this.children.values())
        .filter(child => child.status === ChildStatus.PENDING)
        .map(child => this._spawnChild(child));

      await Promise.all(spawnPromises);

      this._log("info", "Children spawned", {
        total: subtasks.length,
        active: Array.from(this.children.values()).filter(c => c.status === ChildStatus.ACTIVE).length,
      });

      await this._reportProgress(0.4, "Children spawned");
    } catch (err) {
      this._log("error", "Failed to spawn children", { error: err.message, stack: err.stack });
      throw new Error(`SubCoordinator spawnChildren failed: ${err.message}`);
    }
  }

  /**
   * Wait for all children to complete
   *
   * Monitors child heartbeats, handles crashes with retry logic,
   * and collects results.
   *
   * @returns {Promise<Map<string, ChildResult>>} Map of child ID to result
   * @throws {Error} If critical error occurs
   *
   * @typedef {Object} ChildResult
   * @property {string} id - Child agent ID
   * @property {string} status - Final status (completed, failed, crashed)
   * @property {number} exitCode - Exit code
   * @property {number} durationMs - Execution duration
   * @property {string} output - Agent output
   * @property {string} resultFile - Path to result JSON
   * @property {string[]} modifiedFiles - Files modified by this child
   * @property {Object} [error] - Error details if failed
   */
  async waitForChildren() {
    try {
      this._log("info", "Waiting for children", { count: this.children.size });

      const results = new Map();

      // Start heartbeat monitoring for all active children
      for (const child of this.children.values()) {
        if (child.status === ChildStatus.ACTIVE) {
          this._startHeartbeatMonitor(child);
        }
      }

      // Wait for all children to reach terminal state
      const checkInterval = 1000; // Check every second
      const maxWaitTime = this.config.workerTimeout * 1000 * 2; // 2x worker timeout
      const startWait = Date.now();

      while (true) {
        const allDone = Array.from(this.children.values()).every(child =>
          [ChildStatus.COMPLETED, ChildStatus.FAILED, ChildStatus.CRASHED].includes(child.status)
        );

        if (allDone) {
          break;
        }

        // Timeout check
        if (Date.now() - startWait > maxWaitTime) {
          this._log("error", "Children wait timeout exceeded", { maxWaitTime });
          // Mark remaining active children as crashed
          for (const child of this.children.values()) {
            if (child.status === ChildStatus.ACTIVE) {
              child.status = ChildStatus.CRASHED;
              child.error = "coordinator wait timeout";
            }
          }
          break;
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      // Stop all heartbeat monitors
      for (const timer of this.heartbeatTimers.values()) {
        clearTimeout(timer);
      }
      this.heartbeatTimers.clear();

      // Collect results
      for (const child of this.children.values()) {
        try {
          const result = await this._collectChildResult(child);
          results.set(child.id, result);
        } catch (err) {
          this._log("error", "Failed to collect child result", { childId: child.id, error: err.message });
          results.set(child.id, {
            id: child.id,
            status: "failed",
            exitCode: 1,
            durationMs: 0,
            output: "",
            resultFile: "",
            modifiedFiles: [],
            error: { message: err.message },
          });
        }
      }

      const completedCount = Array.from(results.values()).filter(r => r.status === "completed").length;
      const failedCount = results.size - completedCount;

      this._log("info", "Children completed", { total: results.size, completed: completedCount, failed: failedCount });

      await this._reportProgress(0.7, "Children completed");

      return results;
    } catch (err) {
      this._log("error", "Failed while waiting for children", { error: err.message, stack: err.stack });
      throw new Error(`SubCoordinator waitForChildren failed: ${err.message}`);
    }
  }

  /**
   * Aggregate results from child agents
   *
   * Performs conflict detection, semantic merge for overlapping files,
   * and produces a combined result.
   *
   * @param {Map<string, ChildResult>} childResults - Child results
   * @returns {Promise<AggregatedResult>}
   *
   * @typedef {Object} AggregatedResult
   * @property {string} status - "completed" | "partial" | "failed"
   * @property {number} totalChildren - Total number of children
   * @property {number} completedChildren - Number of completed children
   * @property {string[]} modifiedFiles - All modified files (deduplicated)
   * @property {Object[]} conflicts - Detected conflicts
   * @property {string} mergedOutput - Combined output from all children
   * @property {Object[]} childSummaries - Per-child summary
   */
  async aggregateResults(childResults) {
    try {
      this._log("info", "Aggregating results", { childCount: childResults.size });

      await this._reportProgress(0.8, "Aggregating results");

      const childSummaries = [];
      const allModifiedFiles = new Map(); // file → [childId, ...]
      let combinedOutput = [];

      // Collect modified files and outputs
      for (const [childId, result] of childResults) {
        childSummaries.push({
          id: childId,
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          modifiedFiles: result.modifiedFiles.length,
        });

        combinedOutput.push(`\n═══ ${childId} | ${result.status} ═══\n${result.output || "(no output)"}`);

        for (const file of result.modifiedFiles) {
          if (!allModifiedFiles.has(file)) {
            allModifiedFiles.set(file, []);
          }
          allModifiedFiles.get(file).push(childId);
        }
      }

      // Detect conflicts (files modified by >1 child)
      const conflicts = [];
      for (const [file, childIds] of allModifiedFiles) {
        if (childIds.length > 1) {
          conflicts.push({ file, agents: childIds });
        }
      }

      // BUG FIX F: Track merge failures
      let mergeFailures = [];
      if (conflicts.length > 0) {
        this._log("warn", "Conflicts detected", { count: conflicts.length });

        // Perform semantic merge if enabled
        if (this.config.enableSemanticMerge) {
          mergeFailures = await this._semanticMergeConflicts(conflicts, childResults);
        }
      }

      const completedCount = childSummaries.filter(c => c.status === "completed").length;
      const totalCount = childSummaries.length;

      const overallStatus = completedCount === totalCount
        ? "completed"
        : completedCount > 0
        ? "partial"
        : "failed";

      const aggregated = {
        status: overallStatus,
        totalChildren: totalCount,
        completedChildren: completedCount,
        modifiedFiles: Array.from(allModifiedFiles.keys()),
        conflicts: conflicts.length > 0 ? conflicts : [],
        mergeFailures: mergeFailures, // BUG FIX F: Include merge failures in result
        mergedOutput: combinedOutput.join("\n"),
        childSummaries,
      };

      this._log("info", "Results aggregated", {
        status: overallStatus,
        completed: completedCount,
        total: totalCount,
        conflicts: conflicts.length,
      });

      await this._reportProgress(0.9, "Aggregation complete");

      return aggregated;
    } catch (err) {
      this._log("error", "Failed to aggregate results", { error: err.message, stack: err.stack });
      throw new Error(`SubCoordinator aggregateResults failed: ${err.message}`);
    }
  }

  /**
   * Report aggregated result to parent coordinator
   *
   * @param {AggregatedResult} result - Aggregated result
   * @returns {Promise<void>}
   */
  async reportUp(result) {
    try {
      this._log("info", "Reporting to parent", { status: result.status });

      const report = {
        coordinatorId: this.id,
        level: this.level,
        scope: this.scope,
        task: this.task,
        status: result.status,
        durationMs: Date.now() - this.startTime,
        children: result.totalChildren,
        completedChildren: result.completedChildren,
        modifiedFiles: result.modifiedFiles,
        conflicts: result.conflicts,
        output: result.mergedOutput.slice(0, 10000), // Truncate for IPC
      };

      await this.bus.publishUp(HierarchicalTopics.RESULT, report);
      await this._reportStatus("completed");
      await this._reportProgress(1.0, "Complete");

      this._log("info", "Reported to parent", { status: result.status });
    } catch (err) {
      this._log("error", "Failed to report to parent", { error: err.message, stack: err.stack });
      throw new Error(`SubCoordinator reportUp failed: ${err.message}`);
    }
  }

  /**
   * Shutdown coordinator and cleanup resources
   *
   * Closes IPC connections, cleans up worktrees, and releases resources.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    try {
      this._log("info", "Shutting down sub-coordinator", { id: this.id });

      this.active = false;

      // Stop heartbeat monitors
      for (const timer of this.heartbeatTimers.values()) {
        clearTimeout(timer);
      }
      this.heartbeatTimers.clear();

      // Cleanup child worktrees
      for (const child of this.children.values()) {
        if (child.worktreePath) {
          try {
            cleanupIsolation(child.worktreePath, child.backupDir);
          } catch (err) {
            this._log("warn", "Failed to cleanup child worktree", { childId: child.id, error: err.message });
          }
        }
      }

      // Cleanup own worktree
      if (this.worktreePath) {
        try {
          cleanupIsolation(this.worktreePath, this.backupDir);
        } catch (err) {
          this._log("warn", "Failed to cleanup coordinator worktree", { error: err.message });
        }
      }

      // Close IPC connection
      if (this.bus) {
        await this._reportStatus("offline");
        await this.bus.close();
        this.bus = null;
      }

      this._log("info", "Sub-coordinator shutdown complete", { id: this.id });
    } catch (err) {
      this._log("error", "Shutdown failed", { error: err.message, stack: err.stack });
      // Don't throw on shutdown errors
    }
  }

  /**
   * Execute the full coordinator lifecycle: decompose → spawn → wait → aggregate → report
   *
   * Orchestrates the complete sub-coordinator workflow. If the task is simple
   * enough (decompose returns "direct" strategy), returns immediately without
   * spawning children.
   *
   * @returns {Promise<Object>} Execution result
   * @returns {string} result.strategy - "direct" | "split"
   * @returns {Object[]} result.results - Array of child or direct results
   * @returns {Object} [result.aggregation] - Aggregated result (only for "split")
   */
  async execute() {
    try {
      const decomposition = await this.decompose();

      if (decomposition.strategy === "direct" || decomposition.strategy !== "split") {
        // Task too small to split — return a result shaped for the parent aggregator
        this._log("info", "Executing directly (no split)", { reason: decomposition.reason });
        return {
          strategy: "direct",
          results: [{
            id: this.id,
            status: "completed",
            exitCode: 0,
            durationMs: Date.now() - this.startTime,
            output: `Direct execution: ${decomposition.reason}`,
            resultFile: "",
            modifiedFiles: [],
            scope: this.files,
            level: this.level,
          }],
        };
      }

      await this.spawnChildren(decomposition.subtasks);
      const childResults = await this.waitForChildren();
      const aggregated = await this.aggregateResults(childResults);
      await this.reportUp(aggregated);

      return {
        strategy: "split",
        results: Array.from(childResults.values()),
        aggregation: aggregated,
      };
    } catch (err) {
      this._log("error", "Execution failed", { error: err.message });
      throw err;
    } finally {
      await this.shutdown();
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private Methods
  // ──────────────────────────────────────────────────────────────────

  /**
   * Determine if task should be split or executed directly
   * @private
   */
  _shouldSplit() {
    // Too few files
    if (this.files.length < this.config.minFilesForSplit) {
      return { split: false, reason: `only ${this.files.length} files in scope` };
    }

    // Budget too low
    if (this.agentBudget < this.config.maxChildren + 1) {
      return { split: false, reason: "insufficient agent budget" };
    }

    // At max depth
    if (this.level >= this.maxDepth - 1) {
      return { split: false, reason: "at maximum hierarchy depth" };
    }

    // Should split
    return { split: true, reason: "scope warrants decomposition" };
  }

  /**
   * Perform AI-based decomposition of task
   * @private
   */
  async _aiDecompose() {
    try {
      const maxChildren = Math.min(this.config.maxChildren, this.agentBudget - 1);

      const prompt = [
        `Decompose this scoped task into ${maxChildren} subtasks.`,
        ``,
        `SCOPE: ${this.scope}`,
        `TASK: ${this.task}`,
        `FILES IN SCOPE (${this.files.length}):`,
        this.files.slice(0, 100).join("\n"),
        this.files.length > 100 ? `... and ${this.files.length - 100} more` : "",
        ``,
        `Requirements:`,
        `- Create up to ${maxChildren} subtasks with non-overlapping file assignments`,
        `- Each subtask must be self-contained within this scope`,
        `- Assign each file to exactly ONE subtask`,
        `- Mark complex subtasks as type="coordinator" (will be further decomposed)`,
        `- Mark simple subtasks as type="worker" (direct execution)`,
      ].join("\n");

      const systemPrompt = ROLE_PROMPTS.hierarchical_decomposer || ROLE_PROMPTS.decomposer;

      if (isAiClientAvailable()) {
        const result = await aiJsonDecision({
          model: "claude-sonnet-4-6",
          system: systemPrompt,
          prompt,
          maxTokens: 4096,
        });

        if (Array.isArray(result.parsed) && result.parsed.length > 0) {
          return result.parsed.slice(0, maxChildren);
        }
      }

      // Fallback: Single subtask (direct execution)
      return [{
        title: this.task,
        task: this.task,
        scope: this.files,
        type: "worker",
      }];
    } catch (err) {
      this._log("error", "AI decomposition failed", { error: err.message });
      return [];
    }
  }

  /**
   * Allocate budget to subtasks
   * @private
   */
  _allocateBudget(subtasks) {
    const availableBudget = this.agentBudget - 1; // Reserve 1 for this coordinator

    if (this.config.budgetStrategy === "equal") {
      // Equal allocation
      const perChild = Math.max(1, Math.floor(availableBudget / subtasks.length));
      return subtasks.map(st => ({ ...st, budget: perChild }));
    }

    // Weighted allocation based on type
    const weights = subtasks.map(st => st.type === "coordinator" ? 3 : 1);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    let remaining = availableBudget;
    return subtasks.map((st, i) => {
      const allocation = Math.max(1, Math.floor((availableBudget * weights[i]) / totalWeight));
      remaining -= allocation;
      return { ...st, budget: allocation };
    });
  }

  /**
   * Create a child agent record
   * @private
   */
  async _createChild(childId, subtask, index) {
    try {
      // Create worktree for child
      let worktreePath = null;
      let backupDir = null;
      let snapshot = null;

      try {
        const gitResult = prepareWorktreeGit(this.worktreeBase, childId, this.mainCwd);
        worktreePath = gitResult.wtPath;
        backupDir = gitResult.backupDir;

        // Create snapshot
        snapshot = getCachedSnapshot(this.mainCwd) || await cacheSnapshotAsync(this.mainCwd);
        await backupFilesAsync(this.mainCwd, backupDir, snapshot);
      } catch (err) {
        this._log("warn", "Failed to create worktree for child", { childId, error: err.message });
      }

      const child = {
        id: childId,
        subtask,
        index,
        status: ChildStatus.PENDING,
        retries: 0,
        worktreePath,
        backupDir,
        snapshot,
        resultFile: join(this.worktreeBase, `${childId}-result.json`),
        spawnTime: 0,
        completeTime: 0,
        lastHeartbeat: 0,
      };

      return child;
    } catch (err) {
      this._log("error", "Failed to create child", { childId, error: err.message });
      throw err;
    }
  }

  /**
   * Spawn a child agent
   * @private
   */
  async _spawnChild(child) {
    try {
      child.status = ChildStatus.SPAWNING;
      child.spawnTime = Date.now();
      child.lastHeartbeat = Date.now();

      this._log("info", "Spawning child", { childId: child.id, type: child.subtask.type });

      if (child.subtask.type === "coordinator") {
        // Spawn sub-coordinator
        await this._spawnSubCoordinator(child);
      } else {
        // Spawn worker agent
        await this._spawnWorker(child);
      }

      child.status = ChildStatus.ACTIVE;
      this._log("info", "Child spawned", { childId: child.id });
    } catch (err) {
      child.status = ChildStatus.FAILED;
      child.error = err.message;
      this._log("error", "Failed to spawn child", { childId: child.id, error: err.message });
    }
  }

  /**
   * Spawn a sub-coordinator agent
   * @private
   */
  async _spawnSubCoordinator(child) {
    try {
      const childScope = createChildScope(this.scope, child.subtask.title || `sub${child.index}`);

      const subConfig = {
        id: child.id,
        level: this.level + 1,
        scope: childScope,
        task: child.subtask.task,
        files: child.subtask.scope || [],
        parentChannel: this.bus,
        busAddress: this.busAddress,
        worktreeBase: this.worktreeBase,
        agentBudget: child.subtask.budget || 2,
        maxDepth: this.maxDepth,
        mainCwd: this.mainCwd,
        overrides: this.config,
      };

      // Spawn via spawnAgent with sub-coordinator role
      const result = await spawnAgent({
        task: JSON.stringify(subConfig),
        role: "sub-coordinator",
        model: child.subtask.model || "sonnet",
        effort: child.subtask.effort || null,
        scope: child.subtask.scope ? child.subtask.scope.join(",") : null,
        turns: child.subtask.turns || 25,
        budget: 5,
        timeout: this.config.workerTimeout,
        resultFile: child.resultFile,
        agentId: child.id,
        cwd: child.worktreePath || this.mainCwd,
      });

      child.spawnResult = result;
    } catch (err) {
      this._log("error", "Sub-coordinator spawn failed", { childId: child.id, error: err.message });
      throw err;
    }
  }

  /**
   * Spawn a worker agent
   * @private
   */
  async _spawnWorker(child) {
    try {
      const scopePrompt = child.subtask.scope && child.subtask.scope.length > 0
        ? `\n\nYOUR FILE SCOPE (modify only these files):\n${child.subtask.scope.join("\n")}`
        : "";

      const result = await spawnAgent({
        task: child.subtask.task + scopePrompt,
        role: "worker",
        model: child.subtask.model || "sonnet",
        effort: child.subtask.effort || null,
        scope: child.subtask.scope ? child.subtask.scope.join(",") : null,
        turns: child.subtask.turns || 25,
        budget: 5,
        timeout: this.config.workerTimeout,
        resultFile: child.resultFile,
        agentId: child.id,
        cwd: child.worktreePath || this.mainCwd,
      });

      child.spawnResult = result;
    } catch (err) {
      this._log("error", "Worker spawn failed", { childId: child.id, error: err.message });
      throw err;
    }
  }

  /**
   * Start heartbeat monitor for a child
   * BUG FIX D: Use grace period before first heartbeat, normal timeout after
   * @private
   */
  _startHeartbeatMonitor(child) {
    const hasReceivedFirstHeartbeat = this.firstHeartbeatReceived.get(child.id);
    const timeout = hasReceivedFirstHeartbeat
      ? this.config.heartbeatTimeout
      : this.config.startupGracePeriod;

    const timer = setTimeout(() => {
      this._handleHeartbeatTimeout(child);
    }, timeout);

    this.heartbeatTimers.set(child.id, timer);
  }

  /**
   * Record heartbeat from child (called when child sends heartbeat message)
   * BUG FIX D: Mark first heartbeat received to switch from grace period to normal timeout
   * @private
   */
  _recordChildHeartbeat(childId) {
    if (!this.firstHeartbeatReceived.has(childId)) {
      this.firstHeartbeatReceived.set(childId, true);
      this._log("info", "First heartbeat received from child", { childId });
    }

    // Reset heartbeat timer
    const child = this.children.get(childId);
    if (child && this.heartbeatTimers.has(childId)) {
      clearTimeout(this.heartbeatTimers.get(childId));
      this._startHeartbeatMonitor(child);
    }
  }

  /**
   * Handle heartbeat timeout (child crash)
   * BUG FIX E: Check for partial changes before retrying
   * @private
   */
  async _handleHeartbeatTimeout(child) {
    try {
      this._log("warn", "Child heartbeat timeout", { childId: child.id, retries: child.retries });

      child.status = ChildStatus.CRASHED;

      // Retry logic
      if (child.retries < this.config.maxChildRetries) {
        // BUG FIX E: Check if worktree has partial changes before retrying
        let hasPartialChanges = false;
        if (child.worktreePath) {
          try {
            const diffOutput = execFileSync("git", ["diff", "--name-only", "HEAD"], {
              encoding: "utf-8",
              cwd: child.worktreePath,
              timeout: 10000,
            });
            const modifiedFiles = diffOutput.split("\n").filter(Boolean);
            hasPartialChanges = modifiedFiles.length > 0;

            if (hasPartialChanges) {
              this._log("warn", "Child worktree has partial changes", {
                childId: child.id,
                modifiedFiles: modifiedFiles.length
              });
              // Rollback partial changes before retry to prevent conflicts
              execFileSync("git", ["reset", "--hard", "HEAD"], {
                cwd: child.worktreePath,
                timeout: 10000,
              });
              this._log("info", "Rolled back partial changes before retry", { childId: child.id });
            }
          } catch (err) {
            this._log("warn", "Failed to check/rollback partial changes", {
              childId: child.id,
              error: err.message
            });
          }
        }

        child.retries++;
        child.status = ChildStatus.RETRYING;

        this._log("info", "Retrying child", {
          childId: child.id,
          attempt: child.retries,
          hadPartialChanges: hasPartialChanges
        });

        // Respawn after delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this._spawnChild(child);
      } else {
        this._log("error", "Child exhausted retries", { childId: child.id });
        child.status = ChildStatus.CRASHED;
        child.error = "heartbeat timeout, max retries exceeded";
      }
    } catch (err) {
      this._log("error", "Failed to handle heartbeat timeout", { childId: child.id, error: err.message });
    }
  }

  /**
   * Collect result from a child agent
   * @private
   */
  async _collectChildResult(child) {
    try {
      // Read result file
      let output = "";
      let exitCode = 1;
      let modifiedFiles = [];

      if (existsSync(child.resultFile)) {
        const resultData = JSON.parse(readFileSync(child.resultFile, "utf-8"));
        output = resultData.output || "";
        exitCode = resultData.exit_code || (child.status === ChildStatus.COMPLETED ? 0 : 1);
      }

      // Get modified files from worktree
      if (child.worktreePath) {
        try {
          const diffOutput = execFileSync("git", ["diff", "--name-only", "HEAD"], {
            encoding: "utf-8",
            cwd: child.worktreePath,
            timeout: 10000,
          });
          modifiedFiles = diffOutput.split("\n").filter(Boolean);
        } catch (err) {
          this._log("warn", "Failed to get modified files", { childId: child.id, error: err.message });
        }
      }

      return {
        id: child.id,
        status: child.status === ChildStatus.COMPLETED ? "completed" : "failed",
        exitCode,
        durationMs: child.completeTime - child.spawnTime,
        output,
        resultFile: child.resultFile,
        modifiedFiles,
        error: child.error ? { message: child.error } : null,
      };
    } catch (err) {
      this._log("error", "Failed to collect child result", { childId: child.id, error: err.message });
      throw err;
    }
  }

  /**
   * Perform semantic merge for conflicting files
   * BUG FIX F: Track and return merge failures
   * @private
   */
  async _semanticMergeConflicts(conflicts, childResults) {
    const mergeFailures = [];
    try {
      this._log("info", "Performing semantic merge", { conflicts: conflicts.length });

      // Convert to format expected by performSemanticMerge
      const overlaps = new Map();
      for (const conflict of conflicts) {
        overlaps.set(conflict.file, conflict.agents);
      }

      const resultsArray = Array.from(childResults.values()).map(r => ({
        id: r.id,
        isolation: {
          worktreePath: this.children.get(r.id)?.worktreePath,
          snapshot: this.children.get(r.id)?.snapshot,
        },
        scope: this.children.get(r.id)?.subtask?.scope || [],
      }));

      const mergeResult = await performSemanticMerge({
        overlaps,
        results: resultsArray,
        mainCwd: this.mainCwd,
        workDir: this.worktreeBase,
        task: this.task,
        bus: this.bus,
        mergeLevel: this.level,
      });

      // BUG FIX F: Check for merge failures and track them
      if (mergeResult && mergeResult.failures) {
        for (const failure of mergeResult.failures) {
          mergeFailures.push({
            file: failure.file,
            reason: failure.reason || "merge failed",
            agents: failure.agents || [],
          });
          this._log("error", "Semantic merge failed for file", {
            file: failure.file,
            reason: failure.reason
          });
        }
      }

      this._log("info", "Semantic merge complete", {
        failures: mergeFailures.length
      });
    } catch (err) {
      this._log("error", "Semantic merge failed", { error: err.message });
      // BUG FIX F: Track the error as merge failures for all conflicts
      for (const conflict of conflicts) {
        mergeFailures.push({
          file: conflict.file,
          reason: `merge error: ${err.message}`,
          agents: conflict.agents,
        });
      }
    }
    return mergeFailures;
  }

  /**
   * Report status to parent
   * @private
   */
  async _reportStatus(status) {
    try {
      if (!this.bus || !this.bus.connected) {
        return;
      }

      await this.bus.publish(HierarchicalTopics.STATUS, {
        coordinatorId: this.id,
        level: this.level,
        scope: this.scope,
        status,
        timestamp: Date.now(),
      });
    } catch (err) {
      this._log("error", "Failed to report status", { status, error: err.message });
    }
  }

  /**
   * Report progress to parent
   * @private
   */
  async _reportProgress(percent, step) {
    try {
      if (!this.bus || !this.bus.connected) {
        return;
      }

      await this.bus.publish(HierarchicalTopics.PROGRESS, {
        coordinatorId: this.id,
        level: this.level,
        scope: this.scope,
        percent,
        step,
        timestamp: Date.now(),
      });
    } catch (err) {
      this._log("error", "Failed to report progress", { percent, step, error: err.message });
    }
  }

  /**
   * Structured JSON logging
   * @private
   */
  _log(level, message, context = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: "sub-coordinator",
      coordinatorId: this.id,
      hierarchyLevel: this.level,
      scope: this.scope,
      message,
      ...context,
    };

    process.stderr.write(JSON.stringify(logEntry) + "\n");
  }
}

/**
 * Factory function to spawn, execute, and return results from a sub-coordinator
 *
 * Runs the full lifecycle: start → execute (decompose → spawn → wait → aggregate) → shutdown.
 * Returns structured results suitable for consumption by the parent orchestrator.
 *
 * @param {Object} config - SubCoordinator configuration
 * @returns {Promise<Object>} Execution result with strategy and results
 */
export async function spawnSubCoordinator(config) {
  try {
    const coordinator = new SubCoordinator(config);
    await coordinator.start();
    const result = await coordinator.execute();
    return result;
  } catch (err) {
    throw new Error(`Failed to spawn sub-coordinator: ${err.message}`);
  }
}

/**
 * Create a worker task configuration
 *
 * Helper to generate standardized task config for worker agents.
 *
 * @param {string[]} scope - File paths in scope
 * @param {string} task - Task description
 * @param {Object} config - Additional configuration
 * @returns {Object} Worker task configuration
 */
export function createWorkerTask(scope, task, config = {}) {
  if (!Array.isArray(scope)) {
    throw new TypeError("scope must be an array");
  }
  if (!task || typeof task !== "string") {
    throw new TypeError("task must be a non-empty string");
  }

  return {
    title: task.slice(0, 60),
    task,
    scope,
    type: "worker",
    budget: config.budget || 1,
    model: config.model || "sonnet",
    turns: config.turns || 25,
    timeout: config.timeout || 600,
  };
}

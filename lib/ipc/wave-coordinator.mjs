/**
 * Wave Coordination Protocol over IPC
 *
 * REQ-008: Coordinates wave-based execution across distributed agents using the IPC bus.
 * Provides:
 * - Wave lifecycle management (start, task_complete, complete)
 * - Barrier synchronization (waitForWave)
 * - Context injection (getWaveContext for informed execution)
 * - Event-driven progress tracking
 *
 * Integrates with WaveExecutor for local wave execution and OrchestratorControl
 * for distributed coordination.
 *
 * @module wave-coordinator
 */

/**
 * Coordinates wave-based task execution over IPC bus
 *
 * @example
 * const orchestrator = new OrchestratorControl();
 * await orchestrator.connect();
 *
 * const coordinator = new WaveCoordinator(orchestrator);
 * await coordinator.start();
 *
 * // Start wave 1
 * await coordinator.startWave(1, tasks);
 *
 * // Report task completion
 * coordinator.reportTaskComplete('agent-01', 1, {
 *   summary: 'Task completed successfully',
 *   status: 'completed',
 *   filesChanged: ['src/foo.js']
 * });
 *
 * // End wave and broadcast results
 * await coordinator.endWave(1);
 *
 * // Wait for wave completion (barrier sync)
 * const { results } = await coordinator.waitForWave(1);
 *
 * // Get context for next wave
 * const context = coordinator.getWaveContext(1);
 */
export default class WaveCoordinator {
  /**
   * @param {import('./orchestrator-control.mjs').OrchestratorControl} orchestratorControl - Orchestrator control instance
   * @param {object} [options={}] - Configuration options
   * @param {number} [options.maxWaves=3] - Maximum number of waves
   */
  constructor(orchestratorControl, options = {}) {
    if (!orchestratorControl) {
      throw new Error("orchestratorControl is required");
    }

    this.orchestratorControl = orchestratorControl;
    this.maxWaves = options.maxWaves || 3;

    /** @type {Map<number, Array<{agentId: string, summary: string, status: string, filesChanged: string[]}>>} */
    this._waveResults = new Map();

    /** @type {Map<number, {resolve: Function, reject: Function, promise: Promise}>} */
    this._wavePromises = new Map();

    /** @type {Set<number>} Tracks which waves have completed (endWave called) */
    this._completedWaves = new Set();

    /** @type {Array<Function>} */
    this._handlers = [];

    /** @type {boolean} */
    this._subscribed = false;

    // Bind handlers
    this._handleWaveStart = this._handleWaveStart.bind(this);
    this._handleTaskComplete = this._handleTaskComplete.bind(this);
    this._handleWaveComplete = this._handleWaveComplete.bind(this);
  }

  /**
   * Start the coordinator and subscribe to wave events
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._subscribed) {
      return;
    }

    // Subscribe to wave lifecycle topics
    this.orchestratorControl.subscribe("wave.start", this._handleWaveStart);
    this.orchestratorControl.subscribe("wave.task_complete", this._handleTaskComplete);
    this.orchestratorControl.subscribe("wave.complete", this._handleWaveComplete);

    this._subscribed = true;
  }

  /**
   * Start a new wave and broadcast to all agents
   *
   * @param {number} waveNumber - Wave number (1, 2, 3, etc.)
   * @param {Array<{id: string, description: string}>} tasks - Tasks in this wave
   * @returns {Promise<void>}
   */
  async startWave(waveNumber, tasks) {
    if (!Array.isArray(tasks)) {
      throw new Error("tasks must be an array");
    }

    // Initialize results storage for this wave
    this._waveResults.set(waveNumber, []);

    // Broadcast wave start event
    await this.orchestratorControl.publish("wave.start", {
      waveNumber,
      taskCount: tasks.length,
      tasks: tasks.map(t => ({
        id: t.id,
        description: t.description,
      })),
      timestamp: Date.now(),
    });

    // Emit to local handlers
    this._emitEvent("wave.start", {
      waveNumber,
      taskCount: tasks.length,
      tasks,
    });
  }

  /**
   * Report task completion for a wave
   *
   * Stores the result locally and broadcasts to all agents.
   *
   * @param {string} agentId - Agent that completed the task
   * @param {number} waveNumber - Wave number
   * @param {{summary?: string, status?: string, filesChanged?: string[]}} result - Task result
   * @returns {Promise<void>}
   */
  async reportTaskComplete(agentId, waveNumber, result) {
    // Store result locally
    const results = this._waveResults.get(waveNumber) || [];
    results.push({
      agentId,
      summary: result.summary || "",
      status: result.status || "completed",
      filesChanged: result.filesChanged || [],
    });
    this._waveResults.set(waveNumber, results);

    // Broadcast task completion
    await this.orchestratorControl.publish("wave.task_complete", {
      waveNumber,
      agentId,
      result: {
        summary: result.summary || "",
        status: result.status || "completed",
        filesChanged: result.filesChanged || [],
      },
      timestamp: Date.now(),
    });

    // Emit to local handlers
    this._emitEvent("wave.task_complete", {
      waveNumber,
      agentId,
      result,
    });
  }

  /**
   * End a wave and broadcast summarized results
   *
   * Resolves any pending waitForWave promises.
   *
   * @param {number} waveNumber - Wave number
   * @returns {Promise<void>}
   */
  async endWave(waveNumber) {
    // Get results for this wave
    const results = this._waveResults.get(waveNumber) || [];

    // Create summarized results for broadcast
    const summarized = results.map(r => ({
      agentId: r.agentId,
      status: r.status,
      filesChanged: r.filesChanged || [],
      summary: r.summary || "",
    }));

    // Mark wave as completed
    this._completedWaves.add(waveNumber);

    // Broadcast wave completion
    await this.orchestratorControl.publish("wave.complete", {
      waveNumber,
      results: summarized,
      timestamp: Date.now(),
    });

    // Resolve any waiting promises
    const promise = this._wavePromises.get(waveNumber);
    if (promise) {
      promise.resolve({ waveNumber, results: summarized });
      this._wavePromises.delete(waveNumber);
    }

    // Emit to local handlers
    this._emitEvent("wave.complete", {
      waveNumber,
      results: summarized,
    });
  }

  /**
   * Wait for a wave to complete (barrier synchronization)
   *
   * Returns immediately if the wave has already completed.
   *
   * @param {number} waveNumber - Wave number to wait for
   * @returns {Promise<{waveNumber: number, results: Array}>} Wave results
   */
  waitForWave(waveNumber) {
    // Check if wave already completed (endWave was called)
    if (this._completedWaves.has(waveNumber)) {
      const results = this._waveResults.get(waveNumber) || [];
      return Promise.resolve({ waveNumber, results });
    }

    // Create promise if not exists
    if (!this._wavePromises.has(waveNumber)) {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this._wavePromises.set(waveNumber, { resolve, reject, promise });
      return promise;
    }

    return this._wavePromises.get(waveNumber).promise;
  }

  /**
   * Get summarized context from a completed wave for injection into next wave
   *
   * Format: 'PRIOR WAVE {n} RESULTS:\n' + bullet points
   * Capped at 2000 characters.
   *
   * @param {number} waveNumber - Wave number to get context from
   * @returns {string} Formatted context string (max 2000 chars)
   */
  getWaveContext(waveNumber) {
    const results = this._waveResults.get(waveNumber);
    if (!results || results.length === 0) {
      return "";
    }

    // Format context similar to WaveExecutor.summarizeWaveResults
    const parts = [`PRIOR WAVE ${waveNumber} RESULTS:`];
    let charCount = parts[0].length + 1;
    const maxChars = 2000;

    for (const result of results) {
      const agentLabel = `• Agent ${result.agentId}`;
      const statusLabel = result.status === "completed" ? "✓" : "⚠";
      const summary = result.summary || "Completed";
      const summaryLine = `${agentLabel} ${statusLabel}: ${summary}`;

      const filesLine = result.filesChanged?.length > 0
        ? `\n  Modified: ${result.filesChanged.slice(0, 3).join(", ")}${result.filesChanged.length > 3 ? "..." : ""}`
        : "";

      const entry = summaryLine + filesLine;

      // Check if adding this would exceed limit
      if (charCount + entry.length > maxChars) {
        parts.push("  ... (additional results truncated)");
        break;
      }

      parts.push(entry);
      charCount += entry.length + 1; // +1 for newline
    }

    return parts.join("\n");
  }

  /**
   * Register a handler for wave lifecycle events
   *
   * Handler receives: { type: 'wave.start' | 'wave.task_complete' | 'wave.complete', data: {...} }
   *
   * @param {function({type: string, data: object}): void} handler - Event handler
   * @returns {function(): void} Unsubscribe function
   */
  onWaveEvent(handler) {
    if (typeof handler !== "function") {
      throw new Error("handler must be a function");
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
   * Stop the coordinator and unsubscribe from wave events
   *
   * Rejects any pending wave promises.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._subscribed) {
      return;
    }

    // Unsubscribe from topics
    this.orchestratorControl.unsubscribe("wave.start", this._handleWaveStart);
    this.orchestratorControl.unsubscribe("wave.task_complete", this._handleTaskComplete);
    this.orchestratorControl.unsubscribe("wave.complete", this._handleWaveComplete);

    // Reject pending promises
    for (const [waveNumber, { reject }] of this._wavePromises) {
      reject(new Error("WaveCoordinator stopped"));
    }
    this._wavePromises.clear();

    this._subscribed = false;
  }

  /**
   * Handle incoming wave.start events (internal)
   *
   * @private
   * @param {object} msg - Wave start message
   */
  _handleWaveStart(msg) {
    const { waveNumber, taskCount, tasks } = msg;

    // Initialize results if not present (might be from remote orchestrator)
    if (!this._waveResults.has(waveNumber)) {
      this._waveResults.set(waveNumber, []);
    }

    this._emitEvent("wave.start", { waveNumber, taskCount, tasks });
  }

  /**
   * Handle incoming wave.task_complete events (internal)
   *
   * @private
   * @param {object} msg - Task complete message
   */
  _handleTaskComplete(msg) {
    const { waveNumber, agentId, result } = msg;

    // Store result if not already present
    const results = this._waveResults.get(waveNumber) || [];

    // Check if result already exists from this agent (avoid duplicates)
    const existing = results.find(r => r.agentId === agentId);
    if (!existing) {
      results.push({
        agentId,
        summary: result.summary || "",
        status: result.status || "completed",
        filesChanged: result.filesChanged || [],
      });
      this._waveResults.set(waveNumber, results);
    }

    this._emitEvent("wave.task_complete", { waveNumber, agentId, result });
  }

  /**
   * Handle incoming wave.complete events (internal)
   *
   * @private
   * @param {object} msg - Wave complete message
   */
  _handleWaveComplete(msg) {
    const { waveNumber, results } = msg;

    // Mark wave as completed (might be from remote orchestrator)
    this._completedWaves.add(waveNumber);

    // Resolve promise if waiting
    const promise = this._wavePromises.get(waveNumber);
    if (promise) {
      promise.resolve({ waveNumber, results });
      this._wavePromises.delete(waveNumber);
    }

    this._emitEvent("wave.complete", { waveNumber, results });
  }

  /**
   * Emit event to all registered handlers (internal)
   *
   * @private
   * @param {string} type - Event type
   * @param {object} data - Event data
   */
  _emitEvent(type, data) {
    for (const handler of this._handlers) {
      try {
        handler({ type, data });
      } catch (err) {
        // Silently ignore handler errors to prevent one bad handler from breaking others
      }
    }
  }
}

/**
 * Create and start a new wave coordinator
 *
 * @param {import('./orchestrator-control.mjs').OrchestratorControl} orchestratorControl - Orchestrator control instance
 * @param {object} [options={}] - Configuration options
 * @returns {Promise<WaveCoordinator>} Started coordinator
 */
export async function createWaveCoordinator(orchestratorControl, options = {}) {
  const coordinator = new WaveCoordinator(orchestratorControl, options);
  await coordinator.start();
  return coordinator;
}

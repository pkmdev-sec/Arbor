/**
 * Wave-Based Informed Execution
 *
 * Inspired by Fernis REQ-008. Three-wave execution where later waves get
 * prior discoveries injected into their context.
 *
 * Wave 1: Independent tasks (no dependencies)
 * Wave 2: Tasks that reference other tasks or need prior context
 * Wave 3: Verification/review tasks, generated follow-ups
 *
 * Each wave receives summarized results from previous waves to inform
 * their execution.
 */

/**
 * WaveExecutor class for managing multi-wave task execution.
 */
export default class WaveExecutor {
  /**
   * @param {object} [options={}] - Configuration options
   * @param {number} [options.maxWaves=3] - Maximum number of waves
   * @param {number} [options.maxConcurrentPerWave=5] - Max concurrent tasks per wave
   */
  constructor(options = {}) {
    this.maxWaves = options.maxWaves || 3;
    this.maxConcurrentPerWave = options.maxConcurrentPerWave || 5;
  }

  /**
   * Classify tasks into waves based on dependencies and type.
   *
   * @param {Array} tasks - All tasks to execute
   * @param {string} tasks[].description - Task description
   * @param {string} [tasks[].type] - Task type (e.g., 'verify', 'review')
   * @param {string[]} [tasks[].dependencies] - IDs of tasks this depends on
   * @returns {Array<Array>} Array of waves, each wave is array of tasks
   */
  classifyIntoWaves(tasks) {
    if (!Array.isArray(tasks)) {
      return [];
    }

    const waves = [[], [], []];
    const wave1 = waves[0];
    const wave2 = waves[1];
    const wave3 = waves[2];

    for (const task of tasks) {
      const desc = task.description?.toLowerCase() || "";
      const taskType = task.type?.toLowerCase() || "";

      // Wave 3: Verification/review tasks
      if (taskType === "verify" || taskType === "review" ||
          desc.includes("verify") || desc.includes("review") ||
          desc.includes("validate") || desc.includes("check")) {
        wave3.push(task);
        continue;
      }

      // Wave 2: Tasks with explicit dependencies or follow-up indicators
      if (task.dependencies && task.dependencies.length > 0) {
        wave2.push(task);
        continue;
      }

      // Wave 2: Tasks that reference other tasks or chain patterns
      if (desc.includes("after") || desc.includes("depends") ||
          desc.includes("following") || desc.includes("based on") ||
          desc.includes("then") || desc.includes("chain") ||
          desc.includes("follow-up")) {
        wave2.push(task);
        continue;
      }

      // Wave 1: Independent tasks (default)
      wave1.push(task);
    }

    // Filter out empty waves
    return waves.filter(wave => wave.length > 0);
  }

  /**
   * Summarize confirmed results from a completed wave for injection into next wave.
   *
   * @param {Array} results - Results from completed wave
   * @param {string} [results[].output] - Agent output
   * @param {string[]} [results[].filesChanged] - Files modified
   * @param {string[]} [results[].filesModified] - Files modified (alternate)
   * @param {string} [results[].error] - Error message if any
   * @param {object} [results[].task] - Original task
   * @returns {string} Summary text for context injection (max 2000 chars)
   */
  summarizeWaveResults(results) {
    if (!Array.isArray(results) || results.length === 0) {
      return "";
    }

    const summaryParts = [];
    let charCount = 0;
    const maxChars = 2000;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result || typeof result !== "object") continue;

      const taskDesc = result.task?.description || `Task ${i + 1}`;
      const filesChanged = result.filesChanged || result.filesModified || [];
      const hasError = result.error !== undefined && result.error !== null;
      const output = result.output || "";

      // Build summary for this result
      const parts = [];
      parts.push(`• ${taskDesc}:`);

      if (hasError) {
        const errorMsg = typeof result.error === "string"
          ? result.error.slice(0, 100)
          : "Error occurred";
        parts.push(`  ⚠ Error: ${errorMsg}`);
      } else if (filesChanged.length > 0) {
        parts.push(`  ✓ Modified: ${filesChanged.slice(0, 3).join(", ")}${filesChanged.length > 3 ? "..." : ""}`);
      } else {
        parts.push(`  ✓ Completed`);
      }

      // Extract key findings from output (look for patterns)
      const findings = this._extractKeyFindings(output);
      if (findings.length > 0) {
        parts.push(`  → ${findings[0]}`);
      }

      const summary = parts.join("\n");

      // Check if adding this would exceed limit
      if (charCount + summary.length > maxChars) {
        summaryParts.push("  ... (additional results truncated)");
        break;
      }

      summaryParts.push(summary);
      charCount += summary.length + 1; // +1 for newline
    }

    return summaryParts.join("\n");
  }

  /**
   * Extract key findings from agent output.
   * Looks for patterns like "Found:", "Discovered:", "Issue:", etc.
   *
   * @param {string} output - Agent output text
   * @returns {string[]} Array of key findings (max 3)
   * @private
   */
  _extractKeyFindings(output) {
    if (!output || typeof output !== "string") {
      return [];
    }

    const findings = [];
    const patterns = [
      /(?:found|discovered|identified):\s*([^\n]{10,80})/gi,
      /(?:issue|bug|problem):\s*([^\n]{10,80})/gi,
      /(?:pattern|approach):\s*([^\n]{10,80})/gi,
      /(?:critical|important|note):\s*([^\n]{10,80})/gi,
    ];

    for (const pattern of patterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        if (findings.length >= 3) break;
        findings.push(match[1].trim());
      }
      if (findings.length >= 3) break;
    }

    return findings;
  }

  /**
   * Execute tasks in waves, with each wave informed by prior results.
   *
   * @param {Array} tasks - Tasks to execute
   * @param {Function} executeFn - async (task, waveContext) => result
   * @returns {Promise<{ waves: Array, results: Array, stats: object }>}
   */
  async execute(tasks, executeFn) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return {
        waves: [],
        results: [],
        stats: {
          totalTasks: 0,
          wave1Count: 0,
          wave2Count: 0,
          wave3Count: 0,
          wave1Duration: 0,
          wave2Duration: 0,
          wave3Duration: 0,
        },
      };
    }

    if (typeof executeFn !== "function") {
      throw new Error("executeFn must be a function");
    }

    const waves = this.classifyIntoWaves(tasks);
    const allResults = [];
    const stats = {
      totalTasks: tasks.length,
      wave1Count: waves[0]?.length || 0,
      wave2Count: waves[1]?.length || 0,
      wave3Count: waves[2]?.length || 0,
      wave1Duration: 0,
      wave2Duration: 0,
      wave3Duration: 0,
    };

    let priorContext = "";

    for (let waveIdx = 0; waveIdx < waves.length && waveIdx < this.maxWaves; waveIdx++) {
      const wave = waves[waveIdx];
      if (!wave || wave.length === 0) continue;

      const waveStartTime = Date.now();
      const waveResults = [];

      // Execute tasks in this wave with concurrency limit
      const batches = [];
      for (let i = 0; i < wave.length; i += this.maxConcurrentPerWave) {
        batches.push(wave.slice(i, i + this.maxConcurrentPerWave));
      }

      for (const batch of batches) {
        const batchPromises = batch.map(async (task) => {
          try {
            const result = await executeFn(task, priorContext);
            return { ...result, task };
          } catch (error) {
            return {
              task,
              error: error.message || String(error),
              output: "",
              filesChanged: [],
            };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        waveResults.push(...batchResults);
      }

      const waveDuration = Date.now() - waveStartTime;
      if (waveIdx === 0) stats.wave1Duration = waveDuration;
      else if (waveIdx === 1) stats.wave2Duration = waveDuration;
      else if (waveIdx === 2) stats.wave3Duration = waveDuration;

      allResults.push(...waveResults);

      // Summarize results for next wave
      if (waveIdx < waves.length - 1) {
        const summary = this.summarizeWaveResults(waveResults);
        if (summary) {
          priorContext = priorContext
            ? `${priorContext}\n\n[Wave ${waveIdx + 1} Discoveries]\n${summary}`
            : `[Wave ${waveIdx + 1} Discoveries]\n${summary}`;
        }
      }
    }

    return {
      waves,
      results: allResults,
      stats,
    };
  }

  /**
   * Execute tasks in a continuous flow with dynamic follow-up generation.
   * Uses promise-pool pattern to maintain concurrency while allowing new tasks
   * to be added to the queue based on completed results.
   *
   * @param {Array} tasks - Initial tasks to execute
   * @param {Function} executeFn - async (task) => result
   * @param {object} [options={}] - Execution options
   * @param {Function} [options.onResult] - async (result) => void, called when each task completes
   * @param {Function} [options.generateFollowUps] - (result) => Task[], returns new tasks from result
   * @param {number} [options.maxFollowUps=10] - Cap on total follow-up tasks generated
   * @returns {Promise<{ results: Array, stats: object }>}
   */
  async executeContinuous(tasks, executeFn, options = {}) {
    // Validate inputs
    if (!Array.isArray(tasks)) {
      tasks = [];
    }

    if (typeof executeFn !== "function") {
      throw new Error("executeFn must be a function");
    }

    // Extract options
    const {
      onResult = null,
      generateFollowUps = null,
      maxFollowUps = 10,
    } = options;

    // Initialize state
    const results = [];
    const queue = [...tasks];
    let followUpsGenerated = 0;
    const startTime = Date.now();

    // Process tasks with promise pool
    const executing = new Set();

    const processTask = async (task) => {
      try {
        const result = await executeFn(task);
        const fullResult = { ...result, task };

        // Call onResult callback if provided
        if (typeof onResult === "function") {
          await onResult(fullResult);
        }

        results.push(fullResult);

        // Generate follow-ups if function provided
        if (typeof generateFollowUps === "function" && followUpsGenerated < maxFollowUps) {
          const followUps = generateFollowUps(fullResult);
          if (Array.isArray(followUps)) {
            const remainingSlots = maxFollowUps - followUpsGenerated;
            const tasksToAdd = followUps.slice(0, remainingSlots);
            queue.push(...tasksToAdd);
            followUpsGenerated += tasksToAdd.length;
          }
        }

        return fullResult;
      } catch (error) {
        const errorResult = {
          task,
          error: error.message || String(error),
          output: "",
          filesChanged: [],
        };

        // Call onResult even for errors
        if (typeof onResult === "function") {
          await onResult(errorResult);
        }

        results.push(errorResult);
        return errorResult;
      }
    };

    while (queue.length > 0 || executing.size > 0) {
      // Start new tasks up to the concurrency limit
      while (queue.length > 0 && executing.size < this.maxConcurrentPerWave) {
        const task = queue.shift();
        const promise = processTask(task);

        executing.add(promise);

        // Remove from executing set when done
        promise.then(() => executing.delete(promise)).catch(() => executing.delete(promise));
      }

      // Wait for at least one task to complete before continuing
      if (executing.size > 0) {
        await Promise.race(executing);
      }
    }

    const totalDuration = Date.now() - startTime;

    return {
      results,
      stats: {
        totalTasks: tasks.length,
        completedTasks: results.length,
        followUpsGenerated,
        totalDuration,
      },
    };
  }
}

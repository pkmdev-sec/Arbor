/**
 * Pre-task quality gate
 *
 * Filters out wasteful tasks before spawning expensive agents.
 * Inspired by Fernis REQ-005: identify redundant, infeasible, or known-dead-end tasks.
 */

// ── Constants ────────────────────────────────────────────────────

/** Minimum description length for a valid task */
const MIN_DESCRIPTION_LENGTH = 20;

/** Maximum description length for a "simple" task */
const MAX_SIMPLE_TASK_LENGTH = 30;

/** Minimum word overlap percentage for redundancy detection */
const REDUNDANCY_THRESHOLD = 0.7;

/** Minimum test attempts before marking as dead end */
const DEAD_END_THRESHOLD = 5;

// ── Premortem class ──────────────────────────────────────────────

/**
 * Pre-task quality gate that filters out wasteful tasks.
 * Runs multiple checks to identify tasks that should not spawn agents.
 *
 * @example
 * const premortem = new Premortem();
 * const result = premortem.filter(tasks, { learningStore, projectContext });
 * console.log(`Accepted: ${result.accepted.length}, Filtered: ${result.filtered.length}`);
 */
export default class Premortem {
  /**
   * Filter task list to remove redundant, infeasible, or known-dead-end tasks.
   *
   * @param {Array} tasks - Tasks to validate
   * @param {object} options - Configuration options
   * @param {object} options.learningStore - Optional LearningStore instance for history checks
   * @param {object} options.projectContext - Optional project context for validation
   * @returns {{ accepted: Array, filtered: Array, stats: object }} Filtered results
   */
  filter(tasks, options = {}) {
    const { learningStore, projectContext } = options;

    const accepted = [];
    const filtered = [];
    const stats = {
      total: tasks.length,
      accepted: 0,
      redundant: 0,
      infeasible: 0,
      deadEnd: 0,
      simple: 0,
    };

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      // Only check against previously processed tasks to avoid double-filtering
      const previousTasks = tasks.slice(0, i);

      // Run all validation checks
      const checks = [
        this._checkFeasibility(task),
        this._checkRedundancy(task, previousTasks),
        this._checkDeadEnd(task, learningStore),
      ];

      // Check if task is simple (informational, not filtered)
      const complexity = this._checkComplexity(task);

      // Determine if task should be filtered
      let shouldFilter = false;
      let filterReason = null;

      for (const check of checks) {
        if (!check.pass) {
          shouldFilter = true;
          filterReason = check.reason;

          // Update stats based on check type (case-insensitive)
          const reasonLower = check.reason.toLowerCase();
          if (reasonLower.includes("redundant")) {
            stats.redundant++;
          } else if (reasonLower.includes("feasibility") || reasonLower.includes("context")) {
            stats.infeasible++;
          } else if (reasonLower.includes("dead end")) {
            stats.deadEnd++;
          }
          break;
        }
      }

      if (shouldFilter) {
        filtered.push({ ...task, filterReason });
      } else {
        // Add complexity flag if simple
        const enrichedTask = complexity.pass
          ? { ...task, simple: true }
          : task;

        if (complexity.pass) {
          stats.simple++;
        }

        accepted.push(enrichedTask);
        stats.accepted++;
      }
    }

    return { accepted, filtered, stats };
  }

  // ── Individual validation checks ─────────────────────────────────

  /**
   * Check if task has enough context to succeed.
   * Must have either a meaningful description OR targetFiles specified.
   *
   * @param {object} task - Task to validate
   * @returns {{ pass: boolean, reason: string }} Check result
   * @private
   */
  _checkFeasibility(task) {
    const description = task.description || "";
    const hasTargetFiles = task.targetFiles && task.targetFiles.length > 0;

    // Must have either description > 20 chars OR target files
    if (description.length < MIN_DESCRIPTION_LENGTH && !hasTargetFiles) {
      return {
        pass: false,
        reason: "Insufficient context: task has no meaningful description and no target files",
      };
    }

    return {
      pass: true,
      reason: "Task has sufficient context for execution",
    };
  }

  /**
   * Check if two tasks are redundant (same files with same intent).
   * Uses word overlap and file intersection to detect duplicates.
   *
   * @param {object} task - Task to validate
   * @param {Array} otherTasks - Other tasks to compare against
   * @returns {{ pass: boolean, reason: string }} Check result
   * @private
   */
  _checkRedundancy(task, otherTasks) {
    const taskDesc = (task.description || "").toLowerCase();
    const taskFiles = new Set(task.targetFiles || []);

    for (const other of otherTasks) {
      const otherDesc = (other.description || "").toLowerCase();
      const otherFiles = new Set(other.targetFiles || []);

      // Calculate word overlap
      const taskWords = new Set(taskDesc.split(/\s+/).filter(w => w.length > 3));
      const otherWords = new Set(otherDesc.split(/\s+/).filter(w => w.length > 3));

      if (taskWords.size === 0 || otherWords.size === 0) continue;

      const intersection = new Set([...taskWords].filter(w => otherWords.has(w)));
      const wordOverlap = intersection.size / Math.min(taskWords.size, otherWords.size);

      // Calculate file overlap
      const fileIntersection = new Set([...taskFiles].filter(f => otherFiles.has(f)));
      const hasFileOverlap = taskFiles.size > 0 && fileIntersection.size > 0;

      // Tasks are redundant if high word overlap AND file overlap
      if (wordOverlap > REDUNDANCY_THRESHOLD && hasFileOverlap) {
        return {
          pass: false,
          reason: `Redundant with another task (${Math.round(wordOverlap * 100)}% word overlap, shared files)`,
        };
      }
    }

    return {
      pass: true,
      reason: "Task is unique",
    };
  }

  /**
   * Check if task is simple enough to potentially skip agent spawning.
   * Simple tasks are flagged but not filtered (caller decides).
   *
   * @param {object} task - Task to validate
   * @returns {{ pass: boolean, reason: string }} Check result (pass=true means simple)
   * @private
   */
  _checkComplexity(task) {
    const description = task.description || "";
    const targetFiles = task.targetFiles || [];

    // Simple task: short description and single file reference
    const isSimple =
      description.length < MAX_SIMPLE_TASK_LENGTH &&
      targetFiles.length === 1;

    if (isSimple) {
      return {
        pass: true,
        reason: "Task is simple (short description, single file)",
      };
    }

    return {
      pass: false,
      reason: "Task has normal complexity",
    };
  }

  /**
   * Check if this task pattern has repeatedly failed (dead end).
   * Requires learningStore with historical failure data.
   *
   * @param {object} task - Task to validate
   * @param {object} learningStore - Optional LearningStore instance
   * @returns {{ pass: boolean, reason: string }} Check result
   * @private
   */
  _checkDeadEnd(task, learningStore) {
    if (!learningStore) {
      return {
        pass: true,
        reason: "No learning store provided - cannot check dead ends",
      };
    }

    const taskType = task.taskType || "unknown";
    const deadEnds = learningStore.getDeadEnds(taskType);

    // Check if any dead end matches this task
    for (const deadEnd of deadEnds) {
      // Count how many times this pattern has been tested
      const testCount = deadEnd.testCount || DEAD_END_THRESHOLD;

      if (testCount >= DEAD_END_THRESHOLD) {
        // Check if revival conditions are met
        const revivalConditions = deadEnd.revivalConditions || [];
        // If no revival conditions specified, task cannot be revived
        // If revival conditions exist, check if any are met
        const revivalMet = revivalConditions.length > 0 && this._checkRevivalConditions(task, revivalConditions);

        if (!revivalMet) {
          return {
            pass: false,
            reason: `Known dead end: ${deadEnd.reason} (tested ${testCount} times)`,
          };
        }
      }
    }

    return {
      pass: true,
      reason: "Task pattern has not been identified as a dead end",
    };
  }

  /**
   * Check if task has always succeeded (well-known pattern).
   * Used to skip expensive validation for reliable patterns.
   *
   * @param {object} task - Task to validate
   * @param {object} learningStore - Optional LearningStore instance
   * @returns {{ pass: boolean, reason: string }} Check result
   * @private
   */
  _checkHistoryMatch(task, learningStore) {
    if (!learningStore) {
      return {
        pass: false,
        reason: "No learning store provided",
      };
    }

    const taskType = task.taskType || "unknown";
    const language = task.language || "unknown";
    const framework = task.framework || "unknown";

    const patterns = learningStore.query(taskType, language, framework);

    // If we have an active pattern with high success rate, this is well-known
    if (patterns.length > 0 && patterns[0].count >= 3) {
      return {
        pass: true,
        reason: `Well-known pattern (${patterns[0].count} successful executions)`,
      };
    }

    return {
      pass: false,
      reason: "No established success pattern for this task",
    };
  }

  /**
   * Check if revival conditions for a dead end are met.
   *
   * @param {object} task - Task to validate
   * @param {Array<string>} conditions - Revival conditions to check
   * @returns {boolean} True if conditions are met
   * @private
   */
  _checkRevivalConditions(task, conditions) {
    const description = (task.description || "").toLowerCase();

    // Simple keyword matching for revival conditions
    return conditions.some(condition =>
      description.includes(condition.toLowerCase())
    );
  }
}

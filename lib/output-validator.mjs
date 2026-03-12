/**
 * Output semantic validation
 *
 * Validates that agent output makes semantic sense relative to the input task.
 * Catches common failure modes: out-of-scope changes, empty results, overclaiming.
 */

// ── Severity levels ──────────────────────────────────────────────

export const SEVERITY = {
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
};

// ── Score deductions ─────────────────────────────────────────────

const DEDUCTIONS = {
  [SEVERITY.ERROR]: 0.3,
  [SEVERITY.WARNING]: 0.1,
  [SEVERITY.INFO]: 0,
};

// ── OutputValidator class ────────────────────────────────────────

/**
 * Semantic output validator for agent results.
 * Runs multiple checks and produces a validation score.
 *
 * @example
 * const validator = new OutputValidator();
 * const result = validator.validateAgentOutput(task, output, filesChanged);
 * if (!result.valid) {
 *   console.error("Validation failed:", result.checks);
 * }
 */
export default class OutputValidator {
  /**
   * Validate agent output against task and file changes.
   * Runs all semantic checks and returns validation result.
   *
   * @param {object} task - Task specification { description, targetFiles?, targetDirs? }
   * @param {object} result - Agent result { output, toolCalls? }
   * @param {string[]} filesChanged - List of file paths that were modified
   * @returns {object} Validation result { valid, checks, score }
   */
  validateAgentOutput(task, result, filesChanged) {
    const checks = [
      this._checkScope(task, filesChanged),
      this._checkRelevance(task, filesChanged),
      this._checkDestructiveActions(task, filesChanged, result),
      this._checkEmptyResult(result, filesChanged, result.toolCalls?.length || 0),
      this._checkOverclaim(result),
    ];

    let score = 1.0;
    for (const check of checks) {
      if (!check.passed) {
        score -= DEDUCTIONS[check.severity];
      }
    }

    return {
      valid: score > 0.7,
      checks,
      score: Math.max(0, score),
    };
  }

  // ── Individual validation checks ─────────────────────────────────

  /**
   * Check that files changed overlap with task target files/dirs.
   * @private
   */
  _checkScope(task, filesChanged) {
    // If no target files/dirs specified, pass (can't validate scope)
    if (!task.targetFiles && !task.targetDirs) {
      return {
        name: "scope",
        passed: true,
        severity: SEVERITY.INFO,
        message: "No target files/dirs specified - scope check skipped",
      };
    }

    // If no files changed, this is caught by _checkEmptyResult
    if (filesChanged.length === 0) {
      return {
        name: "scope",
        passed: true,
        severity: SEVERITY.INFO,
        message: "No files changed",
      };
    }

    const targetFiles = task.targetFiles || [];
    const targetDirs = task.targetDirs || [];

    // Check if any changed file matches target files or is within target dirs
    const inScope = filesChanged.some(file => {
      // Direct file match
      if (targetFiles.includes(file)) return true;

      // Directory prefix match
      return targetDirs.some(dir => file.startsWith(dir));
    });

    if (!inScope) {
      return {
        name: "scope",
        passed: false,
        severity: SEVERITY.ERROR,
        message: `Files changed (${filesChanged.join(", ")}) do not overlap with task scope`,
      };
    }

    return {
      name: "scope",
      passed: true,
      severity: SEVERITY.INFO,
      message: "Files changed are within task scope",
    };
  }

  /**
   * Check that if task mentions specific file, it was actually changed.
   * @private
   */
  _checkRelevance(task, filesChanged) {
    const description = task.description || "";

    // Extract file paths from task description (simple heuristic: look for paths with extensions)
    const mentionedFiles = description.match(/[\w/-]+\.\w+/g) || [];

    if (mentionedFiles.length === 0) {
      return {
        name: "relevance",
        passed: true,
        severity: SEVERITY.INFO,
        message: "No specific files mentioned in task",
      };
    }

    // Check if mentioned files were actually changed
    const unchangedFiles = mentionedFiles.filter(file => {
      return !filesChanged.some(changed => changed.includes(file));
    });

    if (unchangedFiles.length > 0) {
      return {
        name: "relevance",
        passed: false,
        severity: SEVERITY.WARNING,
        message: `Task mentioned files (${unchangedFiles.join(", ")}) but they were not changed`,
      };
    }

    return {
      name: "relevance",
      passed: true,
      severity: SEVERITY.INFO,
      message: "All mentioned files were changed",
    };
  }

  /**
   * Check for destructive actions (deleted files) not clearly in task scope.
   * @private
   */
  _checkDestructiveActions(task, filesChanged, result) {
    const output = result.output || "";

    // Look for deletions in output or file list
    const deletionIndicators = [
      /\bdeleted\b.*\.[\w]+/gi,
      /\brm\b.*\.[\w]+/gi,
      /\bremoved\b.*\.[\w]+/gi,
    ];

    let deletedFiles = [];
    for (const pattern of deletionIndicators) {
      const matches = output.match(pattern);
      if (matches) {
        deletedFiles = deletedFiles.concat(matches);
      }
    }

    if (deletedFiles.length === 0) {
      return {
        name: "destructive_actions",
        passed: true,
        severity: SEVERITY.INFO,
        message: "No destructive actions detected",
      };
    }

    // Check if task description mentions deletion/removal
    const taskDescription = (task.description || "").toLowerCase();
    const deletionAuthorized =
      taskDescription.includes("delete") ||
      taskDescription.includes("remove") ||
      taskDescription.includes("clean");

    if (!deletionAuthorized) {
      return {
        name: "destructive_actions",
        passed: false,
        severity: SEVERITY.WARNING,
        message: `Deleted files detected (${deletedFiles.length}) but task did not authorize deletion`,
      };
    }

    return {
      name: "destructive_actions",
      passed: true,
      severity: SEVERITY.INFO,
      message: "Destructive actions authorized by task",
    };
  }

  /**
   * Check for empty result despite many tool calls.
   * @private
   */
  _checkEmptyResult(result, filesChanged, toolCallCount) {
    const output = result.output || "";

    // If many tool calls but no output or file changes, likely failed
    if (toolCallCount >= 5 && output.length < 100 && filesChanged.length === 0) {
      return {
        name: "empty_result",
        passed: false,
        severity: SEVERITY.ERROR,
        message: `Agent made ${toolCallCount} tool calls but produced minimal output and no changes`,
      };
    }

    return {
      name: "empty_result",
      passed: true,
      severity: SEVERITY.INFO,
      message: "Result has sufficient content",
    };
  }

  /**
   * Check for overclaiming (claims without evidence).
   * @private
   */
  _checkOverclaim(result) {
    const output = result.output || "";

    // Common overclaims without evidence
    const overclaimPatterns = [
      { pattern: /\ball tests pass/i, evidence: /\d+\s+tests?\s+passed|✓.*test|PASS\b/i },
      { pattern: /\bsuccessfully built/i, evidence: /build.*success|compiled|Build succeeded/i },
      { pattern: /\bno errors/i, evidence: /0 errors|error.*:.*0/i },
    ];

    const overclaims = [];
    for (const { pattern, evidence } of overclaimPatterns) {
      if (pattern.test(output) && !evidence.test(output)) {
        overclaims.push(pattern.source);
      }
    }

    if (overclaims.length > 0) {
      return {
        name: "overclaim",
        passed: false,
        severity: SEVERITY.WARNING,
        message: `Claims made without evidence: ${overclaims.join(", ")}`,
      };
    }

    return {
      name: "overclaim",
      passed: true,
      severity: SEVERITY.INFO,
      message: "No unsupported claims detected",
    };
  }
}

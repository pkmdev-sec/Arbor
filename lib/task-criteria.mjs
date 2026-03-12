/**
 * Task acceptance criteria generation and evaluation
 *
 * Inspired by Fernis REQ-017. Tasks should have explicit success/failure
 * criteria to guide agents and enable objective evaluation of results.
 *
 * generateCriteria:    Build acceptIf/rejectIf/risks based on task type
 * formatCriteriaForPrompt: Format criteria for agent prompt injection
 * evaluateCriteria:    Assess whether criteria were met post-execution
 */

/**
 * Generate acceptance criteria for a task based on its description and context.
 *
 * @param {object} task - Task object with description, targetFiles, targetDirs, type
 * @param {string} task.description - Task description
 * @param {string[]} [task.targetFiles] - Files that should be modified
 * @param {string[]} [task.targetDirs] - Directories in scope
 * @param {string} [task.type] - Task type: 'bugfix', 'feature', 'refactor', etc.
 * @returns {object} { acceptIf: string[], rejectIf: string[], risks: string[] }
 */
export function generateCriteria(task) {
  if (!task || typeof task !== "object") {
    return { acceptIf: [], rejectIf: [], risks: ["Invalid task object"] };
  }

  const acceptIf = [];
  const rejectIf = [];
  const risks = [];

  // Type-specific acceptance criteria
  const taskType = task.type?.toLowerCase();

  if (taskType === "bugfix") {
    acceptIf.push(
      "Bug reproduction confirmed",
      "Fix addresses root cause",
      "Tests pass after fix"
    );
    risks.push("Fix may introduce regressions in related code");
  } else if (taskType === "feature") {
    acceptIf.push(
      "Feature works as described",
      "Tests added for new code",
      "No regressions"
    );
    risks.push("Feature scope creep can lead to incomplete implementation");
  } else if (taskType === "refactor") {
    acceptIf.push(
      "Behavior unchanged",
      "All tests pass",
      "Code is simpler"
    );
    risks.push("Refactoring may accidentally change behavior");
  } else {
    // Default criteria for unspecified task types
    acceptIf.push(
      "Task objective achieved",
      "No errors introduced",
      "Tests pass"
    );
  }

  // Target file criteria
  if (task.targetFiles && Array.isArray(task.targetFiles) && task.targetFiles.length > 0) {
    acceptIf.push("Target files were modified");

    if (task.targetFiles.length > 5) {
      risks.push("Large change set increases merge conflict risk");
    }
  }

  // Target directory criteria
  if (task.targetDirs && Array.isArray(task.targetDirs) && task.targetDirs.length > 0) {
    acceptIf.push("Changes focused within target directories");
  }

  // Universal rejection criteria
  rejectIf.push(
    "Agent wandered off-scope",
    "Files deleted without authorization",
    "Tests fail"
  );

  // Analyze description for additional risks
  const desc = task.description?.toLowerCase() || "";
  if (desc.includes("database") || desc.includes("schema")) {
    risks.push("Database changes may require migration coordination");
  }
  if (desc.includes("api") || desc.includes("endpoint")) {
    risks.push("API changes may break existing clients");
  }
  if (desc.includes("security") || desc.includes("auth")) {
    risks.push("security changes require extra scrutiny");
  }

  return { acceptIf, rejectIf, risks };
}

/**
 * Format criteria for injection into agent prompt.
 *
 * @param {object} criteria - Output of generateCriteria
 * @param {string[]} criteria.acceptIf - Acceptance conditions
 * @param {string[]} criteria.rejectIf - Rejection conditions
 * @param {string[]} criteria.risks - Known risks
 * @returns {string} Formatted text block for prompt injection
 */
export function formatCriteriaForPrompt(criteria) {
  if (!criteria || typeof criteria !== "object") {
    return "";
  }

  const parts = [];

  if (criteria.acceptIf && criteria.acceptIf.length > 0) {
    parts.push("ACCEPTANCE CRITERIA:");
    parts.push(criteria.acceptIf.map(c => `✓ ${c}`).join("\n"));
  }

  if (criteria.rejectIf && criteria.rejectIf.length > 0) {
    parts.push("\nREJECTION CRITERIA:");
    parts.push(criteria.rejectIf.map(c => `✗ ${c}`).join("\n"));
  }

  if (criteria.risks && criteria.risks.length > 0) {
    parts.push("\nKNOWN RISKS:");
    parts.push(criteria.risks.map(r => `⚠ ${r}`).join("\n"));
  }

  return parts.join("\n");
}

/**
 * Evaluate whether criteria were met based on agent result.
 *
 * @param {object} criteria - Acceptance criteria to evaluate against
 * @param {object} result - Agent result with output, filesChanged, testsPassed, etc.
 * @param {string} [result.output] - Agent output text
 * @param {string[]} [result.filesChanged] - Files modified by agent
 * @param {boolean} [result.testsPassed] - Whether tests passed
 * @param {string} [result.error] - Error message if any
 * @returns {{ met: string[], unmet: string[], score: number }}
 */
export function evaluateCriteria(criteria, result) {
  if (!criteria || typeof criteria !== "object") {
    return { met: [], unmet: [], score: 0 };
  }
  if (!result || typeof result !== "object") {
    return { met: [], unmet: criteria.acceptIf || [], score: 0 };
  }

  const met = [];
  const unmet = [];

  const acceptIf = criteria.acceptIf || [];
  const rejectIf = criteria.rejectIf || [];

  const output = result.output?.toLowerCase() || "";
  const filesChanged = result.filesChanged || [];
  const testsPassed = result.testsPassed === true;
  const hasError = result.error !== undefined && result.error !== null;

  // Evaluate acceptIf criteria
  for (const criterion of acceptIf) {
    const lower = criterion.toLowerCase();
    let isMet = false;

    if (lower.includes("tests pass") || lower.includes("tests added")) {
      isMet = testsPassed;
    } else if (lower.includes("target files") && lower.includes("modified")) {
      // Check if any files were changed
      isMet = filesChanged.length > 0;
    } else if (lower.includes("no errors")) {
      isMet = !hasError;
    } else if (lower.includes("bug reproduction") || lower.includes("feature works") || lower.includes("behavior unchanged")) {
      // These require output analysis
      isMet = output.length > 0 && !hasError;
    } else if (lower.includes("objective achieved")) {
      isMet = !hasError && (filesChanged.length > 0 || output.length > 100);
    } else if (lower.includes("code is simpler")) {
      // Heuristic: if refactor succeeded without errors
      isMet = testsPassed && filesChanged.length > 0;
    } else if (lower.includes("focused within target")) {
      // If we don't have targetDirs info, assume met if files changed
      isMet = filesChanged.length > 0;
    } else if (lower.includes("no regressions")) {
      isMet = testsPassed;
    } else if (lower.includes("root cause")) {
      // Heuristic: check if output mentions fix/fixed/resolved
      isMet = /\b(fix|fixed|resolved|addressed)\b/i.test(output);
    } else {
      // Default: check if criterion keywords appear in output
      const keywords = lower.split(/\s+/).filter(w => w.length > 3);
      isMet = keywords.some(kw => output.includes(kw));
    }

    if (isMet) {
      met.push(criterion);
    } else {
      unmet.push(criterion);
    }
  }

  // Check rejectIf criteria (any violation is bad)
  for (const criterion of rejectIf) {
    const lower = criterion.toLowerCase();
    let isViolated = false;

    if (lower.includes("tests fail")) {
      isViolated = !testsPassed && result.testsPassed !== undefined;
    } else if (lower.includes("deleted without authorization")) {
      // Heuristic: look for deletion patterns in output
      isViolated = /\b(deleted?|removed?|rmdir|unlink)\b/i.test(output);
    } else if (lower.includes("wandered off-scope") || lower.includes("off-scope")) {
      // Heuristic: excessive file count or error mentions scope
      isViolated = filesChanged.length > 10 || /scope/i.test(output);
    }

    if (isViolated) {
      unmet.push(`VIOLATED: ${criterion}`);
    }
  }

  // Calculate score: met / (met + unmet)
  const total = met.length + unmet.length;
  const score = total > 0 ? met.length / total : 0;

  return { met, unmet, score };
}

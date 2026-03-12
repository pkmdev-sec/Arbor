/**
 * Per-Agent Tool Allowlists
 *
 * Each agent type gets only the tools it needs — 225 tokens of minimal tool
 * docs outperform 18,000 tokens of full schemas (inspired by Fernis REQ-010).
 *
 * @module tool-allowlists
 */

/** Tool allowlists by task/role type */
export const TOOL_ALLOWLISTS = {
  research:       ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  implementation: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  testing:        ['Read', 'Bash', 'Grep', 'Glob'],
  review:         ['Read', 'Grep', 'Glob', 'Bash'],
  debugging:      ['Read', 'Grep', 'Glob', 'Bash', 'Edit'],
  verification:   ['Read', 'Grep', 'Glob', 'Bash'],
  decomposition:  ['Read', 'Grep', 'Glob'],
  default:        ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
};

/**
 * Infer task type from description if not explicitly set
 *
 * @param {string} description - Task description
 * @returns {string} Inferred task type
 */
export function inferTaskType(description) {
  if (!description || typeof description !== 'string') {
    return 'default';
  }

  const lower = description.toLowerCase();

  // Research patterns
  if (/\b(research|explore|analyze|find|search|investigate)\b/.test(lower)) {
    return 'research';
  }

  // Testing patterns
  if (/\b(test|verify|check|validate)\b/.test(lower)) {
    return 'testing';
  }

  // Review patterns
  if (/\b(review|audit|assess)\b/.test(lower)) {
    return 'review';
  }

  // Debugging patterns
  if (/\b(debug|fix bug|diagnose|troubleshoot)\b/.test(lower)) {
    return 'debugging';
  }

  // Implementation patterns
  if (/\b(refactor|implement|build|create|add|write)\b/.test(lower)) {
    return 'implementation';
  }

  // Decomposition patterns
  if (/\b(decompose|break down|plan)\b/.test(lower)) {
    return 'decomposition';
  }

  return 'default';
}

/**
 * Get the appropriate tool allowlist for a given task
 *
 * @param {object} task - Task object with optional type and description
 * @param {string} [task.type] - Explicit task type
 * @param {string} [task.description] - Task description for inference
 * @returns {string[]} List of allowed tool names
 */
export function getToolsForTask(task) {
  if (!task || typeof task !== 'object') {
    return TOOL_ALLOWLISTS.default;
  }

  // Use explicit type if provided
  if (task.type && TOOL_ALLOWLISTS[task.type]) {
    return TOOL_ALLOWLISTS[task.type];
  }

  // Otherwise infer from description
  if (task.description) {
    const inferredType = inferTaskType(task.description);
    return TOOL_ALLOWLISTS[inferredType];
  }

  return TOOL_ALLOWLISTS.default;
}

/**
 * Format allowlist as --allowedTools CLI flag value
 *
 * @param {string[]} tools - List of tool names
 * @returns {string} Comma-separated tool names
 */
export function formatAllowedTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  return tools.join(',');
}

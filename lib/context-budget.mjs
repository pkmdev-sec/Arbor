/**
 * Context Budget System
 *
 * Enforces the 40% context utilization rule for agent prompts.
 * Prevents context window overflow by tracking token allocations
 * across system prompts, task descriptions, code context, and tool definitions.
 */

// ── Constants ────────────────────────────────────────────────────

/** Maximum context window size in tokens */
export const MAX_TOKENS = 1_000_000;

/** Target utilization ratio (40% of context window) */
export const TARGET_UTILIZATION = 0.40;

/** Total budget in tokens (40% of 1M = 400K) */
export const BUDGET = 400_000;

// ── Component allocation percentages ─────────────────────────────

/** Component budget allocations as fractions of total budget */
export const COMPONENT_ALLOCATIONS = {
  system_prompt:   0.10,  // 40K tokens - role prompts, execution protocol
  task:            0.05,  // 20K tokens - user task description
  code_context:    0.50,  // 200K tokens - file contents, diffs, grep results
  prior_results:   0.15,  // 60K tokens - outputs from completed subtasks
  tools:           0.05,  // 20K tokens - MCP tool definitions
  response_format: 0.05,  // 20K tokens - JSON schemas, output format specs
  reserve:         0.10,  // 40K tokens - safety margin for overhead
};

// ── ContextBudget class ──────────────────────────────────────────

/**
 * Context budget tracker for managing token allocations across components.
 * Enforces the 40% context utilization rule to prevent window overflow.
 *
 * @example
 * const budget = new ContextBudget();
 * const systemPrompt = budget.allocate("system_prompt", longPromptText);
 * const codeContext = budget.allocate("code_context", fileContents, 0.8);
 * console.log(budget.utilizationPct()); // → 25.3%
 */
export default class ContextBudget {
  constructor() {
    /** @type {Map<string, number>} Component name → tokens allocated */
    this.allocations = new Map();
  }

  /**
   * Estimate token count from text using 4 chars/token heuristic.
   * Consistent with Claude API's conservative estimate.
   *
   * @param {string} text - Text to estimate tokens for
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (typeof text !== "string") return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Allocate text to a budget component. Truncates if over budget.
   * Tracks allocation and returns the (possibly truncated) text.
   *
   * @param {string} component - Component name (must exist in COMPONENT_ALLOCATIONS)
   * @param {string} text - Text to allocate
   * @param {number} [maxShare=1.0] - Max fraction of component budget to use (0.0-1.0)
   * @returns {string} Text, truncated if necessary to fit budget
   * @throws {Error} If component is not recognized
   */
  allocate(component, text, maxShare = 1.0) {
    if (!(component in COMPONENT_ALLOCATIONS)) {
      throw new Error(`Unknown component: ${component}`);
    }

    if (maxShare < 0 || maxShare > 1.0) {
      throw new Error(`maxShare must be between 0 and 1, got ${maxShare}`);
    }

    const tokens = this.estimateTokens(text);
    const componentBudget = BUDGET * COMPONENT_ALLOCATIONS[component];
    const allowedTokens = Math.floor(componentBudget * maxShare);

    let finalText = text;
    let finalTokens = tokens;

    // Truncate if over budget
    if (tokens > allowedTokens) {
      const charsAllowed = Math.floor(allowedTokens * 4);
      finalText = text.slice(0, charsAllowed);
      finalTokens = allowedTokens;
    }

    // Track allocation
    this.allocations.set(component, finalTokens);

    return finalText;
  }

  /**
   * Get total tokens allocated across all components.
   *
   * @returns {number} Total allocated tokens
   */
  totalAllocated() {
    let total = 0;
    for (const tokens of this.allocations.values()) {
      total += tokens;
    }
    return total;
  }

  /**
   * Get current utilization as percentage of total budget.
   *
   * @returns {number} Utilization percentage (0-100+)
   */
  utilizationPct() {
    return (this.totalAllocated() / BUDGET) * 100;
  }

  /**
   * Reset all allocations. Call at start of new agent execution.
   */
  reset() {
    this.allocations.clear();
  }
}

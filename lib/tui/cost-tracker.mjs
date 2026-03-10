/**
 * CostTracker — Estimate API costs from model type and tool call heuristics.
 *
 * Since we don't have exact token counts in progress files, we estimate:
 * - ~800 input tokens per tool call (tool prompt + context)
 * - ~400 output tokens per tool call (tool response + reasoning)
 * - ~2000 base tokens per agent (system prompt, task description)
 *
 * Pricing (per 1M tokens):
 *   Sonnet 4.6:  $3 input, $15 output
 *   Opus 4.6:    $15 input, $75 output
 */

// ── Pricing table ─────────────────────────────────────────────────

const PRICING = {
  // model alias → { inputPerM, outputPerM }
  'sonnet':                        { inputPerM: 3,  outputPerM: 15 },
  'claude-sonnet-4-6':             { inputPerM: 3,  outputPerM: 15 },
  'claude-sonnet-4-6[1m]':        { inputPerM: 3,  outputPerM: 15 },
  'opus':                          { inputPerM: 15, outputPerM: 75 },
  'claude-opus-4-6':               { inputPerM: 15, outputPerM: 75 },
  'claude-opus-4-6[1m]':          { inputPerM: 15, outputPerM: 75 },
};

// ── Heuristic constants ───────────────────────────────────────────

const INPUT_TOKENS_PER_TOOL_CALL  = 800;
const OUTPUT_TOKENS_PER_TOOL_CALL = 400;
const BASE_INPUT_TOKENS           = 2000;
const BASE_OUTPUT_TOKENS          = 500;

// ── Cost estimation ───────────────────────────────────────────────

/**
 * Look up pricing for a model string.
 * @param {string} model - Model name or alias
 * @returns {{ inputPerM: number, outputPerM: number }}
 */
function getPricing(model) {
  if (!model) return PRICING['sonnet'];
  const key = model.toLowerCase().replace(/\s+/g, '');
  return PRICING[key] || PRICING['sonnet'];
}

/**
 * Estimate cost for a single agent.
 *
 * @param {object} opts
 * @param {string} opts.model      - Model name
 * @param {number} opts.toolCalls  - Number of tool calls made
 * @returns {{ inputTokens: number, outputTokens: number, cost: number }}
 */
export function estimateAgentCost({ model, toolCalls = 0 }) {
  const pricing = getPricing(model);

  const inputTokens  = BASE_INPUT_TOKENS + (toolCalls * INPUT_TOKENS_PER_TOOL_CALL);
  const outputTokens = BASE_OUTPUT_TOKENS + (toolCalls * OUTPUT_TOKENS_PER_TOOL_CALL);

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerM +
    (outputTokens / 1_000_000) * pricing.outputPerM;

  return { inputTokens, outputTokens, cost };
}

/**
 * Estimate total cost across all agents.
 *
 * @param {Array<{ model: string, toolCalls: number }>} agents
 * @returns {{ totalCost: number, perAgent: Array<{ id: string, cost: number }> }}
 */
export function estimateTotalCost(agents) {
  let totalCost = 0;
  const perAgent = [];

  for (const agent of agents) {
    const est = estimateAgentCost({
      model: agent.model,
      toolCalls: agent.toolCalls || 0,
    });
    totalCost += est.cost;
    perAgent.push({ id: agent.id, cost: est.cost });
  }

  return { totalCost, perAgent };
}

/**
 * Format a cost number as a dollar string.
 * @param {number} cost
 * @returns {string} e.g., "$0.024" or "$1.23"
 */
export function formatCost(cost) {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

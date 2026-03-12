/**
 * P2-D: Smart Model Routing Refinement
 *
 * Inspired by Fernis REQ-003. Route by task complexity — simple tasks to
 * cheaper models, complex tasks to deep models. Tracks cost savings.
 *
 * Usage:
 *   import { routeModel, calculateSavings } from "./model-router.mjs";
 *   const decision = routeModel({ type: 'implementation', description: 'Add login button' });
 *   console.log(`Using ${decision.model}: ${decision.reason}`);
 */

// ── Model cost tiers (input $/M tokens) ──────────────────────────

export const MODEL_TIERS = {
  fast:   { model: 'haiku',      cost: 0.001,  maxComplexity: 'simple' },
  standard: { model: 'sonnet[1m]', cost: 0.003, maxComplexity: 'moderate' },
  deep:   { model: 'opus[1m]',   cost: 0.015,  maxComplexity: 'complex' },
};

// ── Complexity estimation ────────────────────────────────────────

/**
 * Estimate task complexity from description and context.
 * @param {object} task - { type?, description?, targetFiles?, complexity? }
 * @returns {'simple'|'moderate'|'complex'}
 */
export function estimateComplexity(task) {
  if (!task || typeof task !== 'object') return 'moderate';

  // If complexity is explicitly provided, trust it
  if (task.complexity) return task.complexity;

  const description = task.description ?? '';
  const targetFiles = task.targetFiles ?? [];
  const type = task.type ?? '';

  // Complex: >5 files, architecture changes, security-sensitive, multi-system, debugging race conditions
  if (targetFiles.length > 5) return 'complex';
  if (/security|auth|crypto|race|concurrency|architecture|refactor|migration/i.test(description)) return 'complex';
  if (/security|auth|architecture|migration|refactor/i.test(type)) return 'complex';

  // Moderate: 2-5 files, standard implementation, refactoring, testing
  if (targetFiles.length >= 2 && targetFiles.length <= 5) return 'moderate';

  // Simple: single file, grep/search task, config change, < 30 chars description
  if (targetFiles.length === 1) return 'simple';
  if (/^(grep|search|find|read|config|typo|doc)/i.test(type)) return 'simple';
  if (description.length < 30) return 'simple';

  // Default: moderate
  return 'moderate';
}

// ── Model routing ────────────────────────────────────────────────

/**
 * Select optimal model for a task based on complexity.
 * @param {object} task - { type?, description?, targetFiles?, complexity? }
 * @param {object} options - { defaultModel?, costBudget?, forceModel? }
 * @returns {{ model: string, reason: string, estimatedCost: number }}
 */
export function routeModel(task, options = {}) {
  if (!task || typeof task !== 'object') {
    return { model: 'sonnet[1m]', reason: 'default fallback', estimatedCost: 0.003 };
  }

  const { defaultModel, costBudget, forceModel } = options;

  // Override: force model if specified
  if (forceModel) {
    const tier = Object.values(MODEL_TIERS).find(t => t.model === forceModel);
    const cost = tier ? tier.cost : 0.003;
    return { model: forceModel, reason: 'forced by options', estimatedCost: cost };
  }

  const type = task.type ?? '';
  const complexity = estimateComplexity(task);

  // Type-based routing rules
  if (type === 'research' || type === 'decomposition') {
    return { model: MODEL_TIERS.standard.model, reason: 'research/decomposition → standard', estimatedCost: MODEL_TIERS.standard.cost };
  }

  if (type === 'verification' || type === 'review') {
    // Check cost budget for deep model
    if (costBudget !== undefined && costBudget < MODEL_TIERS.deep.cost) {
      return { model: MODEL_TIERS.standard.model, reason: 'cost budget insufficient for deep, downgraded to standard', estimatedCost: MODEL_TIERS.standard.cost };
    }
    return { model: MODEL_TIERS.deep.model, reason: 'verification/review → deep', estimatedCost: MODEL_TIERS.deep.cost };
  }

  // Complexity-based routing
  if (complexity === 'simple') {
    return { model: MODEL_TIERS.fast.model, reason: 'simple complexity → fast', estimatedCost: MODEL_TIERS.fast.cost };
  }

  if (complexity === 'complex') {
    // Check cost budget for deep model
    if (costBudget !== undefined && costBudget < MODEL_TIERS.deep.cost) {
      return { model: MODEL_TIERS.standard.model, reason: 'complex task but cost budget insufficient, downgraded to standard', estimatedCost: MODEL_TIERS.standard.cost };
    }
    return { model: MODEL_TIERS.deep.model, reason: 'complex complexity → deep', estimatedCost: MODEL_TIERS.deep.cost };
  }

  // Default: moderate complexity → standard
  return { model: MODEL_TIERS.standard.model, reason: 'moderate complexity → standard', estimatedCost: MODEL_TIERS.standard.cost };
}

// ── Cost tracking ────────────────────────────────────────────────

/**
 * Calculate cost savings from routing vs using default model for all tasks.
 * @param {Array} routingDecisions - Array of routeModel results
 * @param {string} defaultModel - What would have been used without routing
 * @returns {{ totalCost: number, defaultCost: number, savings: number, savingsPct: number }}
 */
export function calculateSavings(routingDecisions, defaultModel) {
  if (!Array.isArray(routingDecisions) || routingDecisions.length === 0) {
    return { totalCost: 0, defaultCost: 0, savings: 0, savingsPct: 0 };
  }

  const defaultTier = Object.values(MODEL_TIERS).find(t => t.model === defaultModel);
  const defaultCostPerTask = defaultTier ? defaultTier.cost : 0.003;

  const totalCost = routingDecisions.reduce((sum, d) => sum + (d.estimatedCost ?? 0), 0);
  const defaultCost = routingDecisions.length * defaultCostPerTask;
  const savings = defaultCost - totalCost;
  const savingsPct = defaultCost > 0 ? (savings / defaultCost) * 100 : 0;

  return {
    totalCost: Math.round(totalCost * 1000000) / 1000000, // Round to 6 decimals
    defaultCost: Math.round(defaultCost * 1000000) / 1000000,
    savings: Math.round(savings * 1000000) / 1000000,
    savingsPct: Math.round(savingsPct * 100) / 100, // Round to 2 decimals
  };
}

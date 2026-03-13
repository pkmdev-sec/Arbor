/**
 * Tests for Model Router
 *
 * Tests intelligent model selection based on task complexity and cost optimization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_TIERS, estimateComplexity, routeModel, calculateSavings } from "../lib/model-router.mjs";

// ── MODEL_TIERS constant ─────────────────────────────────────────

describe("MODEL_TIERS", () => {
  it("defines three tiers with correct structure", () => {
    assert.ok(MODEL_TIERS.fast);
    assert.ok(MODEL_TIERS.standard);
    assert.ok(MODEL_TIERS.deep);

    assert.equal(MODEL_TIERS.fast.model, 'haiku');
    assert.equal(MODEL_TIERS.standard.model, 'sonnet[1m]');
    assert.equal(MODEL_TIERS.deep.model, 'opus[1m]');

    assert.ok(MODEL_TIERS.fast.cost < MODEL_TIERS.standard.cost);
    assert.ok(MODEL_TIERS.standard.cost < MODEL_TIERS.deep.cost);
  });
});

// ── estimateComplexity() ─────────────────────────────────────────

describe("estimateComplexity()", () => {
  it("returns 'moderate' for null or invalid input", () => {
    assert.equal(estimateComplexity(null), 'moderate');
    assert.equal(estimateComplexity('string'), 'moderate');
    assert.equal(estimateComplexity(undefined), 'moderate');
  });

  it("trusts explicitly provided complexity", () => {
    assert.equal(estimateComplexity({ complexity: 'simple' }), 'simple');
    assert.equal(estimateComplexity({ complexity: 'complex' }), 'complex');
  });

  it("estimates 'simple' for short descriptions", () => {
    assert.equal(estimateComplexity({ description: 'Fix typo' }), 'simple');
    assert.equal(estimateComplexity({ description: 'Update doc' }), 'simple');
  });

  it("estimates 'simple' for single file", () => {
    assert.equal(estimateComplexity({ targetFiles: ['src/auth.ts'], description: 'Add method to handle login' }), 'simple');
  });

  it("estimates 'simple' for search/grep tasks", () => {
    assert.equal(estimateComplexity({ type: 'grep', description: 'Search for API calls' }), 'simple');
    assert.equal(estimateComplexity({ type: 'search', description: 'Find all imports' }), 'simple');
  });

  it("estimates 'complex' for >5 files", () => {
    const task = {
      targetFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      description: 'Refactor module',
    };
    assert.equal(estimateComplexity(task), 'complex');
  });

  it("estimates 'complex' for security/architecture keywords", () => {
    assert.equal(estimateComplexity({ description: 'Implement security audit' }), 'complex');
    assert.equal(estimateComplexity({ description: 'Fix race condition in handler' }), 'complex');
    assert.equal(estimateComplexity({ description: 'Refactor architecture' }), 'complex');
    assert.equal(estimateComplexity({ type: 'security' }), 'complex');
  });

  it("estimates 'moderate' for 2-5 files", () => {
    const task = {
      targetFiles: ['a.ts', 'b.ts', 'c.ts'],
      description: 'Update API endpoints',
    };
    assert.equal(estimateComplexity(task), 'moderate');
  });

  it("estimates 'moderate' for standard implementation", () => {
    assert.equal(estimateComplexity({ description: 'Implement user profile page with form validation' }), 'moderate');
  });
});

// ── routeModel() ─────────────────────────────────────────────────

describe("routeModel()", () => {
  it("returns default fallback for null or invalid input", () => {
    const result = routeModel(null);
    assert.equal(result.model, 'sonnet[1m]');
    assert.equal(result.reason, 'default fallback');
  });

  it("uses forceModel when specified", () => {
    const result = routeModel(
      { type: 'implementation', description: 'Complex task' },
      { forceModel: 'haiku' }
    );
    assert.equal(result.model, 'haiku');
    assert.equal(result.reason, 'forced by options');
  });

  it("routes research tasks to standard model", () => {
    const result = routeModel({ type: 'research', description: 'Investigate API' });
    assert.equal(result.model, 'sonnet[1m]');
    assert.ok(result.reason.includes('research'));
  });

  it("routes decomposition tasks to standard model", () => {
    const result = routeModel({ type: 'decomposition', description: 'Break down feature' });
    assert.equal(result.model, 'sonnet[1m]');
    assert.ok(result.reason.includes('decomposition'));
  });

  it("routes verification tasks to deep model", () => {
    const result = routeModel({ type: 'verification', description: 'Verify implementation' });
    assert.equal(result.model, 'opus[1m]');
    assert.ok(result.reason.includes('verification'));
  });

  it("routes review tasks to deep model", () => {
    const result = routeModel({ type: 'review', description: 'Review code changes' });
    assert.equal(result.model, 'opus[1m]');
    assert.ok(result.reason.includes('review'));
  });

  it("routes simple complexity to fast model", () => {
    const result = routeModel({ description: 'Fix typo', complexity: 'simple' });
    assert.equal(result.model, 'haiku');
    assert.ok(result.reason.includes('simple'));
  });

  it("routes moderate complexity to standard model", () => {
    const result = routeModel({ description: 'Implement login endpoint', complexity: 'moderate' });
    assert.equal(result.model, 'sonnet[1m]');
    assert.ok(result.reason.includes('moderate'));
  });

  it("routes complex complexity to deep model", () => {
    const result = routeModel({ description: 'Refactor architecture', complexity: 'complex' });
    assert.equal(result.model, 'opus[1m]');
    assert.ok(result.reason.includes('complex'));
  });

  it("downgrades deep model when cost budget insufficient", () => {
    const result = routeModel(
      { type: 'verification', description: 'Verify code' },
      { costBudget: 0.005 }
    );
    assert.equal(result.model, 'sonnet[1m]');
    assert.ok(result.reason.includes('cost budget insufficient'));
  });

  it("downgrades complex task when cost budget insufficient", () => {
    const result = routeModel(
      { description: 'Complex security audit', complexity: 'complex' },
      { costBudget: 0.005 }
    );
    assert.equal(result.model, 'sonnet[1m]');
    assert.ok(result.reason.includes('cost budget insufficient'));
  });

  it("includes estimatedCost in result", () => {
    const result = routeModel({ description: 'Fix typo', complexity: 'simple' });
    assert.ok(result.estimatedCost > 0);
    assert.equal(result.estimatedCost, MODEL_TIERS.fast.cost);
  });

  it("uses estimateComplexity when complexity not provided", () => {
    const result = routeModel({ description: 'Fix typo in config' });
    assert.equal(result.model, 'haiku'); // Should be simple
  });
});

// ── calculateSavings() ───────────────────────────────────────────

describe("calculateSavings()", () => {
  it("returns zero savings for empty array", () => {
    const result = calculateSavings([], 'sonnet[1m]');
    assert.deepStrictEqual(result, {
      totalCost: 0,
      defaultCost: 0,
      savings: 0,
      savingsPct: 0,
    });
  });

  it("returns zero savings for null input", () => {
    const result = calculateSavings(null, 'sonnet[1m]');
    assert.deepStrictEqual(result, {
      totalCost: 0,
      defaultCost: 0,
      savings: 0,
      savingsPct: 0,
    });
  });

  it("calculates savings when using mixed models vs all default", () => {
    const decisions = [
      { model: 'haiku', estimatedCost: 0.001 },
      { model: 'haiku', estimatedCost: 0.001 },
      { model: 'sonnet[1m]', estimatedCost: 0.003 },
    ];

    const result = calculateSavings(decisions, 'sonnet[1m]');
    assert.equal(result.totalCost, 0.005);
    assert.equal(result.defaultCost, 0.009); // 3 tasks * 0.003
    assert.equal(result.savings, 0.004);
    assert.ok(result.savingsPct > 40 && result.savingsPct < 45); // ~44.44%
  });

  it("calculates negative savings when using more expensive models", () => {
    const decisions = [
      { model: 'opus[1m]', estimatedCost: 0.015 },
      { model: 'opus[1m]', estimatedCost: 0.015 },
    ];

    const result = calculateSavings(decisions, 'haiku');
    assert.equal(result.totalCost, 0.030);
    assert.equal(result.defaultCost, 0.002); // 2 tasks * 0.001
    assert.equal(result.savings, -0.028);
    assert.ok(result.savingsPct < 0);
  });

  it("handles unknown default model with fallback cost", () => {
    const decisions = [
      { model: 'haiku', estimatedCost: 0.001 },
    ];

    const result = calculateSavings(decisions, 'unknown-model');
    assert.equal(result.totalCost, 0.001);
    assert.equal(result.defaultCost, 0.003); // Fallback to 0.003
  });

  it("rounds costs to 6 decimals and percentage to 2 decimals", () => {
    const decisions = [
      { model: 'haiku', estimatedCost: 0.001 },
      { model: 'haiku', estimatedCost: 0.001 },
      { model: 'haiku', estimatedCost: 0.001 },
    ];

    const result = calculateSavings(decisions, 'sonnet[1m]');
    // 3 * 0.001 = 0.003 total, 3 * 0.003 = 0.009 default
    // savings = 0.006, savingsPct = 66.666...%
    assert.equal(result.savingsPct, 66.67);
  });
});

// ── Integration tests ────────────────────────────────────────────

describe("Integration: routeModel + calculateSavings", () => {
  it("demonstrates cost savings from smart routing", () => {
    const tasks = [
      { description: 'Fix typo in README' },
      { description: 'Add login button' },
      { description: 'Update config file' },
      { description: 'Add validation to form field' },
    ];

    const decisions = tasks.map(task => routeModel(task));

    // Verify routing decisions - all should be simple/fast (haiku)
    assert.equal(decisions[0].model, 'haiku'); // Simple task
    assert.equal(decisions[1].model, 'haiku'); // Simple task
    assert.equal(decisions[2].model, 'haiku'); // Simple task
    assert.equal(decisions[3].model, 'haiku'); // Simple task

    const savings = calculateSavings(decisions, 'sonnet[1m]');
    // 4 * 0.001 = 0.004 (haiku) vs 4 * 0.003 = 0.012 (sonnet) = 0.008 savings
    assert.ok(savings.savings > 0, 'Should have positive savings');
    assert.ok(savings.savings > 0.007, 'Should save at least 0.007');
  });

  it("respects cost budget constraints", () => {
    const tasks = [
      { type: 'verification', description: 'Verify implementation' },
      { complexity: 'complex', description: 'Complex task' },
    ];

    const decisionsWithBudget = tasks.map(task => routeModel(task, { costBudget: 0.005 }));

    // Both should be downgraded to standard due to budget
    assert.equal(decisionsWithBudget[0].model, 'sonnet[1m]');
    assert.equal(decisionsWithBudget[1].model, 'sonnet[1m]');
  });
});

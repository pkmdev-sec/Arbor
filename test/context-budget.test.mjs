/**
 * Tests for Context Budget Manager
 *
 * Tests token budget tracking, estimation, and enforcement for LLM context management.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ContextBudget, {
  MAX_TOKENS,
  TARGET_UTILIZATION,
  BUDGET,
  COMPONENT_ALLOCATIONS,
} from "../lib/context-budget.mjs";

describe("ContextBudget constants", () => {
  it("MAX_TOKENS is 1,000,000", () => {
    assert.equal(MAX_TOKENS, 1_000_000);
  });

  it("TARGET_UTILIZATION is 0.40 (40%)", () => {
    assert.equal(TARGET_UTILIZATION, 0.40);
  });

  it("BUDGET is 400,000 (40% of 1M)", () => {
    assert.equal(BUDGET, 400_000);
  });

  it("COMPONENT_ALLOCATIONS sum to 1.0", () => {
    const sum = Object.values(COMPONENT_ALLOCATIONS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.0001, `Expected sum ~1.0, got ${sum}`);
  });
});

describe("ContextBudget.estimateTokens", () => {
  it("estimates tokens using 4 chars/token heuristic", () => {
    const budget = new ContextBudget();
    assert.equal(budget.estimateTokens("1234"), 1);
    assert.equal(budget.estimateTokens("12345678"), 2);
    assert.equal(budget.estimateTokens("123456789"), 3);
  });

  it("rounds up fractional tokens", () => {
    const budget = new ContextBudget();
    assert.equal(budget.estimateTokens("123"), 1); // 0.75 → 1
    assert.equal(budget.estimateTokens("12345"), 2); // 1.25 → 2
  });

  it("handles empty string", () => {
    const budget = new ContextBudget();
    assert.equal(budget.estimateTokens(""), 0);
  });

  it("handles non-string input", () => {
    const budget = new ContextBudget();
    assert.equal(budget.estimateTokens(null), 0);
    assert.equal(budget.estimateTokens(undefined), 0);
  });
});

describe("ContextBudget.allocate", () => {
  it("allocates text within budget", () => {
    const budget = new ContextBudget();
    const text = "a".repeat(1000); // 250 tokens
    const result = budget.allocate("system_prompt", text);

    assert.equal(result, text);
    assert.equal(budget.allocations.get("system_prompt"), 250);
  });

  it("truncates text exceeding component budget", () => {
    const budget = new ContextBudget();
    // system_prompt budget = 40K tokens = 160K chars
    const text = "a".repeat(200_000); // 50K tokens, exceeds 40K budget
    const result = budget.allocate("system_prompt", text);

    assert.ok(result.length < text.length, "Text should be truncated");
    assert.equal(result.length, 160_000); // 40K tokens * 4 chars/token
  });

  it("respects maxShare parameter", () => {
    const budget = new ContextBudget();
    const text = "a".repeat(100_000); // 25K tokens
    const result = budget.allocate("code_context", text, 0.1); // Use only 10% of budget

    // code_context budget = 200K tokens, 10% = 20K tokens = 80K chars
    assert.ok(result.length <= 80_000, `Expected ≤80K chars, got ${result.length}`);
  });

  it("throws on unknown component", () => {
    const budget = new ContextBudget();
    assert.throws(
      () => budget.allocate("unknown_component", "text"),
      /Unknown component/
    );
  });

  it("throws on invalid maxShare", () => {
    const budget = new ContextBudget();
    assert.throws(
      () => budget.allocate("system_prompt", "text", 1.5),
      /maxShare must be between 0 and 1/
    );
    assert.throws(
      () => budget.allocate("system_prompt", "text", -0.1),
      /maxShare must be between 0 and 1/
    );
  });
});

describe("ContextBudget.totalAllocated", () => {
  it("returns 0 for empty budget", () => {
    const budget = new ContextBudget();
    assert.equal(budget.totalAllocated(), 0);
  });

  it("sums allocations across components", () => {
    const budget = new ContextBudget();
    budget.allocate("system_prompt", "a".repeat(4000)); // 1K tokens
    budget.allocate("task", "b".repeat(8000)); // 2K tokens
    budget.allocate("code_context", "c".repeat(12000)); // 3K tokens

    assert.equal(budget.totalAllocated(), 6000); // 1K + 2K + 3K
  });
});

describe("ContextBudget.utilizationPct", () => {
  it("returns 0% for empty budget", () => {
    const budget = new ContextBudget();
    assert.equal(budget.utilizationPct(), 0);
  });

  it("calculates utilization percentage", () => {
    const budget = new ContextBudget();
    budget.allocate("system_prompt", "a".repeat(160_000)); // 40K tokens = 10% of 400K budget

    assert.ok(Math.abs(budget.utilizationPct() - 10) < 0.1,
      `Expected ~10%, got ${budget.utilizationPct()}%`);
  });

  it("allocates to multiple components up to their budgets", () => {
    const budget = new ContextBudget();
    budget.allocate("system_prompt", "a".repeat(200_000)); // Requests 50K tokens, gets 40K (budget limit)
    budget.allocate("code_context", "b".repeat(800_000)); // Requests 200K tokens, gets 200K (budget limit)

    // system_prompt budget = 40K, code_context budget = 200K, total = 240K
    assert.ok(budget.totalAllocated() <= BUDGET,
      `Expected ≤${BUDGET} tokens, got ${budget.totalAllocated()}`);
    assert.ok(budget.utilizationPct() > 50,
      `Expected >50%, got ${budget.utilizationPct()}%`);
  });
});

describe("ContextBudget.reset", () => {
  it("clears all allocations", () => {
    const budget = new ContextBudget();
    budget.allocate("system_prompt", "a".repeat(4000));
    budget.allocate("task", "b".repeat(8000));

    assert.ok(budget.totalAllocated() > 0);

    budget.reset();

    assert.equal(budget.totalAllocated(), 0);
    assert.equal(budget.utilizationPct(), 0);
  });
});

describe("ContextBudget integration", () => {
  it("enforces 40% rule across typical agent prompt", () => {
    const budget = new ContextBudget();

    // Simulate typical agent prompt components
    const systemPrompt = "a".repeat(30_000); // ~7.5K tokens
    const taskDesc = "b".repeat(10_000); // ~2.5K tokens
    const codeContext = "c".repeat(300_000); // ~75K tokens
    const priorResults = "d".repeat(50_000); // ~12.5K tokens

    budget.allocate("system_prompt", systemPrompt);
    budget.allocate("task", taskDesc);
    budget.allocate("code_context", codeContext);
    budget.allocate("prior_results", priorResults);

    // Total should be under 400K budget (40% rule)
    assert.ok(budget.totalAllocated() <= BUDGET,
      `Expected ≤${BUDGET} tokens, got ${budget.totalAllocated()}`);

    assert.ok(budget.utilizationPct() <= 100,
      `Expected ≤100%, got ${budget.utilizationPct()}%`);
  });
});

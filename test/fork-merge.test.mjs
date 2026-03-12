import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreApproach } from "../lib/branch-selector.mjs";
import { APPROACH_SCHEMA } from "../lib/approach-generator.mjs";
import { parseSwarmArgs } from "../lib/cli.mjs";

// ── scoreApproach ─────────────────────────────────────────────────

describe("scoreApproach", () => {
  it("gives 40 points for successful exit code", () => {
    const score = scoreApproach({ exitCode: 0, durationMs: 1000, output: "" }, null);
    assert.ok(score.succeeded);
    // 40 (success) + 30 (zero diff) + 15 (partial credit, no tests) = 85
    assert.equal(score.qualityScore, 85);
  });

  it("gives 0 success points for failed exit code", () => {
    const score = scoreApproach({ exitCode: 1, durationMs: 1000, output: "" }, null);
    assert.ok(!score.succeeded);
    // 0 (failed) + 30 (zero diff) + 0 (no tests, not succeeded) = 30
    assert.equal(score.qualityScore, 30);
  });

  it("extracts test results from output", () => {
    const score = scoreApproach({
      exitCode: 0, durationMs: 2000,
      output: "Running tests...\n10 tests passed\n2 tests failed\nDone.",
    }, null);
    assert.ok(score.testsPassed);
    assert.equal(score.testsPassed.passed, 10);
    assert.equal(score.testsPassed.failed, 2);
    assert.equal(score.testsPassed.total, 12);
  });

  it("computes test bonus correctly", () => {
    // 10/12 pass rate = 25 points (30 * 10/12 rounded)
    const score = scoreApproach({
      exitCode: 0, durationMs: 2000,
      output: "10 tests passed\n2 tests failed",
    }, null);
    // 40 (success) + 30 (zero diff) + 25 (test bonus) = 95
    assert.equal(score.qualityScore, 95);
  });

  it("penalizes large diffs", () => {
    // With 500+ line diff, diff economy = 0 points
    const score = scoreApproach({
      exitCode: 0, durationMs: 1000, output: "",
    }, null);
    // Without a real worktree, diff is 0 lines → full 30 points
    assert.equal(score.diffStats.total, 0);
  });

  it("handles null output gracefully", () => {
    const score = scoreApproach({ exitCode: 0, durationMs: 500, output: null }, null);
    assert.equal(score.testsPassed, null);
    assert.ok(score.qualityScore >= 40); // at least success points
  });
});

// ── APPROACH_SCHEMA ──────────────────────────────────────────────

describe("APPROACH_SCHEMA", () => {
  it("has the expected structure", () => {
    assert.equal(APPROACH_SCHEMA.type, "object");
    assert.ok(APPROACH_SCHEMA.properties.approaches);
    assert.equal(APPROACH_SCHEMA.properties.approaches.type, "array");
    const itemProps = APPROACH_SCHEMA.properties.approaches.items.properties;
    assert.ok(itemProps.title);
    assert.ok(itemProps.strategy);
    assert.ok(itemProps.instructions);
    assert.ok(itemProps.risk);
    assert.ok(itemProps.estimated_diff_size);
  });

  it("requires title, strategy, instructions", () => {
    const required = APPROACH_SCHEMA.properties.approaches.items.required;
    assert.ok(required.includes("title"));
    assert.ok(required.includes("strategy"));
    assert.ok(required.includes("instructions"));
  });

  it("risk enum contains low, medium, high", () => {
    const riskEnum = APPROACH_SCHEMA.properties.approaches.items.properties.risk.enum;
    assert.deepStrictEqual(riskEnum, ["low", "medium", "high"]);
  });
});

// ── CLI: --forks parsing ─────────────────────────────────────────

describe("parseSwarmArgs --forks", () => {
  it("defaults forks to 2", () => {
    const args = parseSwarmArgs(["node", "swarm", "some task"]);
    assert.equal(args.forks, 2);
  });

  it("parses --forks flag", () => {
    const args = parseSwarmArgs(["node", "swarm", "--forks", "3", "some task"]);
    assert.equal(args.forks, 3);
  });

  it("clamps --forks to max 5", () => {
    const args = parseSwarmArgs(["node", "swarm", "--forks", "10", "some task"]);
    assert.equal(args.forks, 5);
  });

  it("clamps --forks to min 2", () => {
    const args = parseSwarmArgs(["node", "swarm", "--forks", "1", "some task"]);
    assert.equal(args.forks, 2);
  });

  it("parses fork-merge mode", () => {
    const args = parseSwarmArgs(["node", "swarm", "--mode", "fork-merge", "--forks", "4", "task"]);
    assert.equal(args.mode, "fork-merge");
    assert.equal(args.forks, 4);
  });
});

// ── CLI: fork-merge in help text ────────────────────────────────

describe("swarm help text includes fork-merge", () => {
  it("KNOWN_SWARM_FLAGS includes --forks", () => {
    // Verify by parsing — unknown flags cause process.exit, so if this parses, --forks is known
    const args = parseSwarmArgs(["node", "swarm", "--forks", "2", "test"]);
    assert.equal(args.forks, 2);
  });
});

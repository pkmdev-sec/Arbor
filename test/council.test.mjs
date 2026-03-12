import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Council from "../lib/council.mjs";

describe("Council", () => {
  it("should not review simple feature tasks", () => {
    const council = new Council();
    const task = {
      type: "feature",
      description: "Add a new button to the UI",
      targetFiles: ["src/ui.js"],
    };
    const result = {
      output: "Button added successfully",
      filesChanged: ["src/ui.js"],
    };

    assert.equal(council.shouldReview(task, result), false);
  });

  it("should review security tasks", () => {
    const council = new Council();
    const task = {
      type: "security",
      description: "Update authentication flow",
      targetFiles: ["lib/auth.mjs"],
    };
    const result = {
      output: "Authentication updated",
      filesChanged: ["lib/auth.mjs"],
    };

    assert.equal(council.shouldReview(task, result), true);
  });

  it("should review architecture tasks", () => {
    const council = new Council();
    const task = {
      type: "architecture",
      description: "Refactor module structure",
    };
    const result = {
      output: "Refactoring complete",
      filesChanged: ["lib/module.mjs"],
    };

    assert.equal(council.shouldReview(task, result), true);
  });

  it("should review tasks with large file changes", () => {
    const council = new Council();
    const task = {
      type: "feature",
      description: "Add comprehensive test suite",
    };
    const result = {
      output: "Tests added",
      filesChanged: Array.from({ length: 15 }, (_, i) => `test/file${i}.test.mjs`),
    };

    assert.equal(council.shouldReview(task, result), true);
  });

  it("should review tasks with critical keywords", () => {
    const council = new Council();
    const testCases = [
      { keyword: "critical", description: "Critical bug fix in payment processing" },
      { keyword: "breaking", description: "Breaking change to API interface" },
      { keyword: "migration", description: "Database migration for user table" },
      { keyword: "auth", description: "Update auth token validation" },
      { keyword: "security", description: "Security patch for XSS vulnerability" },
    ];

    for (const testCase of testCases) {
      const task = { description: testCase.description };
      const result = { filesChanged: ["lib/file.mjs"] };
      assert.equal(
        council.shouldReview(task, result),
        true,
        `Should review task with keyword: ${testCase.keyword}`
      );
    }
  });

  it("generates three judge prompts with correct roles", () => {
    const council = new Council();
    const task = {
      description: "Implement user authentication",
      targetFiles: ["lib/auth.mjs"],
    };
    const result = {
      output: "Authentication implemented with JWT tokens",
      filesChanged: ["lib/auth.mjs", "lib/tokens.mjs"],
    };

    const prompts = council.generateJudgePrompts(task, result);

    assert.equal(prompts.length, 3);
    assert.equal(prompts[0].role, "correctness");
    assert.equal(prompts[1].role, "regression");
    assert.equal(prompts[2].role, "quality");

    // Check that prompts contain relevant information
    assert.ok(prompts[0].prompt.includes("Implement user authentication"));
    assert.ok(prompts[0].prompt.includes("Does this implementation actually work?"));
    assert.ok(prompts[1].prompt.includes("Does this break existing functionality?"));
    assert.ok(prompts[2].prompt.includes("Is this the simplest correct solution?"));
  });

  it("evaluates unanimous approval correctly", () => {
    const council = new Council();
    const verdicts = [
      { role: "correctness", verdict: "APPROVE", confidence: 0.9, concerns: [] },
      { role: "regression", verdict: "APPROVE", confidence: 0.85, concerns: [] },
      { role: "quality", verdict: "APPROVE", confidence: 0.95, concerns: [] },
    ];

    const result = council.evaluateVerdicts(verdicts);

    assert.equal(result.consensus, "approved");
    assert.equal(result.confidence, 0.95);
    assert.equal(result.concerns.length, 0);
    assert.ok(result.recommendation.includes("approved by all judges"));
  });

  it("evaluates threshold approval correctly", () => {
    const council = new Council({ judgeCount: 3, consensusThreshold: 2 });
    const verdicts = [
      { role: "correctness", verdict: "APPROVE", confidence: 0.9, concerns: [] },
      { role: "regression", verdict: "APPROVE", confidence: 0.8, concerns: [] },
      { role: "quality", verdict: "NEEDS_WORK", confidence: 0.6, concerns: ["Over-engineered"] },
    ];

    const result = council.evaluateVerdicts(verdicts);

    assert.equal(result.consensus, "approved");
    assert.ok(result.confidence > 0.7 && result.confidence < 0.95);
    assert.equal(result.concerns.length, 1);
    assert.ok(result.recommendation.includes("2/3 judges"));
  });

  it("evaluates mixed reviews correctly", () => {
    const council = new Council({ judgeCount: 3, consensusThreshold: 2 });
    const verdicts = [
      { role: "correctness", verdict: "APPROVE", confidence: 0.8, concerns: [] },
      { role: "regression", verdict: "REJECT", confidence: 0.7, concerns: ["Breaks API"] },
      { role: "quality", verdict: "NEEDS_WORK", confidence: 0.6, concerns: ["Complex"] },
    ];

    const result = council.evaluateVerdicts(verdicts);

    assert.equal(result.consensus, "needs_review");
    assert.equal(result.concerns.length, 2);
    assert.ok(result.recommendation.includes("mixed reviews"));
  });

  it("evaluates rejection correctly", () => {
    const council = new Council();
    const verdicts = [
      { role: "correctness", verdict: "REJECT", confidence: 0.9, concerns: ["Logic errors"] },
      { role: "regression", verdict: "REJECT", confidence: 0.85, concerns: ["Breaks tests"] },
      { role: "quality", verdict: "NEEDS_WORK", confidence: 0.8, concerns: ["Poor quality"] },
    ];

    const result = council.evaluateVerdicts(verdicts);

    assert.equal(result.consensus, "rejected");
    assert.ok(result.confidence > 0.8);
    assert.equal(result.concerns.length, 3);
    assert.ok(result.recommendation.includes("rejected by all judges"));
  });

  it("aggregates concerns from all judges", () => {
    const council = new Council();
    const verdicts = [
      { role: "correctness", verdict: "APPROVE", confidence: 0.8, concerns: ["Minor edge case"] },
      { role: "regression", verdict: "APPROVE", confidence: 0.85, concerns: [] },
      { role: "quality", verdict: "NEEDS_WORK", confidence: 0.6, concerns: ["Complexity", "Duplication"] },
    ];

    const result = council.evaluateVerdicts(verdicts);

    assert.equal(result.concerns.length, 3);
    assert.ok(result.concerns.includes("Minor edge case"));
    assert.ok(result.concerns.includes("Complexity"));
    assert.ok(result.concerns.includes("Duplication"));
  });

  it("handles missing verdict fields gracefully", () => {
    const council = new Council();
    const verdicts = [
      { role: "correctness" }, // Missing verdict, confidence, concerns
      { role: "regression", verdict: "APPROVE" }, // Missing confidence, concerns
      { role: "quality", verdict: "REJECT", confidence: 0.7 }, // Missing concerns
    ];

    const result = council.evaluateVerdicts(verdicts);

    // Should not throw and should produce reasonable output
    assert.ok(result.consensus);
    assert.ok(typeof result.confidence === "number");
    assert.ok(Array.isArray(result.concerns));
    assert.ok(result.recommendation);
  });

  it("handles empty verdicts array", () => {
    const council = new Council();
    const result = council.evaluateVerdicts([]);

    assert.equal(result.consensus, "rejected");
    assert.equal(result.confidence, 0.5);
    assert.equal(result.concerns.length, 0);
  });

  it("respects custom judge count and threshold", () => {
    const council = new Council({ judgeCount: 5, consensusThreshold: 3 });

    assert.equal(council.judgeCount, 5);
    assert.equal(council.consensusThreshold, 3);
  });

  it("handles task without description", () => {
    const council = new Council();
    const task = { type: "feature" };
    const result = { filesChanged: ["lib/file.mjs"] };

    const prompts = council.generateJudgePrompts(task, result);

    assert.equal(prompts.length, 3);
    assert.ok(prompts[0].prompt.includes("No description provided"));
  });

  it("handles result without output", () => {
    const council = new Council();
    const task = { description: "Test task" };
    const result = { filesChanged: ["lib/file.mjs"] };

    const prompts = council.generateJudgePrompts(task, result);

    assert.equal(prompts.length, 3);
    assert.ok(prompts[0].prompt.includes("No output"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Premortem from "../lib/premortem.mjs";

describe("Premortem", () => {
  it("accepts task with sufficient description", () => {
    const premortem = new Premortem();
    const tasks = [
      { description: "Refactor authentication module to use JWT tokens" },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.filtered.length, 0);
    assert.equal(result.stats.infeasible, 0);
  });

  it("filters task with insufficient context", () => {
    const premortem = new Premortem();
    const tasks = [
      { description: "Fix it" }, // Too short, no target files
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 0);
    assert.equal(result.filtered.length, 1);
    assert.equal(result.stats.infeasible, 1);
    assert.ok(result.filtered[0].filterReason.includes("Insufficient context"));
  });

  it("accepts task with target files but short description", () => {
    const premortem = new Premortem();
    const tasks = [
      {
        description: "Fix bug",
        targetFiles: ["lib/auth.mjs"],
      },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.filtered.length, 0);
  });

  it("detects redundant tasks with high word overlap and shared files", () => {
    const premortem = new Premortem();
    const tasks = [
      {
        description: "Update user authentication system to use modern tokens",
        targetFiles: ["lib/auth.mjs"],
      },
      {
        description: "Update user authentication system with modern tokens",
        targetFiles: ["lib/auth.mjs"],
      },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.filtered.length, 1);
    assert.equal(result.stats.redundant, 1);
    assert.ok(result.filtered[0].filterReason.includes("Redundant"));
  });

  it("does not flag tasks as redundant without file overlap", () => {
    const premortem = new Premortem();
    const tasks = [
      {
        description: "Update user authentication system to use modern tokens",
        targetFiles: ["lib/auth.mjs"],
      },
      {
        description: "Update user authentication system with modern tokens",
        targetFiles: ["lib/database.mjs"],
      },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 2);
    assert.equal(result.filtered.length, 0);
  });

  it("marks simple tasks but does not filter them", () => {
    const premortem = new Premortem();
    const tasks = [
      {
        description: "Add JSDoc comment",
        targetFiles: ["lib/utils.mjs"],
      },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.filtered.length, 0);
    assert.equal(result.stats.simple, 1);
    assert.ok(result.accepted[0].simple);
  });

  it("does not mark complex tasks as simple", () => {
    const premortem = new Premortem();
    const tasks = [
      {
        description: "Refactor the entire authentication system to support OAuth2 and JWT",
        targetFiles: ["lib/auth.mjs", "lib/tokens.mjs"],
      },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.stats.simple, 0);
    assert.ok(!result.accepted[0].simple);
  });

  it("passes dead end check without learning store", () => {
    const premortem = new Premortem();
    const tasks = [
      {
        description: "Optimize database queries for better performance",
        taskType: "optimization",
      },
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.filtered.length, 0);
  });

  it("filters dead end tasks when learning store indicates failure", () => {
    const premortem = new Premortem();

    // Mock learning store with dead end
    const mockLearningStore = {
      getDeadEnds: (taskType) => {
        if (taskType === "optimization") {
          return [
            {
              reason: "Premature optimization without profiling",
              testCount: 6,
              revivalConditions: [],
            },
          ];
        }
        return [];
      },
    };

    const tasks = [
      {
        description: "Optimize all the things for maximum performance",
        taskType: "optimization",
      },
    ];

    const result = premortem.filter(tasks, { learningStore: mockLearningStore });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.filtered.length, 1);
    assert.equal(result.stats.deadEnd, 1);
    assert.ok(result.filtered[0].filterReason.includes("Known dead end"));
  });

  it("allows dead end tasks when revival conditions are met", () => {
    const premortem = new Premortem();

    // Mock learning store with dead end that has revival conditions
    const mockLearningStore = {
      getDeadEnds: (taskType) => {
        if (taskType === "optimization") {
          return [
            {
              reason: "Premature optimization without profiling",
              testCount: 6,
              revivalConditions: ["profiling data available"],
            },
          ];
        }
        return [];
      },
    };

    const tasks = [
      {
        description: "Optimize queries based on profiling data available from production",
        taskType: "optimization",
      },
    ];

    const result = premortem.filter(tasks, { learningStore: mockLearningStore });

    assert.equal(result.accepted.length, 1);
    assert.equal(result.filtered.length, 0);
  });

  it("returns correct stats for mixed task set", () => {
    const premortem = new Premortem();
    const tasks = [
      { description: "Refactor authentication to use JWT tokens" }, // Valid
      { description: "Fix" }, // Infeasible
      {
        description: "Add tests for authentication",
        targetFiles: ["test/auth.test.mjs"],
      }, // Valid, simple
      {
        description: "Update user authentication system",
        targetFiles: ["lib/auth.mjs"],
      }, // Valid
      {
        description: "Update user authentication system",
        targetFiles: ["lib/auth.mjs"],
      }, // Redundant
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.stats.total, 5);
    assert.equal(result.stats.accepted, 3);
    assert.equal(result.stats.infeasible, 1);
    assert.equal(result.stats.redundant, 1);
    assert.equal(result.stats.simple, 1);
  });

  it("handles empty task list", () => {
    const premortem = new Premortem();
    const result = premortem.filter([]);

    assert.equal(result.accepted.length, 0);
    assert.equal(result.filtered.length, 0);
    assert.equal(result.stats.total, 0);
  });

  it("handles tasks without descriptions", () => {
    const premortem = new Premortem();
    const tasks = [
      { targetFiles: ["lib/utils.mjs"] }, // No description but has files
    ];

    const result = premortem.filter(tasks);

    assert.equal(result.accepted.length, 1);
  });
});

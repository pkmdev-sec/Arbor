import { describe, it } from "node:test";
import assert from "node:assert/strict";
import WaveExecutor from "../lib/wave-executor.mjs";

// ── classifyIntoWaves ────────────────────────────────────────────

describe("WaveExecutor.classifyIntoWaves", () => {
  it("independent tasks go to wave 1", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Fix bug in login" },
      { description: "Update readme" },
      { description: "Add logging" },
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.equal(waves.length, 1);
    assert.equal(waves[0].length, 3);
  });

  it("verify/review tasks go to wave 3", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Verify the fix works", type: "verify" },
      { description: "Review code quality", type: "review" },
      { description: "Check test coverage" },
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.ok(waves.length >= 1);
    const lastWave = waves[waves.length - 1];
    assert.ok(lastWave.length >= 3);
    assert.ok(lastWave.some(t => t.description.includes("Verify")));
    assert.ok(lastWave.some(t => t.description.includes("Review")));
    assert.ok(lastWave.some(t => t.description.includes("Check")));
  });

  it("tasks with dependencies go to wave 2", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Fix bug", id: "task-1" },
      { description: "Test the fix", dependencies: ["task-1"] },
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.ok(waves.length >= 2);
    assert.equal(waves[0].length, 1);
    assert.equal(waves[0][0].description, "Fix bug");
    assert.ok(waves[1].length >= 1);
  });

  it("tasks with 'after' in description go to wave 2", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Implement feature" },
      { description: "After implementing, add tests" },
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.ok(waves.length >= 2);
    assert.ok(waves[1].some(t => t.description.includes("After")));
  });

  it("tasks with 'depends' in description go to wave 2", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Build API" },
      { description: "This depends on the API being ready" },
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.ok(waves.length >= 2);
    assert.ok(waves[1].some(t => t.description.includes("depends")));
  });

  it("mixed task types distribute across waves", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Fix login bug" }, // Wave 1
      { description: "Update config" }, // Wave 1
      { description: "After fixing, test login flow" }, // Wave 2
      { description: "Verify all tests pass", type: "verify" }, // Wave 3
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.equal(waves.length, 3);
    assert.equal(waves[0].length, 2); // independent
    assert.equal(waves[1].length, 1); // depends on prior
    assert.equal(waves[2].length, 1); // verify
  });

  it("empty tasks array returns empty waves", () => {
    const executor = new WaveExecutor();
    const waves = executor.classifyIntoWaves([]);

    assert.deepStrictEqual(waves, []);
  });

  it("null tasks returns empty waves", () => {
    const executor = new WaveExecutor();
    const waves = executor.classifyIntoWaves(null);

    assert.deepStrictEqual(waves, []);
  });

  it("filters out empty waves", () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Fix bug" }, // Wave 1
      { description: "Verify fix", type: "verify" }, // Wave 3
      // No Wave 2 tasks
    ];

    const waves = executor.classifyIntoWaves(tasks);

    assert.equal(waves.length, 2);
    assert.ok(waves[0][0].description === "Fix bug");
    assert.ok(waves[1][0].description === "Verify fix");
  });
});

// ── summarizeWaveResults ─────────────────────────────────────────

describe("WaveExecutor.summarizeWaveResults", () => {
  it("summarizes successful results with file changes", () => {
    const executor = new WaveExecutor();
    const results = [
      {
        task: { description: "Fix login bug" },
        filesChanged: ["src/auth.js", "test/auth.test.js"],
        output: "Fixed null pointer issue in login handler",
      },
    ];

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.includes("Fix login bug"));
    assert.ok(summary.includes("src/auth.js"));
    assert.ok(summary.includes("✓"));
  });

  it("summarizes errors", () => {
    const executor = new WaveExecutor();
    const results = [
      {
        task: { description: "Update config" },
        error: "File not found: config.json",
        filesChanged: [],
        output: "",
      },
    ];

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.includes("Update config"));
    assert.ok(summary.includes("⚠"));
    assert.ok(summary.includes("Error"));
  });

  it("extracts key findings from output", () => {
    const executor = new WaveExecutor();
    const results = [
      {
        task: { description: "Analyze codebase" },
        filesChanged: [],
        output: "Found: Authentication uses deprecated JWT library. Issue: Token validation is missing expiry checks.",
      },
    ];

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.includes("Analyze codebase"));
    assert.ok(summary.includes("→")); // Key finding marker
  });

  it("truncates at 2000 chars", () => {
    const executor = new WaveExecutor();
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push({
        task: { description: `Task ${i}: ${"a".repeat(100)}` },
        filesChanged: ["file.js"],
        output: "Completed successfully",
      });
    }

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.length <= 2100); // Allow small buffer for truncation message
    assert.ok(summary.includes("truncated") || summary.length < 2000);
  });

  it("handles results with no task description", () => {
    const executor = new WaveExecutor();
    const results = [
      {
        filesChanged: ["file.js"],
        output: "Done",
      },
    ];

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.includes("Task 1")); // Default task name
  });

  it("empty results returns empty string", () => {
    const executor = new WaveExecutor();
    const summary = executor.summarizeWaveResults([]);

    assert.equal(summary, "");
  });

  it("null results returns empty string", () => {
    const executor = new WaveExecutor();
    const summary = executor.summarizeWaveResults(null);

    assert.equal(summary, "");
  });

  it("limits files shown to 3", () => {
    const executor = new WaveExecutor();
    const results = [
      {
        task: { description: "Update many files" },
        filesChanged: ["a.js", "b.js", "c.js", "d.js", "e.js"],
        output: "",
      },
    ];

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.includes("..."));
    // Should show first 3 files
    assert.ok(summary.includes("a.js"));
    assert.ok(summary.includes("b.js"));
    assert.ok(summary.includes("c.js"));
  });

  it("handles filesModified alternate field", () => {
    const executor = new WaveExecutor();
    const results = [
      {
        task: { description: "Fix bug" },
        filesModified: ["src/app.js"],
        output: "",
      },
    ];

    const summary = executor.summarizeWaveResults(results);

    assert.ok(summary.includes("src/app.js"));
  });
});

// ── execute ──────────────────────────────────────────────────────

describe("WaveExecutor.execute", () => {
  it("executes independent tasks in wave 1", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task A", id: "a" },
      { description: "Task B", id: "b" },
    ];

    const executedTasks = [];
    const executeFn = async (task, context) => {
      executedTasks.push({ task, context });
      return { output: `Completed ${task.id}`, filesChanged: [`${task.id}.js`] };
    };

    const result = await executor.execute(tasks, executeFn);

    assert.equal(result.results.length, 2);
    assert.equal(result.stats.totalTasks, 2);
    assert.equal(result.stats.wave1Count, 2);
    assert.equal(result.stats.wave2Count, 0);
    assert.equal(result.stats.wave3Count, 0);
    assert.equal(executedTasks.length, 2);
  });

  it("passes prior context to wave 2", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task A", id: "a" },
      { description: "After A, do Task B", id: "b" },
    ];

    const contextsReceived = [];
    const executeFn = async (task, context) => {
      contextsReceived.push({ taskId: task.id, context });
      return {
        output: `Completed ${task.id}. Found: Important discovery from ${task.id}`,
        filesChanged: [`${task.id}.js`],
      };
    };

    const result = await executor.execute(tasks, executeFn);

    assert.equal(result.results.length, 2);
    assert.equal(result.stats.wave1Count, 1);
    assert.equal(result.stats.wave2Count, 1);

    // Wave 1 should have empty context
    assert.equal(contextsReceived[0].context, "");

    // Wave 2 should have context from Wave 1
    assert.ok(contextsReceived[1].context.length > 0);
    assert.ok(contextsReceived[1].context.includes("Wave 1 Discoveries"));
    assert.ok(contextsReceived[1].context.includes("Task A"));
  });

  it("executes all three waves", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Fix bug", id: "fix" },
      { description: "After fixing, test it", id: "test" },
      { description: "Verify all tests pass", type: "verify", id: "verify" },
    ];

    const executeFn = async (task) => {
      return { output: `Done ${task.id}`, filesChanged: [`${task.id}.js`] };
    };

    const result = await executor.execute(tasks, executeFn);

    assert.equal(result.waves.length, 3);
    assert.equal(result.results.length, 3);
    assert.equal(result.stats.wave1Count, 1);
    assert.equal(result.stats.wave2Count, 1);
    assert.equal(result.stats.wave3Count, 1);
    assert.ok(result.stats.wave1Duration >= 0);
    assert.ok(result.stats.wave2Duration >= 0);
    assert.ok(result.stats.wave3Duration >= 0);
  });

  it("respects maxConcurrentPerWave limit", async () => {
    const executor = new WaveExecutor({ maxConcurrentPerWave: 2 });
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      tasks.push({ description: `Task ${i}`, id: `task-${i}` });
    }

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const executeFn = async (task) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrent--;
      return { output: "Done", filesChanged: [] };
    };

    await executor.execute(tasks, executeFn);

    assert.ok(maxConcurrent <= 2, `Expected max 2 concurrent, got ${maxConcurrent}`);
  });

  it("handles execution errors gracefully", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task A", id: "a" },
      { description: "Task B (will fail)", id: "b" },
    ];

    const executeFn = async (task) => {
      if (task.id === "b") {
        throw new Error("Simulated failure");
      }
      return { output: "Success", filesChanged: ["a.js"] };
    };

    const result = await executor.execute(tasks, executeFn);

    assert.equal(result.results.length, 2);
    assert.ok(result.results[0].output === "Success" || result.results[1].output === "Success");
    const failedResult = result.results.find(r => r.task.id === "b");
    assert.ok(failedResult.error.includes("Simulated failure"));
  });

  it("empty tasks array returns empty result", async () => {
    const executor = new WaveExecutor();
    const executeFn = async () => ({ output: "", filesChanged: [] });

    const result = await executor.execute([], executeFn);

    assert.deepStrictEqual(result.waves, []);
    assert.deepStrictEqual(result.results, []);
    assert.equal(result.stats.totalTasks, 0);
  });

  it("throws error if executeFn is not a function", async () => {
    const executor = new WaveExecutor();
    const tasks = [{ description: "Task" }];

    await assert.rejects(
      async () => await executor.execute(tasks, null),
      /executeFn must be a function/
    );
  });
});

// ── constructor options ──────────────────────────────────────────

describe("WaveExecutor.constructor", () => {
  it("uses default options when none provided", () => {
    const executor = new WaveExecutor();

    assert.equal(executor.maxWaves, 3);
    assert.equal(executor.maxConcurrentPerWave, 5);
  });

  it("accepts custom maxWaves", () => {
    const executor = new WaveExecutor({ maxWaves: 2 });

    assert.equal(executor.maxWaves, 2);
  });

  it("accepts custom maxConcurrentPerWave", () => {
    const executor = new WaveExecutor({ maxConcurrentPerWave: 10 });

    assert.equal(executor.maxConcurrentPerWave, 10);
  });

  it("accepts all custom options", () => {
    const executor = new WaveExecutor({ maxWaves: 4, maxConcurrentPerWave: 3 });

    assert.equal(executor.maxWaves, 4);
    assert.equal(executor.maxConcurrentPerWave, 3);
  });
});

// ── executeContinuous ────────────────────────────────────────────

describe("WaveExecutor.executeContinuous", () => {
  it("executes all tasks and returns results", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task 1", id: "1" },
      { description: "Task 2", id: "2" },
      { description: "Task 3", id: "3" },
    ];

    const executeFn = async (task) => {
      return { output: `Done ${task.id}`, filesChanged: [`${task.id}.js`] };
    };

    const result = await executor.executeContinuous(tasks, executeFn);

    assert.equal(result.results.length, 3);
    assert.equal(result.stats.totalTasks, 3);
    assert.equal(result.stats.completedTasks, 3);
    assert.equal(result.stats.followUpsGenerated, 0);
    assert.ok(result.stats.totalDuration >= 0);
  });

  it("calls onResult for each completed task", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task 1", id: "1" },
      { description: "Task 2", id: "2" },
    ];

    const onResultCalls = [];
    const executeFn = async (task) => {
      return { output: `Done ${task.id}`, filesChanged: [] };
    };

    const options = {
      onResult: async (result) => {
        onResultCalls.push(result.task.id);
      },
    };

    await executor.executeContinuous(tasks, executeFn, options);

    assert.equal(onResultCalls.length, 2);
    assert.ok(onResultCalls.includes("1"));
    assert.ok(onResultCalls.includes("2"));
  });

  it("generates follow-up tasks dynamically", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task 1", id: "1" },
    ];

    const executeFn = async (task) => {
      return { output: `Done ${task.id}`, filesChanged: [] };
    };

    const options = {
      generateFollowUps: (result) => {
        if (result.task.id === "1") {
          return [
            { description: "Follow-up 1", id: "follow-1" },
            { description: "Follow-up 2", id: "follow-2" },
          ];
        }
        return [];
      },
    };

    const result = await executor.executeContinuous(tasks, executeFn, options);

    assert.equal(result.stats.totalTasks, 1);
    assert.equal(result.stats.completedTasks, 3); // Original + 2 follow-ups
    assert.equal(result.stats.followUpsGenerated, 2);
  });

  it("respects maxFollowUps cap", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task 1", id: "1" },
    ];

    let callCount = 0;
    const executeFn = async (task) => {
      callCount++;
      return { output: `Done ${task.id}`, filesChanged: [] };
    };

    const options = {
      maxFollowUps: 3,
      generateFollowUps: (result) => {
        // Each task generates 2 follow-ups
        const taskNum = parseInt(result.task.id.split("-").pop() || result.task.id);
        return [
          { description: `Follow-up ${taskNum}-1`, id: `follow-${taskNum}-1` },
          { description: `Follow-up ${taskNum}-2`, id: `follow-${taskNum}-2` },
        ];
      },
    };

    const result = await executor.executeContinuous(tasks, executeFn, options);

    // Should be capped at 3 follow-ups
    assert.equal(result.stats.followUpsGenerated, 3);
    assert.ok(result.stats.completedTasks <= 4, "Should not exceed 1 + maxFollowUps");
  });

  it("respects maxConcurrentPerWave limit", async () => {
    const executor = new WaveExecutor({ maxConcurrentPerWave: 2 });
    const tasks = [];
    for (let i = 0; i < 6; i++) {
      tasks.push({ description: `Task ${i}`, id: `${i}` });
    }

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const executeFn = async (task) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      currentConcurrent--;
      return { output: "Done", filesChanged: [] };
    };

    await executor.executeContinuous(tasks, executeFn);

    assert.ok(maxConcurrent <= 2, `Expected max 2 concurrent, got ${maxConcurrent}`);
  });

  it("handles errors gracefully", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task 1", id: "1" },
      { description: "Task 2 (will fail)", id: "2" },
      { description: "Task 3", id: "3" },
    ];

    const executeFn = async (task) => {
      if (task.id === "2") {
        throw new Error("Task 2 failed");
      }
      return { output: "Success", filesChanged: [] };
    };

    const result = await executor.executeContinuous(tasks, executeFn);

    assert.equal(result.results.length, 3);
    assert.equal(result.stats.completedTasks, 3);
    const failedResult = result.results.find(r => r.task.id === "2");
    assert.ok(failedResult.error.includes("Task 2 failed"));
  });

  it("calls onResult even for failed tasks", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Task 1", id: "1" },
      { description: "Task 2 (will fail)", id: "2" },
    ];

    const onResultCalls = [];
    const executeFn = async (task) => {
      if (task.id === "2") {
        throw new Error("Failed");
      }
      return { output: "Success", filesChanged: [] };
    };

    const options = {
      onResult: async (result) => {
        onResultCalls.push({ id: result.task.id, hasError: !!result.error });
      },
    };

    await executor.executeContinuous(tasks, executeFn, options);

    assert.equal(onResultCalls.length, 2);
    const task2Call = onResultCalls.find(c => c.id === "2");
    assert.ok(task2Call.hasError);
  });

  it("handles empty tasks array", async () => {
    const executor = new WaveExecutor();
    const executeFn = async (task) => {
      return { output: "Done", filesChanged: [] };
    };

    const result = await executor.executeContinuous([], executeFn);

    assert.deepStrictEqual(result.results, []);
    assert.equal(result.stats.totalTasks, 0);
    assert.equal(result.stats.completedTasks, 0);
    assert.equal(result.stats.followUpsGenerated, 0);
  });

  it("throws error if executeFn is not a function", async () => {
    const executor = new WaveExecutor();
    const tasks = [{ description: "Task" }];

    await assert.rejects(
      async () => await executor.executeContinuous(tasks, null),
      /executeFn must be a function/
    );
  });

  it("uses default maxFollowUps of 10", async () => {
    const executor = new WaveExecutor();
    const tasks = [{ description: "Task 1", id: "1" }];

    const executeFn = async (task) => {
      return { output: "Done", filesChanged: [] };
    };

    const options = {
      generateFollowUps: () => {
        // Always generate 2 follow-ups
        return [
          { description: "Follow-up", id: `follow-${Math.random()}` },
          { description: "Follow-up", id: `follow-${Math.random()}` },
        ];
      },
    };

    const result = await executor.executeContinuous(tasks, executeFn, options);

    // Should cap at default maxFollowUps of 10
    assert.equal(result.stats.followUpsGenerated, 10);
  });

  it("processes follow-ups in order with concurrency", async () => {
    const executor = new WaveExecutor({ maxConcurrentPerWave: 2 });
    const tasks = [
      { description: "Root task", id: "root" },
    ];

    const executionOrder = [];
    const executeFn = async (task) => {
      executionOrder.push(task.id);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { output: "Done", filesChanged: [] };
    };

    const options = {
      maxFollowUps: 4,
      generateFollowUps: (result) => {
        if (result.task.id === "root") {
          return [
            { description: "Follow 1", id: "follow-1" },
            { description: "Follow 2", id: "follow-2" },
          ];
        }
        return [];
      },
    };

    const result = await executor.executeContinuous(tasks, executeFn, options);

    // Should have executed root + 2 follow-ups
    assert.equal(executionOrder.length, 3);
    assert.equal(executionOrder[0], "root");
    assert.ok(executionOrder.includes("follow-1"));
    assert.ok(executionOrder.includes("follow-2"));
    assert.equal(result.stats.followUpsGenerated, 2);
  });

  it("cascades follow-ups from follow-ups", async () => {
    const executor = new WaveExecutor();
    const tasks = [
      { description: "Root", id: "root" },
    ];

    const executeFn = async (task) => {
      return { output: "Done", filesChanged: [] };
    };

    const options = {
      maxFollowUps: 5,
      generateFollowUps: (result) => {
        const taskId = result.task.id;
        if (taskId === "root") {
          return [{ description: "Gen 1", id: "gen-1" }];
        } else if (taskId === "gen-1") {
          return [{ description: "Gen 2", id: "gen-2" }];
        } else if (taskId === "gen-2") {
          return [{ description: "Gen 3", id: "gen-3" }];
        }
        return [];
      },
    };

    const result = await executor.executeContinuous(tasks, executeFn, options);

    // Should have root + 3 cascading follow-ups (all within maxFollowUps limit)
    assert.equal(result.stats.completedTasks, 4);
    assert.equal(result.stats.followUpsGenerated, 3);
  });
});

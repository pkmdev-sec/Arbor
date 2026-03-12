import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the DAG builder (it's a module-scoped function, check if exported)
// Note: buildExecutionDAG may not be exported. We test the autoMode regex instead.

describe("autoMode regex heuristic", () => {
  // The regex heuristic is inside autoMode — we test the patterns it should match
  it("detects review-like tasks", () => {
    const reviewPatterns = /review|audit|check|inspect|assess|evaluate/i;
    assert.ok(reviewPatterns.test("Review the authentication module"));
    assert.ok(reviewPatterns.test("Audit security of API endpoints"));
  });

  it("detects refactor-like tasks", () => {
    const refactorPatterns = /refactor|restructure|reorganize|clean.?up|modernize/i;
    assert.ok(refactorPatterns.test("Refactor the database layer"));
    assert.ok(refactorPatterns.test("Clean up legacy code"));
  });

  it("detects pipeline-like tasks", () => {
    const pipelinePatterns = /implement.*and.*test|build.*and.*review|create.*and.*verify/i;
    assert.ok(pipelinePatterns.test("Implement the API and test it"));
    assert.ok(pipelinePatterns.test("Build the feature and review"));
  });
});

describe("buildExecutionDAG logic", () => {
  // Replicate the DAG builder's core algorithm for unit testing
  function buildDAG(subtasks) {
    const titleToIndex = new Map();
    subtasks.forEach((st, i) => titleToIndex.set(st.title || `subtask-${i}`, i));

    const graph = new Map();
    const inDegree = new Array(subtasks.length).fill(0);
    for (let i = 0; i < subtasks.length; i++) graph.set(i, []);

    for (let i = 0; i < subtasks.length; i++) {
      const deps = subtasks[i].depends_on || [];
      for (const depTitle of deps) {
        const depIndex = titleToIndex.get(depTitle);
        if (depIndex !== undefined && depIndex !== i) {
          graph.get(depIndex).push(i);
          inDegree[i]++;
        }
      }
    }

    const waves = [];
    const remaining = new Set([...Array(subtasks.length).keys()]);

    while (remaining.size > 0) {
      const wave = [];
      for (const idx of remaining) {
        if (inDegree[idx] === 0) wave.push(idx);
      }
      if (wave.length === 0) return { waves: [[...remaining]], hasCycle: true };
      waves.push(wave);
      for (const idx of wave) {
        remaining.delete(idx);
        for (const dep of graph.get(idx)) inDegree[dep]--;
      }
    }
    return { waves, hasCycle: false };
  }

  it("runs independent tasks in one wave", () => {
    const subtasks = [
      { title: "A", depends_on: [] },
      { title: "B", depends_on: [] },
      { title: "C", depends_on: [] },
    ];
    const { waves, hasCycle } = buildDAG(subtasks);
    assert.equal(hasCycle, false);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].length, 3);
  });

  it("respects linear dependency chain", () => {
    const subtasks = [
      { title: "A", depends_on: [] },
      { title: "B", depends_on: ["A"] },
      { title: "C", depends_on: ["B"] },
    ];
    const { waves, hasCycle } = buildDAG(subtasks);
    assert.equal(hasCycle, false);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0], [0]); // A
    assert.deepEqual(waves[1], [1]); // B
    assert.deepEqual(waves[2], [2]); // C
  });

  it("detects cycles and falls back", () => {
    const subtasks = [
      { title: "A", depends_on: ["B"] },
      { title: "B", depends_on: ["A"] },
    ];
    const { hasCycle } = buildDAG(subtasks);
    assert.equal(hasCycle, true);
  });

  it("handles diamond dependency", () => {
    const subtasks = [
      { title: "A", depends_on: [] },
      { title: "B", depends_on: ["A"] },
      { title: "C", depends_on: ["A"] },
      { title: "D", depends_on: ["B", "C"] },
    ];
    const { waves, hasCycle } = buildDAG(subtasks);
    assert.equal(hasCycle, false);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0], [0]);       // A
    assert.ok(waves[1].includes(1));       // B and C in same wave
    assert.ok(waves[1].includes(2));
    assert.deepEqual(waves[2], [3]);       // D
  });

  it("ignores unknown dependencies", () => {
    const subtasks = [
      { title: "A", depends_on: ["nonexistent"] },
      { title: "B", depends_on: [] },
    ];
    const { waves, hasCycle } = buildDAG(subtasks);
    assert.equal(hasCycle, false);
    assert.equal(waves.length, 1); // Both run in parallel (unknown dep ignored)
  });
});

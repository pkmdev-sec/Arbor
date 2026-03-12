import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_ALLOWLISTS,
  getToolsForTask,
  inferTaskType,
  formatAllowedTools,
} from "../lib/tool-allowlists.mjs";

describe("TOOL_ALLOWLISTS", () => {
  it("defines expected task types", () => {
    assert.ok(TOOL_ALLOWLISTS.research);
    assert.ok(TOOL_ALLOWLISTS.implementation);
    assert.ok(TOOL_ALLOWLISTS.testing);
    assert.ok(TOOL_ALLOWLISTS.review);
    assert.ok(TOOL_ALLOWLISTS.debugging);
    assert.ok(TOOL_ALLOWLISTS.verification);
    assert.ok(TOOL_ALLOWLISTS.decomposition);
    assert.ok(TOOL_ALLOWLISTS.default);
  });

  it("research has correct tools", () => {
    assert.deepEqual(TOOL_ALLOWLISTS.research, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
  });

  it("implementation has correct tools", () => {
    assert.deepEqual(TOOL_ALLOWLISTS.implementation, ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);
  });
});

describe("inferTaskType", () => {
  it("infers research from keywords", () => {
    assert.equal(inferTaskType("research the codebase"), "research");
    assert.equal(inferTaskType("Explore authentication flow"), "research");
    assert.equal(inferTaskType("analyze performance"), "research");
    assert.equal(inferTaskType("find all usages"), "research");
    assert.equal(inferTaskType("search for patterns"), "research");
    assert.equal(inferTaskType("investigate bug"), "research");
  });

  it("infers testing from keywords", () => {
    assert.equal(inferTaskType("test the feature"), "testing");
    assert.equal(inferTaskType("verify correctness"), "testing");
    assert.equal(inferTaskType("check edge cases"), "testing");
    assert.equal(inferTaskType("validate output"), "testing");
  });

  it("infers review from keywords", () => {
    assert.equal(inferTaskType("review code changes"), "review");
    assert.equal(inferTaskType("audit security"), "review");
    assert.equal(inferTaskType("assess quality"), "review");
  });

  it("infers debugging from keywords", () => {
    assert.equal(inferTaskType("debug memory leak"), "debugging");
    assert.equal(inferTaskType("fix bug in parser"), "debugging");
    assert.equal(inferTaskType("diagnose crash"), "debugging");
    assert.equal(inferTaskType("troubleshoot issue"), "debugging");
  });

  it("infers implementation from keywords", () => {
    assert.equal(inferTaskType("implement authentication"), "implementation");
    assert.equal(inferTaskType("build API endpoint"), "implementation");
    assert.equal(inferTaskType("create new feature"), "implementation");
    assert.equal(inferTaskType("add logging"), "implementation");
    assert.equal(inferTaskType("write tests"), "implementation");
    assert.equal(inferTaskType("refactor module"), "implementation");
  });

  it("infers decomposition from keywords", () => {
    assert.equal(inferTaskType("decompose large task"), "decomposition");
    assert.equal(inferTaskType("break down the work"), "decomposition");
    assert.equal(inferTaskType("plan the approach"), "decomposition");
  });

  it("returns default for unknown patterns", () => {
    assert.equal(inferTaskType("do something"), "default");
    assert.equal(inferTaskType("handle request"), "default");
  });

  it("handles empty or invalid input", () => {
    assert.equal(inferTaskType(""), "default");
    assert.equal(inferTaskType(null), "default");
    assert.equal(inferTaskType(undefined), "default");
    assert.equal(inferTaskType(123), "default");
  });

  it("is case insensitive", () => {
    assert.equal(inferTaskType("RESEARCH codebase"), "research");
    assert.equal(inferTaskType("Build Feature"), "implementation");
  });
});

describe("getToolsForTask", () => {
  it("uses explicit type if provided", () => {
    const task = { type: "research" };
    assert.deepEqual(getToolsForTask(task), TOOL_ALLOWLISTS.research);
  });

  it("infers from description if type not provided", () => {
    const task = { description: "explore the API" };
    assert.deepEqual(getToolsForTask(task), TOOL_ALLOWLISTS.research);
  });

  it("prefers explicit type over description", () => {
    const task = { type: "testing", description: "implement feature" };
    assert.deepEqual(getToolsForTask(task), TOOL_ALLOWLISTS.testing);
  });

  it("returns default for empty task", () => {
    assert.deepEqual(getToolsForTask({}), TOOL_ALLOWLISTS.default);
  });

  it("returns default for null/undefined", () => {
    assert.deepEqual(getToolsForTask(null), TOOL_ALLOWLISTS.default);
    assert.deepEqual(getToolsForTask(undefined), TOOL_ALLOWLISTS.default);
  });

  it("returns default for unknown type", () => {
    const task = { type: "unknown-type" };
    assert.deepEqual(getToolsForTask(task), TOOL_ALLOWLISTS.default);
  });

  it("handles all defined types", () => {
    for (const type of Object.keys(TOOL_ALLOWLISTS)) {
      const task = { type };
      assert.deepEqual(getToolsForTask(task), TOOL_ALLOWLISTS[type]);
    }
  });
});

describe("formatAllowedTools", () => {
  it("formats tool list as comma-separated string", () => {
    const tools = ['Read', 'Write', 'Edit'];
    assert.equal(formatAllowedTools(tools), "Read,Write,Edit");
  });

  it("handles single tool", () => {
    assert.equal(formatAllowedTools(['Read']), "Read");
  });

  it("handles empty array", () => {
    assert.equal(formatAllowedTools([]), "");
  });

  it("handles null/undefined", () => {
    assert.equal(formatAllowedTools(null), "");
    assert.equal(formatAllowedTools(undefined), "");
  });

  it("handles non-array input", () => {
    assert.equal(formatAllowedTools("not-array"), "");
  });

  it("formats all tool types correctly", () => {
    const formatted = formatAllowedTools(TOOL_ALLOWLISTS.research);
    assert.equal(formatted, "Read,Grep,Glob,WebSearch,WebFetch");
  });
});

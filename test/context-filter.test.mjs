/**
 * Tests for Context Filter
 *
 * Tests role-based context filtering and system prompt adaptation for different agent types.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterContextForRole, filterSystemPromptForRole, filteringStats, getStrippedSections, filterContextSemantically } from "../lib/context-filter.mjs";

// ── filterContextForRole ─────────────────────────────────────────

describe("filterContextForRole", () => {
  const fullCtx = {
    task: {
      constraints: ["must use TypeScript", "no external deps"],
      scope: ["src/auth/", "src/api/"],
    },
    prior_knowledge: {
      decisions: ["use JWT for auth", "REST not GraphQL"],
      file_summaries: { "src/auth/login.ts": "handles login flow", "src/api/routes.ts": "API route definitions" },
    },
    project: {
      recent_files: ["src/auth/login.ts", "src/api/routes.ts"],
    },
    metadata: { version: 1 },
  };

  it("worker: keeps decisions, file_summaries, constraints, scope, recent_files", () => {
    const f = filterContextForRole(fullCtx, "worker");
    assert.deepStrictEqual(f.task.constraints, fullCtx.task.constraints);
    assert.deepStrictEqual(f.task.scope, fullCtx.task.scope);
    assert.deepStrictEqual(f.prior_knowledge.decisions, fullCtx.prior_knowledge.decisions);
    assert.deepStrictEqual(f.prior_knowledge.file_summaries, fullCtx.prior_knowledge.file_summaries);
    assert.deepStrictEqual(f.project.recent_files, fullCtx.project.recent_files);
    assert.deepStrictEqual(f.metadata, fullCtx.metadata);
  });

  it("verifier: strips decisions, file_summaries, recent_files", () => {
    const f = filterContextForRole(fullCtx, "verifier");
    assert.deepStrictEqual(f.task.constraints, fullCtx.task.constraints);
    assert.deepStrictEqual(f.task.scope, fullCtx.task.scope);
    assert.equal(f.prior_knowledge, undefined);
    assert.equal(f.project, undefined);
  });

  it("decomposer: keeps decisions, file_summaries, constraints, scope, recent_files", () => {
    const f = filterContextForRole(fullCtx, "decomposer");
    assert.deepStrictEqual(f.task.constraints, fullCtx.task.constraints);
    assert.deepStrictEqual(f.prior_knowledge.decisions, fullCtx.prior_knowledge.decisions);
    assert.deepStrictEqual(f.prior_knowledge.file_summaries, fullCtx.prior_knowledge.file_summaries);
    assert.deepStrictEqual(f.project.recent_files, fullCtx.project.recent_files);
  });

  it("unknown role: returns unfiltered", () => {
    const f = filterContextForRole(fullCtx, "unknown");
    assert.deepStrictEqual(f, fullCtx);
  });

  it("null context: returns null", () => {
    assert.equal(filterContextForRole(null, "worker"), null);
  });

  it("empty context: returns empty object", () => {
    const f = filterContextForRole({}, "worker");
    assert.deepStrictEqual(f, {});
  });

  it("does not mutate original context", () => {
    const original = JSON.parse(JSON.stringify(fullCtx));
    filterContextForRole(fullCtx, "verifier");
    assert.deepStrictEqual(fullCtx, original);
  });

  it("sub-coordinator: keeps decisions, constraints, scope, but strips file_summaries and recent_files", () => {
    const f = filterContextForRole(fullCtx, "sub-coordinator");
    assert.deepStrictEqual(f.task.constraints, fullCtx.task.constraints);
    assert.deepStrictEqual(f.task.scope, fullCtx.task.scope);
    assert.deepStrictEqual(f.prior_knowledge.decisions, fullCtx.prior_knowledge.decisions);
    assert.equal(f.prior_knowledge.file_summaries, undefined);
    assert.equal(f.project, undefined);
  });

  it("governor: keeps constraints and scope only", () => {
    const f = filterContextForRole(fullCtx, "governor");
    assert.deepStrictEqual(f.task.constraints, fullCtx.task.constraints);
    assert.deepStrictEqual(f.task.scope, fullCtx.task.scope);
    assert.equal(f.prior_knowledge, undefined);
    assert.equal(f.project, undefined);
  });

  it("aggregator: keeps constraints and scope only", () => {
    const f = filterContextForRole(fullCtx, "aggregator");
    assert.deepStrictEqual(f.task.constraints, fullCtx.task.constraints);
    assert.deepStrictEqual(f.task.scope, fullCtx.task.scope);
    assert.equal(f.prior_knowledge, undefined);
    assert.equal(f.project, undefined);
  });
});

// ── filterSystemPromptForRole ────────────────────────────────────

describe("filterSystemPromptForRole", () => {
  it("worker: strips GIT DIFF and TEST EXECUTION sections", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TS\n- no deps",
      "KNOWN DECISIONS:\n- use JWT",
      "FILE CONTEXT:\n- src/auth.ts: auth module",
      "GIT DIFF:\n+added line\n-removed line",
      "TEST EXECUTION RESULTS:\nExit code: 0\nAll tests passed",
    ].join("\n\n");

    const f = filterSystemPromptForRole(prompt, "worker");
    assert.ok(!f.includes("GIT DIFF"), "should strip GIT DIFF");
    assert.ok(!f.includes("TEST EXECUTION"), "should strip TEST EXECUTION");
    assert.ok(f.includes("CONSTRAINTS"), "should keep CONSTRAINTS");
    assert.ok(f.includes("KNOWN DECISIONS"), "should keep KNOWN DECISIONS");
    assert.ok(f.includes("FILE CONTEXT"), "should keep FILE CONTEXT");
  });

  it("verifier: strips Scout Report, Wave Discoveries, FILE CONTEXT", () => {
    const prompt = [
      "[Scout Report]\nProject is a Node.js monorepo with 3 packages.",
      "[Wave 1 Discoveries]\nagent-01: found auth module",
      "KNOWN DECISIONS:\n- use JWT",
      "FILE CONTEXT:\n- src/auth.ts: auth module",
      "GIT DIFF:\n+added line",
      "TEST EXECUTION RESULTS:\nAll passed",
    ].join("\n\n");

    const f = filterSystemPromptForRole(prompt, "verifier");
    assert.ok(!f.includes("[Scout Report]"), "should strip Scout Report");
    assert.ok(!f.includes("[Wave 1 Discoveries]"), "should strip Wave Discoveries");
    assert.ok(!f.includes("KNOWN DECISIONS"), "should strip KNOWN DECISIONS");
    assert.ok(!f.includes("FILE CONTEXT"), "should strip FILE CONTEXT");
    assert.ok(f.includes("GIT DIFF"), "should keep GIT DIFF");
    assert.ok(f.includes("TEST EXECUTION"), "should keep TEST EXECUTION");
  });

  it("decomposer: strips GIT DIFF, TEST EXECUTION, Wave Discoveries", () => {
    const prompt = [
      "[Scout Report]\nProject structure analysis.",
      "CONSTRAINTS:\n- use TS",
      "FILE CONTEXT:\n- src/auth.ts: auth module",
      "GIT DIFF:\n+added line",
      "TEST EXECUTION RESULTS:\nAll passed",
    ].join("\n\n");

    const f = filterSystemPromptForRole(prompt, "decomposer");
    assert.ok(f.includes("[Scout Report]"), "should keep Scout Report");
    assert.ok(f.includes("CONSTRAINTS"), "should keep CONSTRAINTS");
    assert.ok(f.includes("FILE CONTEXT"), "should keep FILE CONTEXT");
    assert.ok(!f.includes("GIT DIFF"), "should strip GIT DIFF");
    assert.ok(!f.includes("TEST EXECUTION"), "should strip TEST EXECUTION");
  });

  it("unknown role: returns prompt unchanged", () => {
    const prompt = "some prompt text";
    assert.equal(filterSystemPromptForRole(prompt, "unknown"), prompt);
  });

  it("null prompt: returns null", () => {
    assert.equal(filterSystemPromptForRole(null, "worker"), null);
  });

  it("empty prompt: returns empty string", () => {
    assert.equal(filterSystemPromptForRole("", "worker"), "");
  });

  it("collapses excessive blank lines", () => {
    const prompt = "CONSTRAINTS:\n- use TS\n\n\n\n\n\nFILE CONTEXT:\n- src/auth.ts: auth";
    const f = filterSystemPromptForRole(prompt, "worker");
    assert.ok(!f.includes("\n\n\n"), "should not have 3+ consecutive newlines");
  });

  it("sub-coordinator: keeps Scout Report, Wave Discoveries, decisions, worker outputs, strips file context", () => {
    const prompt = [
      "[Scout Report]\nProject structure",
      "[Wave 1 Discoveries]\nagent-01: found auth",
      "KNOWN DECISIONS:\n- use JWT",
      "FILE CONTEXT:\n- src/auth.ts: auth",
      "WORKER OUTPUTS:\nagent-01: completed auth",
    ].join("\n\n");

    const f = filterSystemPromptForRole(prompt, "sub-coordinator");
    assert.ok(f.includes("[Scout Report]"), "should keep Scout Report");
    assert.ok(f.includes("[Wave 1 Discoveries]"), "should keep Wave Discoveries");
    assert.ok(f.includes("KNOWN DECISIONS"), "should keep KNOWN DECISIONS");
    assert.ok(f.includes("WORKER OUTPUTS"), "should keep WORKER OUTPUTS");
    assert.ok(!f.includes("FILE CONTEXT"), "should strip FILE CONTEXT");
  });

  it("governor: keeps constraints and scope only", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TS",
      "SCOPE: src/auth/",
      "FILE CONTEXT:\n- src/auth.ts: auth",
      "GIT DIFF:\n+added line",
    ].join("\n\n");

    const f = filterSystemPromptForRole(prompt, "governor");
    assert.ok(f.includes("CONSTRAINTS"), "should keep CONSTRAINTS");
    assert.ok(f.includes("SCOPE"), "should keep SCOPE");
    assert.ok(!f.includes("FILE CONTEXT"), "should strip FILE CONTEXT");
    assert.ok(!f.includes("GIT DIFF"), "should strip GIT DIFF");
  });

  it("aggregator: keeps constraints, scope, gitDiff, testResults, workerOutputs", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TS",
      "SCOPE: src/auth/",
      "FILE CONTEXT:\n- src/auth.ts: auth",
      "GIT DIFF:\n+added line",
      "TEST EXECUTION RESULTS:\nAll passed",
      "WORKER OUTPUTS:\nagent-01: completed",
    ].join("\n\n");

    const f = filterSystemPromptForRole(prompt, "aggregator");
    assert.ok(f.includes("CONSTRAINTS"), "should keep CONSTRAINTS");
    assert.ok(f.includes("SCOPE"), "should keep SCOPE");
    assert.ok(f.includes("GIT DIFF"), "should keep GIT DIFF");
    assert.ok(f.includes("TEST EXECUTION"), "should keep TEST EXECUTION");
    assert.ok(f.includes("WORKER OUTPUTS"), "should keep WORKER OUTPUTS");
    assert.ok(!f.includes("FILE CONTEXT"), "should strip FILE CONTEXT");
  });
});

// ── filteringStats ───────────────────────────────────────────────

describe("filteringStats", () => {
  it("computes reduction percentage", () => {
    const stats = filteringStats("a".repeat(100), "a".repeat(70));
    assert.equal(stats.originalSize, 100);
    assert.equal(stats.filteredSize, 70);
    assert.equal(stats.reductionPct, 30);
  });

  it("handles zero-length original", () => {
    const stats = filteringStats("", "");
    assert.equal(stats.reductionPct, 0);
  });

  it("handles null inputs", () => {
    const stats = filteringStats(null, null);
    assert.equal(stats.originalSize, 0);
    assert.equal(stats.filteredSize, 0);
  });
});

// ── getStrippedSections ──────────────────────────────────────────

describe("getStrippedSections", () => {
  it("worker: strips gitDiff, testResults, workerOutputs", () => {
    const stripped = getStrippedSections("worker");
    assert.ok(stripped.includes("gitDiff"));
    assert.ok(stripped.includes("testResults"));
    assert.ok(stripped.includes("workerOutputs"));
    assert.ok(!stripped.includes("decisions"));
    assert.ok(!stripped.includes("fileSummaries"));
  });

  it("verifier: strips scoutReport, waveDiscoveries, decisions, fileSummaries, recentFiles", () => {
    const stripped = getStrippedSections("verifier");
    assert.ok(stripped.includes("scoutReport"));
    assert.ok(stripped.includes("waveDiscoveries"));
    assert.ok(stripped.includes("decisions"));
    assert.ok(stripped.includes("fileSummaries"));
    assert.ok(stripped.includes("recentFiles"));
    assert.ok(!stripped.includes("gitDiff"));
    assert.ok(!stripped.includes("testResults"));
  });

  it("decomposer: strips gitDiff, testResults, waveDiscoveries, workerOutputs", () => {
    const stripped = getStrippedSections("decomposer");
    assert.ok(stripped.includes("gitDiff"));
    assert.ok(stripped.includes("testResults"));
    assert.ok(stripped.includes("waveDiscoveries"));
    assert.ok(!stripped.includes("scoutReport"));
    assert.ok(!stripped.includes("constraints"));
  });

  it("unknown role: returns empty array", () => {
    assert.deepStrictEqual(getStrippedSections("unknown"), []);
  });

  it("sub-coordinator: strips fileSummaries, recentFiles, gitDiff, testResults, previousAttempt", () => {
    const stripped = getStrippedSections("sub-coordinator");
    assert.ok(stripped.includes("fileSummaries"));
    assert.ok(stripped.includes("recentFiles"));
    assert.ok(stripped.includes("gitDiff"));
    assert.ok(stripped.includes("testResults"));
    assert.ok(stripped.includes("previousAttempt"));
    assert.ok(!stripped.includes("scoutReport"));
    assert.ok(!stripped.includes("workerOutputs"));
  });

  it("governor: strips most sections except constraints and scope", () => {
    const stripped = getStrippedSections("governor");
    assert.ok(stripped.includes("scoutReport"));
    assert.ok(stripped.includes("waveDiscoveries"));
    assert.ok(stripped.includes("previousAttempt"));
    assert.ok(stripped.includes("decisions"));
    assert.ok(stripped.includes("fileSummaries"));
    assert.ok(stripped.includes("recentFiles"));
    assert.ok(stripped.includes("gitDiff"));
    assert.ok(stripped.includes("testResults"));
    assert.ok(stripped.includes("workerOutputs"));
    assert.ok(!stripped.includes("constraints"));
    assert.ok(!stripped.includes("scope"));
  });

  it("aggregator: strips most sections except constraints, scope, gitDiff, testResults, workerOutputs", () => {
    const stripped = getStrippedSections("aggregator");
    assert.ok(stripped.includes("scoutReport"));
    assert.ok(stripped.includes("waveDiscoveries"));
    assert.ok(stripped.includes("previousAttempt"));
    assert.ok(stripped.includes("decisions"));
    assert.ok(stripped.includes("fileSummaries"));
    assert.ok(stripped.includes("recentFiles"));
    assert.ok(!stripped.includes("constraints"));
    assert.ok(!stripped.includes("scope"));
    assert.ok(!stripped.includes("gitDiff"));
    assert.ok(!stripped.includes("testResults"));
    assert.ok(!stripped.includes("workerOutputs"));
  });
});

// ── filterContextSemantically ────────────────────────────────────────

describe("filterContextSemantically", () => {
  it("worker with scope=['lib/tui/'] gets only tui-related file summaries", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TypeScript",
      "FILE CONTEXT:\n- lib/tui/foo.go: TUI component\n- lib/ipc/bar.mjs: IPC module\n- lib/context-filter.mjs: Context filtering",
      "KNOWN DECISIONS:\n- use Go for TUI\n- use Node.js for backend",
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, "worker", "lib/tui/");

    // Should keep tui-related file
    assert.ok(filtered.includes("lib/tui/foo.go"), "should include lib/tui/foo.go");
    // Should strip non-tui files
    assert.ok(!filtered.includes("lib/ipc/bar.mjs"), "should not include lib/ipc/bar.mjs");
    assert.ok(!filtered.includes("lib/context-filter.mjs"), "should not include lib/context-filter.mjs");
    // Should keep constraints
    assert.ok(filtered.includes("CONSTRAINTS"), "should keep CONSTRAINTS");
  });

  it("worker with multiple scopes filters file summaries correctly", () => {
    const prompt = [
      "FILE CONTEXT:\n- lib/tui/model.go: TUI model\n- lib/ipc/client.mjs: IPC client\n- test/tui.test.mjs: TUI tests\n- hooks/agent.py: Agent hook",
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, "worker", "lib/tui/,test/");

    assert.ok(filtered.includes("lib/tui/model.go"), "should include lib/tui/model.go");
    assert.ok(filtered.includes("test/tui.test.mjs"), "should include test/tui.test.mjs");
    assert.ok(!filtered.includes("lib/ipc/client.mjs"), "should not include lib/ipc/client.mjs");
    assert.ok(!filtered.includes("hooks/agent.py"), "should not include hooks/agent.py");
  });

  it("worker with scope filters decisions to relevant paths", () => {
    const prompt = [
      "KNOWN DECISIONS:\n- lib/tui/: use Bubble Tea framework\n- lib/ipc/: use JSON-RPC\n- use ESM modules everywhere",
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, "worker", "lib/tui/");

    assert.ok(filtered.includes("use Bubble Tea framework"), "should include TUI decision");
    assert.ok(filtered.includes("use ESM modules"), "should include generic decision");
    assert.ok(!filtered.includes("use JSON-RPC"), "should not include IPC decision");
  });

  it("verifier with large diff gets summarized version", () => {
    // Create a diff with > 500 lines
    const diffLines = ["GIT DIFF:", "diff --git a/file1.js b/file1.js", "--- a/file1.js", "+++ b/file1.js", "@@ -1,10 +1,10 @@"];
    for (let i = 0; i < 550; i++) {
      diffLines.push(`+line ${i}`);
    }
    const prompt = diffLines.join("\n");

    const filtered = filterContextSemantically(prompt, "verifier", null);

    // Should be shorter
    assert.ok(filtered.length < prompt.length, "should reduce diff size");
    // Should keep headers
    assert.ok(filtered.includes("diff --git"), "should keep diff headers");
    assert.ok(filtered.includes("@@ -1,10 +1,10 @@"), "should keep hunk headers");
    // Should have truncation message
    assert.ok(filtered.includes("[diff truncated for verifier context efficiency]"), "should have truncation message");
  });

  it("verifier with small diff is not truncated", () => {
    const prompt = [
      "GIT DIFF:",
      "diff --git a/file.js b/file.js",
      "--- a/file.js",
      "+++ b/file.js",
      "@@ -1,5 +1,5 @@",
      "+added line 1",
      "+added line 2",
      "-removed line",
    ].join("\n");

    const filtered = filterContextSemantically(prompt, "verifier", null);

    // Should not be truncated
    assert.ok(!filtered.includes("[diff truncated"), "should not truncate small diff");
    assert.equal(filtered.includes("added line 1"), true, "should keep all lines");
  });

  it("verifier summarizes worker outputs", () => {
    const prompt = [
      "WORKER OUTPUTS:",
      "agent-01: Starting task...",
      "agent-01: Reading file src/auth.ts",
      "agent-01: Modified src/auth.ts to add JWT support",
      "agent-01: Tool call: Read(src/api.ts)",
      "agent-01: Created new file src/middleware/auth.js",
      "agent-01: Analyzing dependencies...",
      "agent-01: Fixed bug in login handler",
    ].join("\n");

    const filtered = filterContextSemantically(prompt, "verifier", null);

    // Should keep action lines
    assert.ok(filtered.includes("Modified src/auth.ts"), "should keep modified line");
    assert.ok(filtered.includes("Created new file"), "should keep created line");
    assert.ok(filtered.includes("Fixed bug"), "should keep fixed line");
    // Should strip intermediate lines
    assert.ok(!filtered.includes("Starting task"), "should strip starting line");
    assert.ok(!filtered.includes("Reading file"), "should strip reading line");
  });

  it("decomposer gets directory-level summaries, not file-level", () => {
    const prompt = [
      "FILE CONTEXT:",
      "- lib/tui/model.go: TUI model",
      "- lib/tui/view.go: TUI view",
      "- lib/tui/ipc.go: TUI IPC",
      "- lib/ipc/client.mjs: IPC client",
      "- lib/ipc/server.mjs: IPC server",
      "- test/tui.test.mjs: TUI test",
      "- test/ipc.test.mjs: IPC test",
    ].join("\n");

    const filtered = filterContextSemantically(prompt, "decomposer", null);

    // Should have directory summaries
    assert.ok(filtered.includes("lib/tui/ — 3 files"), "should have lib/tui summary");
    assert.ok(filtered.includes("lib/ipc/ — 2 files"), "should have lib/ipc summary");
    assert.ok(filtered.includes("test/ — 2 files"), "should have test summary");
    // Should NOT have individual files
    assert.ok(!filtered.includes("model.go"), "should not have individual file");
    assert.ok(!filtered.includes("client.mjs"), "should not have individual file");
  });

  it("decomposer gets high-level scout report only", () => {
    const prompt = [
      "[Scout Report]",
      "Project structure: Node.js monorepo",
      "Main components: TUI (Go), Backend (Node.js)",
      "Dependencies: @anthropic-ai/sdk, bubbletea",
      "Code details: function processRequest() { ... }",
      "Module boundaries: lib/tui/, lib/ipc/",
      "More code: class Agent extends Base { ... }",
    ].join("\n");

    const filtered = filterContextSemantically(prompt, "decomposer", null);

    // Should keep structure info
    assert.ok(filtered.includes("Project structure"), "should keep structure line");
    assert.ok(filtered.includes("Main components"), "should keep components line");
    assert.ok(filtered.includes("Module boundaries"), "should keep boundaries line");
    // Should strip code details
    assert.ok(!filtered.includes("function processRequest"), "should strip code details");
    assert.ok(!filtered.includes("class Agent extends"), "should strip code details");
  });

  it("token reduction is measured correctly", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TypeScript\n- no external deps\n- follow style guide",
      "FILE CONTEXT:\n- lib/tui/foo.go: TUI\n- lib/ipc/bar.mjs: IPC\n- lib/context-filter.mjs: Filter\n- test/foo.test.mjs: Test",
      "KNOWN DECISIONS:\n- use Go for TUI\n- use Node.js for backend\n- use ESM modules",
      "GIT DIFF:\n" + "+line\n".repeat(100),
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, "worker", "lib/tui/");

    // Should have significant reduction (target >= 30%, test for >= 20% to be conservative)
    const reduction = ((1 - filtered.length / prompt.length) * 100);
    assert.ok(reduction >= 20, `should have >= 20% reduction, got ${reduction.toFixed(1)}%`);

    // Verify GIT DIFF was stripped (worker doesn't get it)
    assert.ok(!filtered.includes("GIT DIFF"), "worker should not have GIT DIFF");
  });

  it("unfiltered path works (no role set)", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TypeScript",
      "FILE CONTEXT:\n- lib/tui/foo.go: TUI\n- lib/ipc/bar.mjs: IPC",
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, undefined, null);

    // Should return unchanged (but will apply filterSystemPromptForRole which returns unchanged for unknown role)
    assert.equal(filtered, prompt, "should return prompt unchanged for undefined role");
  });

  it("unknown role returns section-filtered prompt", () => {
    const prompt = [
      "CONSTRAINTS:\n- use TypeScript",
      "FILE CONTEXT:\n- lib/tui/foo.go: TUI",
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, "unknown-role", null);

    // Should pass through filterSystemPromptForRole which returns unchanged for unknown roles
    assert.equal(filtered, prompt, "should return prompt unchanged for unknown role");
  });

  it("handles empty scope gracefully", () => {
    const prompt = [
      "FILE CONTEXT:\n- lib/tui/foo.go: TUI\n- lib/ipc/bar.mjs: IPC",
    ].join("\n\n");

    // Empty string scope
    const filtered1 = filterContextSemantically(prompt, "worker", "");
    assert.ok(filtered1.includes("lib/tui/foo.go"), "should include all files with empty scope");
    assert.ok(filtered1.includes("lib/ipc/bar.mjs"), "should include all files with empty scope");

    // Null scope
    const filtered2 = filterContextSemantically(prompt, "worker", null);
    assert.ok(filtered2.includes("lib/tui/foo.go"), "should include all files with null scope");
    assert.ok(filtered2.includes("lib/ipc/bar.mjs"), "should include all files with null scope");

    // Undefined scope
    const filtered3 = filterContextSemantically(prompt, "worker", undefined);
    assert.ok(filtered3.includes("lib/tui/foo.go"), "should include all files with undefined scope");
    assert.ok(filtered3.includes("lib/ipc/bar.mjs"), "should include all files with undefined scope");
  });

  it("handles scope array input", () => {
    const prompt = [
      "FILE CONTEXT:\n- lib/tui/foo.go: TUI\n- lib/ipc/bar.mjs: IPC\n- test/foo.test.mjs: Test",
    ].join("\n\n");

    const filtered = filterContextSemantically(prompt, "worker", ["lib/tui/", "test/"]);

    assert.ok(filtered.includes("lib/tui/foo.go"), "should include lib/tui/foo.go");
    assert.ok(filtered.includes("test/foo.test.mjs"), "should include test/foo.test.mjs");
    assert.ok(!filtered.includes("lib/ipc/bar.mjs"), "should not include lib/ipc/bar.mjs");
  });
});

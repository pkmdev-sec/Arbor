import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterContextForRole, filterSystemPromptForRole, filteringStats, getStrippedSections } from "../lib/context-filter.mjs";

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
});

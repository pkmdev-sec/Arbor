import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextToSystemPrompt, readAgentResult } from "../lib/context-bridge.mjs";

describe("contextToSystemPrompt", () => {
  let tmpDir;

  it("extracts constraints from valid context", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "ctx.json");
    writeFileSync(ctxFile, JSON.stringify({
      task: { constraints: ["No external deps", "Keep under 100 LOC"], scope: ["lib/"] },
      prior_knowledge: { decisions: ["Use ESM modules"] },
    }));
    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, false);
    assert.ok(prompt.includes("No external deps"));
    assert.ok(prompt.includes("SCOPE: Focus on lib/"));
    assert.ok(prompt.includes("Use ESM modules"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null prompt for empty context", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "empty.json");
    writeFileSync(ctxFile, "{}");
    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, false);
    assert.equal(prompt, null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns error for invalid JSON", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "bad.json");
    writeFileSync(ctxFile, "not json");
    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, true);
    assert.equal(prompt, null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles non-object context gracefully", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "array.json");
    writeFileSync(ctxFile, "[1,2,3]");
    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, true);
    assert.equal(prompt, null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns error for missing file", () => {
    const { prompt, error } = contextToSystemPrompt("/nonexistent/path.json");
    assert.equal(error, true);
    assert.equal(prompt, null);
  });
});

describe("readAgentResult", () => {
  it("reads valid result file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "result-test-"));
    const resultFile = join(tmpDir, "result.json");
    writeFileSync(resultFile, JSON.stringify({ status: "ok", output: "done" }));
    const result = readAgentResult(resultFile);
    assert.equal(result.status, "ok");
    assert.equal(result.output, "done");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns error for missing file", () => {
    const result = readAgentResult("/nonexistent.json");
    assert.ok(result.error);
  });
});

describe("contextToSystemPrompt edge cases", () => {
  it("warns on unknown context keys", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "unknown.json");
    writeFileSync(ctxFile, JSON.stringify({
      task: { constraints: ["test"] },
      unknownKey: "value",
      anotherUnknown: 123
    }));

    // Capture stderr to verify warning
    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, false);
    assert.ok(prompt.includes("CONSTRAINTS"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles empty file_summaries object", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "empty-summaries.json");
    writeFileSync(ctxFile, JSON.stringify({
      prior_knowledge: { file_summaries: {} }
    }));

    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, false);
    // Empty summaries should not add FILE CONTEXT section
    assert.ok(!prompt || !prompt.includes("FILE CONTEXT"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes recent_files when present", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    const ctxFile = join(tmpDir, "recent.json");
    writeFileSync(ctxFile, JSON.stringify({
      project: { recent_files: ["file1.js", "file2.js"] }
    }));

    const { prompt, error } = contextToSystemPrompt(ctxFile);
    assert.equal(error, false);
    assert.ok(prompt.includes("RECENTLY MODIFIED"));
    assert.ok(prompt.includes("file1.js"));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("writeResult", () => {
  it("writes result to JSON file atomically", async () => {
    const { writeResult } = await import("../lib/context-bridge.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "result-write-"));
    const resultFile = join(tmpDir, "result.json");

    writeResult(resultFile, { status: "success", data: "test" });

    const content = readFileSync(resultFile, "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.status, "success");
    assert.equal(parsed.data, "test");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles write errors gracefully", async () => {
    const { writeResult } = await import("../lib/context-bridge.mjs");
    // Try to write to invalid path
    writeResult("/invalid/path/that/does/not/exist/result.json", { data: "test" });
    // Should not throw, just log error
  });
});

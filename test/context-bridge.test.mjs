import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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

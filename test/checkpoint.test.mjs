import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CheckpointManager } from "../lib/checkpoint.mjs";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("CheckpointManager", () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    // Create temporary directory for each test
    tempDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    manager = new CheckpointManager(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates checkpoint directory on construction", () => {
    const checkpointDir = join(tempDir, "checkpoints");
    assert.ok(existsSync(checkpointDir));
  });

  it("saves and loads checkpoint", () => {
    const data = { result: "success", files: ["a.js", "b.js"] };
    manager.save(1, "decomposition", data);

    const loaded = manager.load(1);
    assert.ok(loaded);
    assert.equal(loaded.phase, 1);
    assert.equal(loaded.phaseName, "decomposition");
    assert.deepEqual(loaded.data, data);
  });

  it("checks if checkpoint exists", () => {
    assert.equal(manager.exists(1), false);
    manager.save(1, "decomposition", { result: "done" });
    assert.equal(manager.exists(1), true);
  });

  it("returns null for non-existent checkpoint", () => {
    const loaded = manager.load(99);
    assert.equal(loaded, null);
  });

  it("finds latest checkpoint", () => {
    manager.save(1, "decomposition", { step: 1 });
    manager.save(2, "implementation", { step: 2 });
    manager.save(3, "verification", { step: 3 });

    const latest = manager.findLatest();
    assert.ok(latest);
    assert.equal(latest.phase, 3);
    assert.equal(latest.phaseName, "verification");
    assert.deepEqual(latest.data, { step: 3 });
  });

  it("returns null when no checkpoints exist", () => {
    const latest = manager.findLatest();
    assert.equal(latest, null);
  });

  it("getResumePoint returns 1 when no checkpoints", () => {
    assert.equal(manager.getResumePoint(), 1);
  });

  it("getResumePoint returns next phase after latest", () => {
    manager.save(1, "decomposition", { step: 1 });
    manager.save(2, "implementation", { step: 2 });
    assert.equal(manager.getResumePoint(), 3);
  });

  it("cleanup removes all checkpoints", () => {
    manager.save(1, "decomposition", { step: 1 });
    manager.save(2, "implementation", { step: 2 });
    manager.save(3, "verification", { step: 3 });

    manager.cleanup();

    assert.equal(manager.exists(1), false);
    assert.equal(manager.exists(2), false);
    assert.equal(manager.exists(3), false);
  });

  it("sanitizes phase names in file paths", () => {
    manager.save(1, "Phase: Decomposition!", { step: 1 });
    const checkpointDir = join(tempDir, "checkpoints");
    const files = readdirSync(checkpointDir);
    const found = files.some(f => f.includes("phase-1-phase--decomposition"));
    assert.ok(found);
  });

  it("includes metadata in checkpoint", () => {
    const data = {
      result: "success",
      agentCount: 5,
      filesChanged: ["a.js", "b.js"],
      cost: 1.23,
    };
    manager.save(1, "decomposition", data);

    const loaded = manager.load(1);
    assert.ok(loaded.metadata);
    assert.equal(loaded.metadata.agentCount, 5);
    assert.deepEqual(loaded.metadata.filesChanged, ["a.js", "b.js"]);
    assert.equal(loaded.metadata.cost, 1.23);
  });

  it("includes timestamp in checkpoint", () => {
    const before = Date.now();
    manager.save(1, "decomposition", { result: "done" });
    const after = Date.now();

    const loaded = manager.load(1);
    assert.ok(loaded.timestamp >= before && loaded.timestamp <= after);
    assert.ok(loaded.timestampISO);
  });

  it("throws on invalid phase number", () => {
    assert.throws(() => manager.save(0, "test", {}), TypeError);
    assert.throws(() => manager.save(-1, "test", {}), TypeError);
    assert.throws(() => manager.save("not-a-number", "test", {}), TypeError);
  });

  it("throws on invalid phase name", () => {
    assert.throws(() => manager.save(1, "", {}), TypeError);
    assert.throws(() => manager.save(1, null, {}), TypeError);
    assert.throws(() => manager.save(1, 123, {}), TypeError);
  });

  it("throws on invalid data", () => {
    assert.throws(() => manager.save(1, "test", null), TypeError);
    assert.throws(() => manager.save(1, "test", "not-object"), TypeError);
  });

  it("throws on invalid workDir", () => {
    assert.throws(() => new CheckpointManager(""), TypeError);
    assert.throws(() => new CheckpointManager(null), TypeError);
    assert.throws(() => new CheckpointManager(123), TypeError);
  });

  it("handles multiple checkpoints for same phase", () => {
    manager.save(1, "decomposition", { version: 1 });
    manager.save(1, "decomposition-retry", { version: 2 });

    // Should load first matching checkpoint
    const loaded = manager.load(1);
    assert.ok(loaded);
    assert.equal(loaded.phase, 1);
  });

  it("handles empty data object", () => {
    manager.save(1, "empty", {});
    const loaded = manager.load(1);
    assert.ok(loaded);
    assert.deepEqual(loaded.data, {});
  });

  it("returns false for invalid phase in exists()", () => {
    assert.equal(manager.exists(0), false);
    assert.equal(manager.exists(-1), false);
    assert.equal(manager.exists("invalid"), false);
  });

  it("returns null for invalid phase in load()", () => {
    assert.equal(manager.load(0), null);
    assert.equal(manager.load(-1), null);
    assert.equal(manager.load("invalid"), null);
  });

  it("atomic write cleans up temp file on failure", () => {
    // Force a write failure by providing circular reference
    const circularData = {};
    circularData.self = circularData;

    assert.throws(() => manager.save(1, "test", circularData));

    const checkpointDir = join(tempDir, "checkpoints");
    const files = readdirSync(checkpointDir);
    const hasTmpFile = files.some(f => f.endsWith('.tmp'));
    assert.equal(hasTmpFile, false);
  });
});

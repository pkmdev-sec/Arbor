/**
 * Tests for Isolation Mechanisms
 *
 * Tests file snapshotting, backup, and worktree isolation for agent execution.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { snapshotFiles, backupFiles, snapshotFilesFiltered, snapshotFilesAsync, cacheSnapshot, getCachedSnapshot, cacheSnapshotAsync } from "../lib/isolation.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "arbor-isolation-test-"));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// ── snapshotFiles ────────────────────────────────────────────────────

describe("snapshotFiles", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns SHA-256 hashes for files in a directory", () => {
    writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.mjs"), "export const b = 2;\n");

    const manifest = snapshotFiles(dir, []);

    assert.ok(manifest["a.mjs"], "Should contain a.mjs");
    assert.ok(manifest["b.mjs"], "Should contain b.mjs");
    assert.equal(manifest["a.mjs"].hash, sha256("export const a = 1;\n"));
    assert.equal(manifest["b.mjs"].hash, sha256("export const b = 2;\n"));
  });

  it("includes file size", () => {
    const content = "hello world";
    writeFileSync(join(dir, "file.txt"), content);

    const manifest = snapshotFiles(dir, []);
    assert.equal(manifest["file.txt"].size, Buffer.byteLength(content));
  });

  it("includes mtimeMs", () => {
    writeFileSync(join(dir, "file.txt"), "content");

    const manifest = snapshotFiles(dir, []);
    assert.equal(typeof manifest["file.txt"].mtimeMs, "number");
    assert.ok(manifest["file.txt"].mtimeMs > 0);
  });

  it("walks nested directories", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "nested.js"), "// nested");

    const manifest = snapshotFiles(dir, []);
    assert.ok(manifest["sub/nested.js"], "Should contain nested file");
  });

  it("excludes directories matching exclude patterns", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg.js"), "// pkg");
    writeFileSync(join(dir, "main.js"), "// main");

    const manifest = snapshotFiles(dir, ["node_modules"]);

    assert.ok(manifest["main.js"], "Should contain main.js");
    assert.ok(!manifest["node_modules/pkg.js"], "Should exclude node_modules");
  });

  it("returns empty manifest for empty directory", () => {
    const manifest = snapshotFiles(dir, []);
    assert.deepEqual(manifest, {});
  });

  it("produces different hashes for different content", () => {
    writeFileSync(join(dir, "a.txt"), "aaa");
    writeFileSync(join(dir, "b.txt"), "bbb");

    const manifest = snapshotFiles(dir, []);
    assert.notEqual(manifest["a.txt"].hash, manifest["b.txt"].hash);
  });
});

// ── snapshotFilesFiltered ────────────────────────────────────────────

describe("snapshotFilesFiltered", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses cached hash when mtime and size match", () => {
    writeFileSync(join(dir, "file.mjs"), "const x = 1;");
    const preSnapshot = snapshotFiles(dir, []);

    // Take a filtered snapshot immediately (mtime/size should match)
    const filtered = snapshotFilesFiltered(dir, preSnapshot, [], []);
    assert.equal(filtered["file.mjs"].hash, preSnapshot["file.mjs"].hash);
  });

  it("re-hashes files in agentScope even if mtime matches", () => {
    writeFileSync(join(dir, "file.mjs"), "const x = 1;");
    const preSnapshot = snapshotFiles(dir, []);

    // Force a re-hash by putting the file in agentScope
    const filtered = snapshotFilesFiltered(dir, preSnapshot, ["file.mjs"], []);
    // Hash should still be the same (content unchanged), but the code path differs
    assert.equal(filtered["file.mjs"].hash, preSnapshot["file.mjs"].hash);
  });

  it("detects changed files", () => {
    writeFileSync(join(dir, "file.mjs"), "const x = 1;");
    const preSnapshot = snapshotFiles(dir, []);

    // Modify with different size to ensure detection
    writeFileSync(join(dir, "file.mjs"), "const x = 999999;");

    const filtered = snapshotFilesFiltered(dir, preSnapshot, [], []);
    assert.notEqual(filtered["file.mjs"].hash, preSnapshot["file.mjs"].hash);
  });
});

// ── snapshotFilesAsync ───────────────────────────────────────────────

describe("snapshotFilesAsync", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns same hashes as synchronous version", async () => {
    writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "b.mjs"), "export const b = 2;\n");

    const syncManifest = snapshotFiles(dir, []);
    const asyncManifest = await snapshotFilesAsync(dir, []);

    assert.equal(asyncManifest["a.mjs"].hash, syncManifest["a.mjs"].hash);
    assert.equal(asyncManifest["sub/b.mjs"].hash, syncManifest["sub/b.mjs"].hash);
  });
});

// ── backupFiles ──────────────────────────────────────────────────────

describe("backupFiles", () => {
  let mainDir;
  let backupDir;

  beforeEach(() => {
    mainDir = makeTempDir();
    backupDir = join(makeTempDir(), "backups");
  });

  afterEach(() => {
    rmSync(mainDir, { recursive: true, force: true });
    // backupDir parent was created with makeTempDir
    const parent = join(backupDir, "..");
    rmSync(parent, { recursive: true, force: true });
  });

  it("creates backup copies of files matching BACKUP_EXTENSIONS", () => {
    writeFileSync(join(mainDir, "app.mjs"), "// app code");
    writeFileSync(join(mainDir, "config.json"), '{"key": "value"}');
    writeFileSync(join(mainDir, "readme.md"), "# Readme");

    // Build a snapshot that includes these files
    const snapshot = snapshotFiles(mainDir, []);

    const count = backupFiles(mainDir, backupDir, snapshot);

    // .mjs and .json should be backed up, .md should not (per BACKUP_EXTENSIONS regex)
    assert.ok(existsSync(join(backupDir, "app.mjs")), "Should backup .mjs file");
    assert.ok(existsSync(join(backupDir, "config.json")), "Should backup .json file");
    assert.ok(!existsSync(join(backupDir, "readme.md")), "Should not backup .md file");
    assert.equal(count, 2);
  });

  it("preserves file content in backups", () => {
    const content = "export function hello() { return 'world'; }\n";
    writeFileSync(join(mainDir, "mod.mjs"), content);

    const snapshot = snapshotFiles(mainDir, []);
    backupFiles(mainDir, backupDir, snapshot);

    const backedUp = readFileSync(join(backupDir, "mod.mjs"), "utf-8");
    assert.equal(backedUp, content);
  });

  it("handles nested directory structures", () => {
    mkdirSync(join(mainDir, "lib", "utils"), { recursive: true });
    writeFileSync(join(mainDir, "lib", "utils", "helper.js"), "// helper");

    const snapshot = snapshotFiles(mainDir, []);
    const count = backupFiles(mainDir, backupDir, snapshot);

    assert.ok(existsSync(join(backupDir, "lib", "utils", "helper.js")));
    assert.equal(count, 1);
  });

  it("returns 0 for empty snapshot", () => {
    const count = backupFiles(mainDir, backupDir, {});
    assert.equal(count, 0);
  });

  it("creates the backup directory if it does not exist", () => {
    writeFileSync(join(mainDir, "file.js"), "// code");
    const snapshot = snapshotFiles(mainDir, []);

    const deepBackup = join(backupDir, "deep", "nested");
    backupFiles(mainDir, deepBackup, snapshot);

    assert.ok(existsSync(join(deepBackup, "file.js")));
  });
});

// ── cacheSnapshot / getCachedSnapshot ────────────────────────────────

describe("cacheSnapshot / getCachedSnapshot", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("caches and retrieves snapshot for the same directory", () => {
    writeFileSync(join(dir, "f.js"), "// f");

    const snapshot = cacheSnapshot(dir, []);
    const cached = getCachedSnapshot(dir);

    assert.deepEqual(cached, snapshot);
  });

  it("returns null for a different directory", () => {
    writeFileSync(join(dir, "f.js"), "// f");
    cacheSnapshot(dir, []);

    const cached = getCachedSnapshot("/some/other/dir");
    assert.equal(cached, null);
  });
});

// ── cacheSnapshotAsync ───────────────────────────────────────────────

describe("cacheSnapshotAsync", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a valid snapshot asynchronously", async () => {
    writeFileSync(join(dir, "a.mjs"), "export const a = 1;");

    const snapshot = await cacheSnapshotAsync(dir, []);
    assert.ok(snapshot["a.mjs"]);
    assert.equal(typeof snapshot["a.mjs"].hash, "string");
    assert.equal(snapshot["a.mjs"].hash.length, 64); // SHA-256 hex = 64 chars
  });
});

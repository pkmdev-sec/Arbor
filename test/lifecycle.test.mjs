import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerCleanupHandler,
  unregisterCleanupHandler,
  executeCleanup,
  cleanOldRuns,
  cleanupTeamDir,
} from "../lib/lifecycle.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "arbor-lifecycle-test-"));
}

// ── registerCleanupHandler / executeCleanup ──────────────────────────

describe("registerCleanupHandler", () => {
  it("throws TypeError for non-function argument", () => {
    assert.throws(() => registerCleanupHandler("not a function"), {
      name: "TypeError",
      message: "Cleanup handler must be a function",
    });
  });

  it("throws TypeError for null", () => {
    assert.throws(() => registerCleanupHandler(null), {
      name: "TypeError",
    });
  });
});

describe("unregisterCleanupHandler", () => {
  it("removes a previously registered handler", async () => {
    let called = false;
    const handler = () => { called = true; };

    registerCleanupHandler(handler);
    unregisterCleanupHandler(handler);
    await executeCleanup();

    assert.equal(called, false, "Handler should not be called after unregistration");
  });
});

describe("executeCleanup", () => {
  it("calls all registered handlers", async () => {
    const calls = [];
    const h1 = () => calls.push("h1");
    const h2 = () => calls.push("h2");

    registerCleanupHandler(h1);
    registerCleanupHandler(h2);

    await executeCleanup();

    assert.ok(calls.includes("h1"), "h1 should have been called");
    assert.ok(calls.includes("h2"), "h2 should have been called");
  });

  it("clears handlers after execution", async () => {
    let callCount = 0;
    const handler = () => callCount++;

    registerCleanupHandler(handler);
    await executeCleanup();
    await executeCleanup(); // second call should have no handlers

    assert.equal(callCount, 1, "Handler should only be called once");
  });

  it("continues executing remaining handlers when one throws", async () => {
    const calls = [];
    const badHandler = () => { throw new Error("oops"); };
    const goodHandler = () => calls.push("good");

    registerCleanupHandler(badHandler);
    registerCleanupHandler(goodHandler);

    await executeCleanup();

    assert.ok(calls.includes("good"), "Good handler should still run despite earlier failure");
  });

  it("supports async handlers", async () => {
    let resolved = false;
    const asyncHandler = async () => {
      await new Promise(r => setTimeout(r, 10));
      resolved = true;
    };

    registerCleanupHandler(asyncHandler);
    await executeCleanup();

    assert.ok(resolved, "Async handler should complete");
  });
});

// ── cleanOldRuns ─────────────────────────────────────────────────────

describe("cleanOldRuns", () => {
  let swarmBase;

  beforeEach(() => {
    swarmBase = makeTempDir();
  });

  afterEach(() => {
    rmSync(swarmBase, { recursive: true, force: true });
  });

  it("does nothing when swarmBase is null", () => {
    // Should not throw
    cleanOldRuns(null);
  });

  it("does nothing when swarmBase does not exist", () => {
    cleanOldRuns("/tmp/nonexistent-arbor-test-dir-" + Date.now());
  });

  it("removes directories older than TTL", () => {
    // Create an old directory
    const oldDir = join(swarmBase, "old-run");
    mkdirSync(oldDir, { recursive: true });

    // Set mtime to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(oldDir, oldTime, oldTime);

    // Default TTL is 24h (env var SWARM_TTL_HOURS)
    const originalTtl = process.env.SWARM_TTL_HOURS;
    process.env.SWARM_TTL_HOURS = "24";

    try {
      cleanOldRuns(swarmBase);
      assert.ok(!existsSync(oldDir), "Old directory should be removed");
    } finally {
      if (originalTtl !== undefined) {
        process.env.SWARM_TTL_HOURS = originalTtl;
      } else {
        delete process.env.SWARM_TTL_HOURS;
      }
    }
  });

  it("keeps directories newer than TTL", () => {
    // Create a fresh directory (just created = recent mtime)
    const freshDir = join(swarmBase, "fresh-run");
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, "marker"), "data");

    const originalTtl = process.env.SWARM_TTL_HOURS;
    process.env.SWARM_TTL_HOURS = "24";

    try {
      cleanOldRuns(swarmBase);
      assert.ok(existsSync(freshDir), "Fresh directory should be kept");
    } finally {
      if (originalTtl !== undefined) {
        process.env.SWARM_TTL_HOURS = originalTtl;
      } else {
        delete process.env.SWARM_TTL_HOURS;
      }
    }
  });

  it("caps cleanup to 50 directories", () => {
    // Create 55 old directories
    for (let i = 0; i < 55; i++) {
      const d = join(swarmBase, `run-${String(i).padStart(3, "0")}`);
      mkdirSync(d, { recursive: true });
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      utimesSync(d, oldTime, oldTime);
    }

    const originalTtl = process.env.SWARM_TTL_HOURS;
    process.env.SWARM_TTL_HOURS = "24";

    try {
      cleanOldRuns(swarmBase);
      // At most 50 should be processed (some may remain)
      const remaining = readdirSync(swarmBase);
      assert.ok(remaining.length >= 5, "At least 5 directories should remain (55 - 50 cap)");
    } finally {
      if (originalTtl !== undefined) {
        process.env.SWARM_TTL_HOURS = originalTtl;
      } else {
        delete process.env.SWARM_TTL_HOURS;
      }
    }
  });
});

// ── cleanupTeamDir ───────────────────────────────────────────────────

describe("cleanupTeamDir", () => {
  it("does nothing when teamName is null", () => {
    // Should not throw
    cleanupTeamDir(null);
  });

  it("does nothing when teamName is empty string", () => {
    cleanupTeamDir("");
  });

  it("does nothing when team directory does not exist", () => {
    // Should not throw even if directory doesn't exist
    cleanupTeamDir("nonexistent-team-" + Date.now());
  });
});

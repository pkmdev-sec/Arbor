import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import LearningStore from "../lib/learning.mjs";

const STORE_PATH = join(homedir(), ".arbor", "learning-store.json");
const BACKUP_PATH = STORE_PATH + ".test-backup";

describe("LearningStore", () => {
  // Backup and restore the real store around tests
  before(() => {
    if (existsSync(STORE_PATH)) {
      writeFileSync(BACKUP_PATH, readFileSync(STORE_PATH));
    }
  });

  after(() => {
    if (existsSync(BACKUP_PATH)) {
      writeFileSync(STORE_PATH, readFileSync(BACKUP_PATH));
      unlinkSync(BACKUP_PATH);
    } else if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }
  });

  it("creates empty store if file doesn't exist", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    assert.ok(store.store);
    assert.equal(store.store.version, 1);
    assert.deepEqual(store.store.patterns, {});
    assert.deepEqual(store.store.deadEnds, {});
    assert.deepEqual(store.store.promptHints, {});
  });

  it("records a pattern", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.record("refactor", "javascript", "react", {
      approach: "hooks",
      success: true,
    });

    const key = "refactor:javascript:react";
    assert.ok(store.store.patterns[key]);
    assert.equal(store.store.patterns[key].count, 1);
    assert.equal(store.store.patterns[key].status, "staged");
  });

  it("increments count on repeated patterns", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.record("bugfix", "python", "django", { fix: "async" });
    store.record("bugfix", "python", "django", { fix: "async" });

    const key = "bugfix:python:django";
    assert.equal(store.store.patterns[key].count, 2);
  });

  it("records dead ends", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.recordDeadEnd("optimization", "Too aggressive caching", [
      "Low traffic site",
      "Simple data model",
    ]);

    assert.ok(store.store.deadEnds.optimization);
    assert.equal(store.store.deadEnds.optimization.length, 1);
    assert.equal(store.store.deadEnds.optimization[0].reason, "Too aggressive caching");
  });

  it("limits dead ends per task type to 10", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Add 15 dead ends
    for (let i = 0; i < 15; i++) {
      store.recordDeadEnd("test", `Reason ${i}`, []);
    }

    // Should keep only the 10 most recent
    assert.equal(store.store.deadEnds.test.length, 10);
  });

  it("records prompt hints", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.recordPromptHint("parallel", "Always specify file scope");

    assert.ok(store.store.promptHints.parallel);
    assert.equal(store.store.promptHints.parallel.length, 1);
    assert.equal(store.store.promptHints.parallel[0].useCount, 1);
  });

  it("increments use count for duplicate hints", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.recordPromptHint("sequential", "Check dependencies first");
    store.recordPromptHint("sequential", "Check dependencies first");

    assert.equal(store.store.promptHints.sequential.length, 1);
    assert.equal(store.store.promptHints.sequential[0].useCount, 2);
  });

  it("queries patterns with freshness decay", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Record pattern twice to meet promotion requirements
    store.record("feature", "typescript", "vue", { approach: "composition-api" });

    // Manually add second project to meet 2-project requirement
    const key = "feature:typescript:vue";
    store.store.patterns[key].projects.add("other-project");

    // Promote to active
    store.promote();

    const results = store.query("feature", "typescript", "vue");

    assert.equal(results.length, 1);
    assert.ok(results[0].freshness > 0.9); // Recent pattern
    assert.ok(results[0].relevance > 0);
  });

  it("returns empty array for non-existent patterns", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    const results = store.query("nonexistent", "language", "framework");

    assert.deepEqual(results, []);
  });

  it("returns empty array for staged patterns", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.record("feature", "typescript", "vue", { approach: "composition-api" });

    // Pattern is staged, not active
    const results = store.query("feature", "typescript", "vue");
    assert.deepEqual(results, []);
  });

  it("gets dead ends for task type", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.recordDeadEnd("perf", "Premature optimization", []);

    const deadEnds = store.getDeadEnds("perf");
    assert.equal(deadEnds.length, 1);
    assert.equal(deadEnds[0].reason, "Premature optimization");
  });

  it("gets prompt hints sorted by use count", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.recordPromptHint("parallel", "Hint A");
    store.recordPromptHint("parallel", "Hint B");
    store.recordPromptHint("parallel", "Hint B"); // useCount = 2
    store.recordPromptHint("parallel", "Hint B"); // useCount = 3

    const hints = store.getPromptHints("parallel");
    assert.equal(hints[0].hint, "Hint B"); // Most used first
    assert.equal(hints[0].useCount, 3);
  });

  it("promotes staged patterns to active after 2 observations from different projects", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Record pattern twice (simulating 2 different projects)
    store.record("refactor", "go", "gin", { pattern: "middleware" });

    // Manually add a second project to simulate cross-project observation
    const key = "refactor:go:gin";
    store.store.patterns[key].projects.add("other-project");

    const promoted = store.promote();

    assert.equal(promoted, 1);
    assert.equal(store.store.patterns[key].status, "active");
  });

  it("does not promote patterns with insufficient observations", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.record("feature", "rust", "actix", { pattern: "handlers" });

    const promoted = store.promote();

    assert.equal(promoted, 0);
    const key = "feature:rust:actix";
    assert.equal(store.store.patterns[key].status, "staged");
  });

  it("prunes stale patterns", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Add a pattern and manually set lastSeen to 2 years ago
    store.record("old", "perl", "catalyst", { old: true });
    const key = "old:perl:catalyst";
    const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    store.store.patterns[key].lastSeen = twoYearsAgo;
    store._save();

    const pruned = store.prune();

    assert.equal(pruned, 1);
    assert.ok(!store.store.patterns[key]);
  });

  it("persists data to disk", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store1 = new LearningStore();
    store1.record("test", "java", "spring", { data: "persistence" });

    // Create new instance - should load from disk
    const store2 = new LearningStore();
    const key = "test:java:spring";

    assert.ok(store2.store.patterns[key]);
    assert.equal(store2.store.patterns[key].pattern.data, "persistence");
  });

  it("handles corrupt store file gracefully", () => {
    // Write invalid JSON
    writeFileSync(STORE_PATH, "{ invalid json", "utf-8");

    // Should create empty store instead of crashing
    const store = new LearningStore();

    assert.ok(store.store);
    assert.equal(store.store.version, 1);
  });

  it("records pattern with projectType", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();
    store.record("refactor", "javascript", "react", { approach: "hooks" }, "web_app");

    const key = "refactor:javascript:react:web_app";
    assert.ok(store.store.patterns[key]);
    assert.equal(store.store.patterns[key].projectType, "web_app");
    assert.equal(store.store.patterns[key].count, 1);
    assert.equal(store.store.patterns[key].status, "staged");
  });

  it("queryWithFallback returns exact projectType match", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Record pattern with projectType
    store.record("feature", "typescript", "express", { approach: "middleware" }, "web_app");

    // Manually add second project and promote to active
    const key = "feature:typescript:express:web_app";
    store.store.patterns[key].projects.add("other-project");
    store.promote();

    // Query with projectType should return exact match
    const results = store.queryWithFallback("feature", "typescript", "express", "web_app");

    assert.equal(results.length, 1);
    assert.equal(results[0].projectType, "web_app");
    assert.ok(results[0].freshness > 0.9);
  });

  it("queryWithFallback falls back to base key when no exact projectType match", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Record pattern without projectType (base key)
    store.record("bugfix", "python", "flask", { fix: "validation" });

    // Manually add second project and promote to active
    const key = "bugfix:python:flask";
    store.store.patterns[key].projects.add("other-project");
    store.promote();

    // Query with projectType should fall back to base key
    const results = store.queryWithFallback("bugfix", "python", "flask", "cli_tool");

    assert.equal(results.length, 1);
    assert.equal(results[0].projectType, ""); // Base key has empty projectType
    assert.ok(results[0].freshness > 0.9);
  });

  it("cross-project-type isolation: web_app pattern does not appear in cli_tool query", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Record pattern for web_app projectType
    store.record("optimization", "go", "gin", { strategy: "caching" }, "web_app");

    // Manually add second project and promote to active
    const webKey = "optimization:go:gin:web_app";
    store.store.patterns[webKey].projects.add("other-project");
    store.promote();

    // Query with different projectType should not return web_app pattern
    // (no fallback because there's no base key pattern)
    const results = store.queryWithFallback("optimization", "go", "gin", "cli_tool");

    assert.equal(results.length, 0);
  });

  it("queryWithFallback prefers exact projectType match over base key", () => {
    if (existsSync(STORE_PATH)) {
      unlinkSync(STORE_PATH);
    }

    const store = new LearningStore();

    // Record base pattern (no projectType)
    store.record("deploy", "javascript", "node", { approach: "docker" });
    const baseKey = "deploy:javascript:node";
    store.store.patterns[baseKey].projects.add("other-project");

    // Record specific pattern for web_app
    store.record("deploy", "javascript", "node", { approach: "kubernetes" }, "web_app");
    const specificKey = "deploy:javascript:node:web_app";
    store.store.patterns[specificKey].projects.add("other-project");

    // Promote both
    store.promote();

    // Query with projectType should return the specific match, not base
    const results = store.queryWithFallback("deploy", "javascript", "node", "web_app");

    assert.equal(results.length, 1);
    assert.equal(results[0].projectType, "web_app");
    assert.equal(results[0].pattern.approach, "kubernetes");
  });
});

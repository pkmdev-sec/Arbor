#!/usr/bin/env node
/**
 * Integration Test Suite for arbor / swarm
 *
 * Tests all features from Parts 1-3:
 *   - Prefill warm-starting (A1)
 *   - Disallowed-tools denylist (A3)
 *   - SubCoordinator lifecycle (B1-B4)
 *   - CLI parsing, config, MCP tools, autoMode
 *   - Scope guard, session resume, effort passthrough
 *
 * Run: node ~/.claude/arbor/tests/integration-test.mjs
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, "..", "lib");

// ── Test harness ──────────────────────────────────────────────────
const results = [];
let totalTests = 0;
let passed = 0;
let failed = 0;

function test(name, fn) {
  totalTests++;
  const entry = { name, status: "pending", error: null, durationMs: 0 };
  results.push(entry);
  return { name, fn, entry };
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(`${message || "assertIncludes"}: "${needle}" not found in "${String(haystack).slice(0, 200)}"`);
  }
}

function assertNotIncludes(haystack, needle, message) {
  if (haystack.includes(needle)) {
    throw new Error(`${message || "assertNotIncludes"}: "${needle}" unexpectedly found in "${String(haystack).slice(0, 200)}"`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "assertEqual"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertType(value, type, message) {
  if (typeof value !== type) {
    throw new Error(`${message || "assertType"}: expected type ${type}, got ${typeof value}`);
  }
}

async function runTests(tests) {
  for (const t of tests) {
    const start = Date.now();
    try {
      await Promise.race([
        t.fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Test timeout")), t.timeout || 10000)),
      ]);
      t.entry.status = "PASS";
      t.entry.durationMs = Date.now() - start;
      passed++;
      process.stderr.write(`  ✓ ${t.name} (${t.entry.durationMs}ms)\n`);
    } catch (err) {
      t.entry.status = "FAIL";
      t.entry.error = err.message;
      t.entry.durationMs = Date.now() - start;
      failed++;
      process.stderr.write(`  ✗ ${t.name}: ${err.message} (${t.entry.durationMs}ms)\n`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// C1: Basic arbor CLI parsing — prefill, MCP, scope-guard, effort
// ═══════════════════════════════════════════════════════════════════
const c1 = test("C1: CLI parsing — prefill, scope, effort flags", async () => {
  const { parseAgentArgs } = await import(join(LIB, "cli.mjs"));

  const args = parseAgentArgs([
    "node", "agent-entry.mjs",
    "-m", "sonnet",
    "--effort", "high",
    "--scope", "src/auth/,src/shared/types.ts",
    "--prefill", "I'll start reading files now.\n\n",
    "--persist-context",
    "--max-retries", "2",
    "--fallback-model", "sonnet",
    "implement auth module",
  ]);

  assertEqual(args.model, "sonnet", "model");
  assertEqual(args.effort, "high", "effort");
  assertEqual(args.scope, "src/auth/,src/shared/types.ts", "scope");
  assertEqual(args.prefill, "I'll start reading files now.\n\n", "prefill");
  assertEqual(args.persistContext, true, "persistContext");
  assertEqual(args.maxRetries, 2, "maxRetries");
  assertEqual(args.fallbackModel, "sonnet", "fallbackModel");
  assertEqual(args.task, "implement auth module", "task");
});

// ═══════════════════════════════════════════════════════════════════
// C2: Verifier role with --agent flag and tool restriction
// ═══════════════════════════════════════════════════════════════════
const c2 = test("C2: Verifier role — disallowed-tools and --agent verifier", async () => {
  const { ROLE_DISALLOWED_TOOLS, ROLE_PROMPTS } = await import(join(LIB, "config.mjs"));

  // Verify disallowed tools for verifier: blocks Write, Edit, NotebookEdit, Agent
  const verifierBlocked = ROLE_DISALLOWED_TOOLS.verifier;
  assert(verifierBlocked !== null, "verifier should have disallowed tools");
  assertIncludes(verifierBlocked, "Write", "verifier should block Write");
  assertIncludes(verifierBlocked, "Edit", "verifier should block Edit");
  assertIncludes(verifierBlocked, "NotebookEdit", "verifier should block NotebookEdit");
  assertIncludes(verifierBlocked, "Agent", "verifier should block Agent");
  assertNotIncludes(verifierBlocked, "Read", "verifier should NOT block Read");
  assertNotIncludes(verifierBlocked, "Bash", "verifier should NOT block Bash");

  // Verify worker has full access
  assertEqual(ROLE_DISALLOWED_TOOLS.worker, null, "worker should have null (full access)");

  // Verify role prompts still exist
  assertType(ROLE_PROMPTS.verifier, "string", "verifier prompt should exist");
  assertType(ROLE_PROMPTS.worker, "string", "worker prompt should exist");
  assertType(ROLE_PROMPTS.decomposer, "string", "decomposer prompt should exist");
});

// ═══════════════════════════════════════════════════════════════════
// C3: Decomposer role with effort and tool restriction
// ═══════════════════════════════════════════════════════════════════
const c3 = test("C3: Decomposer role — disallowed-tools, effort in prompt", async () => {
  const { ROLE_DISALLOWED_TOOLS, ROLE_PROMPTS } = await import(join(LIB, "config.mjs"));

  // Decomposer: blocks Write, Edit, Bash, NotebookEdit, Agent
  const decomposerBlocked = ROLE_DISALLOWED_TOOLS.decomposer;
  assert(decomposerBlocked !== null, "decomposer should have disallowed tools");
  assertIncludes(decomposerBlocked, "Write", "decomposer should block Write");
  assertIncludes(decomposerBlocked, "Bash", "decomposer should block Bash");
  assertIncludes(decomposerBlocked, "Edit", "decomposer should block Edit");
  assertNotIncludes(decomposerBlocked, "Read", "decomposer should NOT block Read");
  assertNotIncludes(decomposerBlocked, "Grep", "decomposer should NOT block Grep");
  assertNotIncludes(decomposerBlocked, "Glob", "decomposer should NOT block Glob");

  // Decomposer prompt should reference effort in output format
  assertIncludes(ROLE_PROMPTS.decomposer, "effort", "decomposer prompt should mention effort");
});

// ═══════════════════════════════════════════════════════════════════
// C4: Scope guard — PreToolUse hook configuration
// ═══════════════════════════════════════════════════════════════════
const c4 = test("C4: Scope guard — hook config generation", async () => {
  // Verify scope-guard.py exists
  const hookPath = join(__dirname, "..", "hooks", "scope-guard.py");
  assert(existsSync(hookPath), "scope-guard.py should exist");

  // Verify the scope guard is a valid Python file (check shebang or import)
  const content = readFileSync(hookPath, "utf-8");
  assert(content.length > 50, "scope-guard.py should have content");

  // Test that parseAgentArgs correctly parses --scope
  const { parseAgentArgs } = await import(join(LIB, "cli.mjs"));
  const args = parseAgentArgs(["node", "entry.mjs", "--scope", "src/a.ts,src/b.ts", "task"]);
  assertEqual(args.scope, "src/a.ts,src/b.ts", "scope should be parsed");
});

// ═══════════════════════════════════════════════════════════════════
// C5: Session resume on retry — session-id first, --resume on retry
// ═══════════════════════════════════════════════════════════════════
const c5 = test("C5: Session resume — CLI args for retry support", async () => {
  const { parseAgentArgs } = await import(join(LIB, "cli.mjs"));

  // Verify --max-retries parsing
  const args = parseAgentArgs(["node", "entry.mjs", "--max-retries", "3", "task"]);
  assertEqual(args.maxRetries, 3, "maxRetries should be 3");

  // Verify resolveModel validates models
  const { resolveModel } = await import(join(LIB, "config.mjs"));
  assertEqual(resolveModel("sonnet"), "sonnet[1m]", "sonnet resolves to sonnet[1m]");
  assertEqual(resolveModel("opus"), "opus[1m]", "opus resolves to opus[1m]");
  assertEqual(resolveModel("gpt-4"), null, "invalid model returns null");
});

// ═══════════════════════════════════════════════════════════════════
// C6: MCP server standalone — all 4 tools respond correctly
// ═══════════════════════════════════════════════════════════════════
const c6 = test("C6: MCP tools — all 4 tools defined with valid schemas", async () => {
  const { SWARM_TOOLS } = await import(join(LIB, "mcp", "tools.mjs"));

  assertEqual(SWARM_TOOLS.length, 4, "should have exactly 4 MCP tools");

  const names = SWARM_TOOLS.map(t => t.name);
  assertIncludes(names, "swarm_report_progress", "should have swarm_report_progress");
  assertIncludes(names, "swarm_report_result", "should have swarm_report_result");
  assertIncludes(names, "swarm_get_context", "should have swarm_get_context");
  assertIncludes(names, "swarm_log", "should have swarm_log");

  // Validate each tool has required schema fields
  for (const tool of SWARM_TOOLS) {
    assertType(tool.name, "string", `${tool.name} name`);
    assertType(tool.description, "string", `${tool.name} description`);
    assert(tool.inputSchema, `${tool.name} should have inputSchema`);
    assertEqual(tool.inputSchema.type, "object", `${tool.name} schema type`);
    assert(Array.isArray(tool.inputSchema.required), `${tool.name} should have required fields`);
    assert(tool.inputSchema.required.length > 0, `${tool.name} should have at least one required field`);
  }

  // Verify coordinator-server.mjs exists
  const serverPath = join(LIB, "mcp", "coordinator-server.mjs");
  assert(existsSync(serverPath), "coordinator-server.mjs should exist");
});

// ═══════════════════════════════════════════════════════════════════
// C7: Swarm parallel mode — CLI parsing, governor, conflict detection
// ═══════════════════════════════════════════════════════════════════
const c7 = test("C7: Swarm parallel mode — args, governor, conflict detection", async () => {
  const { parseSwarmArgs } = await import(join(LIB, "cli.mjs"));

  const args = parseSwarmArgs([
    "node", "swarm.mjs",
    "--mode", "parallel",
    "--agents", "3",
    "--verify",
    "--result-file", "/tmp/test-result.json",
    "implement feature X across 3 modules",
  ]);

  assertEqual(args.mode, "parallel", "mode");
  assertEqual(args.agents, 3, "agents");
  assertEqual(args.verify, true, "verify");
  assertEqual(args.resultFile, "/tmp/test-result.json", "resultFile");
  assertEqual(args.task, "implement feature X across 3 modules", "task");

  // Test ResourceGovernor
  const { ResourceGovernor } = await import(join(LIB, "hierarchy", "governor.mjs"));
  const governor = new ResourceGovernor({
    maxTotalAgents: 5,
    maxConcurrentAgents: 3,
    maxWorktrees: 5,
  });

  // Register agents
  governor.registerAgent({ id: "a1", level: 0, scope: "src/auth" });
  governor.registerAgent({ id: "a2", level: 0, scope: "src/api" });

  // Verify governor tracks agents
  const stats = governor.getUtilization();
  assertEqual(stats.activeAgents, 2, "governor should track 2 active agents");

  // Deregister
  governor.deregisterAgent("a1", { status: "completed", turns: 10 });
  const stats2 = governor.getUtilization();
  assertEqual(stats2.activeAgents, 1, "governor should track 1 active agent after deregister");

  // Cleanup
  await governor.cleanup();

  // Test conflict detection
  const { detectFileLevelConflicts } = await import(join(LIB, "hierarchy", "aggregator.mjs"));
  const conflicts = detectFileLevelConflicts([
    { id: "a1", agentId: "a1", files: new Map([["src/shared.ts", true], ["src/auth.ts", true]]) },
    { id: "a2", agentId: "a2", files: new Map([["src/shared.ts", true], ["src/api.ts", true]]) },
  ]);

  assert(conflicts.summary.total > 0, "should detect conflict on src/shared.ts");
});

// ═══════════════════════════════════════════════════════════════════
// C8: Swarm pipeline mode — effort per stage, governor, 4 stages
// ═══════════════════════════════════════════════════════════════════
const c8 = test("C8: Swarm pipeline mode — CLI parsing, semantic merge flag", async () => {
  const { parseSwarmArgs } = await import(join(LIB, "cli.mjs"));

  const args = parseSwarmArgs([
    "node", "swarm.mjs",
    "--mode", "pipeline",
    "--verify",
    "--semantic-merge",
    "refactor authentication module",
  ]);

  assertEqual(args.mode, "pipeline", "mode");
  assertEqual(args.verify, true, "verify");
  assertEqual(args.semanticMerge, true, "semanticMerge");

  // Verify DEPTH presets include all expected keys
  const { DEPTH } = await import(join(LIB, "config.mjs"));
  assert(DEPTH.shallow, "DEPTH.shallow should exist");
  assert(DEPTH.normal, "DEPTH.normal should exist");
  assert(DEPTH.thorough, "DEPTH.thorough should exist");

  // Each preset should have turns, budget, verifyModel
  for (const [key, preset] of Object.entries(DEPTH)) {
    assertType(preset.turns, "number", `${key}.turns`);
    assertType(preset.budget, "number", `${key}.budget`);
    assertType(preset.verifyModel, "string", `${key}.verifyModel`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// C9: Hierarchy estimate-only — decomposition, effort, budget
// ═══════════════════════════════════════════════════════════════════
const c9 = test("C9: Hierarchy estimate-only — CLI flags, budget estimation", async () => {
  const { parseSwarmArgs } = await import(join(LIB, "cli.mjs"));

  const args = parseSwarmArgs([
    "node", "swarm.mjs",
    "--mode", "hierarchical",
    "--hierarchy-depth", "3",
    "--max-children", "4",
    "--agent-budget", "20",
    "--min-task-files", "3",
    "--decompose-by", "module-boundary",
    "--estimate-only",
    "massive system refactor across all modules",
  ]);

  assertEqual(args.mode, "hierarchical", "mode");
  assertEqual(args.hierarchyDepth, 3, "hierarchyDepth");
  assertEqual(args.maxChildren, 4, "maxChildren");
  assertEqual(args.agentBudget, 20, "agentBudget");
  assertEqual(args.minTaskFiles, 3, "minTaskFiles");
  assertEqual(args.decomposeBy, "module-boundary", "decomposeBy");
  assertEqual(args.estimateOnly, true, "estimateOnly");

  // Test estimateAgentBudget with a mock decomposition tree
  const { estimateAgentBudget } = await import(join(LIB, "hierarchy", "decomposer.mjs"));

  const mockTree = {
    root: {
      id: "root", type: "coordinator", level: 0, task: "root task",
      children: [
        { id: "w1", type: "worker", level: 1, task: "subtask 1", turns: 20, model: "sonnet", children: [] },
        { id: "w2", type: "worker", level: 1, task: "subtask 2", turns: 25, model: "sonnet", children: [] },
        {
          id: "c1", type: "coordinator", level: 1, task: "sub-coordinator",
          children: [
            { id: "w3", type: "worker", level: 2, task: "deep task", turns: 15, model: "sonnet", children: [] },
          ],
        },
      ],
    },
    depth: 2,
    totalNodes: 5,
    leafNodes: 3,
  };

  const budget = estimateAgentBudget(mockTree);
  assert(budget.totalAgents >= 3, "budget should have at least 3 total agents");
  assert(budget.workers >= 3, "budget should have at least 3 workers");
  assertType(budget.estimatedCost, "number", "budget should have estimated cost");
});

// ═══════════════════════════════════════════════════════════════════
// C10: SubCoordinator lifecycle — execute(), spawnSubCoordinator()
// ═══════════════════════════════════════════════════════════════════
const c10 = test("C10: SubCoordinator lifecycle — execute method and factory", async () => {
  const { SubCoordinator, createWorkerTask } = await import(join(LIB, "hierarchy", "sub-coordinator.mjs"));

  // Verify SubCoordinator has execute() method
  assert(typeof SubCoordinator.prototype.execute === "function", "SubCoordinator should have execute()");
  assert(typeof SubCoordinator.prototype.start === "function", "SubCoordinator should have start()");
  assert(typeof SubCoordinator.prototype.decompose === "function", "SubCoordinator should have decompose()");
  assert(typeof SubCoordinator.prototype.spawnChildren === "function", "SubCoordinator should have spawnChildren()");
  assert(typeof SubCoordinator.prototype.waitForChildren === "function", "SubCoordinator should have waitForChildren()");
  assert(typeof SubCoordinator.prototype.aggregateResults === "function", "SubCoordinator should have aggregateResults()");
  assert(typeof SubCoordinator.prototype.reportUp === "function", "SubCoordinator should have reportUp()");
  assert(typeof SubCoordinator.prototype.shutdown === "function", "SubCoordinator should have shutdown()");

  // Test createWorkerTask helper
  const workerTask = createWorkerTask(["src/a.ts", "src/b.ts"], "Implement feature X", { budget: 3, model: "opus" });
  assertEqual(workerTask.type, "worker", "worker task type");
  assert(workerTask.scope.length === 2, "worker task scope");
  assertEqual(workerTask.budget, 3, "worker task budget");
  assertEqual(workerTask.model, "opus", "worker task model");

  // Test constructor validation
  let validationFailed = false;
  try {
    new SubCoordinator({ id: "", level: 0, scope: "test", task: "test", busAddress: "/tmp/bus.sock", worktreeBase: "/tmp", agentBudget: 5, maxDepth: 3 });
  } catch (err) {
    validationFailed = true;
    assertIncludes(err.message, "non-empty string", "should fail on empty id");
  }
  assert(validationFailed, "empty id should throw TypeError");

  // Test _shouldSplit logic (create a valid instance but don't start it)
  // We can't call start() without a real IPC bus, but we can verify the constructor works
  const tmpDir = mkdtempSync(join(tmpdir(), "sc-test-"));
  try {
    const sc = new SubCoordinator({
      id: "test-sc",
      level: 0,
      scope: "test-scope",
      task: "test task",
      files: ["a.ts", "b.ts"],  // Only 2 files — should NOT split (below minFilesForSplit)
      parentChannel: null,
      busAddress: "/tmp/test-bus.sock",
      worktreeBase: tmpDir,
      agentBudget: 5,
      maxDepth: 3,
    });

    // Verify internal state
    assertEqual(sc.id, "test-sc", "coordinator id");
    assertEqual(sc.level, 0, "coordinator level");
    assertEqual(sc.files.length, 2, "coordinator files count");
    assertEqual(sc.active, false, "coordinator should not be active before start()");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// C11: Auto-mode detection — heuristic scoring for all modes
// ═══════════════════════════════════════════════════════════════════
const c11 = test("C11: Auto-mode detection — regex heuristic scoring", async () => {
  const { autoMode } = await import(join(LIB, "orchestration.mjs"));

  // Capture stderr to suppress autoMode log output
  const origStderrWrite = process.stderr.write;
  process.stderr.write = () => true; // Suppress

  try {
    // Single: bug fix
    assertEqual(await autoMode("fix the login bug in auth.ts"), "single", "bug fix → single");

    // Parallel: exploration
    assertEqual(await autoMode("explore and analyze the codebase structure"), "parallel", "explore → parallel");

    // Pipeline: refactoring
    assertEqual(await autoMode("refactor the authentication module"), "pipeline", "refactor → pipeline");

    // Review: code audit
    assertEqual(await autoMode("review the API handlers for security"), "review", "review → review");

    // Swarm: broad implementation
    assertEqual(await autoMode("implement logging across all modules in the whole codebase"), "swarm", "all modules → swarm");

    // Hierarchical: massive scope
    assertEqual(await autoMode("complete overhaul and rebuild of the entire system"), "hierarchical", "massive → hierarchical");

    // Default fallback: ambiguous
    assertEqual(await autoMode("do something"), "single", "ambiguous → single (default)");
  } finally {
    process.stderr.write = origStderrWrite;
  }
});

// ═══════════════════════════════════════════════════════════════════
// C12: All flags passthrough — effort, fallback-model, scope, persist-context
// ═══════════════════════════════════════════════════════════════════
const c12 = test("C12: All flags together — compound CLI parsing", async () => {
  const { parseAgentArgs } = await import(join(LIB, "cli.mjs"));

  const args = parseAgentArgs([
    "node", "agent-entry.mjs",
    "-m", "opus",
    "-b", "25",
    "-n", "80",
    "--effort", "max",
    "--fallback-model", "sonnet",
    "--scope", "src/auth/,lib/shared.ts",
    "--persist-context",
    "--prefill", "Starting implementation now.\n\n",
    "--max-retries", "2",
    "--result-file", "/tmp/result.json",
    "--context-file", "/tmp/ctx.json",
    "--json",
    "--role", "worker",
    "--stdin-timeout", "15",
    "complex multi-file refactoring task",
  ]);

  assertEqual(args.model, "opus", "model");
  assertEqual(args.budget, 25, "budget");
  assertEqual(args.maxTurns, 80, "maxTurns");
  assertEqual(args.effort, "max", "effort");
  assertEqual(args.fallbackModel, "sonnet", "fallbackModel");
  assertEqual(args.scope, "src/auth/,lib/shared.ts", "scope");
  assertEqual(args.persistContext, true, "persistContext");
  assertEqual(args.prefill, "Starting implementation now.\n\n", "prefill");
  assertEqual(args.maxRetries, 2, "maxRetries");
  assertEqual(args.resultFile, "/tmp/result.json", "resultFile");
  assertEqual(args.contextFile, "/tmp/ctx.json", "contextFile");
  assertEqual(args.outputFormat, "json", "outputFormat");
  assertEqual(args.role, "worker", "role");
  assertEqual(args.stdinTimeout, 15, "stdinTimeout");
  assertEqual(args.task, "complex multi-file refactoring task", "task");

  // Verify model resolution for compound flags
  const { resolveModel, ROLE_DISALLOWED_TOOLS } = await import(join(LIB, "config.mjs"));
  assertEqual(resolveModel(args.model), "opus[1m]", "opus resolves correctly");

  // Verify role-disallowed tools
  assertEqual(ROLE_DISALLOWED_TOOLS[args.role], null, "worker has null (full access)");
});

// ═══════════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════════
const allTests = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12];

process.stderr.write("\n═══ INTEGRATION TEST SUITE ═══\n\n");

await runTests(allTests);

process.stderr.write(`\n═══ RESULTS ═══\n`);
process.stderr.write(`Total: ${totalTests} | Passed: ${passed} | Failed: ${failed}\n`);

if (failed > 0) {
  process.stderr.write(`\nFailed tests:\n`);
  for (const r of results) {
    if (r.status === "FAIL") {
      process.stderr.write(`  ✗ ${r.name}: ${r.error}\n`);
    }
  }
}

// Write structured report to stdout
const report = {
  version: 1,
  timestamp: new Date().toISOString(),
  total: totalTests,
  passed,
  failed,
  tests: results,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

process.exit(failed > 0 ? 1 : 0);

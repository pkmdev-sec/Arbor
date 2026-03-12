#!/usr/bin/env node
/**
 * swarm — Parallel arbor orchestrator with verification
 *
 * Sits between the main Claude session and individual arbor calls.
 * Handles: task decomposition → parallel execution → verification → reporting.
 *
 * All orchestration logic lives in lib/ modules. This file is the slim
 * entry point that wires everything together via mode routing.
 *
 * Catch blocks: 3 total, 3 fixed (added error logging to silent catches)
 */

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import { colors, log, setQuiet } from "./lib/output.mjs";
import { DEPTH } from "./lib/config.mjs";
import { initIpcLogger, logIpc } from "./lib/ipc-logger.mjs";
import { parseSwarmArgs, showSwarmHelp } from "./lib/cli.mjs";
import { spawnAgent } from "./lib/agent-spawn.mjs";
import { aiDecision, isAiClientAvailable } from "./lib/ai-client.mjs";
import { autoMode, decompose, executeParallel, executePipeline, verify, buildContract } from "./lib/orchestration.mjs";
import { prepareWorktree, validateAndApply, cleanupIsolation } from "./lib/isolation.mjs";
import { selectMode, shouldVerifyMode, resolveDepth } from "./lib/mode-selector.mjs";
import { collectWorktreeChanges, runMergePipeline } from "./lib/merge-pipeline.mjs";
import { claimBdTask, cleanOldRuns } from "./lib/lifecycle.mjs";
import { generateApproaches } from "./lib/approach-generator.mjs";
import { selectWinner } from "./lib/branch-selector.mjs";
import LearningStore from "./lib/learning.mjs";
import OutputValidator from "./lib/output-validator.mjs";

// Hierarchical mode — lazy-loaded for graceful fallback if modules are missing
let hierarchyModules = null;
async function loadHierarchy() {
  if (hierarchyModules) return hierarchyModules;
  try {
    hierarchyModules = await import("./lib/hierarchy/index.mjs");
    return hierarchyModules;
  } catch (err) {
    log(`${colors.yellow}⚠ Hierarchy modules unavailable: ${err.message}${colors.reset}`);
    log(`${colors.yellow}  Falling back to flat swarm mode.${colors.reset}`);
    return null;
  }
}

const SWARM_BASE = "/tmp/swarm";

/**
 * Compute the agentCwd resolver for worktree-based agents.
 * When the user invokes arbor from a subdirectory of a git repo, agents
 * spawned in worktrees need their CWD set to the corresponding subdirectory
 * within the worktree (not the worktree root).
 *
 * Returns a function: (wtPath?: string) => string
 */
function computeAgentCwd(mainCwd) {
  let cwdPrefix = "";
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: mainCwd, encoding: "utf-8", timeout: 5000,
    }).trim();
    cwdPrefix = relative(gitRoot, mainCwd);
  } catch {}
  return (wtPath) =>
    wtPath ? (cwdPrefix ? join(wtPath, cwdPrefix) : wtPath) : mainCwd;
}

// ── Scout project structure (Phase 3 — parallel with decompose) ──
async function scoutProject(task, workDir, contextFile, projectTree = "", busSocketPath = null) {
  // S3: Use pre-computed projectTree if provided, otherwise scan
  let tree = projectTree;
  if (!tree) {
    try {
      try {
        tree = execFileSync("git", ["ls-files"], {
          encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
        }).split("\n").filter(Boolean).slice(0, 300).join("\n");
      } catch {
        tree = execFileSync("find", [".", "-maxdepth", "2", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
          encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
        }).split("\n").filter(Boolean).slice(0, 300).join("\n");
      }
    } catch {}
  }

  // Fast path: Direct API call (~2-5s vs 30-60s subprocess)
  if (isAiClientAvailable() && tree) {
    try {
      const result = await aiDecision({
        model: "claude-sonnet-4-6",
        system: [
          "You are a project structure analyzer. Given a file listing and task context, identify architecture and module boundaries that inform parallel work decomposition.",
          "",
          "Output a concise summary covering exactly these points:",
          "1. Primary language and framework",
          "2. Key entry points (main files, route definitions, CLI entry)",
          "3. Architecture pattern (monolith, microservices, monorepo, library)",
          "4. Module boundaries (which directories are independent units)",
          "5. Shared dependencies (files imported across multiple modules)",
          "",
          "Keep the summary to 1 paragraph, max 150 words. Prioritize information relevant to the task context.",
        ].join("\n"),
        prompt: `Project files:\n${tree}\n\nTask context: ${task.slice(0, 300)}\n\nSummarize the project structure focusing on module boundaries and parallel work decomposition.`,
        maxTokens: 512,
      });

      const tokens = `${result.usage.input_tokens}+${result.usage.output_tokens}`;
      log(`${colors.dim}scout: project scan [${result.latencyMs}ms, ${tokens} tokens] (API direct)${colors.reset}`);

      const rf = join(workDir, "scout.json");
      writeFileSync(rf, JSON.stringify({ version: 1, status: "completed", output: result.content, duration_ms: result.latencyMs, exit_code: 0, model: result.model }, null, 2));

      return result.content;
    } catch (err) {
      process.stderr.write(`scout: AI call failed (${err.message}), falling back to subprocess\n`);
    }
  }

  // Fallback: Full Claude Code subprocess
  const rf = join(workDir, "scout.json");
  const scoutTask = [
    `Scan the project structure using Glob and Read tools. Identify:`,
    `1. Primary language/framework and build system`,
    `2. Key entry points and route definitions`,
    `3. Module boundaries (independent directories)`,
    `4. Shared dependencies across modules`,
    `Output a 1-paragraph summary (max 150 words) focused on how work could be split across parallel agents.`,
    ``,
    `Task context: ${task.slice(0, 200)}`,
  ].join("\n");

  const start = Date.now();
  const result = await spawnAgent({
    task: scoutTask,
    role: "worker",
    model: "sonnet",
    turns: 5,
    budget: 2,
    resultFile: rf,
    contextFile,
    agentId: "scout",
    ipcSocket: busSocketPath,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`${colors.dim}scout: project scan completed in ${elapsed}s (subprocess fallback)${colors.reset}`);

  return result.output || "(scout produced no output)";
}

// ── Hierarchical execution ────────────────────────────────────────
async function executeHierarchical(task, args, workDir, depth) {
  const hierarchy = await loadHierarchy();
  if (!hierarchy) {
    log(`${colors.yellow}⚠ Falling back to flat swarm mode (hierarchy modules missing)${colors.reset}`);
    return null; // Caller will fall through to parallel/swarm
  }

  const { decomposeHierarchically, estimateAgentBudget, ResourceGovernor,
    buildFinalResult, generateMergeReport, buildHierarchicalContract,
    detectFileLevelConflicts, createConflictSummary } = hierarchy;

  const mainCwd = process.cwd();
  const agentCwd = computeAgentCwd(mainCwd);

  const hierarchyConfig = {
    maxDepth: args.hierarchyDepth,
    maxFanOut: args.maxChildren,
    maxTotalAgents: args.agentBudget,
    minFilesForSplit: args.minTaskFiles,
    decomposeBy: args.decomposeBy,
  };

  // ── Phase 1: Decompose ─────────────────────────────────────────────
  log(`${colors.bold}${colors.cyan}[HIERARCHICAL]${colors.reset} Analyzing task scope and dependencies...`);
  logIpc('orchestrator', 'decomposer', 'task_assign', 'Hierarchical decomposition starting');

  const decompositionTree = await decomposeHierarchically(task, mainCwd, hierarchyConfig);
  const budgetEstimate = estimateAgentBudget(decompositionTree);

  log(`${colors.green}  ✓ Decomposition complete${colors.reset}`);
  log(`    Tree depth: ${decompositionTree.depth} | Total nodes: ${decompositionTree.totalNodes} | Leaf workers: ${decompositionTree.leafNodes}`);
  log(`    Est. agents: ${budgetEstimate.totalAgents} (${budgetEstimate.workers} workers, ${budgetEstimate.coordinators} coordinators)`);
  log(`    Max concurrent: ${budgetEstimate.maxConcurrent} | Est. cost: $${budgetEstimate.estimatedCost.toFixed(3)}`);

  logIpc('decomposer', 'orchestrator', 'result',
    `${decompositionTree.totalNodes} nodes, ${decompositionTree.leafNodes} leaves, depth ${decompositionTree.depth}`,
    { budget: budgetEstimate.totalAgents, cost: budgetEstimate.estimatedCost });

  // ── Phase 2: Estimate-only exit ────────────────────────────────────
  if (args.estimateOnly) {
    log(`\n${colors.bold}═══ DECOMPOSITION PLAN (estimate-only) ═══${colors.reset}`);
    printDecompositionTree(decompositionTree.root, 0);
    log(`\n${colors.bold}Budget:${colors.reset}`);
    log(`  Total agents: ${budgetEstimate.totalAgents}`);
    log(`  Workers: ${budgetEstimate.workers} | Coordinators: ${budgetEstimate.coordinators}`);
    log(`  Max concurrent: ${budgetEstimate.maxConcurrent}`);
    log(`  Est. cost: $${budgetEstimate.estimatedCost.toFixed(3)}`);
    for (const [level, count] of Object.entries(budgetEstimate.byLevel)) {
      log(`  Level ${level}: ${count} agents`);
    }
    return { estimateOnly: true, tree: decompositionTree, budget: budgetEstimate };
  }

  // ── Phase 3: Create ResourceGovernor + IPC Bus ──────────────────────
  const governor = new ResourceGovernor({
    maxTotalAgents: args.agentBudget,
    maxConcurrentAgents: Math.min(args.agentBudget, 10),
    maxWorktrees: Math.min(args.agentBudget, 15),
  });

  // IPC bus: reuse top-level bus if already started, otherwise create one
  let bus = null;
  const busSocketPath = join(workDir, "ipc-bus.sock");
  let busOwnedHere = false; // Track if we need to stop bus on cleanup

  // BUG FIX 2: Wrap entire execution pipeline in try-finally to ensure cleanup on early failure
  // Governor and bus must be cleaned up even if decomposition fails or execution throws
  let workerResults;
  let governorReport;
  let executionMs = 0;

  try {
    try {
      // Check if bus socket already exists (started at top level before TUI)
      if (existsSync(busSocketPath)) {
        log(`${colors.dim}IPC bus already running: ${busSocketPath}${colors.reset}`);
      } else {
        const { MessageBus } = await import("./lib/ipc/message-bus.mjs");
        bus = new MessageBus({ socketPath: busSocketPath });
        await bus.start();
        busOwnedHere = true;
        log(`${colors.dim}IPC bus started: ${busSocketPath}${colors.reset}`);
      }

      // Connect governor to bus for real-time monitoring
      await governor.connectBus(busSocketPath, "orchestrator");
    } catch (err) {
      log(`${colors.yellow}IPC bus unavailable: ${err.message} (continuing without real-time IPC)${colors.reset}`);
    }

    // ── Phase 4: Execute the hierarchy top-down ────────────────────────
    log(`\n${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Starting hierarchical execution...`);
    logIpc('orchestrator', 'all', 'lifecycle', 'Hierarchical execution starting');

    // Track per-level progress during execution
    const levelProgress = new Map(); // level → { total, completed, failed }
    function trackNodeProgress(node) {
      if (!node.children || node.children.length === 0) return;
      const level = node.level;
      if (!levelProgress.has(level)) {
        levelProgress.set(level, { total: 0, completed: 0, failed: 0 });
      }
      levelProgress.get(level).total += node.children.length;
      for (const child of node.children) {
        trackNodeProgress(child);
      }
    }
    trackNodeProgress(decompositionTree.root);

    const executionStart = Date.now();
    workerResults = await executeHierarchyLevel(
      decompositionTree.root, task, workDir, depth, args, governor, mainCwd, busSocketPath, agentCwd
    );
    executionMs = Date.now() - executionStart;
  } finally {
    // ── Phase 5: Cleanup IPC bus + Governor (always, even on throw or early return) ────
    // BUG FIX 2: This finally block ensures cleanup happens even if:
    // - decomposition failed (phase 1-2)
    // - governor/bus creation failed (phase 3)
    // - execution threw an error (phase 4)
    if (bus && busOwnedHere) {
      try {
        await bus.stop();
        log(`${colors.dim}IPC bus stopped${colors.reset}`);
      } catch (err) {
        log(`${colors.yellow}IPC bus cleanup failed: ${err.message}${colors.reset}`);
      }
    }
    try {
      governorReport = await governor.cleanup();
    } catch (err) {
      log(`${colors.yellow}Governor cleanup failed: ${err.message}${colors.reset}`);
      governorReport = { totalSpawned: 0, totalCompleted: 0, totalFailed: 0, totalCost: 0 };
    }
  }

  log(`${colors.dim}Governor: spawned=${governorReport.totalSpawned} completed=${governorReport.totalCompleted} failed=${governorReport.totalFailed} cost=$${governorReport.totalCost.toFixed(3)}${colors.reset}`);
  logIpc('governor', 'orchestrator', 'result',
    `spawned=${governorReport.totalSpawned} completed=${governorReport.totalCompleted} failed=${governorReport.totalFailed}`,
    governorReport);

  // ── Phase 6: Aggregate results ─────────────────────────────────────
  // Pre-flight conflict detection before full aggregation
  const preflightConflicts = detectFileLevelConflicts(
    workerResults.map(r => ({
      id: r.id,
      agentId: r.id,
      files: new Map((r.applied_files || []).map(f => [f, true])),
    }))
  );

  if (preflightConflicts.summary.total > 0) {
    log(`\n${colors.bold}${colors.yellow}[CONFLICTS]${colors.reset} ${preflightConflicts.summary.total} file-level conflict(s) detected`);
    log(createConflictSummary(preflightConflicts.conflicts));
    logIpc('aggregator', 'orchestrator', 'warning',
      `${preflightConflicts.summary.total} conflicts: ${preflightConflicts.summary.high} high, ${preflightConflicts.summary.medium} medium, ${preflightConflicts.summary.low} low`,
      preflightConflicts.summary);
  } else {
    log(`${colors.green}  ✓ No file-level conflicts detected${colors.reset}`);
  }

  // Build allResults Map for the aggregator (agentId → result object)
  const allResultsMap = new Map();
  for (const r of workerResults) {
    allResultsMap.set(r.id, {
      agentId: r.id,
      role: "worker",
      level: r.level || 1,
      scope: r.scope || [],
      files: new Map((r.applied_files || []).map(f => [f, true])),
      status: r.exitCode === 0 ? "completed" : "failed",
      output: r.output || "",
    });
  }

  // Run full aggregation with cross-boundary checking
  let aggregation = null;
  let mergeReport = null;

  try {
    log(`${colors.dim}  Running hierarchical result aggregation...${colors.reset}`);
    aggregation = await buildFinalResult(decompositionTree.root, allResultsMap, {
      mainCwd,
      enableSemanticMerge: args.semanticMerge !== false,
      enableCrossBoundaryCheck: decompositionTree.depth > 1,
    });

    const confLabel = aggregation.overallConfidence >= 0.85 ? colors.green
      : aggregation.overallConfidence >= 0.65 ? colors.yellow
      : colors.red;

    log(`${colors.green}  ✓ Aggregation complete${colors.reset}`);
    log(`    Files: ${aggregation.files?.size || 0} | Conflicts: ${aggregation.totalConflicts} (${aggregation.resolvedConflicts} resolved, ${aggregation.unresolvedConflicts} unresolved)`);
    log(`    Confidence: ${confLabel}${(aggregation.overallConfidence * 100).toFixed(0)}%${colors.reset}`);

    logIpc('aggregator', 'orchestrator', 'result',
      `confidence=${(aggregation.overallConfidence * 100).toFixed(0)}% conflicts=${aggregation.totalConflicts}`,
      { confidence: aggregation.overallConfidence, totalConflicts: aggregation.totalConflicts });

    // Generate merge report for detailed analysis
    mergeReport = generateMergeReport(decompositionTree.root, allResultsMap);
    if (mergeReport.warnings && mergeReport.warnings.length > 0) {
      log(`\n${colors.yellow}  Merge warnings:${colors.reset}`);
      for (const w of mergeReport.warnings) {
        log(`    [${w.severity.toUpperCase()}] ${w.message}`);
        if (w.recommendation) {
          log(`      → ${w.recommendation}`);
        }
      }
    }
  } catch (err) {
    log(`${colors.yellow}  ⚠ Aggregation failed: ${err.message} (results still available)${colors.reset}`);
    logIpc('aggregator', 'orchestrator', 'error', `Aggregation failed: ${err.message}`, {});
  }

  // ── Phase 7: Display per-level summary ─────────────────────────────
  const levelCounts = new Map();
  for (const r of workerResults) {
    const level = r.level || 1;
    if (!levelCounts.has(level)) levelCounts.set(level, { completed: 0, failed: 0, totalMs: 0 });
    const lc = levelCounts.get(level);
    if (r.exitCode === 0) lc.completed++; else lc.failed++;
    lc.totalMs += r.durationMs || 0;
  }

  if (levelCounts.size > 1) {
    log(`\n${colors.bold}Per-level breakdown:${colors.reset}`);
    for (const [level, stats] of [...levelCounts.entries()].sort((a, b) => a[0] - b[0])) {
      const total = stats.completed + stats.failed;
      const avgMs = total > 0 ? (stats.totalMs / total / 1000).toFixed(1) : "0";
      log(`  L${level}: ${stats.completed} done, ${stats.failed} failed (avg ${avgMs}s/agent)`);
    }
  }

  // Attach metadata for the contract builder in main()
  workerResults._hierarchical = {
    decompositionTree,
    budgetEstimate,
    governorReport,
    aggregation,
    mergeReport,
    executionMs,
  };

  return workerResults;
}

/**
 * Recursively execute a decomposition node and its children.
 * Coordinators spawn children in parallel; workers execute directly.
 * For deep hierarchies (depth > 1), coordinator nodes can spawn SubCoordinators
 * with crash recovery and independent budget tracking.
 *
 * @param {Object} node - Decomposition tree node
 * @param {string} parentTask - Parent task description (fallback)
 * @param {string} workDir - Swarm work directory
 * @param {string} depth - Depth preset key (shallow/normal/thorough)
 * @param {Object} args - CLI args (hierarchyDepth, contextFile, etc.)
 * @param {ResourceGovernor} governor - Resource governor instance
 * @param {string} mainCwd - Original working directory
 * @param {string|null} busSocketPath - IPC bus socket path (null if bus unavailable)
 */
async function executeHierarchyLevel(node, parentTask, workDir, depth, args, governor, mainCwd, busSocketPath = null, agentCwd = null) {
  // Fallback: compute agentCwd if caller didn't provide it (safety net)
  if (!agentCwd) agentCwd = computeAgentCwd(mainCwd);
  const preset = DEPTH[depth];
  const results = [];

  if (node.type === "worker" || !node.children || node.children.length === 0) {
    // Leaf worker — execute directly with full Part 1 features
    const agentId = node.id || `h-worker-${randomUUID().slice(0, 6)}`;
    const rf = join(workDir, `${agentId}-result.json`);
    const taskDesc = node.task || parentTask;
    // Build scope hint for the agent's task description
    // For greenfield tasks (scope=["."]), don't restrict to existing files
    // For targeted greenfield (scope=["/path/to/new-dir/"]), indicate target directory
    let scopeHint = "";
    if (node.scope && node.scope.length > 0) {
      const isFullAccess = node.scope.length === 1 && node.scope[0] === ".";
      const isSingleDir = node.scope.length === 1 && node.scope[0] !== "." && !node.scope[0].includes(",");
      if (isFullAccess) {
        scopeHint = "\n\nYou have full write access to the working directory. Create any files/directories needed.";
      } else if (isSingleDir && node.scope[0].endsWith("/")) {
        scopeHint = `\n\nTARGET DIRECTORY: ${node.scope[0]}\nCreate files within this directory. You may also read files elsewhere for context.`;
      } else {
        scopeHint = `\n\nFILE SCOPE (modify only these):\n${node.scope.join("\n")}`;
      }
    }

    log(`  ${colors.dim}[L${node.level}] ${agentId}: ${(taskDesc).slice(0, 60)}${colors.reset}`);
    logIpc('orchestrator', agentId, 'task_assign', taskDesc.slice(0, 80), { level: node.level, scope: node.scope || [], effort: node.effort || null });

    const isolation = await prepareWorktree(workDir, agentId, mainCwd);

    governor.registerAgent({ id: agentId, level: node.level, scope: node.scope?.[0] || "root", worktreePath: isolation.worktreePath, parentId: null });

    // BUG FIX 1: Ensure agentCwd uses worktree path when isolation succeeds, falls back to mainCwd otherwise
    // The agentCwd function computes the correct subdirectory within the worktree based on git root
    // If isolation failed (no worktree), use mainCwd directly; if isolation succeeded, use worktree path
    const effectiveCwd = isolation.success && isolation.worktreePath
      ? agentCwd(isolation.worktreePath)  // Worktree path with proper subdirectory
      : mainCwd;                          // Fallback to main repo if isolation failed

    // BUG FIX 1: Set ARBOR_SCOPE to match the actual cwd being used
    const scopeEnv = node.scope && node.scope.length > 0
      ? { ARBOR_SCOPE: node.scope.join(",") }
      : {};

    const result = await spawnAgent({
      task: taskDesc + scopeHint,
      role: "worker",
      model: node.model || "sonnet",
      effort: node.effort || null,                              // Part 1: effort routing
      scope: node.scope ? node.scope.join(",") : null,          // Part 1: scope enforcement
      fallbackModel: args.fallbackModel || null,                 // Part 1: overload fallback
      turns: node.turns || preset.turns,
      budget: preset.budget,
      resultFile: rf,
      contextFile: args.contextFile,
      agentId,
      cwd: effectiveCwd,
      env: scopeEnv,
      ipcSocket: busSocketPath,                                  // Part 2: IPC bus connection
    });

    governor.deregisterAgent(agentId, { status: result.exitCode === 0 ? "completed" : "failed", turns: 0 });

    const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} [L${node.level}] ${agentId}: ${(result.durationMs / 1000).toFixed(1)}s`);
    logIpc(agentId, 'orchestrator', 'result', `exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`, { exitCode: result.exitCode, durationMs: result.durationMs });

    // Apply worktree changes and track applied files for aggregator
    let appliedFiles = [];
    if (isolation.success) {
      const apply = await validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked, new Set(), [], new Map(), new Set(), isolation.baseCommit);
      if (apply.valid) {
        appliedFiles = apply.applied;
        log(`  ${colors.green}✓${colors.reset} ${agentId}: applied ${appliedFiles.length} files`);
      } else {
        log(`  ${colors.red}✗${colors.reset} ${agentId}: REJECTED — ${apply.errors.join(", ")}`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }

    results.push({
      id: agentId,
      subtask: taskDesc.slice(0, 80),
      scope: node.scope || [],
      model: node.model || "sonnet",
      effort: node.effort || null,
      level: node.level,
      applied_files: appliedFiles,  // Change 7: propagate for aggregator
      ...result,
      resultFile: rf,
      worktreePath: isolation.worktreePath,
    });

    return results;
  }

  // Coordinator node — execute children
  const coordId = node.id || `h-coord-${randomUUID().slice(0, 6)}`;
  log(`${colors.bold}${colors.magenta}[L${node.level}]${colors.reset} ${coordId}: coordinating ${node.children.length} children...`);
  logIpc('orchestrator', coordId, 'lifecycle', `Coordinating ${node.children.length} children at level ${node.level}`);

  // Change 4: For deep hierarchies, use SubCoordinator for crash recovery
  if (args.hierarchyDepth > 1 && node.level > 0 && node.children.length > 2 && busSocketPath) {
    try {
      const { spawnSubCoordinator } = await import("./lib/hierarchy/sub-coordinator.mjs");
      log(`  ${colors.dim}[L${node.level}] ${coordId}: spawning SubCoordinator (deep hierarchy)${colors.reset}`);
      const subCoordResult = await spawnSubCoordinator({
        id: coordId,
        level: node.level,
        scope: node.scope?.[0] || "default",
        task: node.task || parentTask,
        files: node.scope || [],
        busAddress: busSocketPath,
        worktreeBase: join(workDir, "worktrees"),
        agentBudget: node.children.length + 1,
        maxDepth: args.hierarchyDepth - node.level,
      });
      results.push(...(subCoordResult.results || []));
    } catch (err) {
      log(`${colors.yellow}  ⚠ SubCoordinator failed: ${err.message} — falling back to direct execution${colors.reset}`);
      // Fall through to direct recursive execution below
      const childPromises = node.children.map(child =>
        executeHierarchyLevel(child, node.task || parentTask, workDir, depth, args, governor, mainCwd, busSocketPath, agentCwd)
      );
      const childResultArrays = await Promise.all(childPromises);
      for (const childResults of childResultArrays) {
        results.push(...childResults);
      }
    }
  } else {
    // Shallow hierarchy or no bus: direct recursive execution
    const childPromises = node.children.map(child =>
      executeHierarchyLevel(child, node.task || parentTask, workDir, depth, args, governor, mainCwd, busSocketPath, agentCwd)
    );
    const childResultArrays = await Promise.all(childPromises);
    for (const childResults of childResultArrays) {
      results.push(...childResults);
    }
  }

  // Log coordinator completion
  const completed = results.filter(r => r.exitCode === 0).length;
  const failed = results.length - completed;
  log(`${colors.bold}${colors.magenta}[L${node.level}]${colors.reset} ${coordId}: ${completed} done, ${failed} failed`);
  logIpc(coordId, 'orchestrator', 'result', `${completed} completed, ${failed} failed`, { completed, failed });

  return results;
}

/**
 * Print decomposition tree for --estimate-only display
 */
function printDecompositionTree(node, indent) {
  const prefix = "  ".repeat(indent);
  const typeIcon = node.type === "coordinator" ? "📋" : "⚡";
  const scopeStr = node.scope && node.scope.length > 0
    ? ` [${node.scope.slice(0, 3).join(", ")}${node.scope.length > 3 ? "..." : ""}]`
    : "";
  log(`${prefix}${typeIcon} ${node.id} (${node.type}, L${node.level}, ${node.turns || "?"}t, ${node.model || "sonnet"})${scopeStr}`);
  log(`${prefix}   ${(node.task || "").slice(0, 70)}`);
  if (node.children) {
    for (const child of node.children) {
      printDecompositionTree(child, indent + 1);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseSwarmArgs(process.argv);
  setQuiet(args.quiet);

  if (args.help) { showSwarmHelp(); process.exit(0); }

  // ── Monitor mode: observe all active runs (no task needed) ──
  if (args.monitor) {
    const goTui = new URL('./tui/orch-tui', import.meta.url).pathname;
    if (existsSync(goTui) && process.stdout.isTTY) {
      // Find the most recent active IPC bus socket for live streaming
      const tuiArgs = ['--poll-interval', '2s'];
      try {
        const { readdirSync, statSync } = await import("node:fs");
        const runs = readdirSync(SWARM_BASE).map(d => {
          const sock = join(SWARM_BASE, d, "ipc-bus.sock");
          try { return { path: sock, mtime: statSync(sock).mtimeMs }; }
          catch { return null; }
        }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
        if (runs.length > 0) tuiArgs.unshift('--bus-address', runs[0].path);
      } catch { /* No active runs — TUI will auto-discover or run without IPC */ }

      // Go TUI: 9 tabs, native socket streaming, better performance
      const tuiProc = spawnChild(goTui, tuiArgs, { stdio: 'inherit' });
      await new Promise(resolve => tuiProc.on('close', resolve));
    } else {
      // Fallback: Node.js TUI
      const { startMonitor } = await import("./lib/tui/monitor.mjs");
      const instance = startMonitor();
      if (instance) await instance.waitUntilExit();
    }
    process.exit(0);
  }

  if (!args.task) {
    log(`${colors.red}Error: No task provided.${colors.reset}`);
    process.exit(1);
  }

  const mode = args.mode === "auto" ? await autoMode(args.task, { smartRoute: args.smartRoute }) : args.mode;
  const depth = DEPTH[args.depth] ? args.depth : "normal";
  const shouldVerify = args.verify ?? (mode === "swarm" || mode === "pipeline" || mode === "review" || mode === "hierarchical" || mode === "fork-merge");

  // Create per-run work directory — all agent files go here
  const runId = randomUUID().slice(0, 8);
  const workDir = join(SWARM_BASE, runId);
  const busSocketPath = join(workDir, "ipc-bus.sock");
  mkdirSync(workDir, { recursive: true });
  initIpcLogger(workDir);
  logIpc('system', 'user', 'lifecycle', 'Swarm started: mode=' + mode + ' agents=' + args.agents, { workDir, depth });
  logIpc('orchestrator', 'all', 'decision', 'Mode: ' + mode + ' (depth: ' + depth + ')', {});
  // S4: Defer cleanup to background — runs after event loop starts actual work
  setTimeout(() => cleanOldRuns(SWARM_BASE), 100);

  // Initialize learning store and output validator
  const learningStore = new LearningStore();
  const outputValidator = new OutputValidator();
  const promoted = learningStore.promote();
  const pruned = learningStore.prune();
  if (promoted > 0 || pruned > 0) {
    log(`${colors.dim}Learning store: promoted ${promoted}, pruned ${pruned} patterns${colors.reset}`);
  }

  log(`${colors.bold}${colors.cyan}swarm${colors.reset} ${colors.dim}|${colors.reset} mode=${mode} ${colors.dim}|${colors.reset} agents=${args.agents} ${colors.dim}|${colors.reset} depth=${depth} ${colors.dim}|${colors.reset} verify=${shouldVerify}${args.bdTask ? ` ${colors.dim}|${colors.reset} bd=${args.bdTask}` : ""}`);
  log(`${colors.dim}Run: ${workDir}${colors.reset}`);
  log(`${colors.dim}Task: ${args.task.slice(0, 80)}${args.task.length > 80 ? "..." : ""}${colors.reset}`);
  log("");

  // F9: Propagate TUI flag to child agents for PostToolUse progress hooks
  if (args.tui) {
    process.env.ARBOR_TUI = "1";
  }

  // ── Start IPC bus EARLY so TUI can connect immediately ──
  // Previously the bus was only started inside executeHierarchical(), after
  // the TUI had already launched and failed to connect (no socket yet).
  let topLevelBus = null;
  try {
    const { MessageBus } = await import("./lib/ipc/message-bus.mjs");
    topLevelBus = new MessageBus({ socketPath: busSocketPath });
    await topLevelBus.start();
    log(`${colors.dim}IPC bus started: ${busSocketPath}${colors.reset}`);
  } catch (err) {
    log(`${colors.dim}IPC bus unavailable: ${err.message}${colors.reset}`);
    topLevelBus = null;
  }

  // ── TUI dashboard (read-only overlay — does NOT control execution) ──
  let dashboard = null;
  if (args.tui && process.stdout.isTTY) {
    try {
      const goTui = new URL('./tui/orch-tui', import.meta.url).pathname;
      if (existsSync(goTui)) {
        // Go TUI: native socket client, 9 tabs, real-time IPC streaming
        const tuiProc = spawnChild(goTui, ['--bus-address', busSocketPath, '--poll-interval', '2s'], { stdio: 'inherit' });
        setQuiet(true);
        const exitPromise = new Promise(resolve => tuiProc.on('close', resolve));
        dashboard = {
          waitUntilExit: () => exitPromise,
          unmount: () => { try { tuiProc.kill('SIGTERM'); } catch {} },
        };
        tuiProc.on('error', () => { setQuiet(args.quiet); dashboard = null; });
        exitPromise.then(() => {
          setQuiet(args.quiet);
          dashboard = null;
        });
      } else {
        // Fallback: Node.js TUI (with bus address for real-time streaming)
        const { startDashboard } = await import("./lib/tui/dashboard.mjs");
        dashboard = startDashboard({ workDir, agents: [], mode, depth, busAddress: busSocketPath });
        if (dashboard) {
          setQuiet(true);
          dashboard.waitUntilExit().then(() => {
            setQuiet(args.quiet);
            dashboard = null;
          });
        }
      }
    } catch (err) {
      process.stderr.write(`TUI: failed to start (${err.message}), falling back to plain output\n`);
    }
  }

  // bd task lifecycle: claim
  await claimBdTask(args.bdTask);

  const startTime = Date.now();
  let workerResults = [];
  let verifyResult = null;
  let scoutSummary = null;
  let conflictReport = null;
  const mainCwd = process.cwd();

  const agentCwd = computeAgentCwd(mainCwd);

  // Query learning patterns for this task type
  const taskType = mode;
  const language = "javascript"; // Default, could be auto-detected
  const framework = "node"; // Default, could be auto-detected
  const patterns = learningStore.query(taskType, language, framework);
  if (patterns.length > 0) {
    log(`${colors.dim}[learning-store] Found ${patterns.length} relevant patterns (freshness: ${patterns[0].freshness.toFixed(2)})${colors.reset}`);
    // Patterns could be injected into agent context via args.contextFile augmentation
    // For now, just log them for visibility
  }

  if (mode === "single") {
    const rf = join(workDir, "agent-01-result.json");
    log(`${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Single agent...`);
    const isolation = await prepareWorktree(workDir, "agent-01", mainCwd);
    const result = await spawnAgent({
      task: args.task, role: "worker", model: "sonnet",
      turns: DEPTH[depth].turns, budget: DEPTH[depth].budget,
      resultFile: rf, contextFile: args.contextFile,
      agentId: "agent-01", cwd: agentCwd(isolation.worktreePath),
      ipcSocket: busSocketPath,
    });
    workerResults = [{ id: "agent-01", subtask: args.task.slice(0, 80), model: "sonnet", ...result, resultFile: rf, worktreePath: isolation.worktreePath }];
    logIpc('agent-01', 'orchestrator', 'result', 'Completed in ' + (result.durationMs / 1000).toFixed(1) + 's (exit ' + result.exitCode + ')', { exitCode: result.exitCode, durationMs: result.durationMs });
    log(`  ${result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`} ${(result.durationMs / 1000).toFixed(1)}s`);
    if (isolation.success) {
      const apply = await validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked, new Set(), [], new Map(), new Set(), isolation.baseCommit);
      if (apply.valid) {
        logIpc('orchestrator', 'agent-01', 'lifecycle', 'Applied ' + apply.applied.length + ' files' + (apply.escaped.length ? ', ' + apply.escaped.length + ' escaped' : ''), {});
        log(`  ${colors.green}✓${colors.reset} agent-01: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
      } else {
        logIpc('orchestrator', 'agent-01', 'error', 'REJECTED: ' + apply.errors.join(', '), {});
        log(`  ${colors.red}✗${colors.reset} agent-01: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }

  } else if (mode === "parallel" || mode === "swarm") {
    // S3: Compute file tree ONCE, pass to both decompose and scoutProject
    let projectTree = "";
    try {
      projectTree = execFileSync("git", ["ls-files"], {
        encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
      }).split("\n").filter(Boolean).slice(0, 300).join("\n");
    } catch {
      try {
        projectTree = execFileSync("find", [".", "-maxdepth", "2", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
          encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
        }).split("\n").filter(Boolean).slice(0, 300).join("\n");
      } catch {}
    }

    // Phase 3: Run scout in parallel with decomposer to eliminate idle time
    const [subtasks, scoutOutput] = await Promise.all([
      decompose(args.task, Math.max(1, args.agents - 1), depth, args.contextFile, workDir, projectTree, { busSocketPath }),
      scoutProject(args.task, workDir, args.contextFile, projectTree, busSocketPath),
    ]);
    scoutSummary = scoutOutput;
    logIpc('scout', 'orchestrator', 'result', (scoutSummary || '(no output)').slice(0, 200), {});

    // Detect decomposition fallback to single-agent mode
    if (subtasks.length === 1 && (subtasks[0].title === "Full task" || subtasks[0].title === "full task")) {
      log(`\n${colors.bold}${colors.red}╔══════════════════════════════════════════════════════╗${colors.reset}`);
      log(`${colors.bold}${colors.red}║  DEGRADED: Decomposition failed — single agent mode  ║${colors.reset}`);
      log(`${colors.bold}${colors.red}║  Requested ${args.agents} agents, but running 1.            ║${colors.reset}`);
      log(`${colors.bold}${colors.red}║  Quality may be lower than expected.                  ║${colors.reset}`);
      log(`${colors.bold}${colors.red}╚══════════════════════════════════════════════════════════╝${colors.reset}\n`);
    }

    // Auto-detect: suggest hierarchical mode for large scope
    if (projectTree) {
      const fileCount = projectTree.split("\n").filter(Boolean).length;
      if (fileCount > 10 && !args.mode.startsWith("hierarchical")) {
        log(`${colors.dim}Task scope large enough for hierarchical decomposition (${fileCount} files).${colors.reset}`);
        log(`${colors.dim}Consider --mode hierarchical for better results on large tasks.${colors.reset}`);
      }
    }

    // Post-decomposition: suggest hierarchical if too many subtasks for flat parallel
    if (subtasks.length > 5 && mode !== "hierarchical") {
      log(`${colors.yellow}Note: ${subtasks.length} subtasks generated — consider --mode hierarchical for better coordination and crash recovery.${colors.reset}`);
    }

    const parallelResult = await executeParallel(subtasks, depth, args.contextFile, workDir, scoutSummary, busSocketPath);
    workerResults = parallelResult.results;
    conflictReport = parallelResult.conflictReport;

  } else if (mode === "pipeline") {
    workerResults = await executePipeline(args.task, depth, args.contextFile, workDir, busSocketPath);

  } else if (mode === "review") {
    const rf = join(workDir, "reviewer-result.json");
    log(`${colors.bold}${colors.cyan}[REVIEW]${colors.reset} Opus reviewer...`);
    const isolation = await prepareWorktree(workDir, "reviewer", mainCwd);
    const result = await spawnAgent({
      task: args.task, role: "worker", model: "opus",
      turns: 15, budget: DEPTH[depth].budget,
      resultFile: rf, contextFile: args.contextFile,
      agentId: "reviewer", cwd: agentCwd(isolation.worktreePath),
      ipcSocket: busSocketPath,
    });
    workerResults = [{ id: "reviewer", subtask: args.task.slice(0, 80), model: "opus", ...result, resultFile: rf, worktreePath: isolation.worktreePath }];
    logIpc('reviewer', 'orchestrator', 'result', 'Completed in ' + (result.durationMs / 1000).toFixed(1) + 's (exit ' + result.exitCode + ')', { exitCode: result.exitCode, durationMs: result.durationMs });
    log(`  ${result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`} ${(result.durationMs / 1000).toFixed(1)}s`);
    if (isolation.success) {
      const apply = await validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked, new Set(), [], new Map(), new Set(), isolation.baseCommit);
      if (apply.valid) {
        logIpc('orchestrator', 'reviewer', 'lifecycle', 'Applied ' + apply.applied.length + ' files' + (apply.escaped.length ? ', ' + apply.escaped.length + ' escaped' : ''), {});
        log(`  ${colors.green}✓${colors.reset} reviewer: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
      } else {
        logIpc('orchestrator', 'reviewer', 'error', 'REJECTED: ' + apply.errors.join(', '), {});
        log(`  ${colors.red}✗${colors.reset} reviewer: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }

  } else if (mode === "hierarchical") {
    const hierarchicalResult = await executeHierarchical(args.task, args, workDir, depth);

    if (hierarchicalResult && hierarchicalResult.estimateOnly) {
      // --estimate-only: print plan and exit
      const contract = {
        version: 2,
        task: args.task,
        mode: "hierarchical",
        work_dir: workDir,
        timestamp: new Date().toISOString(),
        estimate_only: true,
        decomposition: {
          depth: hierarchicalResult.tree.depth,
          totalNodes: hierarchicalResult.tree.totalNodes,
          leafNodes: hierarchicalResult.tree.leafNodes,
          metadata: hierarchicalResult.tree.metadata,
        },
        budget: hierarchicalResult.budget,
        agents: [],
        summary: { total_agents: 0, completed: 0, failed: 0, total_duration_ms: Date.now() - startTime, per_agent_files: [] },
      };
      if (args.resultFile) {
        writeFileSync(args.resultFile, JSON.stringify(contract, null, 2), "utf-8");
      }
      process.stdout.write(JSON.stringify(contract, null, 2) + "\n");
      process.exit(0);
    }

    if (hierarchicalResult) {
      workerResults = hierarchicalResult;
      // Attach hierarchical metadata for contract building below
      workerResults._isHierarchical = true;
    } else {
      // BUG FIX 3: Hierarchy fallback — run as flat swarm with context about the fallback
      // This ensures the flat swarm knows it's a fallback and can make informed decisions
      log(`${colors.yellow}⚠ Hierarchy unavailable, executing as flat swarm (fallback mode)${colors.reset}`);
      log(`${colors.dim}  Reason: Hierarchical decomposition or execution failed${colors.reset}`);

      const projectTree = (() => {
        try {
          return execFileSync("git", ["ls-files"], { encoding: "utf-8", timeout: 5000, cwd: process.cwd() })
            .split("\n").filter(Boolean).slice(0, 300).join("\n");
        } catch { return ""; }
      })();

      // BUG FIX 3: Pass fallback context to decompose so it knows this is a fallback
      // This allows the decomposer to adjust its strategy (e.g., be more conservative)
      const [subtasks, scoutOutput] = await Promise.all([
        decompose(args.task, Math.max(1, args.agents - 1), depth, args.contextFile, workDir, projectTree, {
          isFallback: true,
          fallbackReason: "hierarchical_mode_failed",
          fallbackContext: "Executing flat swarm as fallback from hierarchical mode failure",
          busSocketPath,
        }),
        scoutProject(args.task, workDir, args.contextFile, projectTree, busSocketPath),
      ]);
      scoutSummary = scoutOutput;

      // Execute parallel with fallback metadata
      const parallelResult2 = await executeParallel(subtasks, depth, args.contextFile, workDir, scoutSummary, busSocketPath);
      workerResults = parallelResult2.results;
      conflictReport = parallelResult2.conflictReport;

      // Attach metadata indicating this was a hierarchical fallback
      workerResults._hierarchicalFallback = true;
      workerResults._fallbackReason = "hierarchical_mode_unavailable";
    }

  } else if (mode === "fork-merge") {
    // F12: Fork-Merge — generate N approaches, execute in parallel worktrees, compare, apply winner
    const forkCount = args.forks || 2;
    log(`${colors.bold}${colors.cyan}[FORK-MERGE]${colors.reset} Generating ${forkCount} competing approaches...`);
    logIpc('orchestrator', 'all', 'lifecycle', `Fork-merge: ${forkCount} forks`);

    // Compute project tree for approach generation context
    let projectTree = "";
    try {
      projectTree = execFileSync("git", ["ls-files"], {
        encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
      }).split("\n").filter(Boolean).slice(0, 300).join("\n");
    } catch {
      try {
        projectTree = execFileSync("find", [".", "-maxdepth", "2", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
          encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
        }).split("\n").filter(Boolean).slice(0, 300).join("\n");
      } catch {}
    }

    // Optional scout for richer context
    scoutSummary = await scoutProject(args.task, workDir, args.contextFile, projectTree, busSocketPath);

    // Generate distinct approaches
    const approaches = await generateApproaches(args.task, forkCount, {
      projectTree,
      scoutSummary: scoutSummary || "",
    });

    log(`\n${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Running ${approaches.length} approaches in parallel worktrees...`);
    logIpc('orchestrator', 'all', 'lifecycle', `Executing ${approaches.length} approaches`);

    // Execute each approach in its own worktree
    const preset = DEPTH[depth];
    const candidates = await Promise.all(approaches.map(async (approach, idx) => {
      const agentId = `fork-${idx + 1}`;
      const rf = join(workDir, `${agentId}-result.json`);
      const isolation = await prepareWorktree(workDir, agentId, mainCwd);

      const agentTask = [
        `APPROACH: ${approach.title}`,
        `STRATEGY: ${approach.strategy}`,
        ``,
        `INSTRUCTIONS:`,
        approach.instructions,
        ``,
        `ORIGINAL TASK: ${args.task}`,
      ].join("\n");

      log(`  ${colors.dim}${agentId}: ${approach.title}${colors.reset}`);
      logIpc('orchestrator', agentId, 'task_assign', approach.title, { strategy: approach.strategy });

      const result = await spawnAgent({
        task: agentTask,
        role: "worker",
        model: "sonnet",
        turns: preset.turns,
        budget: preset.budget,
        resultFile: rf,
        contextFile: args.contextFile,
        agentId,
        cwd: agentCwd(isolation.worktreePath),
        ipcSocket: busSocketPath,
      });

      const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
      log(`  ${icon} ${agentId} (${approach.title}): ${(result.durationMs / 1000).toFixed(1)}s`);
      logIpc(agentId, 'orchestrator', 'result', `exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`, { exitCode: result.exitCode, durationMs: result.durationMs });

      return {
        id: agentId,
        approach,
        result,
        worktreePath: isolation.worktreePath,
        isolation,
        resultFile: rf,
      };
    }));

    // Compare and select winner
    const selection = await selectWinner(candidates, args.task, { useAiJudge: true });
    const winner = selection.winner;

    log(`\n${colors.bold}${colors.green}[WINNER]${colors.reset} Applying "${winner.approach.title}" changes...`);
    logIpc('orchestrator', winner.id, 'lifecycle', `Winner: ${winner.approach.title}`, { scores: selection.scores });

    // Apply only the winner's worktree changes
    if (winner.isolation.success) {
      const apply = await validateAndApply(winner.isolation.worktreePath, mainCwd, winner.isolation.snapshot, winner.isolation.backupDir, winner.isolation.copiedUntracked, new Set(), [], new Map(), new Set(), winner.isolation.baseCommit);
      if (apply.valid) {
        log(`  ${colors.green}✓${colors.reset} ${winner.id}: applied ${apply.applied.length} files`);
        logIpc('orchestrator', winner.id, 'lifecycle', `Applied ${apply.applied.length} files`);
      } else {
        log(`  ${colors.red}✗${colors.reset} ${winner.id}: REJECTED — ${apply.errors.join(", ")}`);
        logIpc('orchestrator', winner.id, 'error', `REJECTED: ${apply.errors.join(", ")}`);
      }
    }

    // Cleanup all worktrees (winner + losers)
    for (const c of candidates) {
      if (c.isolation.success) {
        cleanupIsolation(c.isolation.worktreePath, c.isolation.backupDir);
      }
    }

    // Build worker results for contract
    workerResults = candidates.map(c => ({
      id: c.id,
      subtask: c.approach.title,
      model: "sonnet",
      ...c.result,
      resultFile: c.resultFile,
      worktreePath: c.worktreePath,
    }));

    // Attach fork-merge metadata
    workerResults._forkMerge = {
      approaches,
      selection,
      winnerId: winner.id,
    };
  }

  // Write conflict data to workDir for TUI consumption (Go TUI + Node.js TUI both read it)
  if (conflictReport && conflictReport.length > 0) {
    try {
      writeFileSync(join(workDir, "conflicts.json"), JSON.stringify(conflictReport, null, 2), "utf-8");
      logIpc('orchestrator', 'all', 'merge.completed', `${conflictReport.length} file(s) with conflicts detected`, { fileCount: conflictReport.length });
    } catch { /* non-fatal */ }
  }

  // Verification pass
  if (shouldVerify) {
    verifyResult = await verify(args.task, workerResults, depth, workDir, busSocketPath);
    if (verifyResult) {
      const vm = (verifyResult.output || '').match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
      logIpc('verifier', 'orchestrator', 'verdict', vm ? vm[1] : 'UNKNOWN', { durationMs: verifyResult.durationMs });
    }
  }

  const totalMs = Date.now() - startTime;

  // ── Unmount TUI before printing summary ──
  if (dashboard) {
    dashboard.unmount();
    setQuiet(args.quiet);
  }

  // Log swarm completion to IPC
  const completed = workerResults.filter(r => r.exitCode === 0).length;
  const failed = workerResults.filter(r => r.exitCode !== 0).length;
  logIpc('system', 'user', 'lifecycle', 'Swarm complete: ' + completed + ' done, ' + failed + ' failed', { totalMs });

  // Validate and record agent outputs
  for (const result of workerResults) {
    // Validate output
    const validation = outputValidator.validateAgentOutput(
      { description: result.subtask || args.task, targetFiles: result.targetFiles, targetDirs: result.targetDirs },
      { output: result.output || "", toolCalls: result.toolCalls },
      result.filesChanged || []
    );

    if (!validation.valid) {
      log(`${colors.yellow}[output-validator] Agent ${result.id}: score ${validation.score.toFixed(2)} (${validation.checks.filter(c => !c.passed).length} failed checks)${colors.reset}`);
      if (validation.score < 0.4) {
        result._unreliable = true;
        log(`${colors.red}[output-validator] Agent ${result.id} marked UNRELIABLE (score < 0.4)${colors.reset}`);
      }
    }

    // Record learning patterns
    const taskType = mode; // Use swarm mode as task type
    const language = "javascript"; // Default, could be detected from file extensions
    const framework = "node"; // Default, could be detected from package.json

    if (result.exitCode === 0 && validation.score >= 0.7) {
      // Record successful pattern
      learningStore.record(taskType, language, framework, {
        approach: result.model || "default",
        success: true,
        duration: result.durationMs,
        filesChanged: (result.filesChanged || []).length,
      });
    } else if (result.exitCode !== 0) {
      // Record dead end
      learningStore.recordDeadEnd(
        taskType,
        `Agent ${result.id} failed with exit code ${result.exitCode}`,
        ["retry_with_different_model", "decompose_further"]
      );
    } else if (validation.score < 0.7) {
      // Record prompt hint for low-quality output
      learningStore.recordPromptHint(
        mode,
        `Agent produced low-quality output (score ${validation.score.toFixed(2)}): ${validation.checks.filter(c => !c.passed).map(c => c.name).join(", ")}`
      );
    }
  }

  // Build contract with FULL agent outputs embedded
  let contract;
  if (workerResults._isHierarchical && workerResults._hierarchical) {
    // Use the enriched hierarchical contract builder
    const hMeta = workerResults._hierarchical;
    const hierarchy = await loadHierarchy();
    if (hierarchy && hierarchy.buildHierarchicalContract) {
      contract = hierarchy.buildHierarchicalContract({
        task: args.task,
        decompositionTree: hMeta.decompositionTree,
        budgetEstimate: hMeta.budgetEstimate,
        workerResults,
        verifyResult,
        aggregation: hMeta.aggregation,
        mergeReport: hMeta.mergeReport,
        totalMs,
        workDir,
        governorReport: hMeta.governorReport,
      });
    } else {
      // Hierarchy module lost between phases — fall back to generic
      contract = buildContract(args.task, mode, workerResults, verifyResult, totalMs, workDir, conflictReport, depth);
    }
  } else {
    // Use outer conflictReport (from executeParallel) — don't shadow with workerResults._conflictReport
    const effectiveConflicts = conflictReport || workerResults._conflictReport || null;
    contract = buildContract(args.task, mode, workerResults, verifyResult, totalMs, workDir, effectiveConflicts, depth);
  }

  // Write result file
  if (args.resultFile) {
    writeFileSync(args.resultFile, JSON.stringify(contract, null, 2), "utf-8");
    log(`\n${colors.dim}Result: ${args.resultFile}${colors.reset}`);
  }

  // Summary
  log(`\n${colors.bold}═══ SWARM COMPLETE ═══${colors.reset}`);
  log(`Mode: ${mode} | Agents: ${contract.summary.total_agents} | Duration: ${(totalMs / 1000).toFixed(1)}s`);
  log(`Completed: ${contract.summary.completed} | Failed: ${contract.summary.failed}`);
  log(`Work dir: ${workDir}`);
  log(`Per-agent files: ${contract.summary.per_agent_files.join(", ")}`);

  if (verifyResult) {
    const verdictMatch = verifyResult.output?.match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
    const verdict = verdictMatch ? verdictMatch[1] : "UNKNOWN";
    log(`Verification: ${verdict === "PASS" ? `${colors.green}PASS${colors.reset}` : verdict === "FAIL" ? `${colors.red}FAIL${colors.reset}` : `${colors.yellow}${verdict}${colors.reset}`}`);
  }

  // Hierarchical-specific summary
  if (contract.aggregation) {
    const agg = contract.aggregation;
    const confPct = agg.overallConfidence != null ? `${(agg.overallConfidence * 100).toFixed(0)}%` : "N/A";
    log(`Aggregation: confidence=${confPct} | conflicts=${agg.totalConflicts} (${agg.resolvedConflicts} resolved, ${agg.unresolvedConflicts} unresolved)`);
  }
  if (contract.decomposition) {
    log(`Decomposition: depth=${contract.decomposition.depth} | nodes=${contract.decomposition.totalNodes} | workers=${contract.decomposition.leafNodes}`);
  }

  // Write merged output to stdout (all agents combined)
  if (contract.merged_output) {
    process.stdout.write(contract.merged_output + "\n");
  }

  // If no result file specified, also write the contract to stdout
  if (!args.resultFile) {
    process.stdout.write("\n" + JSON.stringify(contract, null, 2) + "\n");
  }

  // bd task lifecycle: close
  if (args.bdTask) {
    try {
      if (contract.summary.failed === 0) {
        execFileSync("bd", ["close", args.bdTask, "--reason", `completed: ${mode}, ${contract.summary.total_agents} agents, ${(totalMs/1000).toFixed(0)}s`], { timeout: 5000 });
        log(`${colors.dim}bd: closed ${args.bdTask}${colors.reset}`);
      } else {
        log(`${colors.yellow}bd: ${args.bdTask} left open (${contract.summary.failed} failures)${colors.reset}`);
      }
    } catch (error) {
      console.error("[swarm.mjs:main] Error:", error.message || error);
    }
  }

  // Clean up any remaining worktrees and backups (belt-and-suspenders)
  const wtDir = join(workDir, "worktrees");
  if (existsSync(wtDir)) {
    try {
      for (const d of readdirSync(wtDir)) {
        cleanupIsolation(join(wtDir, d), null);
      }
    } catch (error) {
      console.error("[swarm.mjs:main] Error:", error.message || error);
    }
  }
  const bkDir = join(workDir, "backups");
  if (existsSync(bkDir)) {
    try { rmSync(bkDir, { recursive: true, force: true }); } catch (error) {
      console.error("[swarm.mjs:main] Error:", error.message || error);
    }
  }

  // Stop top-level IPC bus (started before TUI for early connectivity)
  if (topLevelBus) {
    try { await topLevelBus.stop(); } catch {}
  }

  process.exit(contract.summary.failed > 0 ? 1 : 0);
}

process.on("unhandledRejection", (reason) => {
  console.error("[swarm:unhandledRejection] Unhandled promise rejection:", reason);
  process.exit(1);
});

main().catch((err) => {
  log(`${colors.red}Fatal: ${err.message}${colors.reset}`);
  process.exit(1);
});

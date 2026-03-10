#!/usr/bin/env node
/**
 * swarm — Parallel remote-agent orchestrator with verification
 *
 * Sits between the main Claude session and individual remote-agent calls.
 * Handles: task decomposition → parallel execution → verification → reporting.
 *
 * All orchestration logic lives in lib/ modules. This file is the slim
 * entry point that wires everything together via mode routing.
 *
 * Catch blocks: 3 total, 3 fixed (added error logging to silent catches)
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { colors, log, setQuiet } from "./lib/output.mjs";
import { DEPTH } from "./lib/config.mjs";
import { parseSwarmArgs, showSwarmHelp } from "./lib/cli.mjs";
import { spawnAgent } from "./lib/agent-spawn.mjs";
import { aiDecision, isAiClientAvailable } from "./lib/ai-client.mjs";
import { autoMode, decompose, executeParallel, executePipeline, verify, buildContract } from "./lib/orchestration.mjs";
import { prepareWorktree, validateAndApply, cleanupIsolation } from "./lib/isolation.mjs";
import { claimBdTask, cleanOldRuns } from "./lib/lifecycle.mjs";

const SWARM_BASE = "/tmp/swarm";

// ── Scout project structure (Phase 3 — parallel with decompose) ──
async function scoutProject(task, workDir, contextFile) {
  // Gather file tree (same approach as decompose)
  let tree = "";
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

  // Fast path: Direct API call (~2-5s vs 30-60s subprocess)
  if (isAiClientAvailable() && tree) {
    try {
      const result = await aiDecision({
        model: "claude-sonnet-4-6",
        system: "You are a project structure analyzer. Given a file listing, identify the main language/framework, key entry points, architecture pattern, and module boundaries. Output a concise 1-paragraph summary.",
        prompt: `Project files:\n${tree}\n\nTask context: ${task.slice(0, 300)}\n\nSummarize the project structure in 1 paragraph.`,
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
    `Quickly scan the project structure. List the top-level directories, key files, and identify the main language/framework.`,
    `Output a 1-paragraph summary.`,
    ``,
    `Context: ${task.slice(0, 200)}`,
  ].join("\n");

  const start = Date.now();
  const result = await spawnAgent({
    task: scoutTask,
    role: "worker",
    model: "sonnet",
    turns: 5,
    budget: 2,
    timeout: 60,
    resultFile: rf,
    contextFile,
    agentId: "scout",
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`${colors.dim}scout: project scan completed in ${elapsed}s (subprocess fallback)${colors.reset}`);

  return result.output || "(scout produced no output)";
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseSwarmArgs(process.argv);
  setQuiet(args.quiet);

  if (args.help) { showSwarmHelp(); process.exit(0); }
  if (!args.task) {
    log(`${colors.red}Error: No task provided.${colors.reset}`);
    process.exit(1);
  }

  const mode = args.mode === "auto" ? await autoMode(args.task) : args.mode;
  const depth = DEPTH[args.depth] ? args.depth : "normal";
  const shouldVerify = args.verify ?? (mode === "swarm" || mode === "pipeline" || mode === "review");

  // Create per-run work directory — all agent files go here
  const runId = randomUUID().slice(0, 8);
  const workDir = join(SWARM_BASE, runId);
  mkdirSync(workDir, { recursive: true });
  cleanOldRuns(SWARM_BASE);

  log(`${colors.bold}${colors.cyan}swarm${colors.reset} ${colors.dim}|${colors.reset} mode=${mode} ${colors.dim}|${colors.reset} agents=${args.agents} ${colors.dim}|${colors.reset} depth=${depth} ${colors.dim}|${colors.reset} verify=${shouldVerify}${args.bdTask ? ` ${colors.dim}|${colors.reset} bd=${args.bdTask}` : ""}`);
  log(`${colors.dim}Run: ${workDir}${colors.reset}`);
  log(`${colors.dim}Task: ${args.task.slice(0, 80)}${args.task.length > 80 ? "..." : ""}${colors.reset}`);
  log("");

  // bd task lifecycle: claim
  await claimBdTask(args.bdTask);

  const startTime = Date.now();
  let workerResults = [];
  let verifyResult = null;
  let scoutSummary = null;
  const mainCwd = process.cwd();

  if (mode === "single") {
    const rf = join(workDir, "agent-01-result.json");
    log(`${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Single agent...`);
    const isolation = prepareWorktree(workDir, "agent-01", mainCwd);
    const result = await spawnAgent({
      task: args.task, role: "worker", model: "sonnet",
      turns: DEPTH[depth].turns, budget: DEPTH[depth].budget,
      timeout: args.timeout, resultFile: rf, contextFile: args.contextFile,
      agentId: "agent-01", cwd: isolation.worktreePath || mainCwd,
    });
    workerResults = [{ id: "agent-01", subtask: args.task.slice(0, 80), model: "sonnet", ...result, resultFile: rf, worktreePath: isolation.worktreePath }];
    log(`  ${result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`} ${(result.durationMs / 1000).toFixed(1)}s`);
    if (isolation.success) {
      const apply = validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked);
      if (apply.valid) {
        log(`  ${colors.green}✓${colors.reset} agent-01: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
      } else {
        log(`  ${colors.red}✗${colors.reset} agent-01: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }

  } else if (mode === "parallel" || mode === "swarm") {
    // Phase 3: Run scout in parallel with decomposer to eliminate idle time
    const [subtasks, scoutOutput] = await Promise.all([
      decompose(args.task, Math.max(1, args.agents - 1), depth, args.contextFile, workDir),
      scoutProject(args.task, workDir, args.contextFile),
    ]);
    scoutSummary = scoutOutput;
    workerResults = await executeParallel(subtasks, depth, args.contextFile, workDir, scoutSummary);

  } else if (mode === "pipeline") {
    workerResults = await executePipeline(args.task, depth, args.contextFile, workDir);

  } else if (mode === "review") {
    const rf = join(workDir, "reviewer-result.json");
    log(`${colors.bold}${colors.cyan}[REVIEW]${colors.reset} Opus reviewer...`);
    const isolation = prepareWorktree(workDir, "reviewer", mainCwd);
    const result = await spawnAgent({
      task: args.task, role: "worker", model: "opus",
      turns: 15, budget: DEPTH[depth].budget,
      timeout: args.timeout, resultFile: rf, contextFile: args.contextFile,
      agentId: "reviewer", cwd: isolation.worktreePath || mainCwd,
    });
    workerResults = [{ id: "reviewer", subtask: args.task.slice(0, 80), model: "opus", ...result, resultFile: rf, worktreePath: isolation.worktreePath }];
    log(`  ${result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`} ${(result.durationMs / 1000).toFixed(1)}s`);
    if (isolation.success) {
      const apply = validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked);
      if (apply.valid) {
        log(`  ${colors.green}✓${colors.reset} reviewer: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
      } else {
        log(`  ${colors.red}✗${colors.reset} reviewer: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }
  }

  // Verification pass
  if (shouldVerify) {
    verifyResult = await verify(args.task, workerResults, depth, workDir);
  }

  const totalMs = Date.now() - startTime;

  // Build contract with FULL agent outputs embedded
  const contract = buildContract(args.task, mode, workerResults, verifyResult, totalMs, workDir);

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

  process.exit(contract.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`${colors.red}Fatal: ${err.message}${colors.reset}`);
  process.exit(1);
});

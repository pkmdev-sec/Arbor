/**
 * Swarm orchestration — decompose, execute, verify, report
 *
 * Extracted from swarm.mjs.pre-refactor:
 *   - decompose()         lines ~191-249
 *   - executeParallel()   lines ~252-317
 *   - executePipeline()   lines ~320-373
 *   - verify()            lines ~376-425
 *   - buildContract()     lines ~428-482
 *   - autoMode()          lines ~485-561
 *
 * These are the top-level swarm workflow phases. The main entry point
 * (swarm.mjs) calls these in sequence based on the chosen mode.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { colors, log } from "./output.mjs";
import { DEPTH } from "./config.mjs";
import { spawnAgent } from "./agent-spawn.mjs";
import { readAgentResult } from "./context-bridge.mjs";
import { prepareWorktree, validateAndApply, cleanupIsolation } from "./isolation.mjs";

// ── Phase: Decompose task into subtasks ───────────────────────────
export async function decompose(task, maxAgents, depth, contextFile, workDir) {
  log(`${colors.bold}${colors.cyan}[DECOMPOSE]${colors.reset} Scanning project → splitting into ${maxAgents} subtasks...`);

  let projectStructure = "";
  try {
    let tree = "";
    // Try git ls-files first (respects .gitignore)
    try {
      tree = execFileSync("git", ["ls-files"], {
        encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
      }).split("\n").filter(Boolean).slice(0, 300).join("\n");
    } catch {
      // Fallback to find if not a git repo
      tree = execFileSync("find", [".", "-maxdepth", "2", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
        encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
      }).split("\n").filter(Boolean).slice(0, 300).join("\n");
    }
    projectStructure = `\n\nACTUAL PROJECT FILE STRUCTURE (first 300 files):\n${tree}`;
  } catch {}

  const rf = join(workDir, "decompose.json");
  const result = await spawnAgent({
    task: [
      `You are decomposing work for ${maxAgents} parallel agents.`,
      `Each agent gets a SEPARATE subtask — they must NOT overlap.`,
      `Split by directory/module boundaries based on the actual project structure below.`,
      ``,
      `TASK: ${task}`,
      projectStructure,
      ``,
      `Create exactly ${maxAgents} subtasks. Each subtask must specify which files/directories it covers.`,
    ].join("\n"),
    role: "decomposer",
    model: "sonnet",
    turns: 5,
    budget: 3,
    timeout: 120,
    resultFile: rf,
    contextFile,
    agentId: "decomposer",
  });

  try {
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const subtasks = JSON.parse(jsonMatch[0]);
      if (Array.isArray(subtasks) && subtasks.length > 0) {
        log(`${colors.green}  ✓ Decomposed into ${subtasks.length} subtasks${colors.reset}`);
        for (const st of subtasks) {
          log(`  ${colors.dim}  → ${(st.title || st.task || "").slice(0, 70)}${colors.reset}`);
        }
        return subtasks.slice(0, maxAgents);
      }
    }
  } catch {}

  log(`${colors.yellow}  ⚠ Decomposition failed — running as single task${colors.reset}`);
  return [{ title: "Full task", task, scope: [], turns: DEPTH[depth].turns, model: "sonnet" }];
}

// ── Phase: Execute subtasks in parallel ───────────────────────────
export async function executeParallel(subtasks, depth, contextFile, workDir, scoutSummary) {
  log(`${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Spawning ${subtasks.length} parallel agents...`);
  const preset = DEPTH[depth];
  const mainCwd = process.cwd();

  // Phase 3: Inject scout summary as untrusted informational context
  const scoutPrompt = scoutSummary
    ? `\n\n[Scout Report]\n${scoutSummary.slice(0, 500)}\n(This is informational context from a preliminary scan — verify before using)`
    : null;

  const promises = subtasks.map((st, i) => {
    const id = `agent-${String(i + 1).padStart(2, "0")}`;
    const rf = join(workDir, `${id}-result.json`);
    log(`  ${colors.dim}${id}: ${(st.title || st.task || "").slice(0, 60)}${colors.reset}`);

    const isolation = prepareWorktree(workDir, id, mainCwd);

    return spawnAgent({
      task: st.task || st.title,
      role: "worker",
      model: st.model || "sonnet",
      turns: st.turns || preset.turns,
      budget: preset.budget,
      timeout: 600,
      resultFile: rf,
      contextFile,
      systemPrompt: scoutPrompt, // Phase 3: Pass scout context to workers
      agentId: id,
      cwd: isolation.worktreePath || mainCwd,
    }).then((result) => ({
      id,
      subtask: st.title || st.task?.slice(0, 80),
      scope: st.scope || [],
      model: st.model || "sonnet",
      ...result,
      resultFile: rf,
      isolation,
    }));
  });

  const results = await Promise.all(promises);

  for (const r of results) {
    const icon = r.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} ${r.id}: ${(r.durationMs / 1000).toFixed(1)}s (exit ${r.exitCode})`);
  }

  // Validate and apply isolation changes (with cumulative tracking for parallel agents)
  const knownApplied = new Set();
  for (const r of results) {
    if (!r.isolation?.success) continue;
    const apply = validateAndApply(r.isolation.worktreePath, mainCwd, r.isolation.snapshot, r.isolation.backupDir, r.isolation.copiedUntracked, knownApplied);
    if (apply.valid) {
      r.applied_files = apply.applied;
      for (const f of apply.applied) knownApplied.add(f);
      log(`  ${colors.green}✓${colors.reset} ${r.id}: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
    } else {
      log(`  ${colors.red}✗${colors.reset} ${r.id}: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      r.worktree_rejected = true;
      r.validation_errors = apply.errors;
    }
    cleanupIsolation(r.isolation.worktreePath, r.isolation.backupDir);
  }

  return results;
}

// ── Phase: Execute pipeline stages sequentially ───────────────────
export async function executePipeline(task, depth, contextFile, workDir) {
  const preset = DEPTH[depth];
  const mainCwd = process.cwd();
  const stages = [
    { name: "RESEARCH",  model: "sonnet", turns: 15,
      task: `Research and map the codebase for: ${task}. List relevant files, architecture, integration points.` },
    { name: "IMPLEMENT", model: "sonnet", turns: preset.turns,
      task: `Implement: ${task}` },
    { name: "TEST",      model: "sonnet", turns: 20,
      task: `Run the project test suite. If tests fail due to recent changes, fix them. Report all results.` },
    { name: "REVIEW",    model: "opus",   turns: 15,
      task: `Adversarial review of all recent changes. Find bugs, security issues, logic errors. Fix any you find.` },
  ];

  const results = [];
  for (const [i, stage] of stages.entries()) {
    const id = `stage-${i + 1}-${stage.name.toLowerCase()}`;
    const rf = join(workDir, `${id}-result.json`);
    log(`${colors.bold}${colors.magenta}[${stage.name}]${colors.reset} ${stage.task.slice(0, 70)}...`);

    const isolation = prepareWorktree(workDir, id, mainCwd);

    const result = await spawnAgent({
      task: stage.task,
      role: "worker",
      model: stage.model,
      turns: stage.turns,
      budget: preset.budget,
      timeout: 600,
      resultFile: rf,
      contextFile: i > 0 ? results[0]?.resultFile : contextFile,
      agentId: id,
      cwd: isolation.worktreePath || mainCwd,
    });

    const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} ${(result.durationMs / 1000).toFixed(1)}s`);

    // Validate and apply isolation changes for this stage
    if (isolation.success) {
      const apply = validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked);
      if (apply.valid) {
        log(`  ${colors.green}✓${colors.reset} ${id}: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
      } else {
        log(`  ${colors.red}✗${colors.reset} ${id}: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }

    results.push({ id, name: stage.name, subtask: stage.task.slice(0, 80), model: stage.model, ...result, resultFile: rf, worktreePath: isolation.worktreePath });
  }

  return results;
}

// ── Phase: Verify all results ─────────────────────────────────────
export async function verify(task, workerResults, depth, workDir) {
  log(`${colors.bold}${colors.cyan}[VERIFY]${colors.reset} Spawning verifier to cross-check...`);
  const preset = DEPTH[depth];

  const workerSummary = workerResults.map((r) => {
    // Read output from result file if stdout was empty
    let output = r.output || "";
    if (!output) {
      const fileResult = readAgentResult(r.resultFile);
      if (fileResult?.error) {
        output = `(Error reading result file: ${fileResult.error})`;
      } else {
        output = fileResult?.output || "";
      }
    }
    return `--- ${r.id} (${r.subtask || r.name || "worker"}) ---\nStatus: exit ${r.exitCode}\n${output.slice(0, 3000)}`;
  }).join("\n\n");

  let gitDiff = "";
  let gitDiffFailed = false;
  try {
    gitDiff = execFileSync("git", ["diff"], { encoding: "utf-8", timeout: 10000 }).slice(0, 5000);
  } catch (err) {
    gitDiffFailed = true;
    log(`${colors.yellow}Warning: Failed to get git diff for verification: ${err.message}${colors.reset}`);
  }

  const rf = join(workDir, "verify-result.json");
  const gitDiffSection = gitDiff
    ? `GIT DIFF:\n${gitDiff}`
    : gitDiffFailed
    ? "(git diff unavailable - command failed)"
    : "(no git diff)";

  const result = await spawnAgent({
    task: `ORIGINAL TASK: ${task}\n\nWORKER OUTPUTS:\n${workerSummary}\n\n${gitDiffSection}\n\nCross-check every claim against actual changes. Produce your verdict.`,
    role: "verifier",
    model: preset.verifyModel,
    turns: 15,
    budget: preset.budget,
    timeout: 300,
    resultFile: rf,
    agentId: "verifier",
  });

  const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.yellow}⚠${colors.reset}`;
  log(`  ${icon} Verification: ${(result.durationMs / 1000).toFixed(1)}s`);

  return { ...result, resultFile: rf };
}

// ── Build completion contract with FULL agent outputs ─────────────
export function buildContract(task, mode, workerResults, verifyResult, totalMs, workDir) {
  // Collect full output for each agent (from result files + stdout)
  const agents = workerResults.map((r) => {
    let fullOutput = r.output || "";
    // Also try reading from result file for richer data
    const fileResult = readAgentResult(r.resultFile);
    if (fileResult?.output && fileResult.output.length > fullOutput.length) {
      fullOutput = fileResult.output;
    }

    return {
      id: r.id,
      role: r.name ? "stage" : "worker",
      subtask: r.subtask || r.name || "task",
      scope: r.scope || [],
      model: r.model || "sonnet",
      status: r.exitCode === 0 ? "completed" : "failed",
      duration_ms: r.durationMs,
      exit_code: r.exitCode,
      result_file: r.resultFile,
      output: fullOutput,  // FULL output embedded
    };
  });

  // Combine all agent outputs into a structured merged result
  const mergedOutput = agents.map((a) => {
    const header = `═══ ${a.id.toUpperCase()} | ${a.subtask} | ${a.status} (${(a.duration_ms / 1000).toFixed(1)}s) ═══`;
    return `${header}\n${a.output || "(no output)"}`;
  }).join("\n\n");

  const contract = {
    version: 2,
    task,
    mode,
    work_dir: workDir,
    timestamp: new Date().toISOString(),
    agents,
    merged_output: mergedOutput,  // ALL agent outputs combined
    verification: verifyResult ? {
      model: DEPTH[DEPTH.thorough ? "thorough" : "normal"]?.verifyModel || "sonnet",
      duration_ms: verifyResult.durationMs,
      output: (verifyResult.output || "").slice(0, 10000),
      result_file: verifyResult.resultFile,
    } : null,
    summary: {
      total_agents: agents.length + (verifyResult ? 1 : 0),
      completed: agents.filter((a) => a.status === "completed").length,
      failed: agents.filter((a) => a.status === "failed").length,
      total_duration_ms: totalMs,
      per_agent_files: agents.map((a) => a.result_file),
    },
  };

  return contract;
}

// ── Auto-detect mode ──────────────────────────────────────────────
export function autoMode(task) {
  const t = task.toLowerCase();

  // Initialize scores for each mode
  const scores = {
    review: 0,
    single: 0,
    parallel: 0,
    pipeline: 0,
    swarm: 0
  };

  // Check review keywords (weight 3)
  if (/\b(review|audit|check|inspect)\b/.test(t)) {
    scores.review += 3;
  }

  // Check single keywords (weight 2)
  if (/\b(fix|bug|debug|crash|error|broken)\b/.test(t)) {
    scores.single += 2;
  }

  // Check parallel keywords (weight 2)
  if (/\b(explore|analyze|understand|map|research|investigate)\b/.test(t)) {
    scores.parallel += 2;
  }

  // Check refactor keywords → pipeline (weight 2)
  if (/\b(refactor|restructure|clean|reorganize)\b/.test(t)) {
    scores.pipeline += 2;
  }

  // Check implement keywords
  const hasImplement = /\b(implement|build|create|add|scaffold|migrate)\b/.test(t);
  const hasScope = /\b(all|whole|entire|full)\b/.test(t);

  if (hasImplement) {
    if (hasScope) {
      scores.swarm += 3;
    } else {
      scores.pipeline += 2;
    }
  }

  // Find the mode with highest score
  let maxScore = 0;
  let topModes = [];

  for (const [mode, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      topModes = [mode];
    } else if (score === maxScore && score > 0) {
      topModes.push(mode);
    }
  }

  // Tie-breaking: single > pipeline > parallel > swarm > review
  const tieBreaker = ['single', 'pipeline', 'parallel', 'swarm', 'review'];
  let selected = 'single'; // default

  if (topModes.length > 0) {
    selected = topModes.sort((a, b) =>
      tieBreaker.indexOf(a) - tieBreaker.indexOf(b)
    )[0];
  }

  // Log scoring to stderr
  const scoreStr = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .map(([mode, score]) => `${mode}=${score}`)
    .join(' ');

  process.stderr.write(`autoMode: ${scoreStr || 'none=0'} → ${selected}\n`);

  return selected;
}

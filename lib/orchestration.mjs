/**
 * Arbor-swarm orchestration — decompose, execute, verify, report
 *
 * Extracted from swarm.mjs.pre-refactor:
 *   - decompose()         lines ~191-249
 *   - executeParallel()   lines ~252-317
 *   - executePipeline()   lines ~320-373
 *   - verify()            lines ~376-425
 *   - buildContract()     lines ~428-482
 *   - autoMode()          lines ~485-561
 *
 * These are the top-level orchestration workflow phases. The main entry point
 * (swarm.mjs) calls these in sequence based on the chosen mode.
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { colors, log } from "./output.mjs";
import { DEPTH, ROLE_PROMPTS } from "./config.mjs";
import { spawnAgent } from "./agent-spawn.mjs";
import { aiDecision, aiJsonDecision, isAiClientAvailable } from "./ai-client.mjs";
import { readAgentResult } from "./context-bridge.mjs";
import { prepareWorktree, prepareWorktreeGit, prepareWorktreeSnapshot, validateAndApply, cleanupIsolation, cacheSnapshot, getCachedSnapshot, backupFilesAsync } from "./isolation.mjs";
import { logIpc } from "./tui/ipc-logger.mjs";

// ── Test detection and execution ──────────────────────────────────
async function detectAndRunTests() {
  const cwd = process.cwd();

  // 1. Node projects: package.json scripts.test
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const testScript = pkg?.scripts?.test;
      if (testScript && !/no test specified/.test(testScript)) {
        return await runTestCommand("npm", ["test"], cwd);
      }
    }
  } catch { /* skip detection errors */ }

  // 2. Python projects: pytest markers
  for (const marker of ["pytest.ini", "setup.py", "pyproject.toml"]) {
    if (existsSync(join(cwd, marker))) {
      return await runTestCommand("python3", ["-m", "pytest", "--tb=short", "-q"], cwd);
    }
  }

  // 3. Makefile with test target
  try {
    const makefilePath = join(cwd, "Makefile");
    if (existsSync(makefilePath)) {
      const makefile = readFileSync(makefilePath, "utf-8");
      if (/^test\s*:/m.test(makefile)) {
        return await runTestCommand("make", ["test"], cwd);
      }
    }
  } catch { /* skip detection errors */ }

  // 4. Go projects: go.mod or *_test.go files
  if (existsSync(join(cwd, "go.mod"))) {
    return await runTestCommand("go", ["test", "./..."], cwd);
  }
  try {
    const { stdout } = await execFileAsync("find", [".", "-maxdepth", "3", "-name", "*_test.go"], {
      encoding: "utf-8", timeout: 5000, cwd,
    });
    if (stdout.trim()) {
      return await runTestCommand("go", ["test", "./..."], cwd);
    }
  } catch { /* skip detection errors */ }

  // 5. Rust projects: Cargo.toml
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return await runTestCommand("cargo", ["test"], cwd);
  }

  // 6. Swift projects: Package.swift
  if (existsSync(join(cwd, "Package.swift"))) {
    return await runTestCommand("swift", ["test"], cwd);
  }

  return { test_executed: false, reason: "no test command detected" };
}

async function runTestCommand(cmd, cmdArgs, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      encoding: "utf-8",
      timeout: 120000,
      cwd,
    });
    const output = (stdout + "\n" + stderr).trim().slice(-2000);
    return { test_executed: true, test_exit_code: 0, test_output_preview: output };
  } catch (err) {
    const output = ((err.stdout || "") + "\n" + (err.stderr || "")).trim().slice(-2000);
    return { test_executed: true, test_exit_code: err.status ?? 1, test_output_preview: output };
  }
}

// ── Phase: Decompose task into subtasks ───────────────────────────
export async function decompose(task, maxAgents, depth, contextFile, workDir, projectTree = "") {
  log(`${colors.bold}${colors.cyan}[DECOMPOSE]${colors.reset} Scanning project → splitting into ${maxAgents} subtasks...`);
  logIpc('orchestrator', 'decomposer', 'task_assign', 'Decompose into ' + maxAgents + ' subtasks');

  // S3: Use pre-computed projectTree if provided, otherwise scan
  let projectStructure = "";
  if (projectTree) {
    projectStructure = `\n\nACTUAL PROJECT FILE STRUCTURE (first 300 files):\n${projectTree}`;
  } else {
    try {
      let tree = "";
      try {
        tree = execFileSync("git", ["ls-files"], {
          encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
        }).split("\n").filter(Boolean).slice(0, 300).join("\n");
      } catch {
        tree = execFileSync("find", [".", "-maxdepth", "2", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
          encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
        }).split("\n").filter(Boolean).slice(0, 300).join("\n");
      }
      projectStructure = `\n\nACTUAL PROJECT FILE STRUCTURE (first 300 files):\n${tree}`;
    } catch {}
  }

  const userPrompt = [
    `Decompose the following task for ${maxAgents} parallel agents.`,
    `Each agent executes independently in its own worktree — they CANNOT communicate or share state.`,
    ``,
    `TASK: ${task}`,
    projectStructure,
    ``,
    `Requirements:`,
    `- Create exactly ${maxAgents} subtasks with non-overlapping file scopes`,
    `- Each subtask must be self-contained (an agent with zero prior context can execute it)`,
    `- Reference specific files/directories from the project structure above`,
    `- If file ownership is ambiguous, assign it to ONE subtask only`,
  ].join("\n");

  // Fast path: Direct API call (~2-5s vs 30-60s subprocess)
  if (isAiClientAvailable()) {
    try {
      const result = await aiJsonDecision({
        model: "claude-sonnet-4-6",
        system: ROLE_PROMPTS.decomposer,
        prompt: userPrompt,
        maxTokens: 4096,
      });

      const tokens = `${result.usage.input_tokens}+${result.usage.output_tokens}`;
      process.stderr.write(`decompose: [${result.latencyMs}ms, ${tokens} tokens]\n`);

      if (Array.isArray(result.parsed) && result.parsed.length > 0) {
        const subtasks = result.parsed.slice(0, maxAgents);
        log(`${colors.green}  ✓ Decomposed into ${subtasks.length} subtasks (API direct)${colors.reset}`);
        const titles = subtasks.map(st => (st.title || st.task || "").slice(0, 70));
        for (const t of titles) {
          log(`  ${colors.dim}  → ${t}${colors.reset}`);
        }
        logIpc('decomposer', 'orchestrator', 'result', subtasks.length + ' subtasks: ' + titles.join(', '), { latencyMs: result.latencyMs, tokens: tokens });
        process.stderr.write(JSON.stringify({ event: "decompose_status", status: "ai_direct", subtask_count: subtasks.length }) + "\n");
        return subtasks;
      }
      // AI returned invalid/empty result — fall through with explicit warning
      const reason = !result.parsed ? "AI returned null" : !Array.isArray(result.parsed) ? "AI returned non-array" : "AI returned empty array";
      log(`${colors.yellow}  ⚠ Decomposition: ${reason}. Falling back to subprocess.${colors.reset}`);
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "ai_invalid", reason }) + "\n");
    } catch (err) {
      log(`${colors.yellow}  ⚠ Decomposition: API error (${err.message}). Falling back to subprocess.${colors.reset}`);
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "ai_error", reason: err.message }) + "\n");
    }
  }

  // Fallback: Spawn full Claude Code subprocess
  const rf = join(workDir, "decompose.json");
  const result = await spawnAgent({
    task: userPrompt,
    role: "decomposer",
    model: "sonnet",
    turns: 5,
    budget: 3,
    resultFile: rf,
    contextFile,
    agentId: "decomposer",
  });

  try {
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const subtasks = JSON.parse(jsonMatch[0]);
      if (Array.isArray(subtasks) && subtasks.length > 0) {
        log(`${colors.green}  ✓ Decomposed into ${subtasks.length} subtasks (subprocess)${colors.reset}`);
        for (const st of subtasks) {
          log(`  ${colors.dim}  → ${(st.title || st.task || "").slice(0, 70)}${colors.reset}`);
        }
        logIpc('decomposer', 'orchestrator', 'result', subtasks.length + ' subtasks (subprocess): ' + subtasks.map(s => (s.title || s.task || '').slice(0, 50)).join(', '), {});
        process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_fallback", subtask_count: subtasks.length }) + "\n");
        return subtasks.slice(0, maxAgents);
      }
      const reason = !subtasks ? "subprocess JSON parsed to null" : !Array.isArray(subtasks) ? "subprocess JSON not an array" : "subprocess returned empty array";
      log(`${colors.yellow}  ⚠ Decomposition: ${reason}. Falling back to single agent.${colors.reset}`);
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_invalid", reason }) + "\n");
    } else {
      log(`${colors.yellow}  ⚠ Decomposition: subprocess output contained no JSON array. Falling back to single agent.${colors.reset}`);
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_no_json", reason: "no JSON array in output" }) + "\n");
    }
  } catch (err) {
    log(`${colors.yellow}  ⚠ Decomposition: JSON parse failed (${err.message}). Falling back to single agent.${colors.reset}`);
    process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_parse_error", reason: err.message }) + "\n");
  }

  log(`${colors.red}  ✗ DEGRADED: Running as single agent. Task may produce lower quality results.${colors.reset}`);
  logIpc('decomposer', 'orchestrator', 'error', 'Decomposition failed — single agent fallback', {});
  process.stderr.write(JSON.stringify({ event: "decompose_status", status: "single_fallback", reason: "all decomposition methods failed" }) + "\n");
  return [{ title: "Full task", task, scope: [], turns: DEPTH[depth].turns, model: "sonnet" }];
}

// ── Phase: Execute subtasks in parallel ───────────────────────────
export async function executeParallel(subtasks, depth, contextFile, workDir, scoutSummary) {
  log(`${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Spawning ${subtasks.length} parallel agents...`);
  logIpc('orchestrator', 'all', 'lifecycle', 'Spawning ' + subtasks.length + ' parallel agents');
  const preset = DEPTH[depth];
  const mainCwd = process.cwd();

  // Phase 3: Inject scout summary as untrusted informational context
  const scoutPrompt = scoutSummary
    ? `\n\n[Scout Report]\n${scoutSummary.slice(0, 500)}\n(This is informational context from a preliminary scan — verify before using)`
    : null;

  // R2 Phase A: Create worktrees SEQUENTIALLY (git worktree lock)
  const agentSetups = [];
  for (let i = 0; i < subtasks.length; i++) {
    const id = `agent-${String(i + 1).padStart(2, "0")}`;
    log(`  ${colors.dim}${id}: ${(subtasks[i].title || subtasks[i].task || "").slice(0, 60)}${colors.reset}`);
    try {
      const gitResult = prepareWorktreeGit(workDir, id, mainCwd);
      agentSetups.push({ id, st: subtasks[i], ...gitResult, success: true });
    } catch (err) {
      log(`${colors.yellow}isolation: unavailable for ${id} (${err.message}), using parent cwd${colors.reset}`);
      agentSetups.push({ id, st: subtasks[i], wtPath: null, copiedUntracked: [], backupDir: null, success: false });
    }
  }

  // R2 Phase B: Snapshot ONCE, then backup in PARALLEL
  // Pre-cache the snapshot to avoid N redundant SHA-256 computations
  const snapshot = getCachedSnapshot(mainCwd) || await cacheSnapshot(mainCwd);
  const snapshotResults = await Promise.all(
    agentSetups.map(setup => {
      if (!setup.success) return Promise.resolve({ snapshot: null, backedUp: 0 });
      return backupFilesAsync(mainCwd, setup.backupDir, snapshot).then(backedUp => ({ snapshot, backedUp }));
    })
  );

  // Spawn all agents in parallel
  const promises = agentSetups.map((setup, i) => {
    const { id, st, wtPath, copiedUntracked, backupDir, success } = setup;
    const { snapshot } = snapshotResults[i];
    const rf = join(workDir, `${id}-result.json`);

    const isolation = {
      worktreePath: wtPath,
      snapshot,
      backupDir,
      copiedUntracked,
      success,
    };

    logIpc('orchestrator', id, 'task_assign', st.title || st.task?.slice(0, 80) || 'subtask', { model: st.model || 'sonnet', scope: st.scope || [] });

    return spawnAgent({
      task: st.task || st.title,
      role: "worker",
      model: st.model || "sonnet",
      turns: st.turns || preset.turns,
      budget: preset.budget,
      resultFile: rf,
      contextFile,
      systemPrompt: scoutPrompt,
      agentId: id,
      cwd: wtPath || mainCwd,
    }).then((result) => {
      const status = result.exitCode === 0 ? 'completed' : 'failed';
      logIpc(id, 'orchestrator', 'result', status + ' in ' + (result.durationMs / 1000).toFixed(1) + 's', { exitCode: result.exitCode, durationMs: result.durationMs });
      return {
        id,
        subtask: st.title || st.task?.slice(0, 80),
        scope: st.scope || [],
        model: st.model || "sonnet",
        ...result,
        resultFile: rf,
        isolation,
      };
    });
  });

  const results = await Promise.all(promises);

  for (const r of results) {
    const icon = r.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} ${r.id}: ${(r.durationMs / 1000).toFixed(1)}s (exit ${r.exitCode})`);
  }

  // ── Conflict detection: find files modified by multiple agents ───
  const fileToAgents = new Map();   // filename → [agentId, ...]
  const agentFiles = new Map();     // agentId → Set<filename>
  for (const r of results) {
    if (!r.isolation?.worktreePath) continue;
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], {
        encoding: "utf-8", timeout: 10000, cwd: r.isolation.worktreePath,
      });
      const files = stdout.split("\n").filter(Boolean);
      agentFiles.set(r.id, new Set(files));
      for (const f of files) {
        if (!fileToAgents.has(f)) fileToAgents.set(f, []);
        fileToAgents.get(f).push(r.id);
      }
    } catch (err) {
      log(`${colors.yellow}  ⚠ ${r.id}: could not list modified files (${err.message})${colors.reset}`);
    }
  }

  // Identify overlapping files (touched by >1 agent)
  const overlaps = new Map();  // filename → agentId[]
  for (const [file, agents] of fileToAgents) {
    if (agents.length > 1) overlaps.set(file, agents);
  }

  // Attempt three-way merge for each overlapping file
  const conflictReport = [];            // { file, agents, resolved: bool, error? }
  const mergedFiles = new Map();        // filename → merged content (if resolved)
  const unresolvedConflicts = new Set(); // filenames that could not be merged
  if (overlaps.size > 0) {
    log(`\n${colors.bold}${colors.yellow}  ⚠ FILE CONFLICTS: ${overlaps.size} file(s) modified by multiple agents${colors.reset}`);
    for (const [file, agents] of overlaps) {
      log(`    ${colors.yellow}${file}${colors.reset} → ${agents.join(", ")}`);
    }

    for (const [file, agents] of overlaps) {
      // Base: the pre-snapshot version from mainCwd
      const basePath = join(mainCwd, file);
      let baseContent;
      try {
        baseContent = readFileSync(basePath, "utf-8");
      } catch {
        // File didn't exist before — can't three-way merge a new file from two agents
        conflictReport.push({ file, agents, resolved: false, error: "file did not exist in base — cannot merge" });
        unresolvedConflicts.add(file);
        log(`    ${colors.red}✗ ${file}: no base version — cannot merge${colors.reset}`);
        continue;
      }

      // Get each agent's version from their worktree
      const agentVersions = [];
      for (const agentId of agents) {
        const r = results.find(r => r.id === agentId);
        if (!r?.isolation?.worktreePath) continue;
        const agentPath = join(r.isolation.worktreePath, file);
        try {
          agentVersions.push({ agentId, content: readFileSync(agentPath, "utf-8") });
        } catch {
          agentVersions.push({ agentId, content: null });
        }
      }

      // Three-way merge: iteratively merge each agent's version onto the base
      // Uses git merge-file which takes: current, base, other
      let currentMerged = baseContent;
      let mergeSucceeded = true;
      for (let i = 0; i < agentVersions.length; i++) {
        if (!agentVersions[i].content) continue;
        if (i === 0) {
          // First agent's version becomes the starting point
          currentMerged = agentVersions[i].content;
          continue;
        }
        // Write temp files for git merge-file
        const tmpCurrent = join(workDir, `merge-current-${file.replace(/\//g, "_")}`);
        const tmpBase = join(workDir, `merge-base-${file.replace(/\//g, "_")}`);
        const tmpOther = join(workDir, `merge-other-${file.replace(/\//g, "_")}`);
        try {
          writeFileSync(tmpCurrent, currentMerged, "utf-8");
          writeFileSync(tmpBase, baseContent, "utf-8");
          writeFileSync(tmpOther, agentVersions[i].content, "utf-8");
          // git merge-file modifies tmpCurrent in-place, exit 0 = clean merge
          execFileSync("git", ["merge-file", tmpCurrent, tmpBase, tmpOther], { timeout: 10000 });
          currentMerged = readFileSync(tmpCurrent, "utf-8");
        } catch (err) {
          // Non-zero exit from git merge-file means conflicts in the file
          mergeSucceeded = false;
          conflictReport.push({ file, agents, resolved: false, error: `merge conflict between ${agents[0]} and ${agentVersions[i].agentId}` });
          unresolvedConflicts.add(file);
          log(`    ${colors.red}✗ ${file}: merge conflict (${agents[0]} vs ${agentVersions[i].agentId})${colors.reset}`);
          break;
        }
      }

      if (mergeSucceeded) {
        mergedFiles.set(file, currentMerged);
        conflictReport.push({ file, agents, resolved: true });
        log(`    ${colors.green}✓ ${file}: three-way merge succeeded${colors.reset}`);
      }
    }
    log("");
  }

  // Attach conflict report to each affected agent result
  for (const r of results) {
    const agentConflicts = conflictReport.filter(c => c.agents.includes(r.id));
    if (agentConflicts.length > 0) {
      r.conflict_report = agentConflicts;
      if (agentConflicts.some(c => !c.resolved)) {
        r.has_unresolved_conflicts = true;
      }
    }
  }

  // Validate and apply isolation changes (with cumulative tracking for parallel agents)
  const knownApplied = new Set();
  for (const r of results) {
    if (!r.isolation?.success) continue;
    // R1: Pass agent scope for mtime pre-filter (always re-hash scoped files)
    // R6: Outer agent loop stays sequential for deterministic merge order; syntax checks within are parallel (R4)
    const apply = await validateAndApply({
      worktreePath: r.isolation.worktreePath,
      mainCwd,
      preSnapshot: r.isolation.snapshot,
      backupDir: r.isolation.backupDir,
      copiedUntracked: r.isolation.copiedUntracked,
      knownApplied,
      agentScope: r.scope || [],
      mergedFiles,
      unresolvedConflicts,
    });
    if (apply.valid) {
      r.applied_files = apply.applied;
      for (const f of apply.applied) knownApplied.add(f);
      logIpc('orchestrator', r.id, 'lifecycle', 'Applied ' + apply.applied.length + ' files' + (apply.escaped.length ? ', ' + apply.escaped.length + ' escaped' : ''), {});
      log(`  ${colors.green}✓${colors.reset} ${r.id}: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
    } else {
      logIpc('orchestrator', r.id, 'error', 'REJECTED: ' + (apply.errors || []).join(', '), {});
      log(`  ${colors.red}✗${colors.reset} ${r.id}: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      r.worktree_rejected = true;
      r.validation_errors = apply.errors;
    }
    cleanupIsolation(r.isolation.worktreePath, r.isolation.backupDir);
  }

  return { results, conflictReport };
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

    const isolation = await prepareWorktree(workDir, id, mainCwd);

    const result = await spawnAgent({
      task: stage.task,
      role: "worker",
      model: stage.model,
      turns: stage.turns,
      budget: preset.budget,
      resultFile: rf,
      contextFile: i > 0 ? results[0]?.resultFile : contextFile,
      agentId: id,
      cwd: isolation.worktreePath || mainCwd,
    });

    const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} ${(result.durationMs / 1000).toFixed(1)}s`);

    // Validate and apply isolation changes for this stage
    if (isolation.success) {
      const apply = await validateAndApply({
        worktreePath: isolation.worktreePath,
        mainCwd,
        preSnapshot: isolation.snapshot,
        backupDir: isolation.backupDir,
        copiedUntracked: isolation.copiedUntracked,
      });
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
  log(`${colors.bold}${colors.cyan}[VERIFY]${colors.reset} Cross-checking results...`);
  const preset = DEPTH[depth];
  logIpc('orchestrator', 'verifier', 'task_assign', 'Cross-check ' + workerResults.length + ' worker outputs', { model: preset.verifyModel });

  const workerSummary = workerResults.map((r) => {
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

  // R3: Async git diff (independent, no dependency)
  let gitDiff = "";
  let gitDiffFailed = false;
  try {
    const { stdout } = await execFileAsync("git", ["diff"], { encoding: "utf-8", timeout: 10000 });
    gitDiff = stdout.slice(0, 100000);
  } catch (err) {
    gitDiffFailed = true;
    log(`${colors.yellow}Warning: Failed to get git diff for verification: ${err.message}${colors.reset}`);
  }

  // Detect and run project tests if code was changed
  const hasCodeChanges = gitDiff.trim().length > 0;
  const testResults = hasCodeChanges
    ? await detectAndRunTests()
    : { test_executed: false, reason: "no code changes detected" };
  if (testResults.test_executed) {
    const tIcon = testResults.test_exit_code === 0 ? `${colors.green}✓` : `${colors.red}✗`;
    log(`  ${tIcon} Tests: exit ${testResults.test_exit_code}${colors.reset}`);
  } else {
    log(`  ${colors.dim}Tests: ${testResults.reason}${colors.reset}`);
  }

  const rf = join(workDir, "verify-result.json");
  const gitDiffSection = gitDiff
    ? `GIT DIFF:\n${gitDiff}`
    : gitDiffFailed
    ? "(git diff unavailable - command failed)"
    : "(no git diff)";

  const testSection = testResults.test_executed
    ? `TEST EXECUTION RESULTS:\nExit code: ${testResults.test_exit_code}\nOutput (last 2KB):\n${testResults.test_output_preview}`
    : `TEST EXECUTION RESULTS: Not executed — ${testResults.reason}`;

  const verifyPrompt = [
    `ORIGINAL TASK: ${task}`,
    ``,
    `WORKER OUTPUTS:`,
    workerSummary,
    ``,
    gitDiffSection,
    ``,
    testSection,
    ``,
    `## Verification Instructions`,
    `1. Extract every factual claim from worker outputs (files modified, functions added, tests passed)`,
    `2. Cross-reference each claim against the git diff — flag any claim without corresponding diff evidence`,
    `3. Check the diff for unclaimed changes (modifications no worker mentioned)`,
    `4. Identify items from the ORIGINAL TASK that no worker addressed`,
    `5. Evaluate the test execution results — flag failures as CRITICAL, flag missing tests as MAJOR if code was changed`,
    ``,
    `Produce your verdict in the required format.`,
  ].join("\n");

  // Fast path: Direct API call for verification
  if (isAiClientAvailable()) {
    try {
      const verifyModel = preset.verifyModel === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6";
      const result = await aiDecision({
        model: verifyModel,
        system: ROLE_PROMPTS.verifier,
        prompt: verifyPrompt,
        maxTokens: 4096,
      });

      const tokens = `${result.usage.input_tokens}+${result.usage.output_tokens}`;
      process.stderr.write(`verify: [${result.latencyMs}ms, ${tokens} tokens]\n`);

      // Write result for the contract builder
      const verifyOutput = { output: result.content, model: result.model, latencyMs: result.latencyMs };
      writeFileSync(rf, JSON.stringify(verifyOutput, null, 2), "utf-8");

      log(`  ${colors.green}✓${colors.reset} Verification: ${(result.latencyMs / 1000).toFixed(1)}s (API direct)`);

      // Extract verdict for IPC
      const verdictMatch = result.content.match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
      const verdict = verdictMatch ? verdictMatch[1] : 'UNKNOWN';
      logIpc('verifier', 'orchestrator', 'verdict', verdict, { latencyMs: result.latencyMs, tokens: tokens });

      return {
        output: result.content,
        exitCode: 0,
        durationMs: result.latencyMs,
        resultFile: rf,
        testResults,
      };
    } catch (err) {
      process.stderr.write(`verify: AI call failed (${err.message}), falling back to subprocess\n`);
    }
  }

  // Fallback: Spawn full Claude Code subprocess
  const result = await spawnAgent({
    task: verifyPrompt,
    role: "verifier",
    model: preset.verifyModel,
    turns: 15,
    budget: preset.budget,
    resultFile: rf,
    agentId: "verifier",
  });

  const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.yellow}⚠${colors.reset}`;
  log(`  ${icon} Verification: ${(result.durationMs / 1000).toFixed(1)}s`);

  // Extract verdict for IPC (subprocess path)
  const subVerdictMatch = (result.output || '').match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
  const subVerdict = subVerdictMatch ? subVerdictMatch[1] : 'UNKNOWN';
  logIpc('verifier', 'orchestrator', 'verdict', subVerdict, { durationMs: result.durationMs });

  return { ...result, resultFile: rf, testResults };
}

// ── Build completion contract with FULL agent outputs ─────────────
export function buildContract(task, mode, workerResults, verifyResult, totalMs, workDir, conflictReport = null, depth = "normal") {
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
      model: DEPTH[depth]?.verifyModel || "sonnet",
      duration_ms: verifyResult.durationMs,
      output: (verifyResult.output || "").slice(0, 10000),
      result_file: verifyResult.resultFile,
    } : null,
    tests: verifyResult?.testResults || null,
    conflict_report: conflictReport && conflictReport.length > 0 ? conflictReport : null,
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
const VALID_MODES = new Set(["single", "parallel", "pipeline", "swarm", "review"]);

export async function autoMode(task) {
  // Fast path: AI classification
  if (isAiClientAvailable()) {
    try {
      const result = await aiJsonDecision({
        model: "claude-sonnet-4-6",
        system: [
          "You are a routing classifier for a multi-agent code execution system.",
          "Given a task description, select the optimal execution mode by analyzing task complexity, scope, and nature.",
          'Respond with ONLY a JSON object: {"mode": "<mode>", "reasoning": "<1-sentence justification>"}',
          "",
          "## Decision Rubric",
          "",
          "### single",
          "USE WHEN: Task targets 1-3 specific files, is a focused fix/change, or requires deep sequential reasoning.",
          'SIGNALS: "fix bug in", "update function", "change config", "debug this", specific file paths mentioned.',
          "",
          "### parallel",
          "USE WHEN: Task requires broad exploration, analysis, or research across many files/modules.",
          'SIGNALS: "explore", "analyze", "find all", "understand", "map", "research", "investigate", "document".',
          "",
          "### pipeline",
          "USE WHEN: Task has natural sequential phases (research → implement → test → review) or is a refactoring.",
          'SIGNALS: "refactor", "restructure", "implement and test", "migrate", "add feature with tests".',
          "",
          "### swarm",
          "USE WHEN: Task touches many modules simultaneously, requires parallel implementation across boundaries.",
          'SIGNALS: "across all", "every module", "whole codebase", "all files", large scope + implementation.',
          "",
          "### review",
          "USE WHEN: Task is primarily about reading, auditing, or evaluating existing code.",
          'SIGNALS: "review", "audit", "check for", "security scan", "code quality", "find vulnerabilities".',
          "",
          "## Tie-Breaking",
          "If multiple modes seem equally valid, prefer: single > pipeline > parallel > swarm > review.",
          "Rationale: simpler modes have lower overhead and fewer failure points.",
        ].join("\n"),
        prompt: `TASK: ${task}`,
        maxTokens: 256,
      });

      if (result.parsed && VALID_MODES.has(result.parsed.mode)) {
        process.stderr.write(`autoMode(AI): ${result.parsed.mode} — ${result.parsed.reasoning || "no reason"} [${result.latencyMs}ms]\n`);
        logIpc('orchestrator', 'all', 'decision', 'Mode: ' + result.parsed.mode + ' — ' + (result.parsed.reasoning || 'no reason'), { latencyMs: result.latencyMs });
        return result.parsed.mode;
      }
      process.stderr.write(`autoMode: AI returned invalid mode (${JSON.stringify(result.parsed)}), falling back to regex\n`);
    } catch (err) {
      process.stderr.write(`autoMode: AI call failed (${err.message}), falling back to regex\n`);
    }
  }

  // Fallback: Simplified regex heuristic
  return autoModeRegex(task);
}

function autoModeRegex(task) {
  const t = task.toLowerCase();

  const scores = { review: 0, single: 0, parallel: 0, pipeline: 0, swarm: 0 };

  if (/\b(review|audit|check|inspect)\b/.test(t))                    scores.review += 3;
  if (/\b(fix|bug|debug|crash|error|broken)\b/.test(t))              scores.single += 2;
  if (/\b(explore|analyze|understand|map|research|investigate)\b/.test(t)) scores.parallel += 2;
  if (/\b(refactor|restructure|clean|reorganize)\b/.test(t))         scores.pipeline += 2;

  const hasImplement = /\b(implement|build|create|add|scaffold|migrate)\b/.test(t);
  const hasScope = /\b(all|whole|entire|full)\b/.test(t);
  if (hasImplement) {
    if (hasScope) scores.swarm += 3;
    else scores.pipeline += 2;
  }

  let maxScore = 0;
  let topModes = [];
  for (const [mode, score] of Object.entries(scores)) {
    if (score > maxScore)                      { maxScore = score; topModes = [mode]; }
    else if (score === maxScore && score > 0)  { topModes.push(mode); }
  }

  const tieBreaker = ["single", "pipeline", "parallel", "swarm", "review"];
  let selected = "single";
  if (topModes.length > 0) {
    selected = topModes.sort((a, b) => tieBreaker.indexOf(a) - tieBreaker.indexOf(b))[0];
  }

  const scoreStr = Object.entries(scores).filter(([, s]) => s > 0).map(([m, s]) => `${m}=${s}`).join(" ");
  process.stderr.write(`autoMode(regex): ${scoreStr || "none=0"} → ${selected}\n`);
  return selected;
}

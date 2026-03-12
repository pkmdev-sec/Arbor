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

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { colors, log } from "./output.mjs";
import { DEPTH, ROLE_PROMPTS } from "./config.mjs";
import { spawnAgent } from "./agent-spawn.mjs";
import { aiDecision, aiJsonDecision, isAiClientAvailable } from "./ai-client.mjs";
import { readAgentResult } from "./context-bridge.mjs";
import { prepareWorktree, prepareWorktreeGit, prepareWorktreeSnapshot, validateAndApply, cleanupIsolation, cacheSnapshot, getCachedSnapshot, cacheSnapshotAsync, backupFilesAsync } from "./isolation.mjs";
import { logIpc } from "./ipc-logger.mjs";
import { ResourceGovernor } from "./hierarchy/governor.mjs";

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

      // Handle both {subtasks: [...]} wrapper (from --json-schema) and bare array (legacy)
      const parsed = result.parsed?.subtasks ?? (Array.isArray(result.parsed) ? result.parsed : null);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const subtasks = parsed.slice(0, maxAgents);
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
      const reason = !result.parsed ? "AI returned null" : !parsed ? "AI returned non-array/non-wrapper" : "AI returned empty array";
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
    // Try {subtasks: [...]} wrapper first (from --json-schema), then bare array (legacy)
    let subtasks = null;
    const objMatch = result.output.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
    if (objMatch) {
      try { const obj = JSON.parse(objMatch[0]); if (Array.isArray(obj.subtasks)) subtasks = obj.subtasks; } catch {}
    }
    if (!subtasks) {
      const arrMatch = result.output.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        const arr = JSON.parse(arrMatch[0]);
        if (Array.isArray(arr)) subtasks = arr;
      }
    }
    if (Array.isArray(subtasks) && subtasks.length > 0) {
      log(`${colors.green}  ✓ Decomposed into ${subtasks.length} subtasks (subprocess)${colors.reset}`);
      for (const st of subtasks) {
        log(`  ${colors.dim}  → ${(st.title || st.task || "").slice(0, 70)}${colors.reset}`);
      }
      logIpc('decomposer', 'orchestrator', 'result', subtasks.length + ' subtasks (subprocess): ' + subtasks.map(s => (s.title || s.task || '').slice(0, 50)).join(', '), {});
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_fallback", subtask_count: subtasks.length }) + "\n");
      return subtasks.slice(0, maxAgents);
    }
    if (subtasks === null) {
      log(`${colors.yellow}  ⚠ Decomposition: subprocess output contained no JSON. Falling back to single agent.${colors.reset}`);
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_no_json", reason: "no JSON in output" }) + "\n");
    } else {
      log(`${colors.yellow}  ⚠ Decomposition: subprocess returned empty array. Falling back to single agent.${colors.reset}`);
      process.stderr.write(JSON.stringify({ event: "decompose_status", status: "subprocess_invalid", reason: "empty subtasks array" }) + "\n");
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

// ── DAG execution helpers for dependency-aware parallel execution ──
/**
 * Build execution DAG from subtask depends_on fields.
 * Returns { waves, hasCycle } where waves is an array of subtask index arrays.
 * Falls back to full parallelism if cycles detected.
 */
function buildExecutionDAG(subtasks) {
  const titleToIndex = new Map();
  subtasks.forEach((st, i) => {
    titleToIndex.set(st.title || `subtask-${i}`, i);
  });

  // Build adjacency list: index → [dependent indices]
  const graph = new Map();
  const inDegree = new Array(subtasks.length).fill(0);

  for (let i = 0; i < subtasks.length; i++) {
    graph.set(i, []);
  }

  for (let i = 0; i < subtasks.length; i++) {
    const deps = subtasks[i].depends_on || [];
    for (const depTitle of deps) {
      const depIndex = titleToIndex.get(depTitle);
      if (depIndex !== undefined && depIndex !== i) {
        graph.get(depIndex).push(i);
        inDegree[i]++;
      }
    }
  }

  // Topological sort via Kahn's algorithm (BFS-based)
  const waves = [];
  const remaining = new Set([...Array(subtasks.length).keys()]);
  let processed = 0;

  while (remaining.size > 0) {
    // Find all nodes with in-degree 0
    const wave = [];
    for (const idx of remaining) {
      if (inDegree[idx] === 0) {
        wave.push(idx);
      }
    }

    if (wave.length === 0) {
      // Cycle detected — fall back to full parallelism
      log(`${colors.yellow}  ⚠ Dependency cycle detected — executing all subtasks in parallel${colors.reset}`);
      return { waves: [[...remaining]], hasCycle: true };
    }

    waves.push(wave);

    // Remove nodes from remaining and decrement in-degree of dependents
    for (const idx of wave) {
      remaining.delete(idx);
      processed++;
      for (const dependent of graph.get(idx)) {
        inDegree[dependent]--;
      }
    }
  }

  return { waves, hasCycle: false };
}

// ── Phase: Execute subtasks in parallel ───────────────────────────
export async function executeParallel(subtasks, depth, contextFile, workDir, scoutSummary) {
  log(`${colors.bold}${colors.cyan}[EXECUTE]${colors.reset} Spawning ${subtasks.length} parallel agents...`);
  logIpc('orchestrator', 'all', 'lifecycle', 'Spawning ' + subtasks.length + ' parallel agents');
  const preset = DEPTH[depth];

  // Resource governor: enforce concurrency, memory, and budget limits
  const governor = new ResourceGovernor({
    maxTotalAgents: subtasks.length + 2,  // workers + verifier headroom
    maxConcurrentAgents: subtasks.length,
    maxWorktrees: subtasks.length,
  });
  const mainCwd = process.cwd();

  // Compute git root prefix for path normalization (worktree bug fix).
  // git diff returns paths relative to repo root; mainCwd may be a subdirectory.
  let cwdPrefix = "";
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: mainCwd, encoding: "utf-8", timeout: 5000,
    }).trim();
    cwdPrefix = relative(gitRoot, mainCwd); // e.g., "remote-agent"
  } catch {}
  const toLocal = (gitPath) =>
    cwdPrefix && gitPath.startsWith(cwdPrefix + "/") ? gitPath.slice(cwdPrefix.length + 1) : gitPath;

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
  const snapshot = getCachedSnapshot(mainCwd) || await cacheSnapshotAsync(mainCwd);
  const snapshotResults = await Promise.all(
    agentSetups.map(setup => {
      if (!setup.success) return Promise.resolve({ snapshot: null, backedUp: 0 });
      return backupFilesAsync(mainCwd, setup.backupDir, snapshot).then(backedUp => ({ snapshot, backedUp }));
    })
  );

  // Build DAG and execute in waves (respecting depends_on)
  const { waves, hasCycle } = buildExecutionDAG(subtasks);

  if (!hasCycle && waves.length > 1) {
    log(`${colors.dim}  Dependency ordering: ${waves.length} wave(s)${colors.reset}`);
  }

  // Helper to spawn a single agent by index with optional wave knowledge
  const spawnAgentByIndex = (i, waveKnowledge = []) => {
    const setup = agentSetups[i];
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

    // Governor: enforce limits before spawn
    try { governor.enforceLimit(`spawn ${id}`); } catch (err) {
      log(`${colors.yellow}  ⚠ Governor limit: ${err.message}${colors.reset}`);
    }
    governor.registerAgent({ id, level: 0, scope: (st.scope || [])[0] || "worker", worktreePath: wtPath });

    // I9: Combine scout summary with wave knowledge
    const knowledgePrompts = [scoutPrompt].filter(Boolean);
    if (waveKnowledge.length > 0) {
      knowledgePrompts.push(waveKnowledge.join("\n\n"));
    }
    const combinedPrompt = knowledgePrompts.length > 0 ? knowledgePrompts.join("\n\n") : null;

    return spawnAgent({
      task: st.task || st.title,
      role: "worker",
      model: st.model || "sonnet",
      effort: st.effort || null,
      scope: st.scope ? st.scope.join(",") : null,
      turns: st.turns || preset.turns,
      budget: st.budget || preset.budget,
      resultFile: rf,
      contextFile,
      systemPrompt: combinedPrompt,
      agentId: id,
      cwd: wtPath ? (cwdPrefix ? join(wtPath, cwdPrefix) : wtPath) : mainCwd,
    }).then((result) => {
      const status = result.exitCode === 0 ? 'completed' : 'failed';
      governor.deregisterAgent(id, { status, turns: 0 });
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
  };

  // Execute waves sequentially, agents within each wave in parallel
  const results = new Array(subtasks.length);
  let waveKnowledge = []; // I9: Accumulated knowledge from previous waves
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];
    if (!hasCycle && waves.length > 1) {
      const waveIds = wave.map(i => agentSetups[i].id).join(", ");
      log(`${colors.dim}  Wave ${waveIdx + 1}/${waves.length}: [${waveIds}]${colors.reset}`);
      if (waveKnowledge.length > 0) {
        log(`${colors.dim}    (with knowledge from ${waveKnowledge.length} previous wave(s))${colors.reset}`);
      }
    }
    // I9: Pass accumulated knowledge to agents in this wave
    const wavePromises = wave.map(i => spawnAgentByIndex(i, waveKnowledge));
    const waveResults = await Promise.all(wavePromises);
    // Store results in original order
    wave.forEach((subtaskIndex, waveIndex) => {
      results[subtaskIndex] = waveResults[waveIndex];
    });

    // I9: Extract discoveries from this wave and prepare for next wave
    if (waveIdx < waves.length - 1) {
      const waveDiscoveries = [];
      for (const r of waveResults) {
        if (r.exitCode === 0 && r.output) {
          // Extract key insights: file discoveries, architectural observations
          const insights = r.output.slice(0, 500); // First 500 chars as summary
          waveDiscoveries.push(`${r.id}: ${insights}`);
        }
      }
      if (waveDiscoveries.length > 0) {
        const waveSummary = `[Wave ${waveIdx + 1} Discoveries]\n${waveDiscoveries.join("\n\n")}`;
        waveKnowledge.push(waveSummary);
        log(`${colors.dim}  Wave ${waveIdx + 1} knowledge: ${waveDiscoveries.length} discoveries captured${colors.reset}`);
        logIpc('orchestrator', 'all', 'knowledge.discovery', `Wave ${waveIdx + 1}: ${waveDiscoveries.length} discoveries`, { waveIdx, discoveries: waveDiscoveries.length });
      }
    }
  }

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
      // Base: the pre-snapshot version from mainCwd (strip git-root prefix)
      const basePath = join(mainCwd, toLocal(file));
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
        } finally {
          // Clean up temp files
          for (const tmp of [tmpCurrent, tmpBase, tmpOther]) {
            try { unlinkSync(tmp); } catch {}
          }
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
    const apply = await validateAndApply(r.isolation.worktreePath, mainCwd, r.isolation.snapshot, r.isolation.backupDir, r.isolation.copiedUntracked, knownApplied, r.scope || [], mergedFiles, unresolvedConflicts);
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

  // Governor: final report with resource utilization
  const governorReport = await governor.cleanup();
  log(`${colors.dim}Governor: ${governorReport.totalSpawned} spawned, ${governorReport.totalCompleted} completed, ${governorReport.totalFailed} failed${colors.reset}`);

  // Conflict detection from hierarchy aggregator
  let fileLevelConflicts = null;
  try {
    const { detectFileLevelConflicts, createConflictSummary } = await import("./hierarchy/aggregator.mjs");
    const agentFileResults = results.map(r => ({
      id: r.id,
      files: new Map((r.applied || []).map(f => [f, true])),
    }));
    fileLevelConflicts = detectFileLevelConflicts(agentFileResults);
    if (fileLevelConflicts.summary.total > 0) {
      log(`${colors.yellow}File-level conflicts: ${createConflictSummary(fileLevelConflicts.conflicts)}${colors.reset}`);
    }
  } catch {
    // Aggregator unavailable — non-fatal
  }

  return { results, conflictReport, governorReport, fileLevelConflicts };
}

// ── Phase: Execute pipeline stages sequentially ───────────────────
export async function executePipeline(task, depth, contextFile, workDir) {
  const preset = DEPTH[depth];
  const mainCwd = process.cwd();

  // Resource governor for pipeline stages
  const governor = new ResourceGovernor({
    maxTotalAgents: 6,  // 4 stages + verifier headroom
    maxConcurrentAgents: 1,  // Sequential pipeline
    maxWorktrees: 2,
  });

  // Compute git root prefix for agent CWD (same worktree bug fix as executeParallel)
  let pipelineCwdPrefix = "";
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: mainCwd, encoding: "utf-8", timeout: 5000,
    }).trim();
    pipelineCwdPrefix = relative(gitRoot, mainCwd);
  } catch {}

  const stages = [
    { name: "RESEARCH",  model: "sonnet", effort: "low",    turns: 15,
      task: `Research and map the codebase for: ${task}. List relevant files, architecture, integration points.` },
    { name: "IMPLEMENT", model: "sonnet", effort: "medium", turns: preset.turns,
      task: `Implement: ${task}` },
    { name: "TEST",      model: "sonnet", effort: "medium", turns: 20,
      task: `Run the project test suite. If tests fail due to recent changes, fix them. Report all results.` },
    { name: "REVIEW",    model: "opus",   effort: "high",   turns: 15,
      task: `Adversarial review of all recent changes. Find bugs, security issues, logic errors. Fix any you find.` },
  ];

  const results = [];
  for (const [i, stage] of stages.entries()) {
    const id = `stage-${i + 1}-${stage.name.toLowerCase()}`;
    const rf = join(workDir, `${id}-result.json`);
    log(`${colors.bold}${colors.magenta}[${stage.name}]${colors.reset} ${stage.task.slice(0, 70)}...`);

    const isolation = await prepareWorktree(workDir, id, mainCwd);

    try { governor.enforceLimit(`spawn ${id}`); } catch (err) {
      log(`${colors.yellow}  ⚠ Governor limit: ${err.message}${colors.reset}`);
    }
    governor.registerAgent({ id, level: 0, scope: stage.name.toLowerCase(), worktreePath: isolation.worktreePath });

    const result = await spawnAgent({
      task: stage.task,
      role: "worker",
      model: stage.model,
      effort: stage.effort,
      turns: stage.turns,
      budget: preset.budget,
      resultFile: rf,
      contextFile: i > 0 ? results[i - 1]?.resultFile : contextFile,
      agentId: id,
      cwd: isolation.worktreePath ? (pipelineCwdPrefix ? join(isolation.worktreePath, pipelineCwdPrefix) : isolation.worktreePath) : mainCwd,
    });

    governor.deregisterAgent(id, { status: result.exitCode === 0 ? "completed" : "failed", turns: 0 });

    const icon = result.exitCode === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} ${(result.durationMs / 1000).toFixed(1)}s`);

    // Validate and apply isolation changes for this stage
    if (isolation.success) {
      const apply = await validateAndApply(isolation.worktreePath, mainCwd, isolation.snapshot, isolation.backupDir, isolation.copiedUntracked);
      if (apply.valid) {
        log(`  ${colors.green}✓${colors.reset} ${id}: applied ${apply.applied.length} files${apply.escaped.length ? `, ${apply.escaped.length} escaped (validated)` : ""}`);
      } else {
        log(`  ${colors.red}✗${colors.reset} ${id}: REJECTED — ${apply.errors.join(", ")}. Rolled back ${apply.rolled_back.length} files.`);
      }
      cleanupIsolation(isolation.worktreePath, isolation.backupDir);
    }

    results.push({ id, name: stage.name, subtask: stage.task.slice(0, 80), model: stage.model, ...result, resultFile: rf, worktreePath: isolation.worktreePath });
  }

  const governorReport = await governor.cleanup();
  log(`${colors.dim}Governor: ${governorReport.totalSpawned} spawned, ${governorReport.totalCompleted} completed, ${governorReport.totalFailed} failed${colors.reset}`);

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
    effort: "high",
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

// ── Phase: Orchestrate hierarchical execution ─────────────────────
/**
 * Orchestrate a hierarchical swarm execution with orchestration-level concerns.
 *
 * Wraps the hierarchical swarm entry point (from swarm.mjs executeHierarchical)
 * with pre-flight checks, cost estimation, monitoring, and post-completion
 * verification.
 *
 * @param {string} task - Task description
 * @param {Object} config - Orchestration configuration
 * @param {number} [config.hierarchyDepth=3] - Max tree depth
 * @param {number} [config.maxChildren=4] - Max children per coordinator
 * @param {number} [config.agentBudget=20] - Total agent budget
 * @param {number} [config.minTaskFiles=3] - Min files for sub-decomposition
 * @param {string} [config.decomposeBy="module-boundary"] - Decomposition strategy
 * @param {string} [config.workDir] - Working directory for run artifacts
 * @param {string} [config.depth="normal"] - Depth preset: shallow|normal|thorough
 * @returns {Promise<Object>} Orchestration result with status and diagnostics
 */
export async function orchestrateHierarchical(task, config = {}) {
  const startTime = Date.now();
  const mainCwd = process.cwd();

  const cfg = {
    hierarchyDepth: config.hierarchyDepth || 3,
    maxChildren: config.maxChildren || 4,
    agentBudget: config.agentBudget || 20,
    minTaskFiles: config.minTaskFiles || 3,
    decomposeBy: config.decomposeBy || "module-boundary",
    workDir: config.workDir || null,
    depth: config.depth || "normal",
    ...config,
  };

  log(`${colors.bold}${colors.cyan}[ORCHESTRATE-HIERARCHICAL]${colors.reset} Starting hierarchical orchestration`);
  logIpc('orchestrator', 'all', 'lifecycle', 'Hierarchical orchestration starting', { config: cfg });

  // Pre-flight check: working directory cleanliness
  let isClean = true;
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      encoding: "utf-8", timeout: 10000, cwd: mainCwd,
    });
    if (stdout.trim().length > 0) {
      isClean = false;
      const changedCount = stdout.trim().split("\n").length;
      log(`${colors.yellow}  ⚠ Working directory has ${changedCount} uncommitted change(s)${colors.reset}`);
      logIpc('orchestrator', 'all', 'warning', `Working directory not clean: ${changedCount} changes`, {});
    } else {
      log(`${colors.green}  ✓ Working directory clean${colors.reset}`);
    }
  } catch {
    log(`${colors.dim}  (git status check skipped — not a git repo)${colors.reset}`);
  }

  // Decomposition planning with cost estimate
  let hierarchy;
  try {
    hierarchy = await import("./hierarchy/index.mjs");
  } catch (err) {
    log(`${colors.red}  ✗ Hierarchy modules unavailable: ${err.message}${colors.reset}`);
    return {
      status: "failed",
      reason: "hierarchy_modules_unavailable",
      error: err.message,
      durationMs: Date.now() - startTime,
    };
  }

  const { decomposeHierarchically, estimateAgentBudget, ResourceGovernor } = hierarchy;

  log(`${colors.dim}  Decomposing task...${colors.reset}`);
  const decompositionTree = await decomposeHierarchically(task, mainCwd, {
    maxDepth: cfg.hierarchyDepth,
    maxFanOut: cfg.maxChildren,
    maxTotalAgents: cfg.agentBudget,
    minFilesForSplit: cfg.minTaskFiles,
  });

  const budgetEstimate = estimateAgentBudget(decompositionTree);

  log(`${colors.green}  ✓ Decomposition plan ready${colors.reset}`);
  log(`    Depth: ${decompositionTree.depth} | Nodes: ${decompositionTree.totalNodes} | Workers: ${decompositionTree.leafNodes}`);
  log(`    Est. agents: ${budgetEstimate.totalAgents} | Est. cost: $${budgetEstimate.estimatedCost.toFixed(3)}`);

  // Check if task scope is too small for hierarchical mode
  if (decompositionTree.leafNodes <= 2 && decompositionTree.depth <= 1) {
    log(`${colors.yellow}  ⚠ Task scope may be too small for hierarchical mode — consider --mode swarm or pipeline${colors.reset}`);
  }

  // Check if estimated agents exceed budget
  if (budgetEstimate.totalAgents > cfg.agentBudget) {
    log(`${colors.yellow}  ⚠ Estimated agents (${budgetEstimate.totalAgents}) exceed budget (${cfg.agentBudget}). Governor will enforce limits.${colors.reset}`);
  }

  const result = {
    status: "planned",
    decomposition: {
      depth: decompositionTree.depth,
      totalNodes: decompositionTree.totalNodes,
      leafNodes: decompositionTree.leafNodes,
      metadata: decompositionTree.metadata,
    },
    budgetEstimate,
    isClean,
    durationMs: Date.now() - startTime,
  };

  logIpc('orchestrator', 'all', 'lifecycle', 'Hierarchical orchestration plan ready', {
    depth: decompositionTree.depth,
    nodes: decompositionTree.totalNodes,
    estimatedCost: budgetEstimate.estimatedCost,
  });

  return result;
}

// ── Scope recommendation helper ───────────────────────────────────
/**
 * Check if a task scope warrants hierarchical mode recommendation.
 * Called from auto-mode detection to suggest hierarchical for massive tasks.
 *
 * @param {string} task - Task description
 * @returns {{ recommend: boolean, reason: string }} Recommendation result
 */
export function shouldRecommendHierarchical(task) {
  const t = task.toLowerCase();

  // Look for signals of massive scope
  const hasMassiveScope = /\b(entire|full|all|whole|complete)\s+(codebase|project|system|application|repo)\b/.test(t);
  const hasDeepWork = /\b(refactor|restructure|rewrite|redesign|overhaul|rebuild)\b/.test(t);
  const hasMultiModule = /\b(all modules|every module|cross-module|multi-module|system-wide)\b/.test(t);

  if (hasMassiveScope && hasDeepWork) {
    return { recommend: true, reason: "massive scope with deep structural changes" };
  }
  if (hasMultiModule) {
    return { recommend: true, reason: "cross-module coordination needed" };
  }

  return { recommend: false, reason: "" };
}

// ── Auto-detect mode ──────────────────────────────────────────────
const VALID_MODES = new Set(["single", "parallel", "pipeline", "swarm", "hierarchical", "review"]);

export async function autoMode(task, { smartRoute = false } = {}) {
  // AI classification only when --smart-route is set (adds 2-5s latency)
  if (smartRoute && isAiClientAvailable()) {
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
          "### hierarchical",
          "USE WHEN: Task is massive (50+ files, entire codebase), requires multi-level decomposition with coordinated sub-teams.",
          'SIGNALS: "entire system", "complete overhaul", "system-wide", "all modules", "massive refactor", combined with implementation verbs.',
          "NOTE: Only use for truly massive tasks. For moderate parallel work, prefer swarm.",
          "",
          "### review",
          "USE WHEN: Task is primarily about reading, auditing, or evaluating existing code.",
          'SIGNALS: "review", "audit", "check for", "security scan", "code quality", "find vulnerabilities".',
          "",
          "## Tie-Breaking",
          "If multiple modes seem equally valid, prefer: single > pipeline > parallel > swarm > hierarchical > review.",
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

  const scores = { review: 0, single: 0, parallel: 0, pipeline: 0, swarm: 0, hierarchical: 0 };

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

  // Hierarchical: massive scope + deep structural work
  const hasMassive = /\b(entire|complete|system-wide|all modules|every module)\b/.test(t);
  const hasDeep = /\b(overhaul|rebuild|rewrite|redesign|massive)\b/.test(t);
  if (hasMassive && hasDeep) scores.hierarchical += 4;
  if (/\b(multi-module|cross-module)\b/.test(t)) scores.hierarchical += 3;
  // Explicit file count signals
  if (/\b(\d{2,})\s*files?\b/.test(t) || /\b(50|hundred|all)\b.*\bfiles?\b/.test(t)) scores.hierarchical += 3;
  if (/\b(every|all)\s+(file|module|component|service)\b/.test(t)) scores.hierarchical += 2;

  let maxScore = 0;
  let topModes = [];
  for (const [mode, score] of Object.entries(scores)) {
    if (score > maxScore)                      { maxScore = score; topModes = [mode]; }
    else if (score === maxScore && score > 0)  { topModes.push(mode); }
  }

  const tieBreaker = ["single", "pipeline", "parallel", "swarm", "hierarchical", "review"];
  let selected = "single";
  if (topModes.length > 0) {
    selected = topModes.sort((a, b) => tieBreaker.indexOf(a) - tieBreaker.indexOf(b))[0];
  }

  const scoreStr = Object.entries(scores).filter(([, s]) => s > 0).map(([m, s]) => `${m}=${s}`).join(" ");
  process.stderr.write(`autoMode(regex): ${scoreStr || "none=0"} → ${selected}\n`);
  return selected;
}

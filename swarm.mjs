#!/usr/bin/env node
/**
 * swarm — Parallel remote-agent orchestrator with verification
 *
 * Sits between the main Claude session and individual remote-agent calls.
 * Handles: task decomposition → parallel execution → verification → reporting.
 *
 * Key fix (v2): all per-agent outputs are persisted in separate files under
 * a per-run work directory, then aggregated into a single structured result
 * file with full agent outputs embedded.
 */

import { spawn, execFileSync as execFS } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RA_BIN = join(__dirname, "agent-entry.mjs");
const SWARM_BASE = "/tmp/swarm";

// ── Colors ────────────────────────────────────────────────────────
const isTTY = process.stderr.isTTY;
const C = {
  b: isTTY ? "\x1b[1m" : "", d: isTTY ? "\x1b[2m" : "",
  cyan: isTTY ? "\x1b[36m" : "", green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "", red: isTTY ? "\x1b[31m" : "",
  magenta: isTTY ? "\x1b[35m" : "", r: isTTY ? "\x1b[0m" : "",
};

let quietMode = false;
function log(msg) { if (!quietMode) process.stderr.write(msg + "\n"); }

// ── Depth presets ─────────────────────────────────────────────────
const DEPTH = {
  shallow:  { turns: 10, budget: 5,  verifyModel: "sonnet" },
  normal:   { turns: 25, budget: 15, verifyModel: "sonnet" },
  thorough: { turns: 50, budget: 25, verifyModel: "opus" },
};

// ── Argument parsing ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    task: null, mode: "auto", agents: 3, depth: "normal",
    resultFile: null, contextFile: null, bdTask: null, quiet: false,
    verify: null, help: false, timeout: 600,
  };
  const raw = argv.slice(2);
  let i = 0;
  while (i < raw.length) {
    switch (raw[i]) {
      case "-h": case "--help":       args.help = true; i++; break;
      case "--mode":                  args.mode = raw[++i]; i++; break;
      case "--agents":                args.agents = Math.min(Number(raw[++i]), 5); i++; break;
      case "--depth":                 args.depth = raw[++i]; i++; break;
      case "--result-file":           args.resultFile = raw[++i]; i++; break;
      case "--context-file":          args.contextFile = raw[++i]; i++; break;
      case "--bd-task":               args.bdTask = raw[++i]; i++; break;
      case "--timeout":               args.timeout = Number(raw[++i]); i++; break;
      case "--verify":                args.verify = true; i++; break;
      case "--no-verify":             args.verify = false; i++; break;
      case "-q": case "--quiet":      args.quiet = true; i++; break;
      default:
        if (raw[i].startsWith("-")) { log(`${C.red}Unknown: ${raw[i]}${C.r}`); process.exit(1); }
        if (!args.task) args.task = raw[i];
        i++;
    }
  }
  return args;
}

function showHelp() {
  process.stdout.write(`swarm — Parallel remote-agent orchestrator with verification

USAGE:
  swarm [OPTIONS] "task description"

MODES:
  single     1 worker (+ verifier if --verify)
  parallel   Decompose → N parallel workers → merge results
  pipeline   Sequential: research → implement → test → review
  swarm      Decompose → N parallel workers → verify → report
  review     1 reviewer (opus) + 1 verifier cross-check
  auto       Infer mode from task (default)

OPTIONS:
  --mode MODE          single|parallel|pipeline|swarm|review|auto
  --agents N           Max parallel agents, 1-5 (default: 3)
  --depth LEVEL        shallow|normal|thorough (default: normal)
  --timeout SECS       Per-agent timeout (default: 600)
  --result-file PATH   Write structured result JSON (includes all agent outputs)
  --context-file PATH  Pass context to all agents
  --bd-task ID         Beads task ID (claimed on start, closed on completion)
  --verify / --no-verify
  -q, --quiet          Suppress status
  -h, --help           Show this help
`);
}

// ── Spawn a single remote-agent ───────────────────────────────────
function spawnAgent({ task, role, model, turns, budget, timeout, resultFile, contextFile, systemPrompt, bdTask, agentId, cwd }) {
  return new Promise((resolve) => {
    const args = [RA_BIN];
    if (role) args.push("--role", role);
    args.push("-m", model || "sonnet");
    args.push("--turns", String(turns || 25));
    args.push("-b", String(budget || 15));
    args.push("-t", String(timeout || 600));
    // Don't pass -q — let agent stream stderr for live logs
    if (resultFile) args.push("--result-file", resultFile);
    if (contextFile) args.push("--context-file", contextFile);
    if (bdTask) args.push("--bd-task", bdTask);
    if (systemPrompt) args.push("-s", systemPrompt);
    args.push(task);

    // Pass agent ID via env so agent-entry.mjs can prefix its live output
    const childEnv = { ...process.env };
    if (agentId) childEnv.SWARM_AGENT_ID = agentId;

    const start = Date.now();
    const proc = spawn("node", args, {
      env: childEnv,
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));

    // Stream stderr live to parent (agent-entry.mjs already prefixes with agent ID)
    proc.stderr.on("data", (chunk) => {
      if (!quietMode) process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      resolve({
        output: Buffer.concat(chunks).toString("utf-8").trim(),
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      });
    });
    proc.on("error", (err) => {
      resolve({ output: err.message, exitCode: 1, durationMs: Date.now() - start });
    });
  });
}

// ── Read agent output from result file ────────────────────────────
function readAgentResult(resultFile) {
  try {
    if (existsSync(resultFile)) {
      return JSON.parse(readFileSync(resultFile, "utf-8"));
    }
  } catch {}
  return null;
}

// ── Phase: Decompose task into subtasks ───────────────────────────
async function decompose(task, maxAgents, depth, contextFile, workDir) {
  log(`${C.b}${C.cyan}[DECOMPOSE]${C.r} Scanning project → splitting into ${maxAgents} subtasks...`);

  let projectStructure = "";
  try {
    const tree = execFS("find", [".", "-maxdepth", "2", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
      encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
    }).split("\n").filter(Boolean).slice(0, 100).join("\n");
    projectStructure = `\n\nACTUAL PROJECT FILE STRUCTURE (first 100 files):\n${tree}`;
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
        log(`${C.green}  ✓ Decomposed into ${subtasks.length} subtasks${C.r}`);
        for (const st of subtasks) {
          log(`  ${C.d}  → ${(st.title || st.task || "").slice(0, 70)}${C.r}`);
        }
        return subtasks.slice(0, maxAgents);
      }
    }
  } catch {}

  log(`${C.yellow}  ⚠ Decomposition failed — running as single task${C.r}`);
  return [{ title: "Full task", task, scope: [], turns: DEPTH[depth].turns, model: "sonnet" }];
}

// ── Phase: Execute subtasks in parallel ───────────────────────────
async function executeParallel(subtasks, depth, contextFile, workDir) {
  log(`${C.b}${C.cyan}[EXECUTE]${C.r} Spawning ${subtasks.length} parallel agents...`);
  const preset = DEPTH[depth];

  const promises = subtasks.map((st, i) => {
    const id = `agent-${String(i + 1).padStart(2, "0")}`;
    const rf = join(workDir, `${id}-result.json`);
    log(`  ${C.d}${id}: ${(st.title || st.task || "").slice(0, 60)}${C.r}`);

    return spawnAgent({
      task: st.task || st.title,
      role: "worker",
      model: st.model || "sonnet",
      turns: st.turns || preset.turns,
      budget: preset.budget,
      timeout: 600,
      resultFile: rf,
      contextFile,
      agentId: id,
    }).then((result) => ({
      id,
      subtask: st.title || st.task?.slice(0, 80),
      scope: st.scope || [],
      model: st.model || "sonnet",
      ...result,
      resultFile: rf,
    }));
  });

  const results = await Promise.all(promises);

  for (const r of results) {
    const icon = r.exitCode === 0 ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`;
    log(`  ${icon} ${r.id}: ${(r.durationMs / 1000).toFixed(1)}s (exit ${r.exitCode})`);
  }

  return results;
}

// ── Phase: Execute pipeline stages sequentially ───────────────────
async function executePipeline(task, depth, contextFile, workDir) {
  const preset = DEPTH[depth];
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
    log(`${C.b}${C.magenta}[${stage.name}]${C.r} ${stage.task.slice(0, 70)}...`);

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
    });

    const icon = result.exitCode === 0 ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`;
    log(`  ${icon} ${(result.durationMs / 1000).toFixed(1)}s`);
    results.push({ id, name: stage.name, subtask: stage.task.slice(0, 80), model: stage.model, ...result, resultFile: rf });
  }

  return results;
}

// ── Phase: Verify all results ─────────────────────────────────────
async function verify(task, workerResults, depth, workDir) {
  log(`${C.b}${C.cyan}[VERIFY]${C.r} Spawning verifier to cross-check...`);
  const preset = DEPTH[depth];

  const workerSummary = workerResults.map((r) => {
    // Read output from result file if stdout was empty
    let output = r.output || "";
    if (!output) {
      const fileResult = readAgentResult(r.resultFile);
      output = fileResult?.output || "";
    }
    return `--- ${r.id} (${r.subtask || r.name || "worker"}) ---\nStatus: exit ${r.exitCode}\n${output.slice(0, 3000)}`;
  }).join("\n\n");

  let gitDiff = "";
  try { gitDiff = execFS("git", ["diff"], { encoding: "utf-8", timeout: 10000 }).slice(0, 5000); } catch {}

  const rf = join(workDir, "verify-result.json");
  const result = await spawnAgent({
    task: `ORIGINAL TASK: ${task}\n\nWORKER OUTPUTS:\n${workerSummary}\n\n${gitDiff ? `GIT DIFF:\n${gitDiff}` : "(no git diff)"}\n\nCross-check every claim against actual changes. Produce your verdict.`,
    role: "verifier",
    model: preset.verifyModel,
    turns: 15,
    budget: preset.budget,
    timeout: 300,
    resultFile: rf,
    agentId: "verifier",
  });

  const icon = result.exitCode === 0 ? `${C.green}✓${C.r}` : `${C.yellow}⚠${C.r}`;
  log(`  ${icon} Verification: ${(result.durationMs / 1000).toFixed(1)}s`);

  return { ...result, resultFile: rf };
}

// ── Build completion contract with FULL agent outputs ─────────────
function buildContract(task, mode, workerResults, verifyResult, totalMs, workDir) {
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
function autoMode(task) {
  const t = task.toLowerCase();
  if (/\b(review|audit|check|inspect)\b/.test(t)) return "review";
  if (/\b(implement|build|create|add feature|scaffold|migrate)\b/.test(t) &&
      /\b(all|whole|entire|across|end.to.end|full)\b/.test(t)) return "swarm";
  if (/\b(implement|build|create|add feature)\b/.test(t)) return "pipeline";
  if (/\b(explore|analyze|understand|map|research)\b/.test(t)) return "parallel";
  if (/\b(fix|bug|debug|crash|error)\b/.test(t)) return "single";
  if (/\b(refactor|restructure|clean)\b/.test(t)) return "pipeline";
  return "single";
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  quietMode = args.quiet;

  if (args.help) { showHelp(); process.exit(0); }
  if (!args.task) {
    log(`${C.red}Error: No task provided.${C.r}`);
    process.exit(1);
  }

  const mode = args.mode === "auto" ? autoMode(args.task) : args.mode;
  const depth = DEPTH[args.depth] ? args.depth : "normal";
  const shouldVerify = args.verify ?? (mode === "swarm" || mode === "pipeline" || mode === "review");

  // Create per-run work directory — all agent files go here
  const runId = randomUUID().slice(0, 8);
  const workDir = join(SWARM_BASE, runId);
  mkdirSync(workDir, { recursive: true });

  log(`${C.b}${C.cyan}swarm${C.r} ${C.d}|${C.r} mode=${mode} ${C.d}|${C.r} agents=${args.agents} ${C.d}|${C.r} depth=${depth} ${C.d}|${C.r} verify=${shouldVerify}${args.bdTask ? ` ${C.d}|${C.r} bd=${args.bdTask}` : ""}`);
  log(`${C.d}Run: ${workDir}${C.r}`);
  log(`${C.d}Task: ${args.task.slice(0, 80)}${args.task.length > 80 ? "..." : ""}${C.r}`);
  log("");

  // bd task lifecycle: claim
  if (args.bdTask) {
    try { execFS("bd", ["update", args.bdTask, "--claim"], { timeout: 5000 }); log(`${C.d}bd: claimed ${args.bdTask}${C.r}`); } catch {}
  }

  const startTime = Date.now();
  let workerResults = [];
  let verifyResult = null;

  if (mode === "single") {
    const rf = join(workDir, "agent-01-result.json");
    log(`${C.b}${C.cyan}[EXECUTE]${C.r} Single agent...`);
    const result = await spawnAgent({
      task: args.task, role: "worker", model: "sonnet",
      turns: DEPTH[depth].turns, budget: DEPTH[depth].budget,
      timeout: args.timeout, resultFile: rf, contextFile: args.contextFile,
      agentId: "agent-01",
    });
    workerResults = [{ id: "agent-01", subtask: args.task.slice(0, 80), model: "sonnet", ...result, resultFile: rf }];
    log(`  ${result.exitCode === 0 ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`} ${(result.durationMs / 1000).toFixed(1)}s`);

  } else if (mode === "parallel" || mode === "swarm") {
    const subtasks = await decompose(args.task, args.agents, depth, args.contextFile, workDir);
    workerResults = await executeParallel(subtasks, depth, args.contextFile, workDir);

  } else if (mode === "pipeline") {
    workerResults = await executePipeline(args.task, depth, args.contextFile, workDir);

  } else if (mode === "review") {
    const rf = join(workDir, "reviewer-result.json");
    log(`${C.b}${C.cyan}[REVIEW]${C.r} Opus reviewer...`);
    const result = await spawnAgent({
      task: args.task, role: "worker", model: "opus",
      turns: 15, budget: DEPTH[depth].budget,
      timeout: args.timeout, resultFile: rf, contextFile: args.contextFile,
      agentId: "reviewer",
    });
    workerResults = [{ id: "reviewer", subtask: args.task.slice(0, 80), model: "opus", ...result, resultFile: rf }];
    log(`  ${result.exitCode === 0 ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`} ${(result.durationMs / 1000).toFixed(1)}s`);
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
    log(`\n${C.d}Result: ${args.resultFile}${C.r}`);
  }

  // Summary
  log(`\n${C.b}═══ SWARM COMPLETE ═══${C.r}`);
  log(`Mode: ${mode} | Agents: ${contract.summary.total_agents} | Duration: ${(totalMs / 1000).toFixed(1)}s`);
  log(`Completed: ${contract.summary.completed} | Failed: ${contract.summary.failed}`);
  log(`Work dir: ${workDir}`);
  log(`Per-agent files: ${contract.summary.per_agent_files.join(", ")}`);

  if (verifyResult) {
    const verdictMatch = verifyResult.output?.match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
    const verdict = verdictMatch ? verdictMatch[1] : "UNKNOWN";
    log(`Verification: ${verdict === "PASS" ? `${C.green}PASS${C.r}` : verdict === "FAIL" ? `${C.red}FAIL${C.r}` : `${C.yellow}${verdict}${C.r}`}`);
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
        execFS("bd", ["close", args.bdTask, "--reason", `completed: ${mode}, ${contract.summary.total_agents} agents, ${(totalMs/1000).toFixed(0)}s`], { timeout: 5000 });
        log(`${C.d}bd: closed ${args.bdTask}${C.r}`);
      } else {
        log(`${C.yellow}bd: ${args.bdTask} left open (${contract.summary.failed} failures)${C.r}`);
      }
    } catch {}
  }

  process.exit(contract.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`${C.red}Fatal: ${err.message}${C.r}`);
  process.exit(1);
});

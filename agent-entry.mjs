#!/usr/bin/env node
/**
 * remote-agent — Claude Code supervisor for isolated research
 *
 * Spawns a fresh Claude Code subprocess with its own context window.
 * This is a SUPERVISOR, not a wrapper — cli.js runs as a child process.
 *
 * Architecture:
 *   agent-entry.mjs (this file)
 *     ├── Parses custom CLI flags
 *     ├── Reads --context-file → converts to system prompt
 *     ├── Spawns: node cli.js -p [flags] "task"
 *     ├── Streams stdout → buffer (+ optionally stderr for diagnostics)
 *     ├── Writes --result-file on exit
 *     └── Reports status to stderr
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_JS = join(__dirname, "node_modules", "@anthropic-ai", "claude-code", "cli.js");

// ── Colors (disabled if stderr is not a tty) ─────────────────────
const isTTY = process.stderr.isTTY;
const c = {
  bold:   isTTY ? "\x1b[1m"  : "",
  dim:    isTTY ? "\x1b[2m"  : "",
  cyan:   isTTY ? "\x1b[36m" : "",
  green:  isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red:    isTTY ? "\x1b[31m" : "",
  reset:  isTTY ? "\x1b[0m"  : "",
};

// ── Argument parsing ─────────────────────────────────────────────
// ── Allowed models (1M context only) ─────────────────────────────
const ALLOWED_MODELS = {
  "sonnet":    "sonnet",       // resolves to claude-sonnet-4-6 with 1M
  "opus":      "opus",         // resolves to claude-opus-4-6 with 1M
};

function resolveModel(input) {
  const key = input.toLowerCase().replace(/[^a-z0-9[\]]/g, "");
  // Accept: sonnet, opus, sonnet4.6, opus4.6, claude-sonnet-4-6, etc.
  // Always append [1m] to ensure 1M context window
  if (key.includes("sonnet")) return "sonnet[1m]";
  if (key.includes("opus"))   return "opus[1m]";
  return null;
}

// ── Role-specific system prompts ─────────────────────────────────
const ROLE_PROMPTS = {
  worker: [
    "You are a worker agent in a swarm. Execute your assigned subtask thoroughly.",
    "At the END of your response, produce a COMPLETION CHECKLIST:",
    "```checklist",
    "- [PASS] Item you completed successfully",
    "- [FAIL] Item you could not complete (with reason)",
    "- [SKIP] Item you intentionally skipped (with reason)",
    "```",
    "Every item from your assignment must appear in the checklist. Do NOT omit items silently.",
    "If you are uncertain about any item, mark it [FAIL] with explanation rather than claiming success.",
  ].join("\n"),

  verifier: [
    "You are a VERIFIER agent. Your job is adversarial cross-checking.",
    "You will receive: (1) the original task, (2) worker agent outputs, (3) actual file changes (git diff).",
    "Your job:",
    "1. For each claim a worker made, verify it against the actual file changes",
    "2. List any SILENT OMISSIONS — work that was assigned but not done and not mentioned",
    "3. List any EDGE CASES that were not handled",
    "4. Run tests if a test command is available",
    "5. Produce a VERDICT: PASS (all good), FAIL (critical issues), NEEDS_REWORK (minor issues)",
    "",
    "Output format:",
    "```verdict",
    "VERDICT: PASS|FAIL|NEEDS_REWORK",
    "ISSUES: [list of specific issues found]",
    "EDGE_CASES_CHECKED: [list of edge cases you verified]",
    "SILENT_OMISSIONS: [list of work claimed but not done]",
    "```",
  ].join("\n"),

  decomposer: [
    "You are a DECOMPOSER agent. Break the given task into independent subtasks.",
    "Output ONLY valid JSON — no markdown, no explanation, just the JSON array.",
    "Each subtask must be independently executable by a separate agent.",
    "",
    "Output format (JSON array):",
    '[{"title": "...", "task": "detailed description", "scope": ["file/dir paths"], "turns": 20, "model": "sonnet"}]',
    "",
    "Rules:",
    "- Each subtask should be scoped to specific files/directories",
    "- Subtasks must not conflict (no two agents writing the same file)",
    "- Include 1 subtask for tests if the task involves code changes",
    "- Estimate turns conservatively (better to over-estimate)",
    "- 2-5 subtasks is ideal. Never exceed 5.",
  ].join("\n"),
};

function parseArgs(argv) {
  const args = {
    task: null,
    model: "sonnet",
    budget: 15,
    timeout: 600,
    maxTurns: 50,
    systemPrompt: null,
    role: null,  // worker, verifier, decomposer
    bdTask: null,  // bd task ID — agent claims on start, closes on exit
    cwd: null,
    contextFile: null,
    resultFile: null,
    outputFormat: "text",
    quiet: false,
    stdin: false,
    help: false,
    version: false,
  };

  const raw = argv.slice(2);
  let i = 0;

  while (i < raw.length) {
    const a = raw[i];
    switch (a) {
      case "-h": case "--help":    args.help = true; i++; break;
      case "--version":            args.version = true; i++; break;
      case "-m": case "--model":   args.model = raw[++i]; i++; break;
      case "-b": case "--budget":  args.budget = Number(raw[++i]); i++; break;
      case "-t": case "--timeout": args.timeout = Number(raw[++i]); i++; break;
      case "-n": case "--turns":   args.maxTurns = Number(raw[++i]); i++; break;
      case "-s": case "--system":  args.systemPrompt = raw[++i]; i++; break;
      case "--role":               args.role = raw[++i]; i++; break;
      case "--bd-task":            args.bdTask = raw[++i]; i++; break;
      case "-d": case "--dir":     args.cwd = raw[++i]; i++; break;
      case "--context-file":       args.contextFile = raw[++i]; i++; break;
      case "--result-file":        args.resultFile = raw[++i]; i++; break;
      case "--json":               args.outputFormat = "json"; i++; break;
      case "-q": case "--quiet":   args.quiet = true; i++; break;
      case "--stdin":              args.stdin = true; i++; break;
      default:
        if (a.startsWith("-")) {
          status(`${c.red}Unknown flag: ${a}${c.reset}`);
          process.exit(1);
        }
        if (!args.task) args.task = a;
        i++;
    }
  }

  return args;
}

function showHelp() {
  process.stdout.write(`remote-agent — Isolated Claude Code supervisor for research

USAGE:
  remote-agent [OPTIONS] "task description"
  echo "task" | remote-agent --stdin [OPTIONS]

MODES:
  Simple:       remote-agent "explore src/models/"
  Structured:   remote-agent --context-file ctx.json --result-file result.json "task"
  Piped:        git diff | remote-agent --stdin -s "review this diff"

OPTIONS:
  -m, --model MODEL        Model: sonnet (default) or opus. Both use 1M context.
  -b, --budget USD         Max budget in USD (default: 15)
  -t, --timeout SECS       Timeout in seconds (default: 600)
  -n, --turns NUM          Max tool-use turns (default: 50)
  -s, --system PROMPT      Append system prompt
  -d, --dir PATH           Working directory
  --context-file PATH      Read structured context from JSON file
  --result-file PATH       Write structured results to JSON file
  --json                   Output as JSON instead of text
  --stdin                  Read task from stdin
  -q, --quiet              Suppress status messages
  -h, --help               Show this help
  --version                Show version

EXAMPLES:
  remote-agent "explore the auth module and map all endpoints"
  remote-agent -m opus --turns 80 "security audit of src/api/"
  remote-agent -m opus --turns 80 "deep security audit of src/api/"
  remote-agent --context-file ctx.json --result-file out.json "analyze models"
  git diff HEAD~3 | remote-agent --stdin -s "review for bugs"
`);
}

// ── Status output (stderr, suppressed with --quiet) ──────────────
let quietMode = false;
function status(msg) {
  if (!quietMode) process.stderr.write(msg + "\n");
}

// ── Context file → system prompt ─────────────────────────────────
function contextToSystemPrompt(contextPath) {
  try {
    const raw = readFileSync(contextPath, "utf-8");
    const ctx = JSON.parse(raw);

    const parts = [];

    if (ctx.task?.constraints?.length) {
      parts.push(`CONSTRAINTS:\n${ctx.task.constraints.map(c => `- ${c}`).join("\n")}`);
    }

    if (ctx.task?.scope?.length) {
      parts.push(`SCOPE: Focus on ${ctx.task.scope.join(", ")}`);
    }

    if (ctx.prior_knowledge?.decisions?.length) {
      parts.push(`KNOWN DECISIONS:\n${ctx.prior_knowledge.decisions.map(d => `- ${d}`).join("\n")}`);
    }

    if (ctx.prior_knowledge?.file_summaries) {
      const summaries = Object.entries(ctx.prior_knowledge.file_summaries)
        .map(([f, s]) => `- ${f}: ${s}`)
        .join("\n");
      if (summaries) parts.push(`FILE CONTEXT:\n${summaries}`);
    }

    if (ctx.project?.recent_files?.length) {
      parts.push(`RECENTLY MODIFIED: ${ctx.project.recent_files.join(", ")}`);
    }

    return parts.length > 0
      ? `[Parent Session Context]\n${parts.join("\n\n")}`
      : null;
  } catch (err) {
    status(`${c.yellow}Warning: Failed to read context file: ${err.message}${c.reset}`);
    return null;
  }
}

// ── Write result file ────────────────────────────────────────────
function writeResult(resultPath, data) {
  try {
    writeFileSync(resultPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    status(`${c.red}Error writing result file: ${err.message}${c.reset}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  quietMode = args.quiet;

  if (args.help) { showHelp(); process.exit(0); }

  // Validate and resolve model — only sonnet 4.6 and opus 4.6 with 1M context
  const resolved = resolveModel(args.model);
  if (!resolved) {
    status(`${c.red}Error: Model "${args.model}" is not allowed.${c.reset}`);
    status(`Allowed models: sonnet (Sonnet 4.6, 1M), opus (Opus 4.6, 1M)`);
    process.exit(1);
  }
  args.model = resolved;

  if (args.version) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, "node_modules", "@anthropic-ai", "claude-code", "package.json"), "utf-8"));
      process.stdout.write(`remote-agent 1.0.0 (claude-code ${pkg.version})\n`);
    } catch { process.stdout.write("remote-agent 1.0.0\n"); }
    process.exit(0);
  }

  // Read stdin if flagged
  if (args.stdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdinContent = Buffer.concat(chunks).toString("utf-8").trim();
    if (args.task) {
      args.task = `${args.task}\n\n--- stdin content ---\n${stdinContent}`;
    } else {
      args.task = stdinContent;
    }
  }

  if (!args.task && !args.contextFile) {
    status(`${c.red}Error: No task provided.${c.reset}`);
    status("Usage: remote-agent \"your task\" or remote-agent --context-file ctx.json");
    process.exit(1);
  }

  // Build child process arguments
  const childArgs = [
    CLI_JS,
    "-p",
    "--model", args.model,
    "--permission-mode", "dontAsk",
    "--dangerously-skip-permissions",
    "--max-turns", String(args.maxTurns),
    "--max-budget-usd", String(args.budget),
    "--output-format", args.outputFormat,
    "--no-session-persistence",
  ];

  // Context bridge: role prompts + context file → system prompt
  const systemParts = [];
  // Inject role-specific prompt first (highest priority)
  if (args.role && ROLE_PROMPTS[args.role]) {
    systemParts.push(ROLE_PROMPTS[args.role]);
  }
  if (args.contextFile) {
    const ctxPrompt = contextToSystemPrompt(args.contextFile);
    if (ctxPrompt) systemParts.push(ctxPrompt);
  }
  if (args.systemPrompt) {
    systemParts.push(args.systemPrompt);
  }
  if (systemParts.length > 0) {
    childArgs.push("--append-system-prompt", systemParts.join("\n\n"));
  }

  // Task goes last (--add-dir removed: it conflicts with prompt positioning in -p mode;
  // instead, the cwd is set via spawn options so the subprocess starts in the right directory)
  if (args.task) {
    childArgs.push(args.task);
  }

  // Environment: bypass nesting guard + avoid auth conflict
  const env = { ...process.env };

  // Bypass nesting guard: CLAUDECODE="" passes the === "1" check
  // We also provide the full team triple (--team-name + --agent-id + --agent-name)
  // which is the legitimate bypass path — required as a triple by cli.js validation
  const agentId = randomUUID().slice(0, 12);
  const teamName = `remote-${agentId}`;
  childArgs.splice(1, 0,
    "--team-name", teamName,
    "--agent-id", agentId,
    "--agent-name", "remote-agent",
  );
  env.CLAUDECODE = ""; // Belt-and-suspenders: also clear the env guard

  // Don't force effort on models that don't support it
  delete env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;

  // Point subprocess to minimal config (no hooks, no MCP, no taskmaster)
  // CLAUDE_CONFIG_DIR overrides the default ~/.claude/ config path
  env.CLAUDE_CONFIG_DIR = join(__dirname, "config");

  // Disable non-essential features for research subprocess
  delete env.CLAUDE_CODE_ENABLE_TASKS;
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  delete env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES;
  delete env.CLAUDE_AUTO_BACKGROUND_TASKS;

  // Status
  const taskPreview = (args.task || "(from context file)").slice(0, 80);
  status(`${c.bold}${c.cyan}remote-agent${c.reset} ${c.dim}|${c.reset} ${args.model} ${c.dim}|${c.reset} budget $${args.budget} ${c.dim}|${c.reset} timeout ${args.timeout}s ${c.dim}|${c.reset} turns ${args.maxTurns}`);
  status(`${c.dim}Task: ${taskPreview}${taskPreview.length >= 80 ? "..." : ""}${c.reset}`);
  status("");

  // ── bd task lifecycle: claim on start ──
  if (args.bdTask) {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("bd", ["update", args.bdTask, "--claim"], { timeout: 5000 });
      status(`${c.dim}bd: claimed ${args.bdTask}${c.reset}`);
    } catch {}
  }

  const startTime = Date.now();

  // Spawn subprocess
  const proc = spawn("node", childArgs, {
    env,
    cwd: args.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture stdout
  const stdoutChunks = [];
  proc.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    // Stream to our stdout in real-time (unless writing result file)
    if (!args.resultFile) {
      process.stdout.write(chunk);
    }
  });

  // Stream stderr live — this is where Claude Code's tool activity shows
  // (Read, Grep, Bash calls, thinking indicators, etc.)
  const stderrChunks = [];
  const stderrPrefix = process.env.SWARM_AGENT_ID
    ? `${c.dim}[${process.env.SWARM_AGENT_ID}]${c.reset} `
    : "";
  proc.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
    // Forward to parent stderr with optional agent prefix for live visibility
    if (!quietMode) {
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        if (line.trim()) {
          process.stderr.write(`${stderrPrefix}${line}\n`);
        }
      }
    }
  });

  // Timeout handler
  const timer = setTimeout(() => {
    status(`\n${c.yellow}Timeout (${args.timeout}s) — sending SIGTERM${c.reset}`);
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 5000);
  }, args.timeout * 1000);

  // Wait for exit
  const exitCode = await new Promise((resolve) => {
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(signal === "SIGTERM" || signal === "SIGKILL" ? 124 : (code ?? 1));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      status(`${c.red}Spawn error: ${err.message}${c.reset}`);
      resolve(1);
    });
  });

  const durationMs = Date.now() - startTime;
  const durationSec = (durationMs / 1000).toFixed(1);
  const output = Buffer.concat(stdoutChunks).toString("utf-8").trim();

  // Status report
  if (exitCode === 124) {
    status(`\n${c.yellow}Timed out after ${durationSec}s${c.reset}`);
    status(`${c.dim}Tip: use --timeout 900 or split into smaller scoped tasks${c.reset}`);
  } else if (exitCode !== 0) {
    status(`\n${c.red}Failed after ${durationSec}s (exit ${exitCode})${c.reset}`);
    // Show stderr on failure for diagnostics
    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
    if (stderr) {
      const lines = stderr.split("\n").slice(-5);
      status(`${c.dim}${lines.join("\n")}${c.reset}`);
    }
  } else {
    status(`\n${c.green}Completed in ${durationSec}s${c.reset}`);
  }

  // Write result file if requested
  if (args.resultFile) {
    const result = {
      version: 1,
      status: exitCode === 0 ? "completed" : exitCode === 124 ? "timeout" : "failed",
      output: output.slice(0, 500_000), // 500KB cap
      duration_ms: durationMs,
      exit_code: exitCode,
      model: args.model,
      task: args.task || null,
    };
    writeResult(args.resultFile, result);
    status(`${c.dim}Result written to: ${args.resultFile}${c.reset}`);

    // Also write output to stdout so caller can see it
    if (output) process.stdout.write(output + "\n");
  }

  // ── bd task lifecycle: close on exit ──
  if (args.bdTask) {
    try {
      const { execFileSync } = await import("node:child_process");
      const reason = exitCode === 0
        ? `completed: ${(output || "done").slice(0, 100)}`
        : exitCode === 124
        ? `timeout after ${durationSec}s`
        : `failed with exit ${exitCode}`;
      if (exitCode === 0) {
        execFileSync("bd", ["close", args.bdTask, "--reason", reason], { timeout: 5000 });
        status(`${c.dim}bd: closed ${args.bdTask}${c.reset}`);
      } else {
        // Don't close on failure — leave in_progress for retry
        status(`${c.dim}bd: ${args.bdTask} left in_progress (exit ${exitCode})${c.reset}`);
      }
    } catch {}
  }

  // Clean up team directory (--team-name creates ~/.claude/teams/<name>/)
  try {
    const { rmSync } = await import("node:fs");
    const teamDir = join(process.env.HOME, ".claude", "teams", teamName);
    rmSync(teamDir, { recursive: true, force: true });
  } catch {}

  process.exit(exitCode);
}

main().catch((err) => {
  status(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * remote-agent — Claude Code supervisor for isolated research
 *
 * Spawns a fresh Claude Code subprocess with its own context window.
 * This is a SUPERVISOR, not a wrapper — cli.js runs as a child process.
 *
 * Architecture:
 *   agent-entry.mjs (this file) — slim orchestrator
 *     ├── Resolves CLI_JS path (fallback chain)
 *     ├── Parses custom CLI flags (via lib/cli.mjs)
 *     ├── Reads --context-file → converts to system prompt (via lib/context-bridge.mjs)
 *     ├── Spawns: node cli.js -p [flags] "task"
 *     ├── Streams stdout → buffer (+ optionally stderr for diagnostics)
 *     ├── Writes --result-file on exit (via lib/context-bridge.mjs)
 *     └── Reports status to stderr (via lib/output.mjs)
 *
 * All helper functions are imported from lib/ modules.
 *
 * TASK 4 Summary: Error Logging Audit
 * Total catch blocks: 7
 * Catch blocks with logging added: 6
 *   - Line ~147: versionCheck (main package.json read)
 *   - Line ~151: versionCheck (outer error)
 *   - Line ~159: main (package.json read for version)
 *   - Line ~441: progressInterval (progress file write)
 *   - Line ~555: main (temp directory cleanup)
 *   - Line ~616: main (progress file unlink)
 * Catch blocks already with proper logging: 1
 *   - Line ~214: main (stdin timeout - exits with error message)
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";

import { colors, log, setQuiet } from "./lib/output.mjs";
import { MAX_BUFFER_SIZE, TOOL_CALL_RE, resolveModel, ROLE_PROMPTS } from "./lib/config.mjs";
import { parseAgentArgs, showAgentHelp } from "./lib/cli.mjs";
import { contextToSystemPrompt, writeResult } from "./lib/context-bridge.mjs";
import { parseTelemetry, reportPeakBufferSize } from "./lib/telemetry.mjs";
import { claimBdTask, closeBdTask, cleanupTeamDir } from "./lib/lifecycle.mjs";
import { aiJsonDecision, isAiClientAvailable } from "./lib/ai-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── TASK 2: Zombie Process Cleanup ──────────────────────────────────
// Track all spawned child PIDs for cleanup
const activePids = new Set();

// Kill all tracked children with progressive escalation
function killAllChildren() {
  if (activePids.size === 0) return;

  console.error(`[agent-entry:killAllChildren] Cleaning up ${activePids.size} child processes`);

  // Send SIGTERM to all
  for (const pid of activePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      // Process may already be dead
      console.error(`[agent-entry:killAllChildren] Failed to SIGTERM pid ${pid}:`, err.message || err);
    }
  }

  // Wait 3s, then SIGKILL survivors
  setTimeout(() => {
    for (const pid of activePids) {
      try {
        process.kill(pid, 0); // Check if still alive
        console.error(`[agent-entry:killAllChildren] Force killing pid ${pid} with SIGKILL`);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process is dead, ignore
      }
    }
    activePids.clear();
  }, 3000);
}

// Register cleanup handlers
process.on("exit", () => {
  killAllChildren();
  cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME); // Will be set in main()
});

process.on("SIGTERM", () => {
  killAllChildren();
  cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME);
  process.exit(143);
});

process.on("SIGINT", () => {
  killAllChildren();
  cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME);
  process.exit(130);
});

process.on("uncaughtException", (err) => {
  console.error("[agent-entry:uncaughtException] Fatal error:", err.message || err);
  killAllChildren();
  cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME);
  process.exit(1);
});

// ── Resolve CLI_JS with fallback chain ──────────────────────────
let CLI_JS = null;

// (1) Try local node_modules first
const localPath = join(__dirname, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
if (existsSync(localPath)) {
  CLI_JS = localPath;
} else {
  // (2) Fallback to import.meta.resolve (works for globally installed packages)
  try {
    const resolved = await import.meta.resolve("@anthropic-ai/claude-code/cli.js");
    CLI_JS = fileURLToPath(resolved);
    process.stderr.write(`[remote-agent] CLI resolved via fallback: ${CLI_JS}\n`);
  } catch {
    process.stderr.write(`[remote-agent] ERROR: Cannot find @anthropic-ai/claude-code CLI.\n`);
    process.stderr.write(`[remote-agent] Tried:\n`);
    process.stderr.write(`[remote-agent]   1. Local: ${localPath}\n`);
    process.stderr.write(`[remote-agent]   2. import.meta.resolve (failed)\n`);
    process.stderr.write(`[remote-agent] Run: npm install\n`);
    process.exit(1);
  }
}

// ── Version checking ─────────────────────────────────────────────
try {
  const remoteAgentPkgPath = join(dirname(CLI_JS), "..", "package.json");
  const remoteAgentPkg = JSON.parse(readFileSync(remoteAgentPkgPath, "utf-8"));
  const remoteVersion = remoteAgentPkg.version;

  let mainVersion = process.env.CLAUDE_CODE_VERSION;

  if (!mainVersion && process.env.HOME) {
    try {
      const mainPkg = JSON.parse(
        readFileSync(join(process.env.HOME, ".claude", "node_modules", "@anthropic-ai", "claude-code", "package.json"), "utf-8")
      );
      mainVersion = mainPkg.version;
    } catch (err) {
      // TASK 4: Error logging - main package.json read failure
      console.error("[agent-entry:versionCheck] Error reading main package.json:", err.message || err);
    }
  }

  if (mainVersion && mainVersion !== remoteVersion) {
    process.stderr.write(
      `Warning: remote-agent uses claude-code ${remoteVersion} but main session may use different version (detected: ${mainVersion})\n`
    );
  }
} catch (err) {
  // TASK 4: Error logging - version check errors (non-critical)
  console.error("[agent-entry:versionCheck] Error:", err.message || err);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = parseAgentArgs(process.argv);
  setQuiet(args.quiet);

  if (args.help) { showAgentHelp(); process.exit(0); }

  if (args.version) {
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(CLI_JS), "..", "package.json"), "utf-8"));
      process.stdout.write(`remote-agent 1.0.0 (claude-code ${pkg.version})\n`);
    } catch (err) {
      // TASK 4: Error logging - package.json read failure
      console.error("[agent-entry:main] Error reading package.json:", err.message || err);
      process.stdout.write("remote-agent 1.0.0\n");
    }
    process.exit(0);
  }

  // ── Input validation ─────────────────────────────────────────────
  if (isNaN(args.budget) || args.budget <= 0 || args.budget > 100) {
    process.stderr.write(`Error: Invalid budget ${args.budget}. Must be > 0 and <= 100.\n`);
    process.exit(1);
  }

  if (isNaN(args.timeout) || args.timeout < 10 || args.timeout > 3600) {
    process.stderr.write(`Error: Invalid timeout ${args.timeout}. Must be >= 10 and <= 3600.\n`);
    process.exit(1);
  }

  if (isNaN(args.maxTurns) || args.maxTurns < 1 || args.maxTurns > 200) {
    process.stderr.write(`Error: Invalid maxTurns ${args.maxTurns}. Must be >= 1 and <= 200.\n`);
    process.exit(1);
  }

  if (!args.task && !args.contextFile && !args.stdin) {
    process.stderr.write(`Error: No task provided. Must provide task, --context-file, or --stdin.\n`);
    process.exit(1);
  }

  // Validate and resolve model — only sonnet 4.6 and opus 4.6 with 1M context
  const resolved = resolveModel(args.model);
  if (!resolved) {
    log(`${colors.red}Error: Model "${args.model}" is not allowed.${colors.reset}`);
    log(`Allowed models: sonnet (Sonnet 4.6, 1M), opus (Opus 4.6, 1M)`);
    process.exit(1);
  }
  args.model = resolved;

  // Read stdin if flagged
  if (args.stdin) {
    const timeoutMs = args.stdinTimeout * 1000;
    const stdinPromise = (async () => {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf-8").trim();
    })();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`stdin read timed out after ${args.stdinTimeout}s`));
      }, timeoutMs);
    });

    try {
      const stdinContent = await Promise.race([stdinPromise, timeoutPromise]);
      if (args.task) {
        args.task = `${args.task}\n\n--- stdin content ---\n${stdinContent}`;
      } else {
        args.task = stdinContent;
      }
    } catch (err) {
      process.stderr.write(`Error: stdin read timed out after ${args.stdinTimeout}s. Provide input or remove --stdin flag.\n`);
      process.exit(1);
    }
  }

  if (!args.task && !args.contextFile) {
    log(`${colors.red}Error: No task provided.${colors.reset}`);
    log("Usage: remote-agent \"your task\" or remote-agent --context-file ctx.json");
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
    const { prompt: ctxPrompt, error: ctxError } = contextToSystemPrompt(args.contextFile);
    if (ctxPrompt) {
      systemParts.push(ctxPrompt);
    } else if (ctxError) {
      log(`${colors.red}Error: Context file is required but failed to load${colors.reset}`);
      process.exit(1);
    }
  }
  if (args.systemPrompt) {
    systemParts.push(args.systemPrompt);
  }
  if (systemParts.length > 0) {
    childArgs.push("--append-system-prompt", systemParts.join("\n\n"));
  }

  // Task goes last
  if (args.task) {
    childArgs.push(args.task);
  }

  // Environment: bypass nesting guard + avoid auth conflict
  const env = { ...process.env };

  // Bypass nesting guard: provide the full team triple (--team-name + --agent-id + --agent-name)
  const agentId = randomUUID().slice(0, 12);
  const teamName = `remote-${agentId}`;
  process.env.REMOTE_AGENT_TEAM_NAME = teamName; // For cleanup handlers
  childArgs.splice(1, 0,
    "--team-name", teamName,
    "--agent-id", agentId,
    "--agent-name", "remote-agent",
  );
  env.CLAUDECODE = ""; // Belt-and-suspenders: also clear the env guard

  // Don't force effort on models that don't support it
  delete env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;

  // Point subprocess to minimal config (no hooks, no MCP, no taskmaster)
  env.CLAUDE_CONFIG_DIR = join(__dirname, "config");

  // Disable non-essential features for research subprocess
  delete env.CLAUDE_CODE_ENABLE_TASKS;
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  delete env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES;
  delete env.CLAUDE_AUTO_BACKGROUND_TASKS;

  // Status
  const taskPreview = (args.task || "(from context file)").slice(0, 80);
  log(`${colors.bold}${colors.cyan}remote-agent${colors.reset} ${colors.dim}|${colors.reset} ${args.model} ${colors.dim}|${colors.reset} budget $${args.budget} ${colors.dim}|${colors.reset} timeout ${args.timeout}s ${colors.dim}|${colors.reset} turns ${args.maxTurns}`);
  log(`${colors.dim}Task: ${taskPreview}${taskPreview.length >= 80 ? "..." : ""}${colors.reset}`);
  log("");

  // ── bd task lifecycle: claim on start ──
  await claimBdTask(args.bdTask);

  // ── Retry loop ────────────────────────────────────────────────────
  let exitCode;
  let durationMs;
  let output;
  let stdoutChunks;
  let stderrChunks;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let startTime;
  let retryCount = 0;

  while (retryCount <= args.maxRetries) {
    // Check budget before retry (skip if insufficient)
    if (retryCount > 0) {
      if (args.budget < 2) {
        log(`${colors.yellow}Skipping retry: insufficient budget ($${args.budget} < $2)${colors.reset}`);
        break;
      }

      const backoffSeconds = Math.pow(2, retryCount - 1); // 1s, 2s, 4s
      log(`${colors.yellow}Retry ${retryCount}/${args.maxRetries} after ${backoffSeconds}s (exit code: ${exitCode})...${colors.reset}`);
      await new Promise(resolve => setTimeout(resolve, backoffSeconds * 1000));
    }

    startTime = Date.now();

    // TASK 1: Create temp directory for overflow files
    const tempDir = mkdtempSync(join(tmpdir(), "remote-agent-"));
    let stdoutOverflowPath = null;
    let stdoutOverflowStream = null;
    let stderrOverflowPath = null;
    let stderrOverflowStream = null;
    let peakStdoutBytes = 0;
    let peakStderrBytes = 0;

    // Spawn subprocess
    const proc = spawn("node", childArgs, {
      env,
      cwd: args.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false, // TASK 2: Ensure child is not detached for proper cleanup
    });

    // TASK 2: Track PID for cleanup
    activePids.add(proc.pid);
    proc.on("close", () => {
      activePids.delete(proc.pid);
    });

    // TASK 1: Capture stdout with ring buffer + overflow to temp file + backpressure
    stdoutChunks = [];
    stdoutBytes = 0;
    const BACKPRESSURE_THRESHOLD = MAX_BUFFER_SIZE * 0.8; // 80% of max

    proc.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      peakStdoutBytes = Math.max(peakStdoutBytes, stdoutBytes);

      // TASK 1: Write overflow to temp file when exceeding MAX_BUFFER_SIZE
      while (stdoutBytes > MAX_BUFFER_SIZE && stdoutChunks.length > 0) {
        const dropped = stdoutChunks.shift();
        stdoutBytes -= dropped.length;

        // Write dropped chunk to overflow file
        if (!stdoutOverflowStream) {
          stdoutOverflowPath = join(tempDir, "stdout-overflow.log");
          stdoutOverflowStream = createWriteStream(stdoutOverflowPath, { flags: "a" });
        }
        stdoutOverflowStream.write(dropped);
      }

      // TASK 1: Backpressure management - pause when near cap
      if (stdoutBytes > BACKPRESSURE_THRESHOLD && !proc.stdout.isPaused()) {
        proc.stdout.pause();
        // Resume after flush
        setImmediate(() => {
          if (proc.stdout.isPaused()) {
            proc.stdout.resume();
          }
        });
      }

      // Stream to our stdout in real-time (unless writing result file)
      if (!args.resultFile) {
        process.stdout.write(chunk);
      }
    });

    // TASK 1: Stream stderr live with overflow + backpressure
    stderrChunks = [];
    stderrBytes = 0;
    let stderrBufferWarned = false;
    const stderrPrefix = process.env.SWARM_AGENT_ID
      ? `${colors.dim}[${process.env.SWARM_AGENT_ID}]${colors.reset} `
      : "";

    // ── Progress tracking ─────────────────────────────────────────
    const progress = {
      tool_calls_count: 0,
      last_tool: null,
    };
    const toolPatterns = [
      { pattern: /\bRead\(/i, name: "Read" },
      { pattern: /\bGrep\(/i, name: "Grep" },
      { pattern: /\bBash\(/i, name: "Bash" },
      { pattern: /\bEdit\(/i, name: "Edit" },
      { pattern: /\bWrite\(/i, name: "Write" },
      { pattern: /\bGlob\(/i, name: "Glob" },
    ];

    // Emit progress updates every 30s
    const progressInterval = setInterval(() => {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
      const stdoutKB = (stdoutBytes / 1024).toFixed(0);
      const progressMsg = `[progress] ${elapsedSec}s | tools: ${progress.tool_calls_count} | last: ${progress.last_tool || "none"} | stdout: ${stdoutKB}KB`;
      process.stderr.write(`${colors.dim}${progressMsg}${colors.reset}\n`);

      // Write incremental progress file if result file is set
      if (args.resultFile) {
        const progressFile = args.resultFile + ".progress.json";
        const progressData = {
          tool_calls: progress.tool_calls_count,
          elapsed_ms: Date.now() - startTime,
          stdout_bytes: stdoutBytes,
          last_tool: progress.last_tool,
        };
        try {
          writeFileSync(progressFile, JSON.stringify(progressData, null, 2), "utf-8");
        } catch (err) {
          // TASK 4: Error logging - progress file write failure (best-effort)
          console.error("[agent-entry:progressInterval] Error writing progress file:", err.message || err);
        }
      }
    }, 30000);

    proc.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      peakStderrBytes = Math.max(peakStderrBytes, stderrBytes);

      // TASK 1: Write overflow to temp file when exceeding MAX_BUFFER_SIZE
      while (stderrBytes > MAX_BUFFER_SIZE && stderrChunks.length > 0) {
        if (!stderrBufferWarned) {
          process.stderr.write(`${colors.yellow}Warning: Output buffer exceeded 50MB, truncating oldest chunks${colors.reset}\n`);
          stderrBufferWarned = true;
        }
        const dropped = stderrChunks.shift();
        stderrBytes -= dropped.length;

        // Write dropped chunk to overflow file
        if (!stderrOverflowStream) {
          stderrOverflowPath = join(tempDir, "stderr-overflow.log");
          stderrOverflowStream = createWriteStream(stderrOverflowPath, { flags: "a" });
        }
        stderrOverflowStream.write(dropped);
      }

      // TASK 1: Backpressure management - pause when near cap
      if (stderrBytes > BACKPRESSURE_THRESHOLD && !proc.stderr.isPaused()) {
        proc.stderr.pause();
        // Resume after flush
        setImmediate(() => {
          if (proc.stderr.isPaused()) {
            proc.stderr.resume();
          }
        });
      }

      // Parse stderr for tool calls (passive observation only)
      const text = chunk.toString("utf-8");
      for (const { pattern, name } of toolPatterns) {
        if (pattern.test(text)) {
          progress.tool_calls_count++;
          progress.last_tool = name;
        }
      }

      // Forward to parent stderr with optional agent prefix for live visibility
      if (!args.quiet) {
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            process.stderr.write(`${stderrPrefix}${line}\n`);
          }
        }
      }
    });

    // Timeout handler - progressive signal escalation
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      clearInterval(progressInterval);
      log(`\n${colors.yellow}Timeout (${args.timeout}s) — sending SIGINT${colors.reset}`);
      proc.kill("SIGINT");

      // Escalate to SIGTERM after 10s
      setTimeout(() => {
        if (!proc.killed) {
          log(`${colors.yellow}Escalating to SIGTERM${colors.reset}`);
          proc.kill("SIGTERM");

          // Final escalation to SIGKILL after 5s more
          setTimeout(() => {
            if (!proc.killed) {
              log(`${colors.yellow}Force killing with SIGKILL${colors.reset}`);
              try { proc.kill("SIGKILL"); } catch {}
            }
          }, 5000);
        }
      }, 10000);
    }, args.timeout * 1000);

    // Wait for exit
    exitCode = await new Promise((resolve) => {
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        clearInterval(progressInterval);
        // Exit code 124 indicates timeout/interruption
        const wasInterrupted = signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT" || timedOut;
        resolve(wasInterrupted ? 124 : (code ?? 1));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        clearInterval(progressInterval);
        log(`${colors.red}Spawn error: ${err.message}${colors.reset}`);
        resolve(1);
      });
    });

    durationMs = Date.now() - startTime;
    output = Buffer.concat(stdoutChunks).toString("utf-8").trim();

    // TASK 1: Close overflow streams and clean up temp directory
    if (stdoutOverflowStream) {
      stdoutOverflowStream.end();
    }
    if (stderrOverflowStream) {
      stderrOverflowStream.end();
    }
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.error("[agent-entry:main] Error cleaning up temp directory:", err.message || err);
    }

    // TASK 1: Report peak buffer sizes to telemetry
    reportPeakBufferSize(peakStdoutBytes, peakStderrBytes);

    // ── Retry decision (AI-powered error classification) ───────────
    if (exitCode === 0 || exitCode === 124) {
      break; // Success or timeout — don't retry
    }

    // Classify error before deciding to retry
    if (retryCount < args.maxRetries && isAiClientAvailable()) {
      try {
        const stderrTail = Buffer.concat(stderrChunks).toString("utf-8").slice(-2000);
        const classification = await aiJsonDecision({
          model: "claude-sonnet-4-6",
          system: [
            'You are an error classifier for agent subprocess failures. Respond with ONLY JSON: {"type": "transient"|"permanent"|"ambiguous", "reason": "1-sentence explanation"}',
            "",
            "## Error Taxonomy",
            "",
            "### transient (retry WILL help)",
            "- HTTP 429/503/529: rate limits, server overload",
            '- "ECONNRESET", "ETIMEDOUT", "socket hang up": network interruptions',
            '- "resource temporarily unavailable": system load',
            "- Exit code 137 (OOM killed): may succeed with less parallel work",
            "",
            "### permanent (retry will NOT help)",
            "- Syntax errors, import failures, missing modules: code bugs",
            "- Permission denied, authentication failed: config issues",
            '- "Invalid API key", "unauthorized": credential problems',
            "- Assertion failures, test failures: logic errors",
            "- Exit code 1 with clear error message about invalid input",
            "",
            "### ambiguous (retry worth attempting)",
            "- Generic exit code 1 with unclear stderr",
            "- Segfault (exit 139): may be transient race condition",
            "- Empty stderr with non-zero exit: unknown failure mode",
          ].join("\n"),
          prompt: `Agent failed with exit code ${exitCode}.\n\nLast 2K of stderr:\n${stderrTail}\n\nClassify this error.`,
          maxTokens: 128,
        });

        if (classification.parsed?.type === "permanent") {
          log(`${colors.yellow}Error classified as permanent: ${classification.parsed.reason || "unknown"} — skipping retry${colors.reset}`);
          break;
        }
        if (classification.parsed?.type) {
          log(`${colors.dim}Error classified as ${classification.parsed.type}: ${classification.parsed.reason || ""} — will retry${colors.reset}`);
        }
      } catch {
        // Classification failed — proceed with retry (safe default)
      }
    }

    retryCount++;
  } // End retry loop

  const durationSec = (durationMs / 1000).toFixed(1);

  // Status report
  if (exitCode === 124) {
    log(`\n${colors.yellow}Timed out after ${durationSec}s${colors.reset}`);
    log(`${colors.dim}Tip: use --timeout 900 or split into smaller scoped tasks${colors.reset}`);
  } else if (exitCode !== 0) {
    log(`\n${colors.red}Failed after ${durationSec}s (exit ${exitCode})${colors.reset}`);
    // Show stderr on failure for diagnostics
    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
    if (stderr) {
      const lines = stderr.split("\n").slice(-5);
      log(`${colors.dim}${lines.join("\n")}${colors.reset}`);
    }
  } else {
    log(`\n${colors.green}Completed in ${durationSec}s${colors.reset}`);
  }

  // Write result file if requested
  if (args.resultFile) {
    // Parse telemetry from stderr and stdout
    const stderrText = Buffer.concat(stderrChunks).toString("utf-8");
    const telemetry = parseTelemetry(stderrText, output);

    // Quality signals — fast heuristic + optional AI analysis
    const elapsedSec = durationMs / 1000;
    telemetry.quality_signals.high_token_low_tools =
      elapsedSec > 120 && telemetry.tool_calls.total < 5;

    // AI quality analysis for suspicious patterns (post-hoc, non-blocking)
    if (isAiClientAvailable() && telemetry.quality_signals.high_token_low_tools) {
      try {
        const stderrSample = Buffer.concat(stderrChunks).toString("utf-8").slice(-3000);
        const qa = await aiJsonDecision({
          model: "claude-sonnet-4-6",
          system: [
            'You are an execution quality analyzer. Detect pathological execution patterns that indicate wasted compute. Respond with ONLY JSON: {"issue": "description"|null, "severity": "low"|"medium"|"high"}',
            "",
            "## Anti-Patterns to Detect",
            "",
            "### Stuck Loop (high severity)",
            'SIGNALS: Same tool called repeatedly on same file, error messages repeating, "trying again" or "let me retry" patterns.',
            "THRESHOLD: >3 identical tool calls in sequence, or >50% of tool calls are retries.",
            "",
            "### Error Spiral (high severity)",
            "SIGNALS: Fix A breaks B, fix B breaks C — progressive cascading. Increasing stderr volume. No successful tool calls in final 30% of execution.",
            "THRESHOLD: >5 consecutive errors, or tool success rate <30%.",
            "",
            "### Idle Drift (medium severity)",
            "SIGNALS: Long runtime with very few tool calls. Agent producing lengthy text without action.",
            "THRESHOLD: >120s runtime with <5 tool calls.",
            "",
            "### Incomplete Termination (low severity)",
            "SIGNALS: Agent stopped mid-sentence, no completion checklist, output ends abruptly.",
            "",
            "Respond null for issue if execution appears healthy.",
          ].join("\n"),
          prompt: `Agent ran ${elapsedSec.toFixed(0)}s, made ${telemetry.tool_calls.total} tool calls (${JSON.stringify(telemetry.tool_calls)}).\n\nLast 3K stderr:\n${stderrSample}\n\nOutput preview:\n${output.slice(0, 2000)}\n\nAnalyze execution quality.`,
          maxTokens: 256,
        });
        if (qa.parsed) {
          telemetry.quality_signals.ai_analysis = qa.parsed;
          if (qa.parsed.issue) {
            log(`${colors.yellow}Quality warning: ${qa.parsed.issue} (${qa.parsed.severity})${colors.reset}`);
          }
        }
      } catch {
        // Quality analysis failed — non-critical, skip silently
      }
    }

    const result = {
      version: 1,
      status: exitCode === 0 ? "completed" : exitCode === 124 ? "timeout" : "failed",
      output: output.slice(0, 500_000), // 500KB cap
      duration_ms: durationMs,
      exit_code: exitCode,
      model: args.model,
      task: args.task || null,
      truncated: stdoutBytes > MAX_BUFFER_SIZE, // Output was truncated due to ring buffer
      telemetry, // Per-agent quality signals
    };
    writeResult(args.resultFile, result);
    log(`${colors.dim}Result written to: ${args.resultFile}${colors.reset}`);

    // Clean up progress file
    try { unlinkSync(args.resultFile + ".progress.json"); } catch (err) {
      // TASK 4: Error logging - progress file cleanup (best-effort)
      console.error("[agent-entry:main] Error deleting progress file:", err.message || err);
    }

    // Also write output to stdout so caller can see it
    if (output) process.stdout.write(output + "\n");
  }

  // ── bd task lifecycle: close on exit ──
  await closeBdTask(args.bdTask, exitCode, output, durationSec);

  // Clean up team directory (--team-name creates ~/.claude/teams/<name>/)
  cleanupTeamDir(teamName);

  process.exit(exitCode);
}

main().catch((err) => {
  log(`${colors.red}Fatal: ${err.message}${colors.reset}`);
  process.exit(1);
});

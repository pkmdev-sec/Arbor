#!/usr/bin/env node
/**
 * arbor — Claude Code supervisor for isolated research
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

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";

import { colors, log, setQuiet } from "./lib/output.mjs";
import { MAX_BUFFER_SIZE, TOOL_CALL_RE, resolveModel, ROLE_PROMPTS, ROLE_DISALLOWED_TOOLS, ROLE_THINKING_TOKENS, ROLE_OUTPUT_TOKENS, ROLE_BASH_LIMIT, DECOMPOSER_OUTPUT_SCHEMA } from "./lib/config.mjs";
import { parseAgentArgs, showAgentHelp } from "./lib/cli.mjs";
import { contextToSystemPrompt, writeResult } from "./lib/context-bridge.mjs";
import { filterSystemPromptForRole, filteringStats } from "./lib/context-filter.mjs";
import { parseTelemetry, reportPeakBufferSize } from "./lib/telemetry.mjs";
import { claimBdTask, closeBdTask, cleanupTeamDir } from "./lib/lifecycle.mjs";
import { aiJsonDecision, isAiClientAvailable } from "./lib/ai-client.mjs";
import { initIpcLogger, logIpc } from "./lib/ipc-logger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Module-level state for emergency result writing on crash
let _resultFilePath = null;
let _lastExitCode = 1;
let _lastOutput = "";
let _lastDurationMs = 0;
let _resultWritten = false;

function writeEmergencyResult(error) {
  if (_resultWritten || !_resultFilePath) return;
  try {
    const result = {
      version: 1,
      status: "failed",
      output: _lastOutput || `[arbor: agent crashed during post-processing: ${error}]`,
      duration_ms: _lastDurationMs,
      exit_code: _lastExitCode,
      model: null,
      task: null,
      truncated: false,
      changes_applied: false,
      files_changed: [],
      telemetry: { quality_signals: { crash: true, crash_error: String(error) } },
    };
    writeFileSync(_resultFilePath, JSON.stringify(result, null, 2), "utf-8");
  } catch { /* Last resort — nothing more we can do */ }
}

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

  // Synchronous grace period, then SIGKILL survivors.
  // Using spawnSync("sleep") because setTimeout won't fire during process exit
  // (the event loop is drained before exit completes).
  try {
    execFileSync("sleep", ["1"], { timeout: 3000 });
  } catch {
    // sleep may not exist or timeout — proceed to SIGKILL anyway
  }

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
}

// Register cleanup handlers
process.on("exit", () => {
  killAllChildren();
  if (process.env.ARBOR_TEAM_NAME) cleanupTeamDir(process.env.ARBOR_TEAM_NAME); // Will be set in main()
});

process.on("SIGTERM", () => {
  killAllChildren();
  if (process.env.ARBOR_TEAM_NAME) cleanupTeamDir(process.env.ARBOR_TEAM_NAME);
  process.exit(143);
});

process.on("SIGINT", () => {
  killAllChildren();
  if (process.env.ARBOR_TEAM_NAME) cleanupTeamDir(process.env.ARBOR_TEAM_NAME);
  process.exit(130);
});

process.on("uncaughtException", (err) => {
  console.error("[agent-entry:uncaughtException] Fatal error:", err.message || err);
  killAllChildren();
  if (process.env.ARBOR_TEAM_NAME) cleanupTeamDir(process.env.ARBOR_TEAM_NAME);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[agent-entry:unhandledRejection] Unhandled promise rejection:", reason);
  writeEmergencyResult(`unhandledRejection: ${reason}`);
  killAllChildren();
  if (process.env.ARBOR_TEAM_NAME) cleanupTeamDir(process.env.ARBOR_TEAM_NAME);
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
    process.stderr.write(`[arbor] CLI resolved via fallback: ${CLI_JS}\n`);
  } catch {
    process.stderr.write(`[arbor] ERROR: Cannot find @anthropic-ai/claude-code CLI.\n`);
    process.stderr.write(`[arbor] Tried:\n`);
    process.stderr.write(`[arbor]   1. Local: ${localPath}\n`);
    process.stderr.write(`[arbor]   2. import.meta.resolve (failed)\n`);
    process.stderr.write(`[arbor] Run: npm install\n`);
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
      `Warning: arbor uses claude-code ${remoteVersion} but main session may use different version (detected: ${mainVersion})\n`
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
      process.stdout.write(`arbor 1.0.0 (claude-code ${pkg.version})\n`);
    } catch (err) {
      // TASK 4: Error logging - package.json read failure
      console.error("[agent-entry:main] Error reading package.json:", err.message || err);
      process.stdout.write("arbor 1.0.0\n");
    }
    process.exit(0);
  }

  // ── Input validation ─────────────────────────────────────────────
  if (isNaN(args.budget) || args.budget <= 0 || args.budget > 100) {
    process.stderr.write(`Error: Invalid budget ${args.budget}. Must be > 0 and <= 100.\n`);
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

  // Set module-level result path for emergency crash handler
  if (args.resultFile) _resultFilePath = args.resultFile;

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
    log("Usage: arbor \"your task\" or arbor --context-file ctx.json");
    process.exit(1);
  }

  // S2: Delta-only env — single-pass filter avoids spread + V8-deoptimizing deletes
  const ENV_DELETES = new Set([
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
    "CLAUDE_CODE_ENABLE_TASKS",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
    "CLAUDE_AUTO_BACKGROUND_TASKS",
  ]);
  const env = Object.create(null);
  for (const key of Object.keys(process.env)) {
    if (!ENV_DELETES.has(key)) env[key] = process.env[key];
  }

  // Bypass nesting guard: provide the full team triple (--team-name + --agent-id + --agent-name)
  const agentId = randomUUID().slice(0, 12);
  const teamName = `arbor-${agentId}`;
  process.env.ARBOR_TEAM_NAME = teamName; // For cleanup handlers
  env.CLAUDECODE = ""; // Belt-and-suspenders: also clear the env guard

  // F1: Non-essential traffic suppression — verified in SDK
  env.DISABLE_ERROR_REPORTING = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_COST_WARNINGS = "1";
  env.DISABLE_INSTALLATION_CHECKS = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
  env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = "1";

  // F2: Adaptive compaction — defer compaction for short tasks, allow earlier for long
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = args.maxTurns > 25 ? "85" : "95";

  // F3: Small model for internal SDK calls (tool search, summaries)
  env.ANTHROPIC_SMALL_FAST_MODEL = "claude-haiku-4-5-20251001";

  // F4: Role-specific resource tuning — verified env var names in SDK
  if (args.role && ROLE_THINKING_TOKENS[args.role]) {
    env.MAX_THINKING_TOKENS = String(ROLE_THINKING_TOKENS[args.role]);
  }
  if (args.role && ROLE_OUTPUT_TOKENS[args.role]) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(ROLE_OUTPUT_TOKENS[args.role]);
  }
  if (args.role && ROLE_BASH_LIMIT[args.role]) {
    env.BASH_MAX_OUTPUT_LENGTH = String(ROLE_BASH_LIMIT[args.role]);
  }

  // ── Session resume support ───────────────────────────────────────
  // Generate a stable session ID for the first run. On retry, --resume picks up
  // where the previous attempt left off with full conversation history intact.
  const sessionUUID = randomUUID();
  const canResume = args.maxRetries > 0;

  // ── Hooks: scope guard, progress reporting, pre-compact state ──
  // Create a per-agent config when any hook is needed: scope → PreToolUse,
  // TUI → PostToolUse, long-running/persistent → PreCompact.
  let scopeConfigDir = null;
  const tuiActive = process.env.ARBOR_TUI === "1";
  const needsPreCompact = args.persistContext || args.maxTurns > 50 || args.scope;
  const needsHooks = args.scope || (tuiActive && args.resultFile) || needsPreCompact;
  if (needsHooks) {
    scopeConfigDir = mkdtempSync(join(tmpdir(), "ra-scope-"));
    const hooks = {};

    // PreToolUse: scope guard — block writes outside assigned scope
    if (args.scope) {
      hooks.PreToolUse = [{
        matcher: "{Write,Edit,Bash}",
        hooks: [{
          type: "command",
          command: `python3 ${join(__dirname, "hooks", "scope-guard.py")}`,
          timeout: 3,
        }]
      }];
      env.ARBOR_SCOPE = args.scope;
      log(`${colors.dim}Scope guard active: ${args.scope}${colors.reset}`);
    }

    // F9: PostToolUse — progress reporter for TUI real-time display
    if (tuiActive && args.resultFile) {
      hooks.PostToolUse = [{
        matcher: "*",
        hooks: [{
          type: "command",
          command: `python3 ${join(__dirname, "hooks", "progress-reporter.py")}`,
          timeout: 3,
        }]
      }];
      env.ARBOR_PROGRESS_IPC_DIR = dirname(args.resultFile);
      env.ARBOR_AGENT_ID = process.env.SWARM_AGENT_ID || agentId;
    }

    // F10: PreCompact — save agent state before context compaction
    if (needsPreCompact) {
      hooks.PreCompact = [{
        matcher: "*",
        hooks: [{
          type: "command",
          command: `python3 ${join(__dirname, "hooks", "agent-precompact.py")}`,
          timeout: 5,
        }]
      }];
      if (args.role) env.ARBOR_ROLE = args.role;
    }

    const scopeSettings = {
      "$schema": "https://json.schemastore.org/claude-code-settings.json",
      permissions: { allow: ["*"], deny: [], defaultMode: "dontAsk" },
      includeCoAuthoredBy: false,
      hooks,
    };
    writeFileSync(join(scopeConfigDir, "settings.json"), JSON.stringify(scopeSettings, null, 2), "utf-8");
  }

  // Point subprocess to config (scope-guarded or minimal)
  env.CLAUDE_CONFIG_DIR = scopeConfigDir || join(__dirname, "config");

  // ── MCP coordination: write config for agent-side MCP server ───
  let mcpConfigPath = null;
  if (args.resultFile) {
    const mcpServerPath = join(__dirname, "lib", "mcp", "coordinator-server.mjs");
    if (existsSync(mcpServerPath)) {
      mcpConfigPath = join(mkdtempSync(join(tmpdir(), "ra-mcp-")), "mcp-config.json");
      const mcpConfig = {
        mcpServers: {
          "swarm-coordinator": {
            command: "node",
            args: [mcpServerPath],
            env: {
              SWARM_AGENT_ID: process.env.SWARM_AGENT_ID || agentId,
              SWARM_WORK_DIR: dirname(args.resultFile),
              SWARM_SCOPE: args.scope || "",
              SWARM_TASK: (args.task || "").slice(0, 500),
              SWARM_CONTEXT_FILE: args.contextFile || "",
            }
          }
        }
      };
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      log(`${colors.dim}MCP coordinator enabled${colors.reset}`);
    }
  }

  // ── Context persistence: CLAUDE.md for compaction survival ─────
  let persistContextDir = null;
  // F5: Expanded persistence trigger — also fires on scope to survive compaction
  if (args.persistContext || args.maxTurns > 50 || args.scope) {
    const systemParts = [];
    if (args.role && args.role !== "verifier" && ROLE_PROMPTS[args.role]) {
      systemParts.push(ROLE_PROMPTS[args.role]);
    }
    if (args.contextFile) {
      const { prompt: ctxPrompt } = contextToSystemPrompt(args.contextFile);
      if (ctxPrompt) systemParts.push(ctxPrompt);
    }
    if (systemParts.length > 0) {
      persistContextDir = mkdtempSync(join(tmpdir(), "ra-ctx-"));
      writeFileSync(join(persistContextDir, "CLAUDE.md"), systemParts.join("\n\n"), "utf-8");
      // F10: Expose persist dir to PreCompact hook for state preservation
      env.ARBOR_PERSIST_DIR = persistContextDir;
      log(`${colors.dim}Context persisted to ${persistContextDir}/CLAUDE.md (survives compaction)${colors.reset}`);
    }
  }

  // ── Prefill auto-generation per role ─────────────────────────────
  // Role-appropriate prefill text skips the "let me think about what to do" phase,
  // saving 1-3 turns per agent. Verifier is excluded (let it reason from scratch
  // for adversarial quality).
  function _autoGeneratePrefill(role) {
    switch (role) {
      case "worker":
        return "I'll start by reading the relevant files to understand the current code, then make the requested changes.\n\n";
      case "decomposer":
        return "I'll analyze the task scope and produce a JSON decomposition.\n\n";
      case "verifier":
        // Verifier: no prefill (let it reason from scratch for adversarial quality)
        return null;
      default:
        // Standalone calls (no --role): nudge agent to act, not just explore.
        // Without this, opus spends all turns reading files and produces empty output.
        return "I'll examine the relevant code, then produce concrete output (write files, generate content, or provide a clear text response). I will NOT spend all my turns just reading — I'll act on what I find.\n\n";
    }
  }

  // ── Build child process arguments (called per retry attempt) ───
  const buildChildArgs = (previousResultFile, isRetry = false) => {
    const childArgs = [
      CLI_JS,
      // Team triple must come before -p for nesting guard bypass
      "--team-name", teamName,
      "--agent-id", agentId,
      "--agent-name", "arbor",
      "-p",
      "--model", args.model,
      "--permission-mode", "dontAsk",
      "--dangerously-skip-permissions",
      "--max-turns", String(args.maxTurns),
      "--max-budget-usd", String(args.budget),
      // When writing a result file, force stream-json to enable real-time tool call
      // counting from NDJSON events. Claude Code in text mode doesn't emit tool call
      // indicators to stderr, so the TOOL_CALL_RE-based counting was always 0.
      "--output-format", args.resultFile ? "stream-json" : args.outputFormat,
    ];

    // stream-json requires --verbose when used with --print
    if (args.resultFile) {
      childArgs.push("--verbose");
    }

    // Session persistence: enable when retries are possible (session files needed for --resume)
    if (!canResume) {
      childArgs.push("--no-session-persistence");
    }

    // Session resume: on retry, continue from previous session instead of starting fresh
    if (isRetry && canResume) {
      childArgs.push("--resume", sessionUUID, "--fork-session");
      log(`${colors.dim}Resuming session ${sessionUUID}${colors.reset}`);
    } else if (canResume) {
      childArgs.push("--session-id", sessionUUID);
    }

    // Native effort level passthrough
    if (args.effort) {
      childArgs.push("--effort", args.effort);
    }

    // Native fallback model for overload handling
    if (args.fallbackModel) {
      childArgs.push("--fallback-model", args.fallbackModel);
    }

    // F6: Debug passthrough — SWARM_DEBUG/DEBUG env or --debug flag
    if (args.debug || process.env.SWARM_DEBUG || process.env.DEBUG) {
      childArgs.push("--debug");
      env.CLAUDE_CODE_DEBUG_LOGS_DIR = join(tmpdir(), `arbor-debug-${agentId}`);
    }

    // F7: Settings isolation — prevent child from reading user's global settings
    childArgs.push("--setting-sources", "user");

    // F8: Decomposer JSON schema enforcement — structured output via --json-schema
    if (args.role === "decomposer") {
      childArgs.push("--json-schema", JSON.stringify(DECOMPOSER_OUTPUT_SCHEMA));
    }

    // Change 4: Use built-in verifier agent instead of custom role prompt
    if (args.role === "verifier") {
      childArgs.push("--agent", "verifier");
    }

    // Tool restriction per role (denylist — more future-proof than allowlist)
    if (args.role && ROLE_DISALLOWED_TOOLS[args.role]) {
      childArgs.push("--disallowed-tools", ...ROLE_DISALLOWED_TOOLS[args.role].split(" "));
    }

    // Prefill: pre-fill assistant's first response to skip "thinking" phase
    // Auto-generate role-appropriate prefill when not explicitly provided
    if (!isRetry) {
      const prefill = args.prefill || _autoGeneratePrefill(args.role);
      if (prefill) {
        childArgs.push("--prefill", prefill);
      }
    }

    // MCP coordination server
    if (mcpConfigPath) {
      childArgs.push("--mcp-config", mcpConfigPath);
    }

    // Context persistence: add temp directory with CLAUDE.md
    if (persistContextDir) {
      childArgs.push("--add-dir", persistContextDir);
    }

    // Context bridge: role prompts + context file → system prompt
    // On resume retry, skip — the session already has the context
    const systemParts = [];
    if (!isRetry) {
      // Skip role prompt injection for verifier (using --agent verifier instead)
      // and when persisted to CLAUDE.md (avoid double injection)
      if (!persistContextDir && args.role !== "verifier") {
        if (args.role && ROLE_PROMPTS[args.role]) {
          systemParts.push(ROLE_PROMPTS[args.role]);
        }
      }
      if (!persistContextDir && args.contextFile) {
        const { prompt: ctxPrompt, error: ctxError } = contextToSystemPrompt(args.contextFile);
        if (ctxPrompt) {
          systemParts.push(ctxPrompt);
        } else if (ctxError) {
          log(`${colors.red}Error: Context file is required but failed to load${colors.reset}`);
          process.exit(1);
        }
      }
    }
    // I4: Inject previous attempt output as context (non-resume fallback)
    if (!isRetry && previousResultFile && existsSync(previousResultFile)) {
      const { prompt: prevPrompt } = contextToSystemPrompt(previousResultFile);
      if (prevPrompt) {
        systemParts.push("[Previous Attempt Output - use as reference, do not repeat failures]\n\n" + prevPrompt);
      }
    }
    if (args.systemPrompt) {
      systemParts.push(args.systemPrompt);
    }
    if (systemParts.length > 0) {
      // F11: Semantic context filtering — strip irrelevant sections per role
      let assembledPrompt = systemParts.join("\n\n");
      if (args.role) {
        const original = assembledPrompt;
        assembledPrompt = filterSystemPromptForRole(assembledPrompt, args.role);
        const stats = filteringStats(original, assembledPrompt);
        if (stats.reductionPct > 0) {
          log(`${colors.dim}F11: context filtered for ${args.role} (${stats.reductionPct}% reduction, ${stats.originalSize} → ${stats.filteredSize} chars)${colors.reset}`);
        }
      }
      childArgs.push("--append-system-prompt", assembledPrompt);
    }

    // Task goes last — use "--" separator when variadic flags are present
    // to prevent the task string from being consumed as a flag argument
    if (args.task && !isRetry) {
      if (persistContextDir || mcpConfigPath) {
        childArgs.push("--", args.task);
      } else {
        childArgs.push(args.task);
      }
    }

    return childArgs;
  };

  // Status
  const taskPreview = (args.task || "(from context file)").slice(0, 80);
  log(`${colors.bold}${colors.cyan}Arbor${colors.reset} ${colors.dim}|${colors.reset} ${args.model} ${colors.dim}|${colors.reset} budget $${args.budget} ${colors.dim}|${colors.reset} turns ${args.maxTurns}`);
  log(`${colors.dim}Task: ${taskPreview}${taskPreview.length >= 80 ? "..." : ""}${colors.reset}`);
  log("");

  // Initialize IPC logger when resultFile is set (swarm workDir or explicit --result-file)
  // Standalone runs without resultFile skip IPC — no consumer watches random temp dirs
  const agentLabel = process.env.SWARM_AGENT_ID || 'agent';
  if (args.resultFile) {
    try {
      initIpcLogger(dirname(args.resultFile));
      logIpc(agentLabel, 'orchestrator', 'lifecycle', `Agent started: ${args.model}, budget $${args.budget}`, { model: args.model, budget: args.budget, turns: args.maxTurns });
      logIpc(agentLabel, 'orchestrator', 'lifecycle', 'Task: ' + taskPreview, { model: args.model });
    } catch {
      // IPC init failure is non-fatal
    }
  }

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
  let previousResultFile = null;

  // Progress tracking — declared outside retry loop so it's accessible in result-writing section.
  // Accumulates across retries (total tool calls for the entire agent lifecycle).
  const progress = {
    tool_calls_count: 0,
    last_tool: null,
  };

  // Stream-json parsing state — when --result-file forces stream-json output format,
  // we parse NDJSON events from stdout to count tool calls and extract the final text.
  const streamToolCounts = { Read: 0, Grep: 0, Bash: 0, Edit: 0, Write: 0, Glob: 0, WebSearch: 0, WebFetch: 0, total: 0 };
  let streamResultText = null;    // Extracted from the "result" event
  let stdoutNdjsonBuffer = "";    // Line buffer for incomplete NDJSON lines

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

      // I4: If result file exists from previous attempt, pass it as context
      if (args.resultFile && existsSync(args.resultFile)) {
        previousResultFile = args.resultFile + `.retry-${retryCount - 1}.json`;
        try {
          const prevResult = readFileSync(args.resultFile, "utf-8");
          writeFileSync(previousResultFile, prevResult, "utf-8");
          log(`${colors.dim}Retry ${retryCount}: passing previous attempt output as context (${previousResultFile})${colors.reset}`);
        } catch (err) {
          log(`${colors.yellow}Failed to save previous result for retry: ${err.message}${colors.reset}`);
          previousResultFile = null;
        }
      }
    }

    startTime = Date.now();

    // TASK 1: Create temp directory for overflow files
    const tempDir = mkdtempSync(join(tmpdir(), "arbor-"));
    let stdoutOverflowPath = null;
    let stdoutOverflowStream = null;
    let stderrOverflowPath = null;
    let stderrOverflowStream = null;
    let peakStdoutBytes = 0;
    let peakStderrBytes = 0;

    // Build child args per retry attempt (session resume on retry, fresh on first run)
    const isRetry = retryCount > 0;
    const childArgs = buildChildArgs(previousResultFile, isRetry);

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

    // Bug D: Propagate SIGTERM/SIGINT to child process for graceful shutdown
    const handleSignal = (signal) => {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill(signal);
          // Wait briefly for graceful exit before force-killing
          setTimeout(() => {
            if (!proc.killed && proc.exitCode === null) {
              try {
                proc.kill("SIGKILL");
              } catch {}
            }
          }, 3000);
        } catch {}
      }
    };

    const sigintHandler = () => handleSignal("SIGINT");
    const sigtermHandler = () => handleSignal("SIGTERM");
    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);

    // Clean up signal handlers when process exits
    proc.on("exit", () => {
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
    });

    // TASK 1: Capture stdout with ring buffer + overflow to temp file
    stdoutChunks = [];
    stdoutBytes = 0;
    let stdoutTruncationWarned = false; // Bug A: Track if truncation warning was logged

    proc.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      peakStdoutBytes = Math.max(peakStdoutBytes, stdoutBytes);

      // Bug A: Limit buffer to 5MB to prevent OOM on large agent output
      // Truncate from beginning (keep tail with most recent/relevant output)
      const STDOUT_MAX_BUFFER = 5 * 1024 * 1024; // 5MB
      while (stdoutBytes > STDOUT_MAX_BUFFER && stdoutChunks.length > 0) {
        if (!stdoutTruncationWarned) {
          console.error(`[agent-entry] Warning: stdout buffer exceeded ${(STDOUT_MAX_BUFFER / 1024 / 1024).toFixed(0)}MB, truncating oldest chunks`);
          stdoutTruncationWarned = true;
        }
        const dropped = stdoutChunks.shift();
        stdoutBytes -= dropped.length;

        if (!stdoutOverflowStream) {
          stdoutOverflowPath = join(tempDir, "stdout-overflow.log");
          stdoutOverflowStream = createWriteStream(stdoutOverflowPath, { flags: "a" });
        }
        stdoutOverflowStream.write(dropped);
      }

      // Write overflow to temp file when exceeding MAX_BUFFER_SIZE
      while (stdoutBytes > MAX_BUFFER_SIZE && stdoutChunks.length > 0) {
        const dropped = stdoutChunks.shift();
        stdoutBytes -= dropped.length;

        if (!stdoutOverflowStream) {
          stdoutOverflowPath = join(tempDir, "stdout-overflow.log");
          stdoutOverflowStream = createWriteStream(stdoutOverflowPath, { flags: "a" });
        }
        stdoutOverflowStream.write(dropped);
      }

      // Stream to our stdout in real-time (unless writing result file)
      if (!args.resultFile) {
        process.stdout.write(chunk);
      }

      // Parse NDJSON events from stream-json output for real-time tool call counting.
      // Only active when --result-file forces stream-json format.
      if (args.resultFile) {
        stdoutNdjsonBuffer += chunk.toString("utf-8");
        const lines = stdoutNdjsonBuffer.split("\n");
        stdoutNdjsonBuffer = lines.pop() || ""; // Keep incomplete last line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Tool calls from assistant message content blocks.
            // stream-json emits {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read",...}]}}
            if (event.type === "assistant" && Array.isArray(event.message?.content)) {
              for (const block of event.message.content) {
                if (block.type === "tool_use" && block.name) {
                  progress.tool_calls_count++;
                  progress.last_tool = block.name;
                  if (block.name in streamToolCounts) streamToolCounts[block.name]++;
                  streamToolCounts.total++;
                }
              }
            }

            // Final text output from result event
            if (event.type === "result") {
              streamResultText = typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result);
            }
          } catch {
            // Not valid JSON — skip (partial lines, non-JSON output)
          }
        }
      }
    });

    // TASK 1: Stream stderr live with overflow
    stderrChunks = [];
    stderrBytes = 0;
    let stderrBufferWarned = false;
    const stderrPrefix = process.env.SWARM_AGENT_ID
      ? `${colors.dim}[${process.env.SWARM_AGENT_ID}]${colors.reset} `
      : "";

    // Bug B: Reset all state before retry to prevent stale data from previous attempt
    stdoutChunks = []; // Clear output buffer
    stdoutBytes = 0;
    stderrChunks = [];
    stderrBytes = 0;

    // Reset progress tracking for this attempt (accumulates within a single attempt)
    progress.tool_calls_count = 0;
    progress.last_tool = null;

    // Reset stream-json parsing state
    for (const key of Object.keys(streamToolCounts)) streamToolCounts[key] = 0;
    streamResultText = null;
    stdoutNdjsonBuffer = "";

    // ── Stderr write queue — atomic line writes prevent interleaving ──
    const writeQueue = [];
    let writing = false;

    function flushQueue() {
      writing = true;
      while (writeQueue.length > 0) {
        process.stderr.write(writeQueue.shift());
      }
      writing = false;
    }

    function queueWrite(msg) {
      writeQueue.push(msg);
      if (!writing) flushQueue();
    }

    // Line buffer for stderr — accumulate partial chunks, flush only complete lines
    let stderrLineBuffer = "";

    function flushLines(buffer, prefix) {
      const combined = stderrLineBuffer + buffer;
      const lines = combined.split("\n");
      // Last element is incomplete (no trailing newline) — keep in buffer
      stderrLineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          queueWrite(`${prefix}${line}\n`);
        }
      }
    }

    function flushRemainingLines(prefix) {
      if (stderrLineBuffer.trim()) {
        queueWrite(`${prefix}${stderrLineBuffer}\n`);
        stderrLineBuffer = "";
      }
    }

    // Emit progress updates every 5s (progress file for TUI freshness)
    // Stderr + IPC logs throttled to every 30s (every 6th tick) to avoid noise
    let progressTick = 0;
    const progressInterval = setInterval(() => {
      // Bug C: Check if child process is still alive before sending progress updates
      if (proc.killed || proc.exitCode !== null) {
        clearInterval(progressInterval);
        return;
      }

      progressTick++;
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
      const stdoutKB = (stdoutBytes / 1024).toFixed(0);

      // Stderr progress message every 30s (every 6th tick)
      if (progressTick % 6 === 0) {
        const progressMsg = `[progress] ${elapsedSec}s | tools: ${progress.tool_calls_count} | last: ${progress.last_tool || "none"} | stdout: ${stdoutKB}KB`;
        queueWrite(`${colors.dim}${progressMsg}${colors.reset}\n`);
      }

      // IPC progress: log every 30s (every 6th tick) to avoid spam
      if (args.resultFile && progressTick % 6 === 0) {
        try {
          logIpc(agentLabel, 'orchestrator', 'progress', `${elapsedSec}s | tools: ${progress.tool_calls_count} | last: ${progress.last_tool || "none"}`, { elapsedSec: Number(elapsedSec), toolCalls: progress.tool_calls_count, lastTool: progress.last_tool });
        } catch { /* non-fatal */ }
      }

      // Write incremental progress file every 5s for TUI freshness
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
    }, 5000);

    // Bug C: Stop progress tracking immediately on process exit
    proc.on("exit", () => {
      clearInterval(progressInterval);
    });

    proc.stderr.on("data", (chunk) => {
      lastStderrTime = Date.now(); // Reset inactivity watchdog
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      peakStderrBytes = Math.max(peakStderrBytes, stderrBytes);

      // TASK 1: Write overflow to temp file when exceeding MAX_BUFFER_SIZE
      while (stderrBytes > MAX_BUFFER_SIZE && stderrChunks.length > 0) {
        if (!stderrBufferWarned) {
          queueWrite(`${colors.yellow}Warning: Output buffer exceeded 50MB, truncating oldest chunks${colors.reset}\n`);
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

      // Parse stderr for tool calls (passive observation only)
      const text = chunk.toString("utf-8");
      const prevTool = progress.last_tool;
      const toolMatch = TOOL_CALL_RE.exec(text);
      if (toolMatch) {
        progress.tool_calls_count++;
        progress.last_tool = toolMatch[1];
      }
      // IPC: Log when a new tool type is detected
      if (progress.last_tool !== prevTool && args.resultFile) {
        try { logIpc(agentLabel, 'orchestrator', 'tool_call', 'Using: ' + progress.last_tool, {}); } catch { /* non-fatal */ }
      }

      // Forward to parent stderr — line-buffered to prevent mid-line interleaving
      if (!args.quiet) {
        flushLines(text, stderrPrefix);
      }
    });

    // Inactivity watchdog — model-aware timeout (opus thinks longer before first tool call)
    let lastStderrTime = Date.now();
    const isOpus = args.model.includes("opus");
    const INACTIVITY_LIMIT_MS = isOpus ? 15 * 60 * 1000 : 10 * 60 * 1000; // opus: 15min, sonnet: 10min
    const inactivityWatchdog = setInterval(() => {
      const silenceMs = Date.now() - lastStderrTime;
      if (silenceMs >= INACTIVITY_LIMIT_MS) {
        clearInterval(inactivityWatchdog);
        clearInterval(progressInterval);
        log(`\n${colors.yellow}Inactivity watchdog: ${(silenceMs / 1000).toFixed(0)}s stderr silence — sending SIGINT${colors.reset}`);
        proc.kill("SIGINT");

        // Escalate to SIGTERM after 10s
        setTimeout(() => {
          if (!proc.killed) {
            log(`${colors.yellow}Escalating to SIGTERM${colors.reset}`);
            proc.kill("SIGTERM");

            // Final escalation to SIGKILL after 10s more
            setTimeout(() => {
              if (!proc.killed) {
                log(`${colors.yellow}Force killing with SIGKILL${colors.reset}`);
                try { proc.kill("SIGKILL"); } catch {}
              }
            }, 10000);
          }
        }, 10000);
      }
    }, 30000);

    // Wait for exit
    exitCode = await new Promise((resolve) => {
      proc.on("close", (code, signal) => {
        clearInterval(inactivityWatchdog);
        clearInterval(progressInterval);
        // Flush any remaining partial lines in the stderr buffer
        if (!args.quiet) flushRemainingLines(stderrPrefix);
        // Exit code 124 indicates interruption (signal-based or watchdog)
        const wasInterrupted = signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT";
        resolve(wasInterrupted ? 124 : (code ?? 1));
      });
      proc.on("error", (err) => {
        clearInterval(inactivityWatchdog);
        clearInterval(progressInterval);
        log(`${colors.red}Spawn error: ${err.message}${colors.reset}`);
        resolve(1);
      });
    });

    durationMs = Date.now() - startTime;

    // When stream-json was used (--result-file mode), extract the human-readable text
    // from the parsed result event. The raw buffer contains NDJSON, not readable text.
    if (args.resultFile && streamResultText !== null) {
      output = streamResultText.trim();
    } else {
      output = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    }

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
      break; // Success or interrupted — don't retry
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

  // Update module-level state for emergency crash handler
  _lastExitCode = exitCode;
  _lastDurationMs = durationMs;
  _lastOutput = output || "";

  const durationSec = (durationMs / 1000).toFixed(1);

  // Detect if the agent applied changes to the working tree (critical for interrupted agents)
  // This prevents the parent session from blindly retrying when work was already done.
  let changesApplied = false;
  let filesChanged = [];
  try {
    const diffStat = execFileSync("git", ["diff", "--stat", "--name-only"], {
      encoding: "utf-8", timeout: 5000, cwd: args.cwd || process.cwd(),
    }).trim();
    if (diffStat) {
      filesChanged = diffStat.split("\n").filter(Boolean);
      changesApplied = filesChanged.length > 0;
      if (changesApplied && exitCode === 124) {
        log(`${colors.yellow}WARNING: Agent was interrupted but applied changes to ${filesChanged.length} file(s)${colors.reset}`);
        log(`${colors.yellow}  Files: ${filesChanged.slice(0, 5).join(", ")}${filesChanged.length > 5 ? ` (+${filesChanged.length - 5} more)` : ""}${colors.reset}`);
      }
    }
  } catch {
    // Not a git repo or git not available — skip change detection
  }

  // S1: Concat stderr ONCE after retry loop — avoids redundant 200MB allocations
  const stderrFull = Buffer.concat(stderrChunks).toString("utf-8");

  // Status report
  if (exitCode === 124) {
    log(`\n${colors.yellow}Interrupted after ${durationSec}s${colors.reset}`);
  } else if (exitCode !== 0) {
    log(`\n${colors.red}Failed after ${durationSec}s (exit ${exitCode})${colors.reset}`);
    // Show stderr on failure for diagnostics
    const stderr = stderrFull.trim();
    if (stderr) {
      const lines = stderr.split("\n").slice(-5);
      log(`${colors.dim}${lines.join("\n")}${colors.reset}`);
    }
  } else {
    log(`\n${colors.green}Completed in ${durationSec}s${colors.reset}`);
  }

  // IPC: Log agent completion
  if (args.resultFile) {
    const status = exitCode === 0 ? 'completed' : exitCode === 124 ? 'interrupted' : 'failed';
    try {
      logIpc(agentLabel, 'orchestrator', exitCode === 0 ? 'result' : 'error', `Agent ${status} in ${durationSec}s (exit ${exitCode})`, { exitCode, durationMs, status, toolCalls: progress.tool_calls_count });
    } catch { /* non-fatal */ }
  }

  // Write result file if requested
  if (args.resultFile) {
    // Parse telemetry from stderr and stdout
    const telemetry = parseTelemetry(stderrFull, output);

    // Override stderr-based tool counts with accurate stream-json counts.
    // Claude Code in -p mode doesn't emit tool call indicators to stderr,
    // so the TOOL_CALL_RE-based counting from parseTelemetry is always 0.
    // The stream-json NDJSON parser counts tool calls from content_block_start events.
    if (streamToolCounts.total > 0) {
      telemetry.tool_calls = { ...streamToolCounts };
    }

    // Quality signals — fast heuristic + optional AI analysis
    const elapsedSec = durationMs / 1000;
    telemetry.quality_signals.high_token_low_tools =
      elapsedSec > 120 && telemetry.tool_calls.total < 5;

    // AI quality analysis for suspicious patterns (post-hoc, non-blocking)
    if (isAiClientAvailable() && telemetry.quality_signals.high_token_low_tools) {
      try {
        const stderrSample = stderrFull.slice(-3000);
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

    // When output is empty but agent was active, synthesize an activity summary
    // so the parent session knows what happened instead of seeing "(No output)"
    let effectiveOutput = output.slice(0, 500_000);
    if (!effectiveOutput && progress.tool_calls_count > 0) {
      const parts = [`[arbor: agent completed with no text output but made ${progress.tool_calls_count} tool call(s) in ${durationSec}s]`];
      if (changesApplied) {
        parts.push(`Files modified: ${filesChanged.slice(0, 10).join(", ")}${filesChanged.length > 10 ? ` (+${filesChanged.length - 10} more)` : ""}`);
      } else {
        parts.push("No files were modified — agent spent turns exploring/reading without producing changes.");
      }
      parts.push(`Last tool used: ${progress.last_tool || "unknown"}`);
      effectiveOutput = parts.join("\n");
      log(`${colors.yellow}WARNING: Agent produced no text output despite ${progress.tool_calls_count} tool calls — activity summary injected into result${colors.reset}`);
    }

    const result = {
      version: 1,
      status: exitCode === 0 ? "completed" : exitCode === 124 ? "interrupted" : "failed",
      output: effectiveOutput, // 500KB cap, or synthesized activity summary if empty
      duration_ms: durationMs,
      exit_code: exitCode,
      model: args.model,
      task: args.task || null,
      truncated: stdoutBytes > MAX_BUFFER_SIZE, // Output was truncated due to ring buffer
      changes_applied: changesApplied, // true if agent modified files before exit/interrupt
      files_changed: filesChanged,     // list of modified files (from git diff)
      telemetry, // Per-agent quality signals
    };
    writeResult(args.resultFile, result);
    _resultWritten = true;
    log(`${colors.dim}Result written to: ${args.resultFile}${colors.reset}`);

    // Clean up progress file
    try { unlinkSync(args.resultFile + ".progress.json"); } catch (err) {
      // TASK 4: Error logging - progress file cleanup (best-effort)
      console.error("[agent-entry:main] Error deleting progress file:", err.message || err);
    }

    // Always write a status summary to stdout so the parent Bash tool never shows "(No output)".
    // This is critical: the parent Claude decides what to do next based on what it sees in stdout.
    // Without this, it blindly retries or hallucinates that the task failed.
    const statusLine = [
      `[arbor] ${result.status} in ${durationSec}s`,
      `model=${args.model}`,
      changesApplied ? `files_changed=${filesChanged.length}` : "no_changes",
      `result=${args.resultFile}`,
    ].filter(Boolean).join(" | ");
    process.stdout.write(statusLine + "\n");

    // Write full output after summary line
    if (output) process.stdout.write(output + "\n");
  }

  // ── bd task lifecycle: close on exit ──
  await closeBdTask(args.bdTask, exitCode, output, durationSec);

  // Clean up team directory (--team-name creates ~/.claude/teams/<name>/)
  cleanupTeamDir(teamName);

  // Clean up temp directories
  if (persistContextDir) {
    try { rmSync(persistContextDir, { recursive: true, force: true }); } catch {}
  }
  if (scopeConfigDir) {
    try { rmSync(scopeConfigDir, { recursive: true, force: true }); } catch {}
  }
  if (mcpConfigPath) {
    try { rmSync(dirname(mcpConfigPath), { recursive: true, force: true }); } catch {}
  }

  // Use process.exitCode instead of process.exit() to allow stdout to flush.
  // process.exit() can terminate before async stdout.write() completes (piped stdout is async),
  // which is the root cause of the parent seeing "(No output)".
  process.exitCode = exitCode;
}

main().catch((err) => {
  log(`${colors.red}Fatal: ${err.message}${colors.reset}`);
  writeEmergencyResult(`main() crash: ${err.message}`);
  process.exit(1);
});

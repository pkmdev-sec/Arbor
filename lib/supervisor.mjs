/**
 * lib/supervisor.mjs — Extracted testable logic from agent-entry.mjs
 *
 * Functions:
 *   buildClaudeArgs(config) — CLI argument construction for claude subprocess
 *   classifyError(error)    — error classification logic (transient/permanent/ambiguous)
 *   parseClaudeOutput(opts) — result extraction from claude subprocess output
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextToSystemPrompt } from "./context-bridge.mjs";
import { filterSystemPromptForRole, filteringStats } from "./context-filter.mjs";
import { ROLE_PROMPTS, ROLE_DISALLOWED_TOOLS, DECOMPOSER_OUTPUT_SCHEMA } from "./config.mjs";

/**
 * Auto-generate role-appropriate prefill text.
 * Skips the "let me think about what to do" phase, saving 1-3 turns per agent.
 *
 * @param {string|null} role
 * @returns {string|null}
 */
export function autoGeneratePrefill(role) {
  switch (role) {
    case "worker":
      return "I'll start by reading the relevant files to understand the current code, then make the requested changes.\n\n";
    case "decomposer":
      return "I'll analyze the task scope and produce a JSON decomposition.\n\n";
    case "verifier":
      return null;
    default:
      return "I'll examine the relevant code, then produce concrete output (write files, generate content, or provide a clear text response). I will NOT spend all my turns just reading — I'll act on what I find.\n\n";
  }
}

/**
 * Build CLI arguments for spawning a claude subprocess.
 *
 * @param {Object} config
 * @param {string} config.cliJsPath        — resolved path to cli.js
 * @param {string} config.teamName         — team name for nesting guard bypass
 * @param {string} config.agentId          — agent identifier
 * @param {string} config.model            — resolved model string
 * @param {number} config.maxTurns         — max conversation turns
 * @param {number} config.budget           — max budget in USD
 * @param {string|null} config.resultFile  — path to write result JSON
 * @param {string} config.outputFormat     — output format (text, json, stream-json)
 * @param {string|null} config.role        — agent role (worker, decomposer, verifier)
 * @param {string|null} config.effort      — effort level
 * @param {string|null} config.fallbackModel — fallback model for overload
 * @param {boolean} config.debug           — debug mode
 * @param {string|null} config.task        — task text
 * @param {string|null} config.contextFile — context file path
 * @param {string|null} config.systemPrompt — additional system prompt
 * @param {string|null} config.prefill     — explicit prefill text
 * @param {boolean} config.canResume       — whether session resume is possible
 * @param {string} config.sessionUUID      — session UUID for resume
 * @param {string|null} config.mcpConfigPath — MCP config path
 * @param {string|null} config.persistContextDir — persistence directory
 * @param {boolean} config.isRetry         — whether this is a retry attempt
 * @param {string|null} config.previousResultFile — result file from previous attempt
 * @param {Object} config.env              — environment object (for debug dir mutation)
 * @returns {string[]} CLI argument array for child process
 */
export function buildClaudeArgs(config) {
  const {
    cliJsPath, teamName, agentId, model, maxTurns, budget,
    resultFile, outputFormat, role, effort, fallbackModel, debug,
    task, contextFile, systemPrompt, prefill, canResume, sessionUUID,
    mcpConfigPath, persistContextDir, isRetry, previousResultFile, env,
  } = config;

  const childArgs = [
    cliJsPath,
    "--team-name", teamName,
    "--agent-id", agentId,
    "--agent-name", "arbor",
    "-p",
    "--model", model,
    "--permission-mode", "dontAsk",
    "--dangerously-skip-permissions",
    "--max-turns", String(maxTurns),
    "--max-budget-usd", String(budget),
    "--output-format", resultFile ? "stream-json" : outputFormat,
  ];

  // stream-json requires --verbose when used with --print
  if (resultFile) {
    childArgs.push("--verbose");
  }

  // Session persistence
  if (!canResume) {
    childArgs.push("--no-session-persistence");
  }

  // Session resume on retry
  if (isRetry && canResume) {
    childArgs.push("--resume", sessionUUID, "--fork-session");
  } else if (canResume) {
    childArgs.push("--session-id", sessionUUID);
  }

  // Native effort level passthrough
  if (effort) {
    childArgs.push("--effort", effort);
  }

  // Native fallback model for overload handling
  if (fallbackModel) {
    childArgs.push("--fallback-model", fallbackModel);
  }

  // Debug passthrough
  if (debug || process.env.SWARM_DEBUG || process.env.DEBUG) {
    childArgs.push("--debug");
    if (env) {
      env.CLAUDE_CODE_DEBUG_LOGS_DIR = join(tmpdir(), `arbor-debug-${agentId}`);
    }
  }

  // Settings isolation
  childArgs.push("--setting-sources", "user");

  // Decomposer JSON schema enforcement
  if (role === "decomposer") {
    childArgs.push("--json-schema", JSON.stringify(DECOMPOSER_OUTPUT_SCHEMA));
  }

  // Built-in verifier agent
  if (role === "verifier") {
    childArgs.push("--agent", "verifier");
  }

  // Tool restriction per role
  if (role && ROLE_DISALLOWED_TOOLS[role]) {
    childArgs.push("--disallowed-tools", ...ROLE_DISALLOWED_TOOLS[role].split(" "));
  }

  // Prefill: pre-fill assistant's first response
  if (!isRetry) {
    const effectivePrefill = prefill || autoGeneratePrefill(role);
    if (effectivePrefill) {
      childArgs.push("--prefill", effectivePrefill);
    }
  }

  // MCP coordination server
  if (mcpConfigPath) {
    childArgs.push("--mcp-config", mcpConfigPath);
  }

  // Context persistence directory
  if (persistContextDir) {
    childArgs.push("--add-dir", persistContextDir);
  }

  // Context bridge: role prompts + context file → system prompt
  const systemParts = [];
  if (!isRetry) {
    if (!persistContextDir && role !== "verifier") {
      if (role && ROLE_PROMPTS[role]) {
        systemParts.push(ROLE_PROMPTS[role]);
      }
    }
    if (!persistContextDir && contextFile) {
      const { prompt: ctxPrompt, error: ctxError } = contextToSystemPrompt(contextFile);
      if (ctxPrompt) {
        systemParts.push(ctxPrompt);
      } else if (ctxError) {
        throw new Error("Context file is required but failed to load");
      }
    }
  }

  // Inject previous attempt output as context (non-resume fallback)
  if (!isRetry && previousResultFile && existsSync(previousResultFile)) {
    const { prompt: prevPrompt } = contextToSystemPrompt(previousResultFile);
    if (prevPrompt) {
      systemParts.push("[Previous Attempt Output - use as reference, do not repeat failures]\n\n" + prevPrompt);
    }
  }

  if (systemPrompt) {
    systemParts.push(systemPrompt);
  }

  if (systemParts.length > 0) {
    let assembledPrompt = systemParts.join("\n\n");
    // Semantic context filtering per role
    if (role) {
      const original = assembledPrompt;
      assembledPrompt = filterSystemPromptForRole(assembledPrompt, role);
      // Note: caller can check filteringStats if needed for logging
    }
    childArgs.push("--append-system-prompt", assembledPrompt);
  }

  // Task goes last
  if (task && !isRetry) {
    if (persistContextDir || mcpConfigPath) {
      childArgs.push("--", task);
    } else {
      childArgs.push(task);
    }
  }

  return childArgs;
}

// ── Error classification ──────────────────────────────────────────

/**
 * Error taxonomy for agent subprocess failures.
 * Used as the system prompt for AI-powered classification.
 */
export const ERROR_TAXONOMY = [
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
].join("\n");

/**
 * Build the prompt for error classification.
 *
 * @param {number} exitCode
 * @param {string} stderrTail — last ~2K of stderr
 * @returns {string}
 */
export function buildClassifyErrorPrompt(exitCode, stderrTail) {
  return `Agent failed with exit code ${exitCode}.\n\nLast 2K of stderr:\n${stderrTail}\n\nClassify this error.`;
}

/**
 * Classify an error based on AI analysis result.
 * Returns whether to retry.
 *
 * @param {Object} classification — parsed AI response { type, reason }
 * @returns {{ shouldRetry: boolean, type: string, reason: string }}
 */
export function classifyError(classification) {
  if (!classification || !classification.type) {
    return { shouldRetry: true, type: "unknown", reason: "classification failed" };
  }

  if (classification.type === "permanent") {
    return { shouldRetry: false, type: "permanent", reason: classification.reason || "unknown" };
  }

  return {
    shouldRetry: true,
    type: classification.type,
    reason: classification.reason || "",
  };
}

// ── Output parsing ────────────────────────────────────────────────

/**
 * Parse output from claude subprocess.
 *
 * @param {Object} opts
 * @param {boolean} opts.hasResultFile      — whether --result-file was used (stream-json mode)
 * @param {string|null} opts.streamResultText — text extracted from stream-json result event
 * @param {Buffer[]} opts.stdoutChunks      — raw stdout chunks
 * @returns {string} parsed output text
 */
export function parseClaudeOutput({ hasResultFile, streamResultText, stdoutChunks }) {
  if (hasResultFile && streamResultText !== null && streamResultText !== undefined) {
    return (streamResultText || "").trim();
  }
  return (Buffer.concat(stdoutChunks).toString("utf-8") || "").trim();
}

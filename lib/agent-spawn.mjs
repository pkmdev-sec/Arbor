/**
 * Agent subprocess spawning — used by swarm to launch arbor workers
 *
 * Extracted from swarm.mjs.pre-refactor: spawnAgent() (~lines 102-147)
 *
 * NOTE: The CLI subprocess spawn in agent-entry.mjs main() is NOT extracted here
 * because it is deeply interleaved with the retry loop, progress tracking,
 * and buffer management.
 *
 * Catch blocks: 0 total, 0 fixed (no try/catch blocks in this file)
 */

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { colors, log } from "./output.mjs";
import { AgentRegistry } from "./ipc/registry.mjs";
import { RingBuffer } from "./buffer.mjs";

// Path to arbor entry point (used by swarm to spawn agents)
const __dir = dirname(new URL(import.meta.url).pathname);
export const RA_BIN = join(__dir, "..", "agent-entry.mjs");

// IPC registry for tracking spawned agents (optional, non-blocking)
let ipcRegistry = null;
const _activeProcesses = new Set();

/**
 * Initialize IPC registry for agent tracking
 * Called by orchestrator if IPC is enabled
 */
export function initIPCRegistry(registry) {
  ipcRegistry = registry;
}

// From swarm spawnAgent() (lines ~102-147 of pre-refactor)
// This spawns an arbor subprocess
// Note: `quiet` parameter added to replace swarm's module-level quietMode check.
// Callers pass their quiet state; defaults to false (matching original default).
// Bug E: Added timeout parameter (optional, default: no timeout)
export function spawnAgent({ task, role, model, turns, budget, resultFile, contextFile, systemPrompt, bdTask, agentId, cwd, quiet = false, ipcSocket = null, effort = null, fallbackModel = null, scope = null, timeout = null, env: extraEnv = null, signal = null }) {
  return new Promise((resolve) => {
    let timeoutHandle = null;
    const args = [RA_BIN];
    if (role) args.push("--role", role);
    args.push("-m", model || "sonnet");
    args.push("--turns", String(turns || 25));
    args.push("-b", String(budget || 15));
    if (effort) args.push("--effort", effort);
    if (fallbackModel) args.push("--fallback-model", fallbackModel);
    if (scope) args.push("--scope", Array.isArray(scope) ? scope.join(",") : scope);
    // Don't pass -q — let agent stream stderr for live logs
    if (resultFile) args.push("--result-file", resultFile);
    if (contextFile) args.push("--context-file", contextFile);
    if (bdTask) args.push("--bd-task", bdTask);
    if (systemPrompt) args.push("-s", systemPrompt);
    args.push(task);

    // Pass agent ID via env so agent-entry.mjs can prefix its live output
    const childEnv = { ...process.env, ...(extraEnv || {}) };
    if (agentId) childEnv.SWARM_AGENT_ID = agentId;

    // QW1: Non-essential traffic suppression
    childEnv.DISABLE_TELEMETRY = '1';
    childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    childEnv.DISABLE_ERROR_REPORTING = '1';
    childEnv.DISABLE_AUTOUPDATER = '1';
    childEnv.DISABLE_COST_WARNINGS = '1';
    childEnv.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = '1';
    childEnv.DISABLE_INSTALLATION_CHECKS = '1';
    childEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    childEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';

    // QW2: Adaptive compaction threshold
    const turnsValue = turns || 25;
    childEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = turnsValue <= 25 ? '95' : '85';

    // QW3: Small model for internal calls
    childEnv.ANTHROPIC_SMALL_FAST_MODEL = 'claude-haiku-4-5-20251001';

    // IPC integration: pass socket path if provided
    if (ipcSocket) {
      childEnv.CLAUDE_IPC_SOCKET = ipcSocket;
    }

    // Progress IPC: pass directory to child agents for tool event reporting
    if (process.env.ARBOR_PROGRESS_IPC_DIR) {
      childEnv.ARBOR_PROGRESS_IPC_DIR = process.env.ARBOR_PROGRESS_IPC_DIR;
    }

    // Register agent in IPC registry (non-blocking, best-effort)
    if (ipcRegistry && agentId) {
      try {
        ipcRegistry.register(agentId, {
          model: model || "sonnet",
          scope: [],
          role: role || "worker",
          turns: turns || 25,
        });
      } catch (err) {
        // IPC registration failure is non-fatal
        console.error(`[agent-spawn] IPC registry failed for ${agentId}: ${err.message}`);
      }
    }

    const start = Date.now();
    const proc = spawn("node", args, {
      env: childEnv,
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    _activeProcesses.add(proc);

    if (signal) {
      const onAbort = () => {
        if (!proc.killed && proc.exitCode === null) {
          try {
            proc.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            if (!proc.killed && proc.exitCode === null) {
              try {
                proc.kill("SIGKILL");
              } catch {}
            }
          }, 3000);
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

    // Bug E: Set up timeout to kill agent if it hangs
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (!proc.killed && proc.exitCode === null) {
          console.error(`[agent-spawn] Agent ${agentId} timed out after ${timeout}ms, killing process`);
          try {
            proc.kill("SIGTERM");
            // Escalate to SIGKILL after 3s
            setTimeout(() => {
              if (!proc.killed && proc.exitCode === null) {
                try { proc.kill("SIGKILL"); } catch {}
              }
            }, 3000);
          } catch {}
        }
      }, timeout);
    }

    const buffer = new RingBuffer({ maxSize: 10 * 1024 * 1024 });
    proc.stdout.on("data", (c) => buffer.write(c));

    // Stream stderr live to parent (agent-entry.mjs already prefixes with agent ID)
    proc.stderr.on("data", (chunk) => {
      if (!quiet) process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      _activeProcesses.delete(proc);
      // Bug E: Clear timeout handle when process exits
      if (timeoutHandle) clearTimeout(timeoutHandle);

      // Deregister agent from IPC registry (non-blocking, best-effort)
      if (ipcRegistry && agentId) {
        try {
          ipcRegistry.deregister(agentId);
        } catch (err) {
          // Deregistration failure is non-fatal
          console.error(`[agent-spawn] IPC deregister failed for ${agentId}: ${err.message}`);
        }
      }

      // Bug E: Check if timeout was reached (exitCode will be null or signal-based)
      const timedOut = timeout && (Date.now() - start) >= timeout;
      try {
        buffer.destroy();
      } catch {}
      resolve({
        output: timedOut ? `Agent timed out after ${timeout}ms` : buffer.toString("utf-8").trim(),
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Date.now() - start,
      });
    });
    proc.on("error", (err) => {
      _activeProcesses.delete(proc);
      // Bug E: Clear timeout handle on spawn error
      if (timeoutHandle) clearTimeout(timeoutHandle);

      // Bug F: Clean up IPC registry entry on spawn failure
      if (ipcRegistry && agentId) {
        try {
          ipcRegistry.deregister(agentId);
        } catch (cleanupErr) {
          console.error(`[agent-spawn] IPC cleanup after spawn error failed for ${agentId}: ${cleanupErr.message}`);
        }
      }

      resolve({ output: err.message, exitCode: 1, durationMs: Date.now() - start, spawnError: true });
    });
  });
}

export function killAllAgents() {
  for (const proc of _activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const proc of _activeProcesses) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }, 3000);
}

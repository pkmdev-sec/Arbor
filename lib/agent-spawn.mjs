/**
 * Agent subprocess spawning — used by swarm to launch remote-agent workers
 *
 * Extracted from swarm.mjs.pre-refactor: spawnAgent() (~lines 102-147)
 *
 * NOTE: The CLI subprocess spawn in agent-entry.mjs main() is NOT extracted here
 * because it is deeply interleaved with the retry loop, progress tracking,
 * and buffer management.
 */

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { colors, log } from "./output.mjs";

// Path to remote-agent entry point (used by swarm to spawn agents)
const __dir = dirname(new URL(import.meta.url).pathname);
export const RA_BIN = join(__dir, "..", "agent-entry.mjs");

// From swarm spawnAgent() (lines ~102-147 of pre-refactor)
// This spawns a remote-agent subprocess
// Note: `quiet` parameter added to replace swarm's module-level quietMode check.
// Callers pass their quiet state; defaults to false (matching original default).
export function spawnAgent({ task, role, model, turns, budget, timeout, resultFile, contextFile, systemPrompt, bdTask, agentId, cwd, quiet = false }) {
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
      if (!quiet) process.stderr.write(chunk);
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

/**
 * Lifecycle management — bd task tracking and directory cleanup
 *
 * Extracted from:
 *   - agent-entry.mjs.pre-refactor: bd claim (~lines 496-504), bd close (~lines 743-762),
 *     team dir cleanup (~lines 764-771)
 *   - swarm.mjs.pre-refactor: cleanOldRuns() (~lines 564-592)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { colors, log } from "./output.mjs";

// From agent-entry main() — bd task claim (around line ~496-504 of pre-refactor)
export async function claimBdTask(bdTaskId) {
  if (!bdTaskId) return;
  try {
    execFileSync("bd", ["update", bdTaskId, "--claim"], { timeout: 5000 });
    log(`${colors.dim}bd: claimed ${bdTaskId}${colors.reset}`);
  } catch (err) {
    process.stderr.write(`${colors.yellow}Warning: Failed to claim bd task ${bdTaskId}: ${err.message}${colors.reset}\n`);
  }
}

// From agent-entry main() — bd task close (around lines ~743-762 of pre-refactor)
export async function closeBdTask(bdTaskId, exitCode, output, durationSec) {
  if (!bdTaskId) return;
  try {
    const reason = exitCode === 0
      ? `completed: ${(output || "done").slice(0, 100)}`
      : exitCode === 124
      ? `timeout after ${durationSec}s`
      : `failed with exit ${exitCode}`;
    if (exitCode === 0) {
      execFileSync("bd", ["close", bdTaskId, "--reason", reason], { timeout: 5000 });
      log(`${colors.dim}bd: closed ${bdTaskId}${colors.reset}`);
    } else {
      // Don't close on failure — leave in_progress for retry
      log(`${colors.dim}bd: ${bdTaskId} left in_progress (exit ${exitCode})${colors.reset}`);
    }
  } catch (err) {
    process.stderr.write(`${colors.yellow}Warning: Failed to close bd task ${bdTaskId}: ${err.message}${colors.reset}\n`);
  }
}

// From agent-entry main() — team directory cleanup (around lines ~764-771 of pre-refactor)
export function cleanupTeamDir(teamName) {
  try {
    const teamDir = join(process.env.HOME, ".claude", "teams", teamName);
    rmSync(teamDir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`${colors.yellow}Warning: Failed to clean up team directory: ${err.message}${colors.reset}\n`);
  }
}

// From swarm cleanOldRuns() (around lines ~564-592 of pre-refactor)
export function cleanOldRuns(swarmBase) {
  try {
    const ttlHours = Number(process.env.SWARM_TTL_HOURS) || 24;
    const ttlMs = ttlHours * 60 * 60 * 1000;
    const now = Date.now();

    if (!existsSync(swarmBase)) return;

    const dirs = readdirSync(swarmBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .slice(0, 50);  // Cap to first 50

    let cleaned = 0;
    for (const dir of dirs) {
      try {
        const dirPath = join(swarmBase, dir.name);
        const stats = statSync(dirPath);
        if (now - stats.mtimeMs > ttlMs) {
          rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {} // Silent per-dir failure
    }

    if (cleaned > 0) {
      process.stderr.write(`swarm: cleaned ${cleaned} old run dirs (>${ttlHours}h)\n`);
    }
  } catch {} // Silent global failure
}

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

// Track registered cleanup handlers for all exit paths
const cleanupHandlers = new Set();
let cleanupRegistered = false;

/**
 * Register a cleanup handler to be called on all exit paths
 *
 * @param {Function} handler - Cleanup function to register
 */
export function registerCleanupHandler(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("Cleanup handler must be a function");
  }
  cleanupHandlers.add(handler);
  ensureCleanupHooks();
}

/**
 * Unregister a cleanup handler
 *
 * @param {Function} handler - Cleanup function to unregister
 */
export function unregisterCleanupHandler(handler) {
  cleanupHandlers.delete(handler);
}

/**
 * Execute all registered cleanup handlers
 * Called automatically on process exit, but can be called manually if needed
 */
export async function executeCleanup() {
  const handlers = Array.from(cleanupHandlers);

  for (const handler of handlers) {
    try {
      await handler();
    } catch (err) {
      // Log but don't throw - we want all cleanup handlers to run
      process.stderr.write(
        `${colors.yellow}Warning: Cleanup handler failed: ${err.message}${colors.reset}\n`
      );
    }
  }

  cleanupHandlers.clear();
}

/**
 * Ensure cleanup hooks are registered for all exit paths
 * Called automatically when first cleanup handler is registered
 */
function ensureCleanupHooks() {
  if (cleanupRegistered) return;

  // Normal exit
  process.on("exit", () => {
    // Synchronous cleanup only in exit handler
    const handlers = Array.from(cleanupHandlers);
    for (const handler of handlers) {
      try {
        handler();
      } catch (err) {
        process.stderr.write(`Cleanup error: ${err.message}\n`);
      }
    }
  });

  // SIGINT (Ctrl+C)
  process.on("SIGINT", async () => {
    try {
      await executeCleanup();
    } catch (err) {
      process.stderr.write(`Cleanup error on SIGINT: ${err.message}\n`);
    } finally {
      process.exit(130); // Standard exit code for SIGINT
    }
  });

  // SIGTERM
  process.on("SIGTERM", async () => {
    try {
      await executeCleanup();
    } catch (err) {
      process.stderr.write(`Cleanup error on SIGTERM: ${err.message}\n`);
    } finally {
      process.exit(143); // Standard exit code for SIGTERM
    }
  });

  // Uncaught exceptions
  process.on("uncaughtException", async (err) => {
    process.stderr.write(`${colors.red}Uncaught exception: ${err.message}${colors.reset}\n`);
    process.stderr.write(`${err.stack}\n`);
    try {
      await executeCleanup();
    } catch (cleanupErr) {
      process.stderr.write(`Cleanup error: ${cleanupErr.message}\n`);
    } finally {
      process.exit(1);
    }
  });

  // Unhandled promise rejections
  process.on("unhandledRejection", async (reason, promise) => {
    process.stderr.write(
      `${colors.red}Unhandled rejection: ${reason}${colors.reset}\n`
    );
    try {
      await executeCleanup();
    } catch (err) {
      process.stderr.write(`Cleanup error: ${err.message}\n`);
    } finally {
      process.exit(1);
    }
  });

  cleanupRegistered = true;
}

// From agent-entry main() — bd task claim (around line ~496-504 of pre-refactor)
export async function claimBdTask(bdTaskId) {
  if (!bdTaskId) return;

  try {
    execFileSync("bd", ["update", bdTaskId, "--claim"], { timeout: 5000 });
    log(`${colors.dim}bd: claimed ${bdTaskId}${colors.reset}`);
  } catch (err) {
    // Specific error handling for common cases
    if (err.code === "ENOENT") {
      process.stderr.write(
        `${colors.yellow}Warning: 'bd' command not found - task tracking unavailable${colors.reset}\n`
      );
    } else if (err.killed && err.signal === "SIGTERM") {
      process.stderr.write(
        `${colors.yellow}Warning: bd claim timed out for ${bdTaskId}${colors.reset}\n`
      );
    } else {
      process.stderr.write(
        `${colors.yellow}Warning: Failed to claim bd task ${bdTaskId}: ${err.message}${colors.reset}\n`
      );
    }
  }
}

// From agent-entry main() — bd task close (around lines ~743-762 of pre-refactor)
export async function closeBdTask(bdTaskId, exitCode, output, durationSec) {
  if (!bdTaskId) return;

  try {
    const reason = exitCode === 0
      ? `completed: ${(output || "done").slice(0, 100)}`
      : exitCode === 124
      ? `interrupted after ${durationSec}s`
      : `failed with exit ${exitCode}`;

    if (exitCode === 0) {
      execFileSync("bd", ["close", bdTaskId, "--reason", reason], { timeout: 5000 });
      log(`${colors.dim}bd: closed ${bdTaskId}${colors.reset}`);
    } else {
      // Don't close on failure — leave in_progress for retry
      log(`${colors.dim}bd: ${bdTaskId} left in_progress (exit ${exitCode})${colors.reset}`);
    }
  } catch (err) {
    // Specific error handling
    if (err.code === "ENOENT") {
      // bd not installed - already warned in claimBdTask
      return;
    } else if (err.killed && err.signal === "SIGTERM") {
      process.stderr.write(
        `${colors.yellow}Warning: bd close timed out for ${bdTaskId}${colors.reset}\n`
      );
    } else {
      process.stderr.write(
        `${colors.yellow}Warning: Failed to close bd task ${bdTaskId}: ${err.message}${colors.reset}\n`
      );
    }
  }
}

// From agent-entry main() — team directory cleanup (around lines ~764-771 of pre-refactor)
export function cleanupTeamDir(teamName) {
  if (!teamName) {
    // Silent early return - env var not set yet during startup
    return;
  }

  try {
    const homeDir = process.env.HOME;
    if (!homeDir) {
      process.stderr.write(
        `${colors.yellow}Warning: HOME environment variable not set - cannot cleanup team directory${colors.reset}\n`
      );
      return;
    }

    const teamDir = join(homeDir, ".claude", "teams", teamName);

    if (!existsSync(teamDir)) {
      // Directory doesn't exist - nothing to clean
      return;
    }

    rmSync(teamDir, { recursive: true, force: true });
    log(`${colors.dim}Cleaned up team directory: ${teamName}${colors.reset}`);
  } catch (err) {
    // Specific error messages for common issues
    if (err.code === "EACCES") {
      process.stderr.write(
        `${colors.yellow}Warning: Permission denied cleaning team directory ${teamName}${colors.reset}\n`
      );
    } else if (err.code === "EBUSY") {
      process.stderr.write(
        `${colors.yellow}Warning: Team directory ${teamName} is busy and cannot be removed${colors.reset}\n`
      );
    } else {
      process.stderr.write(
        `${colors.yellow}Warning: Failed to clean up team directory ${teamName}: ${err.message}${colors.reset}\n`
      );
    }
  }
}

// From swarm cleanOldRuns() (around lines ~564-592 of pre-refactor)
export function cleanOldRuns(swarmBase) {
  if (!swarmBase) {
    process.stderr.write(
      `${colors.yellow}Warning: No swarm base directory provided for cleanup${colors.reset}\n`
    );
    return;
  }

  try {
    const ttlHours = Number(process.env.SWARM_TTL_HOURS) || 24;

    if (isNaN(ttlHours) || ttlHours <= 0) {
      process.stderr.write(
        `${colors.yellow}Warning: Invalid SWARM_TTL_HOURS=${process.env.SWARM_TTL_HOURS}, using default 24h${colors.reset}\n`
      );
    }

    const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
    const now = Date.now();

    if (!existsSync(swarmBase)) {
      // Base directory doesn't exist - nothing to clean
      return;
    }

    const dirs = readdirSync(swarmBase, { withFileTypes: true })
      .filter(d => d.isDirectory());

    let cleaned = 0;
    let errors = 0;

    for (const dir of dirs) {
      try {
        const dirPath = join(swarmBase, dir.name);
        const stats = statSync(dirPath);

        if (now - stats.mtimeMs > ttlMs) {
          rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch (err) {
        // Count errors but continue with other directories
        errors++;
        if (process.env.DEBUG) {
          process.stderr.write(
            `${colors.dim}Debug: Failed to clean ${dir.name}: ${err.message}${colors.reset}\n`
          );
        }
      }
    }

    if (cleaned > 0) {
      process.stderr.write(`swarm: cleaned ${cleaned} old run dirs (>${ttlHours}h)\n`);
    }

    if (errors > 0 && process.env.DEBUG) {
      process.stderr.write(
        `${colors.yellow}swarm: ${errors} cleanup errors (enable DEBUG for details)${colors.reset}\n`
      );
    }
  } catch (err) {
    // Top-level error - log but don't throw
    if (err.code === "EACCES") {
      process.stderr.write(
        `${colors.yellow}Warning: Permission denied accessing swarm directory ${swarmBase}${colors.reset}\n`
      );
    } else {
      process.stderr.write(
        `${colors.yellow}Warning: Failed to clean old runs from ${swarmBase}: ${err.message}${colors.reset}\n`
      );
    }
  }
}

/**
 * lib/mode-selector.mjs — Mode selection logic extracted from swarm.mjs
 *
 * Functions:
 *   selectMode(task, flags)             — pick execution mode based on task + flags
 *   validateModeForTask(mode, taskCount) — validate mode is appropriate
 *   shouldVerifyMode(mode, verifyFlag)  — determine if verification is needed
 */

import { autoMode } from "./orchestration.mjs";
import { DEPTH } from "./config.mjs";

/**
 * Valid execution modes for the swarm orchestrator.
 */
export const VALID_MODES = new Set([
  "single", "parallel", "pipeline", "swarm",
  "hierarchical", "review", "fork-merge",
]);

/**
 * Modes that trigger automatic verification.
 */
const AUTO_VERIFY_MODES = new Set([
  "swarm", "pipeline", "review", "hierarchical", "fork-merge",
]);

/**
 * Select the execution mode for a task.
 *
 * When mode is "auto", delegates to AI-powered or regex-based autoMode.
 * Otherwise validates and returns the explicit mode.
 *
 * @param {string} task — the task text
 * @param {Object} flags
 * @param {string} flags.mode — "auto" or explicit mode name
 * @param {boolean} [flags.smartRoute=false] — enable AI-powered mode classification
 * @returns {Promise<string>} selected mode name
 */
export async function selectMode(task, flags) {
  const { mode, smartRoute = false } = flags;

  if (mode === "auto") {
    return autoMode(task, { smartRoute });
  }

  // Validate explicit mode
  if (!VALID_MODES.has(mode)) {
    return "single"; // Safe fallback
  }

  return mode;
}

/**
 * Validate that a mode is appropriate for the given task context.
 *
 * @param {string} mode — selected mode
 * @param {number} taskCount — number of subtasks (1 for single task)
 * @returns {{ valid: boolean, warnings: string[] }}
 */
export function validateModeForTask(mode, taskCount) {
  const warnings = [];

  if (!VALID_MODES.has(mode)) {
    return { valid: false, warnings: [`Unknown mode: ${mode}`] };
  }

  // Single mode with many tasks is wasteful
  if (mode === "single" && taskCount > 3) {
    warnings.push(`Single mode with ${taskCount} tasks — consider parallel or swarm mode`);
  }

  // Hierarchical mode with very few tasks is overkill
  if (mode === "hierarchical" && taskCount <= 2) {
    warnings.push("Hierarchical mode with few tasks — consider single or parallel mode");
  }

  // Fork-merge needs at least 2 tasks to be meaningful
  if (mode === "fork-merge" && taskCount < 1) {
    warnings.push("Fork-merge mode requires a task");
  }

  return { valid: true, warnings };
}

/**
 * Determine whether verification should run for the given mode.
 *
 * @param {string} mode — execution mode
 * @param {boolean|null} verifyFlag — explicit --verify flag (null = auto-decide)
 * @returns {boolean}
 */
export function shouldVerifyMode(mode, verifyFlag) {
  if (verifyFlag !== null && verifyFlag !== undefined) {
    return verifyFlag;
  }
  return AUTO_VERIFY_MODES.has(mode);
}

/**
 * Resolve and validate depth preset.
 *
 * @param {string} depthInput — depth key from CLI
 * @returns {string} validated depth key
 */
export function resolveDepth(depthInput) {
  return DEPTH[depthInput] ? depthInput : "normal";
}

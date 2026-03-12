/**
 * lib/progress.mjs — Progress tracking for agent subprocess
 *
 * Extracted from agent-entry.mjs for independent testability.
 * Manages progress file writes and tool-call accumulation.
 */

import { writeFileSync, unlinkSync } from "node:fs";

/**
 * Create a progress tracker for an agent.
 *
 * @param {string} agentId  — agent identifier (for logging)
 * @param {string|null} resultFile — path to the result file (progress file derived from it)
 * @returns {Object} tracker state object
 */
export function createProgressTracker(agentId, resultFile) {
  return {
    agentId,
    resultFile,
    progressFile: resultFile ? resultFile + ".progress.json" : null,
    tool_calls_count: 0,
    last_tool: null,
    startTime: Date.now(),
  };
}

/**
 * Update progress tracker with a new tool call.
 *
 * @param {Object} tracker — tracker from createProgressTracker
 * @param {string} toolName — name of the tool that was called
 */
export function recordToolCall(tracker, toolName) {
  tracker.tool_calls_count++;
  tracker.last_tool = toolName;
}

/**
 * Write current progress to the progress file.
 * This is called periodically (e.g., every 5s) for TUI freshness.
 *
 * @param {Object} tracker — tracker from createProgressTracker
 * @param {Object} [extra] — additional fields to include
 * @param {number} [extra.stdoutBytes] — current stdout buffer size
 * @returns {boolean} true if write succeeded
 */
export function updateProgress(tracker, extra = {}) {
  if (!tracker.progressFile) return false;

  const progressData = {
    tool_calls: tracker.tool_calls_count,
    elapsed_ms: Date.now() - tracker.startTime,
    stdout_bytes: extra.stdoutBytes || 0,
    last_tool: tracker.last_tool,
  };

  try {
    writeFileSync(tracker.progressFile, JSON.stringify(progressData, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("[progress:updateProgress] Error writing progress file:", err.message || err);
    return false;
  }
}

/**
 * Clean up the progress file after agent completion.
 *
 * @param {Object} tracker — tracker from createProgressTracker
 * @returns {boolean} true if cleanup succeeded
 */
export function cleanupProgress(tracker) {
  if (!tracker.progressFile) return false;

  try {
    unlinkSync(tracker.progressFile);
    return true;
  } catch (err) {
    console.error("[progress:cleanupProgress] Error deleting progress file:", err.message || err);
    return false;
  }
}

/**
 * Reset tracker state (e.g., between retry attempts).
 *
 * @param {Object} tracker — tracker from createProgressTracker
 */
export function resetProgress(tracker) {
  tracker.tool_calls_count = 0;
  tracker.last_tool = null;
  tracker.startTime = Date.now();
}

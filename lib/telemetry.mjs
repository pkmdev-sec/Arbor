/**
 * Telemetry: parse stderr/stdout for quality signals
 *
 * Extracted from agent-entry.mjs lines ~87-112.
 */

import { TOOL_CALL_RE, MAX_BUFFER_SIZE } from "./config.mjs";

/**
 * Parse telemetry data from agent output
 *
 * @param {string} stderrText - Agent stderr output
 * @param {string} stdoutText - Agent stdout output
 * @param {object} [memoryStats] - Optional memory statistics (peakBufferSize, etc.)
 * @returns {object} Telemetry data including tool counts, checklist, and memory usage
 */
export function parseTelemetry(stderrText, stdoutText, memoryStats = null) {
  const toolCounts = { Read: 0, Grep: 0, Bash: 0, Edit: 0, Write: 0, Glob: 0, total: 0 };

  try {
    for (const line of stderrText.split("\n")) {
      const m = line.match(TOOL_CALL_RE);
      if (m) {
        const tool = m[1];
        if (tool in toolCounts) toolCounts[tool]++;
        toolCounts.total++;
      }
    }
  } catch (err) {
    // Log error but continue - don't fail telemetry on parse errors
    process.stderr.write(`Warning: Failed to parse tool calls from stderr: ${err.message}\n`);
  }

  const checklist = { pass: 0, fail: 0, skip: 0 };

  try {
    for (const line of stdoutText.split("\n")) {
      if (/\[PASS\]/i.test(line)) checklist.pass++;
      if (/\[FAIL\]/i.test(line)) checklist.fail++;
      if (/\[SKIP\]/i.test(line)) checklist.skip++;
    }
  } catch (err) {
    // Log error but continue - don't fail telemetry on parse errors
    process.stderr.write(`Warning: Failed to parse checklist from stdout: ${err.message}\n`);
  }

  // Memory usage statistics
  const memory = memoryStats ? {
    peakBufferSizeBytes: memoryStats.peakBufferSize || 0,
    peakBufferSizeMB: ((memoryStats.peakBufferSize || 0) / 1024 / 1024).toFixed(2),
    bufferLimitMB: (MAX_BUFFER_SIZE / 1024 / 1024).toFixed(2),
    utilizationPercent: memoryStats.peakBufferSize
      ? ((memoryStats.peakBufferSize / MAX_BUFFER_SIZE) * 100).toFixed(1)
      : "0.0"
  } : null;

  return {
    tool_calls: toolCounts,
    completion_checklist: checklist,
    quality_signals: {
      has_checklist: checklist.pass + checklist.fail + checklist.skip > 0,
    },
    memory: memory
  };
}

/**
 * Track peak buffer size for an agent's output streams
 *
 * @param {string} agentId - Agent identifier
 * @param {string} stdout - Current stdout content
 * @param {string} stderr - Current stderr content
 * @returns {object} Memory statistics { peakBufferSize, currentSize, exceeded }
 */
export function trackMemoryUsage(agentId, stdout = "", stderr = "") {
  const currentSize = Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");

  // Initialize or update peak tracking
  if (!trackMemoryUsage._peaks) {
    trackMemoryUsage._peaks = new Map();
  }

  const existing = trackMemoryUsage._peaks.get(agentId) || 0;
  const peakBufferSize = Math.max(existing, currentSize);
  trackMemoryUsage._peaks.set(agentId, peakBufferSize);

  return {
    peakBufferSize,
    currentSize,
    exceeded: currentSize > MAX_BUFFER_SIZE,
    utilizationPercent: ((peakBufferSize / MAX_BUFFER_SIZE) * 100).toFixed(1)
  };
}

/**
 * Get memory statistics for a specific agent
 *
 * @param {string} agentId - Agent identifier
 * @returns {object|null} Memory stats or null if not tracked
 */
export function getMemoryStats(agentId) {
  if (!trackMemoryUsage._peaks || !trackMemoryUsage._peaks.has(agentId)) {
    return null;
  }

  const peakBufferSize = trackMemoryUsage._peaks.get(agentId);
  return {
    peakBufferSize,
    peakBufferSizeMB: (peakBufferSize / 1024 / 1024).toFixed(2),
    bufferLimitMB: (MAX_BUFFER_SIZE / 1024 / 1024).toFixed(2),
    utilizationPercent: ((peakBufferSize / MAX_BUFFER_SIZE) * 100).toFixed(1)
  };
}

/**
 * Clear memory tracking for a specific agent or all agents
 *
 * @param {string} [agentId] - Optional agent ID (clears all if omitted)
 */
export function clearMemoryTracking(agentId = null) {
  if (!trackMemoryUsage._peaks) return;

  if (agentId) {
    trackMemoryUsage._peaks.delete(agentId);
  } else {
    trackMemoryUsage._peaks.clear();
  }
}

/**
 * Report peak buffer sizes for an agent's stdout/stderr streams
 * Called after process completion to log memory usage telemetry.
 *
 * @param {number} peakStdoutBytes - Peak stdout buffer size in bytes
 * @param {number} peakStderrBytes - Peak stderr buffer size in bytes
 */
export function reportPeakBufferSize(peakStdoutBytes, peakStderrBytes) {
  const stdoutMB = (peakStdoutBytes / 1024 / 1024).toFixed(2);
  const stderrMB = (peakStderrBytes / 1024 / 1024).toFixed(2);
  const limitMB = (MAX_BUFFER_SIZE / 1024 / 1024).toFixed(0);

  // Only log if buffer usage was significant (>1MB)
  if (peakStdoutBytes > 1024 * 1024 || peakStderrBytes > 1024 * 1024) {
    process.stderr.write(
      `[telemetry] Peak buffer: stdout=${stdoutMB}MB stderr=${stderrMB}MB (limit: ${limitMB}MB)\n`
    );
  }
}

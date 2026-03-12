/**
 * Telemetry: parse stderr/stdout for quality signals
 *
 * Extracted from agent-entry.mjs lines ~87-112.
 *
 * IPC Integration: routes telemetry through TelemetryChannel when available
 */

import { TOOL_CALL_RE, MAX_BUFFER_SIZE } from "./config.mjs";
import { TelemetryChannel } from "./ipc/telemetry-channel.mjs";

// IPC telemetry channel (optional, non-blocking)
let telemetryChannel = null;

// Incremental parsing state per agent
const parsingState = new Map(); // agentId -> { stderrOffset, stdoutOffset, toolBatch, checklistBatch }
const _peaks = new Map();

/**
 * Initialize IPC telemetry channel
 * Called at agent startup if IPC is enabled
 *
 * @param {AgentChannel} agentChannel - IPC agent channel
 */
export function initTelemetryIPC(agentChannel) {
  if (!agentChannel) {
    return false;
  }

  try {
    telemetryChannel = TelemetryChannel.init(agentChannel);
    console.error(`[telemetry] IPC channel initialized`);
    return true;
  } catch (err) {
    console.error(`[telemetry] IPC init failed: ${err.message}`);
    return false;
  }
}

/**
 * Flush telemetry on process exit
 * Ensures all buffered events are sent before shutdown
 */
export async function flushTelemetry() {
  if (telemetryChannel) {
    try {
      await telemetryChannel.flush();
    } catch (err) {
      console.error(`[telemetry] Flush error: ${err.message}`);
    }
  }
}

/**
 * Parse telemetry data incrementally from new output
 *
 * @param {string} agentId - Agent identifier for state tracking
 * @param {string} stderrText - Agent stderr output (full or incremental)
 * @param {string} stdoutText - Agent stdout output (full or incremental)
 * @param {object} [memoryStats] - Optional memory statistics (peakBufferSize, etc.)
 * @param {boolean} [final=false] - If true, flush batched IPC events immediately
 * @returns {object} Telemetry data including tool counts, checklist, and memory usage
 */
export function parseTelemetryIncremental(agentId, stderrText, stdoutText, memoryStats = null, final = false) {
  // Get or initialize parsing state for this agent
  if (!parsingState.has(agentId)) {
    parsingState.set(agentId, {
      stderrOffset: 0,
      stdoutOffset: 0,
      toolBatch: {},
      checklistBatch: { pass: [], fail: [], skip: [] },
      batchTimer: null
    });
  }
  const state = parsingState.get(agentId);

  const toolCounts = { Read: 0, Grep: 0, Bash: 0, Edit: 0, Write: 0, Glob: 0, total: 0 };

  try {
    // Only process new stderr content
    const newStderr = stderrText.slice(state.stderrOffset);
    const stderrLines = newStderr.split("\n");

    for (const line of stderrLines) {
      const m = line.match(TOOL_CALL_RE);
      if (m) {
        const tool = m[1];
        if (tool in toolCounts) toolCounts[tool]++;
        toolCounts.total++;

        // Batch tool calls for IPC emission
        if (telemetryChannel) {
          state.toolBatch[tool] = (state.toolBatch[tool] || 0) + 1;
        }
      }
    }
    state.stderrOffset = stderrText.length;
  } catch (err) {
    process.stderr.write(`Warning: Failed to parse tool calls from stderr: ${err.message}\n`);
  }

  const checklist = { pass: 0, fail: 0, skip: 0 };

  try {
    // Only process new stdout content
    const newStdout = stdoutText.slice(state.stdoutOffset);
    const stdoutLines = newStdout.split("\n");

    for (const line of stdoutLines) {
      const passMatch = /\[PASS\]/i.test(line);
      const failMatch = /\[FAIL\]/i.test(line);
      const skipMatch = /\[SKIP\]/i.test(line);

      if (passMatch) {
        checklist.pass++;
        if (telemetryChannel) {
          state.checklistBatch.pass.push(line.slice(0, 100));
        }
      }
      if (failMatch) {
        checklist.fail++;
        if (telemetryChannel) {
          state.checklistBatch.fail.push(line.slice(0, 100));
        }
      }
      if (skipMatch) {
        checklist.skip++;
        if (telemetryChannel) {
          state.checklistBatch.skip.push(line.slice(0, 100));
        }
      }
    }
    state.stdoutOffset = stdoutText.length;
  } catch (err) {
    process.stderr.write(`Warning: Failed to parse checklist from stdout: ${err.message}\n`);
  }

  // Emit batched IPC events (debounced, or immediate on final)
  if (telemetryChannel && (final || !state.batchTimer)) {
    if (state.batchTimer) clearTimeout(state.batchTimer);

    const emitBatch = () => {
      try {
        // Emit tool calls as batch
        for (const [tool, count] of Object.entries(state.toolBatch)) {
          for (let i = 0; i < count; i++) {
            telemetryChannel.toolCall(tool);
          }
        }
        state.toolBatch = {};

        // Emit checklist items as batch
        for (const item of state.checklistBatch.pass) {
          telemetryChannel.checklistItem("pass", item);
        }
        for (const item of state.checklistBatch.fail) {
          telemetryChannel.checklistItem("fail", item);
        }
        for (const item of state.checklistBatch.skip) {
          telemetryChannel.checklistItem("skip", item);
        }
        state.checklistBatch = { pass: [], fail: [], skip: [] };
      } catch (err) {
        // Telemetry emission failure is non-fatal
      }
    };

    if (final) {
      emitBatch();
      parsingState.delete(agentId); // Clean up state on final parse
    } else {
      state.batchTimer = setTimeout(emitBatch, 1000);
    }
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

  // IPC: emit memory usage (non-blocking)
  if (telemetryChannel && memoryStats?.peakBufferSize && final) {
    try {
      telemetryChannel.memoryUsage(
        memoryStats.peakBufferSize,
        memoryStats.peakBufferSize, // current = peak at end
        MAX_BUFFER_SIZE
      );
    } catch (err) {
      // Telemetry emission failure is non-fatal
    }
  }

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
 * Parse telemetry data from agent output (legacy, parses full output)
 *
 * @param {string} stderrText - Agent stderr output
 * @param {string} stdoutText - Agent stdout output
 * @param {object} [memoryStats] - Optional memory statistics (peakBufferSize, etc.)
 * @returns {object} Telemetry data including tool counts, checklist, and memory usage
 */
export function parseTelemetry(stderrText, stdoutText, memoryStats = null) {
  // Use incremental parser with a synthetic agent ID for one-shot parsing
  return parseTelemetryIncremental('legacy', stderrText, stdoutText, memoryStats, true);
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

  const existing = _peaks.get(agentId) || 0;
  const peakBufferSize = Math.max(existing, currentSize);
  _peaks.set(agentId, peakBufferSize);

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
  if (!_peaks.has(agentId)) {
    return null;
  }

  const peakBufferSize = _peaks.get(agentId);
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
  if (agentId) {
    _peaks.delete(agentId);
  } else {
    _peaks.clear();
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

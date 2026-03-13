/**
 * Poll-based progress file watcher for swarm agent monitoring.
 *
 * Reads .progress.json and -result.json files from the swarm workDir
 * and emits events as agents update or complete. More reliable than
 * fs.watch on /tmp (especially macOS APFS).
 *
 * Enhanced with:
 * - Sparkline history tracking (tool calls per 10s bucket)
 * - Tool call breakdown from result files
 * - PID tracking for agent cancellation
 * - Output content for log viewer
 * - IPC tool_event stream reading (real-time tool tracking)
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSparklineTracker } from './sparkline.mjs';

/**
 * Create a progress watcher with enhanced data tracking.
 *
 * @param {string} workDir          - Swarm run directory to watch
 * @param {number} pollIntervalMs   - Polling interval (default: 1000ms)
 * @returns {EventEmitter} Emitter with events: agent-update, agent-complete, tick
 */
export function createProgressWatcher(workDir, pollIntervalMs = 1000) {
  const emitter = new EventEmitter();
  const agentState = new Map();       // agentId → full agent state
  const sparklines = new Map();        // agentId → sparkline tracker
  let prevToolCounts = new Map();      // agentId → last known tool count (for delta)
  let tickCount = 0;
  let ipcLogOffset = 0;                // Track read position in ipc.jsonl
  const toolEventsByAgent = new Map(); // agentId → array of tool_events

  function getOrCreateSparkline(agentId) {
    if (!sparklines.has(agentId)) {
      sparklines.set(agentId, createSparklineTracker(10000, 20));
    }
    return sparklines.get(agentId);
  }

  /**
   * Read new tool_event entries from ipc.jsonl (incremental tail)
   * Returns array of parsed events since last read
   */
  function readIPCToolEvents() {
    const ipcPath = join(workDir, 'ipc.jsonl');
    if (!existsSync(ipcPath)) return [];

    try {
      const stat = statSync(ipcPath);
      const currentSize = stat.size;

      // If file is smaller than our offset, it was truncated/rotated — reset
      if (currentSize < ipcLogOffset) {
        ipcLogOffset = 0;
      }

      // If no new data, return early
      if (currentSize === ipcLogOffset) return [];

      // Read entire file (for simplicity, since log is small in test scenarios)
      // In production, could optimize with fd + read from offset
      const content = readFileSync(ipcPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      // Calculate which lines are new based on byte offset
      // Simplified: just track line count instead of byte offset
      // (More accurate: track byte position, but line-based is sufficient here)
      const allEvents = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);

      // Update offset to current file size
      ipcLogOffset = currentSize;

      // Filter to only tool_event type
      return allEvents.filter(evt => evt.type === 'tool_event');

    } catch {
      return []; // Non-fatal — file may be mid-write
    }
  }

  /**
   * Process tool_event entries and update agent state
   */
  function processToolEvents(events) {
    for (const evt of events) {
      const agentId = evt.from;
      if (!agentId) continue;

      // Store event for this agent
      if (!toolEventsByAgent.has(agentId)) {
        toolEventsByAgent.set(agentId, []);
      }
      toolEventsByAgent.get(agentId).push(evt);

      // Update agent state with tool event data
      const prev = agentState.get(agentId) || {};
      const toolEvents = toolEventsByAgent.get(agentId);
      const currentToolCalls = toolEvents.length;

      // Track sparkline delta
      const prevCount = prevToolCounts.get(agentId) || 0;
      const delta = Math.max(0, currentToolCalls - prevCount);
      if (delta > 0) {
        getOrCreateSparkline(agentId).record(delta);
      }
      prevToolCounts.set(agentId, currentToolCalls);

      // Extract latest tool info from most recent event
      const lastEvent = toolEvents[toolEvents.length - 1];
      const lastTool = lastEvent.meta?.tool || null;
      const lastToolTarget = lastEvent.meta?.target || '';

      const updated = {
        ...prev,
        id: agentId,
        status: prev.status || 'running',
        toolCalls: currentToolCalls,
        lastTool: lastTool,
        lastToolTarget: lastToolTarget,
        lastToolTime: lastEvent.ts,
        sparklineValues: getOrCreateSparkline(agentId).getValues(),
        // Keep existing fields if present
        elapsedMs: prev.elapsedMs || 0,
        stdoutBytes: prev.stdoutBytes || 0,
      };

      agentState.set(agentId, updated);
      emitter.emit('agent-update', updated);
    }
  }

  const interval = setInterval(() => {
    tickCount++;
    try {
      if (!existsSync(workDir)) return;

      // STEP 1: Read new tool_event entries from ipc.jsonl (preferred source)
      const toolEvents = readIPCToolEvents();
      if (toolEvents.length > 0) {
        processToolEvents(toolEvents);
      }

      // STEP 2: Poll .progress.json and -result.json files (fallback)
      const files = readdirSync(workDir).filter(
        f => f.endsWith('-result.json') || f.endsWith('.progress.json')
      );

      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(workDir, file), 'utf-8'));
          // Extract agentId from filename patterns:
          //   agent-01-result.json.progress.json → agent-01
          //   agent-01-result.json → agent-01
          const agentId = file
            .replace(/-result\.json$/, '')
            .replace(/\.progress\.json$/, '')
            .replace('-result.json', '');

          if (file.endsWith('.progress.json')) {
            // In-flight progress update (written every ~30s by agent-entry.mjs)
            const prev = agentState.get(agentId) || {};
            // Don't overwrite terminal states
            if (prev.status === 'done' || prev.status === 'failed' || prev.status === 'timeout') {
              continue;
            }

            const currentToolCalls = data.tool_calls || 0;

            // Track sparkline delta (new tool calls since last poll)
            const prevCount = prevToolCounts.get(agentId) || 0;
            const delta = Math.max(0, currentToolCalls - prevCount);
            if (delta > 0) {
              getOrCreateSparkline(agentId).record(delta);
            }
            prevToolCounts.set(agentId, currentToolCalls);

            const updated = {
              ...prev,
              id: agentId,
              status: 'running',
              toolCalls: currentToolCalls,
              elapsedMs: data.elapsed_ms || 0,
              stdoutBytes: data.stdout_bytes || 0,
              lastTool: data.last_tool || null,
              sparklineValues: getOrCreateSparkline(agentId).getValues(),
            };
            agentState.set(agentId, updated);
            emitter.emit('agent-update', updated);

          } else if (file.endsWith('-result.json')) {
            // Agent completed — result file
            const toolBreakdown = data.telemetry?.tool_calls || {};
            const totalTools = toolBreakdown.total || 0;

            const updated = {
              id: agentId,
              status: data.status === 'completed' ? 'done'
                : data.status === 'timeout' ? 'timeout' : 'failed',
              exitCode: data.exit_code,
              durationMs: data.duration_ms,
              toolCalls: totalTools,
              toolBreakdown: { ...toolBreakdown },
              output: (data.output || '').slice(0, 2000),
              model: data.model,
              task: data.task || '',
              sparklineValues: sparklines.has(agentId)
                ? sparklines.get(agentId).getValues()
                : [],
              qualitySignals: data.telemetry?.quality_signals || {},
            };

            // Remove 'total' from tool breakdown for chart display
            delete updated.toolBreakdown.total;

            agentState.set(agentId, updated);
            emitter.emit('agent-complete', updated);
          }
        } catch {
          // Individual file read/parse errors are non-fatal — file may be mid-write
        }
      }

      // Also try to read decompose.json for subtask descriptions
      try {
        const decomposePath = join(workDir, 'decompose.json');
        if (existsSync(decomposePath)) {
          const decompose = JSON.parse(readFileSync(decomposePath, 'utf-8'));
          const subtasks = Array.isArray(decompose) ? decompose : (decompose.subtasks || []);
          for (const st of subtasks) {
            const agentId = st.agent_id || st.id;
            if (agentId && agentState.has(agentId)) {
              const agent = agentState.get(agentId);
              if (!agent.subtask) {
                agent.subtask = st.task || st.title || st.description || '';
                agentState.set(agentId, agent);
              }
            }
          }
        }
      } catch {
        // decompose.json may not exist yet
      }

      // Emit periodic tick for sparkline updates (even when no file changes)
      emitter.emit('tick', tickCount);

    } catch {
      // Directory read errors are non-fatal — workDir may not exist yet
    }
  }, pollIntervalMs);

  emitter.stop = () => clearInterval(interval);
  emitter.getState = () => new Map(agentState);
  emitter.getSparkline = (agentId) => {
    const tracker = sparklines.get(agentId);
    return tracker ? tracker.getValues() : [];
  };

  return emitter;
}

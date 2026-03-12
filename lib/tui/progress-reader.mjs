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
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

  function getOrCreateSparkline(agentId) {
    if (!sparklines.has(agentId)) {
      sparklines.set(agentId, createSparklineTracker(10000, 20));
    }
    return sparklines.get(agentId);
  }

  const interval = setInterval(() => {
    tickCount++;
    try {
      if (!existsSync(workDir)) return;
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

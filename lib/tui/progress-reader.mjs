/**
 * Poll-based progress file watcher for swarm agent monitoring.
 *
 * Reads .progress.json and -result.json files from the swarm workDir
 * and emits events as agents update or complete. More reliable than
 * fs.watch on /tmp (especially macOS APFS).
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function createProgressWatcher(workDir, pollIntervalMs = 1000) {
  const emitter = new EventEmitter();
  const agentState = new Map(); // agentId -> { status, toolCalls, elapsedMs, ... }

  const interval = setInterval(() => {
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
            // Don't overwrite terminal states — agent already completed
            if (prev.status === 'done' || prev.status === 'failed' || prev.status === 'timeout') {
              continue;
            }
            const updated = {
              ...prev,
              id: agentId,
              status: 'running',
              toolCalls: data.tool_calls || 0,
              elapsedMs: data.elapsed_ms || 0,
              stdoutBytes: data.stdout_bytes || 0,
              lastTool: data.last_tool || null,
            };
            agentState.set(agentId, updated);
            emitter.emit('agent-update', updated);
          } else if (file.endsWith('-result.json')) {
            // Agent completed — result file written by agent-entry.mjs on exit
            const updated = {
              id: agentId,
              status: data.status === 'completed' ? 'done' : data.status === 'timeout' ? 'timeout' : 'failed',
              exitCode: data.exit_code,
              durationMs: data.duration_ms,
              toolCalls: data.telemetry?.tool_calls?.total || 0,
              toolBreakdown: data.telemetry?.tool_calls || {},
              output: (data.output || '').slice(0, 500),
              model: data.model,
            };
            agentState.set(agentId, updated);
            emitter.emit('agent-complete', updated);
          }
        } catch {
          // Individual file read/parse errors are non-fatal — file may be mid-write
        }
      }
    } catch {
      // Directory read errors are non-fatal — workDir may not exist yet
    }
  }, pollIntervalMs);

  emitter.stop = () => clearInterval(interval);
  emitter.getState = () => new Map(agentState);

  return emitter;
}

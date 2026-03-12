/**
 * DataPoller — File-based fallback data source for the TUI.
 *
 * When the IPC bus isn't running (common case), polls these sources:
 *   1. Git worktrees: `git worktree list` for active agent worktrees
 *   2. Result files: /tmp/swarm-*.json, /tmp/ra-*.json for completed agents
 *   3. Process list: detect running claude processes
 *   4. Telemetry files: ~/.claude/telemetry/ for recent activity
 *   5. Beads tasks: `bd list --json` for active task graph
 *
 * Polling interval: 2 seconds (beads every 10s)
 *
 * Events:
 *   'data'   — Full data snapshot
 *   'agents' — Derived agent list from all sources
 *
 * @module tui/data-poller
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const POLL_INTERVAL_MS = 2000;
const BEADS_POLL_INTERVAL_MS = 10000;
const RESULT_MAX_AGE_MS = 3600000; // 1 hour
const HOME = homedir();

/**
 * Parse `git worktree list --porcelain` output into structured data.
 * @returns {object[]} Array of { path, head, branch, bare, detached }
 */
function parseWorktrees() {
  try {
    const output = execSync('git worktree list --porcelain 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const worktrees = [];
    let current = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === 'detached') {
        current.detached = true;
      }
    }
    if (current.path) worktrees.push(current);

    // Filter to agent-related worktrees (skip the main worktree)
    return worktrees.filter(w =>
      w.path.includes('.claude/worktrees') ||
      w.path.includes('agent-') ||
      w.branch?.startsWith('agent-') ||
      w.branch?.startsWith('claude-worktree-')
    );
  } catch {
    return [];
  }
}

/**
 * Scan /tmp for swarm and arbor result files.
 * @returns {object[]} Array of parsed result file data, newest first
 */
function scanResultFiles() {
  const results = [];

  try {
    const tmpFiles = readdirSync('/tmp');
    for (const f of tmpFiles) {
      const isSwarm = f.startsWith('swarm-') && f.endsWith('.json');
      const isRA = f.startsWith('ra-') && f.endsWith('.json');
      if (!isSwarm && !isRA) continue;

      const filepath = join('/tmp', f);
      try {
        const stat = statSync(filepath);
        if (Date.now() - stat.mtimeMs > RESULT_MAX_AGE_MS) continue;
        const raw = readFileSync(filepath, 'utf-8');
        const data = JSON.parse(raw);
        results.push({
          file: f,
          path: filepath,
          mtime: stat.mtimeMs,
          status: data.status || 'unknown',
          model: data.model || '',
          duration: data.duration_ms || 0,
          toolCalls: data.telemetry?.tool_calls?.total || 0,
          toolBreakdown: data.telemetry?.tool_calls || {},
          output: (data.output || '').slice(0, 2000),
          task: data.task || '',
          exitCode: data.exit_code,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* /tmp not readable */ }

  return results.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Detect running Claude Code processes via ps.
 * @returns {object[]} Array of { pid, cpu, mem, command, isAgent }
 */
function detectClaudeProcesses() {
  try {
    const output = execSync(
      "ps aux 2>/dev/null | grep -E '(claude|arbor|swarm)' | grep -v grep",
      { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const processes = [];
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const cmd = parts.slice(10).join(' ');
      processes.push({
        pid: parseInt(parts[1], 10),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: cmd.slice(0, 120),
        isAgent: cmd.includes('arbor') || cmd.includes('CLAUDE_CONFIG_DIR'),
      });
    }
    return processes;
  } catch {
    return [];
  }
}

/**
 * Read recent telemetry files from ~/.claude/telemetry/.
 * @returns {object[]} Parsed telemetry entries from the last hour
 */
function readTelemetry() {
  const telemetryDir = join(HOME, '.claude', 'telemetry');
  if (!existsSync(telemetryDir)) return [];

  try {
    const files = readdirSync(telemetryDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-10);

    const entries = [];
    for (const f of files) {
      try {
        const fullPath = join(telemetryDir, f);
        const stat = statSync(fullPath);
        if (Date.now() - stat.mtimeMs > RESULT_MAX_AGE_MS) continue;
        const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
        entries.push({ file: f, mtime: stat.mtimeMs, ...data });
      } catch { /* skip */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Get beads tasks via bd CLI (if available).
 * @returns {object[]} Task list or empty array
 */
function getBeadsTasks() {
  try {
    const output = execSync('bd list --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * DataPoller — Polls file-based data sources at a regular interval.
 *
 * @extends EventEmitter
 */
export class DataPoller extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.pollInterval] - Poll interval in ms (default: 2000)
   */
  constructor({ pollInterval } = {}) {
    super();
    this.pollInterval = pollInterval || POLL_INTERVAL_MS;
    this.timer = null;
    this.lastData = null;
    this.lastTasksPollTime = 0;
    this.stopped = false;
  }

  /** Start polling. */
  start() {
    if (this.stopped) return;
    this._poll();
    this.timer = setInterval(() => this._poll(), this.pollInterval);
  }

  /** Stop polling and clean up. */
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** @private */
  _poll() {
    const now = Date.now();
    const data = {
      worktrees: parseWorktrees(),
      resultFiles: scanResultFiles(),
      processes: detectClaudeProcesses(),
      telemetry: readTelemetry(),
      tasks: [],
      timestamp: now,
    };

    // Poll beads less frequently (expensive subprocess)
    if (now - this.lastTasksPollTime > BEADS_POLL_INTERVAL_MS) {
      data.tasks = getBeadsTasks();
      this.lastTasksPollTime = now;
    } else {
      data.tasks = this.lastData?.tasks || [];
    }

    this.lastData = data;
    this.emit('data', data);

    const agents = this._deriveAgents(data);
    this.emit('agents', agents);
  }

  /**
   * Derive agent-like entries from all polled data sources.
   * @private
   * @param {object} data - Polled data snapshot
   * @returns {object[]} Agent entries suitable for display
   */
  _deriveAgents(data) {
    const agents = new Map();

    // From result files (highest fidelity — completed agents)
    for (const result of data.resultFiles) {
      const id = basename(result.file, '.json');
      const breakdown = { ...result.toolBreakdown };
      delete breakdown.total;

      agents.set(id, {
        id,
        status: result.status === 'completed' ? 'done'
          : result.status === 'timeout' ? 'timeout'
          : result.status === 'failed' ? 'failed'
          : result.status || 'unknown',
        model: result.model,
        durationMs: result.duration,
        toolCalls: result.toolCalls,
        toolBreakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
        output: result.output,
        exitCode: result.exitCode,
        subtask: result.task,
        source: 'result-file',
      });
    }

    // From worktrees (may indicate active agents not captured by result files)
    for (const wt of data.worktrees) {
      const name = basename(wt.path);
      if (agents.has(name)) {
        // Enrich existing entry with worktree path
        agents.get(name).worktreePath = wt.path;
        agents.get(name).branch = wt.branch;
      } else {
        agents.set(name, {
          id: name,
          status: 'running',
          worktreePath: wt.path,
          branch: wt.branch,
          model: '',
          source: 'worktree',
        });
      }
    }

    // From processes (detect agents that are still running)
    for (const proc of data.processes) {
      if (!proc.isAgent) continue;
      // Try to extract agent ID from command line
      const idMatch = proc.command.match(/agent-(\w+[-\w]*)/);
      if (idMatch) {
        const id = idMatch[0];
        if (agents.has(id)) {
          agents.get(id).pid = proc.pid;
          agents.get(id).cpu = proc.cpu;
          agents.get(id).status = 'running';
        } else {
          agents.set(id, {
            id,
            status: 'running',
            pid: proc.pid,
            cpu: proc.cpu,
            model: '',
            source: 'process',
          });
        }
      }
    }

    return Array.from(agents.values());
  }

  /**
   * Get the latest polled data synchronously.
   * @returns {object|null}
   */
  getLatestData() {
    return this.lastData;
  }
}

/**
 * Create and start a data poller.
 * @param {object} [options]
 * @returns {DataPoller}
 */
export function createDataPoller(options) {
  const poller = new DataPoller(options);
  poller.start();
  return poller;
}

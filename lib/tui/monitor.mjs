/**
 * Monitor — Standalone TUI for observing ALL active swarm runs.
 *
 * Run via: swarm --monitor
 *          swarm --monitor --theme neon --mode dashboard --bus-address /tmp/bus.sock
 *
 * Enhanced features:
 * - CLI argument parsing: --bus-address, --theme, --mode
 * - Terminal resize handling via useTerminalSize hook
 * - Graceful shutdown: SIGINT/SIGTERM handlers
 * - IPC bus connection on launch
 * - Programmatic start(config) function
 * - Run selector for multiple active runs
 * - Expanded agent detail for selected run
 * - Sparklines and tool breakdowns
 * - Responsive layout with keyboard navigation
 * - Auto-discovery of new runs in /tmp/swarm/
 * - All panels wired: hierarchy, governor, merge, control, chat
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { AgentListItem, AgentDetail } from './agent-card.mjs';
import { HelpOverlay } from './help-overlay.mjs';
import { useTerminalSize } from './layout.mjs';
import { estimateTotalCost, formatCost } from './cost-tracker.mjs';
import {
  statusColor, formatElapsed, truncate, setTheme, getThemeName, cycleTheme,
} from './theme.mjs';
import { ChatPanel } from './chat-panel.mjs';
import { HierarchyPanel, buildHierarchyTree } from './hierarchy-panel.mjs';
import { GovernorPanel, normalizeUtilization } from './governor-panel.mjs';
import { MergePanel, normalizeMergeData } from './merge-panel.mjs';
import { ControlPanel, ControlMode, createControlState, parseCommand, executeCommand } from './control-panel.mjs';
import { IpcMonitorClient } from './ipc-monitor-client.mjs';
import { createDataPoller } from './data-poller.mjs';

const { useState, useEffect, useRef } = React;
const e = React.createElement;

const SWARM_BASE = '/tmp/swarm';
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const RECENT_THRESHOLD_MS = 30 * 60 * 1000;

// ── CLI argument parsing ────────────────────────────────────────

/**
 * Parse CLI arguments from process.argv.
 * Supports: --bus-address <path>, --theme <dark|neon|light>, --mode <dashboard|monitor|compact>
 *
 * @param {string[]} [argv] - Argument list (default: process.argv.slice(2))
 * @returns {{ busAddress: string|null, theme: string|null, mode: string|null }}
 */
export function parseCliArgs(argv) {
  const args = argv || process.argv.slice(2);
  const result = { busAddress: null, theme: null, mode: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--bus-address' || arg === '--bus') && next) {
      result.busAddress = next;
      i++;
    } else if (arg === '--theme' && next) {
      const valid = ['dark', 'neon', 'light'];
      if (valid.includes(next)) {
        result.theme = next;
      }
      i++;
    } else if (arg === '--mode' && next) {
      const valid = ['dashboard', 'monitor', 'compact'];
      if (valid.includes(next)) {
        result.mode = next;
      }
      i++;
    }
  }

  return result;
}

// ── Filesystem scanning ─────────────────────────────────────────

function safeReadJSON(filepath) {
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

async function safeReadJSONAsync(filepath) {
  try {
    const content = await fsPromises.readFile(filepath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function newestMtime(dirPath) {
  try {
    const files = readdirSync(dirPath);
    let newest = 0;
    for (const f of files) {
      try {
        const mt = statSync(join(dirPath, f)).mtimeMs;
        if (mt > newest) newest = mt;
      } catch { /* skip */ }
    }
    return newest;
  } catch {
    return 0;
  }
}

async function newestMtimeAsync(dirPath) {
  try {
    const files = await fsPromises.readdir(dirPath);
    let newest = 0;
    for (const f of files) {
      try {
        const stats = await fsPromises.stat(join(dirPath, f));
        if (stats.mtimeMs > newest) newest = stats.mtimeMs;
      } catch { /* skip */ }
    }
    return newest;
  } catch {
    return 0;
  }
}

function scanRun(runId, runDir) {
  const now = Date.now();
  const newest = newestMtime(runDir);
  const age = now - newest;

  const activity = age < ACTIVE_THRESHOLD_MS ? 'active'
    : age < RECENT_THRESHOLD_MS ? 'recent' : 'stale';

  const decompose = safeReadJSON(join(runDir, 'decompose.json'));
  const verifyResult = safeReadJSON(join(runDir, 'verify-result.json'));
  const conflictsRaw = safeReadJSON(join(runDir, 'conflicts.json'));

  let files;
  try { files = readdirSync(runDir); } catch { files = []; }

  const progressFiles = files.filter(f => f.endsWith('.progress.json'));
  const resultFiles = files.filter(f => f.endsWith('-result.json') && !f.startsWith('verify'));

  const agentMap = new Map();

  // Result files (completed agents)
  for (const file of resultFiles) {
    const agentId = file.replace(/-result\.json$/, '');
    const data = safeReadJSON(join(runDir, file));
    if (!data) continue;
    const toolBreakdown = data.telemetry?.tool_calls || {};
    const totalTools = toolBreakdown.total || 0;
    delete toolBreakdown.total;

    agentMap.set(agentId, {
      id: agentId,
      status: data.status === 'completed' ? 'done' : data.status === 'timeout' ? 'timeout' : 'failed',
      exitCode: data.exit_code,
      durationMs: data.duration_ms,
      toolCalls: totalTools,
      toolBreakdown,
      model: data.model,
      output: (data.output || '').slice(0, 2000),
      task: data.task || '',
    });
  }

  // Progress files (in-flight agents)
  for (const file of progressFiles) {
    const agentId = file
      .replace(/-result\.json\.progress\.json$/, '')
      .replace(/\.progress\.json$/, '')
      .replace(/-result\.json/, '');

    const existing = agentMap.get(agentId);
    if (existing && (existing.status === 'done' || existing.status === 'failed' || existing.status === 'timeout')) {
      continue;
    }

    const data = safeReadJSON(join(runDir, file));
    if (!data) continue;
    agentMap.set(agentId, {
      id: agentId,
      status: 'running',
      toolCalls: data.tool_calls || 0,
      elapsedMs: data.elapsed_ms || 0,
      stdoutBytes: data.stdout_bytes || 0,
      lastTool: data.last_tool || null,
    });
  }

  // Sort agents
  const statusOrder = { running: 0, pending: 1, done: 2, timeout: 3, failed: 4 };
  const sortedAgents = Array.from(agentMap.values()).sort(
    (a, b) => (statusOrder[a.status] || 5) - (statusOrder[b.status] || 5)
  );

  // Run status
  let runStatus = 'idle';
  if (sortedAgents.some(a => a.status === 'running')) {
    runStatus = 'running';
  } else if (sortedAgents.length > 0 &&
    sortedAgents.every(a => a.status === 'done' || a.status === 'failed' || a.status === 'timeout')) {
    runStatus = sortedAgents.some(a => a.status === 'failed') ? 'failed' : 'completed';
  }

  // Verdict
  let verdict = null;
  if (verifyResult) {
    const match = (verifyResult.output || '').match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
    verdict = match ? match[1] : null;
  }

  // Task description
  let taskDesc = null;
  if (decompose) {
    if (typeof decompose.task === 'string') taskDesc = decompose.task;
    else if (Array.isArray(decompose) && decompose[0]?.task) taskDesc = decompose[0].task;
  }

  // Cost
  const { totalCost } = estimateTotalCost(sortedAgents);

  return {
    id: runId,
    dir: runDir,
    activity,
    status: runStatus,
    taskDesc,
    agents: sortedAgents,
    agentCount: sortedAgents.length,
    verdict,
    totalCost,
    newestMtime: newest,
    conflicts: conflictsRaw,
  };
}

async function scanRunAsync(runId, runDir) {
  const now = Date.now();
  const newest = await newestMtimeAsync(runDir);
  const age = now - newest;

  const activity = age < ACTIVE_THRESHOLD_MS ? 'active'
    : age < RECENT_THRESHOLD_MS ? 'recent' : 'stale';

  const [decompose, verifyResult, conflictsRaw, files] = await Promise.all([
    safeReadJSONAsync(join(runDir, 'decompose.json')),
    safeReadJSONAsync(join(runDir, 'verify-result.json')),
    safeReadJSONAsync(join(runDir, 'conflicts.json')),
    fsPromises.readdir(runDir).catch(() => []),
  ]);

  const progressFiles = files.filter(f => f.endsWith('.progress.json'));
  const resultFiles = files.filter(f => f.endsWith('-result.json') && !f.startsWith('verify'));

  const agentMap = new Map();

  // Result files (completed agents)
  for (const file of resultFiles) {
    const agentId = file.replace(/-result\.json$/, '');
    const data = await safeReadJSONAsync(join(runDir, file));
    if (!data) continue;
    const toolBreakdown = data.telemetry?.tool_calls || {};
    const totalTools = toolBreakdown.total || 0;
    delete toolBreakdown.total;

    agentMap.set(agentId, {
      id: agentId,
      status: data.status === 'completed' ? 'done' : data.status === 'timeout' ? 'timeout' : 'failed',
      exitCode: data.exit_code,
      durationMs: data.duration_ms,
      toolCalls: totalTools,
      toolBreakdown,
      model: data.model,
      output: (data.output || '').slice(0, 2000),
      task: data.task || '',
    });
  }

  // Progress files (in-flight agents)
  for (const file of progressFiles) {
    const agentId = file
      .replace(/-result\.json\.progress\.json$/, '')
      .replace(/\.progress\.json$/, '')
      .replace(/-result\.json/, '');

    const existing = agentMap.get(agentId);
    if (existing && (existing.status === 'done' || existing.status === 'failed' || existing.status === 'timeout')) {
      continue;
    }

    const data = await safeReadJSONAsync(join(runDir, file));
    if (!data) continue;
    agentMap.set(agentId, {
      id: agentId,
      status: 'running',
      toolCalls: data.tool_calls || 0,
      elapsedMs: data.elapsed_ms || 0,
      stdoutBytes: data.stdout_bytes || 0,
      lastTool: data.last_tool || null,
    });
  }

  // Sort agents
  const statusOrder = { running: 0, pending: 1, done: 2, timeout: 3, failed: 4 };
  const sortedAgents = Array.from(agentMap.values()).sort(
    (a, b) => (statusOrder[a.status] || 5) - (statusOrder[b.status] || 5)
  );

  // Run status
  let runStatus = 'idle';
  if (sortedAgents.some(a => a.status === 'running')) {
    runStatus = 'running';
  } else if (sortedAgents.length > 0 &&
    sortedAgents.every(a => a.status === 'done' || a.status === 'failed' || a.status === 'timeout')) {
    runStatus = sortedAgents.some(a => a.status === 'failed') ? 'failed' : 'completed';
  }

  // Verdict
  let verdict = null;
  if (verifyResult) {
    const match = (verifyResult.output || '').match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
    verdict = match ? match[1] : null;
  }

  // Task description
  let taskDesc = null;
  if (decompose) {
    if (typeof decompose.task === 'string') taskDesc = decompose.task;
    else if (Array.isArray(decompose) && decompose[0]?.task) taskDesc = decompose[0].task;
  }

  // Cost
  const { totalCost } = estimateTotalCost(sortedAgents);

  return {
    id: runId,
    dir: runDir,
    activity,
    status: runStatus,
    taskDesc,
    agents: sortedAgents,
    agentCount: sortedAgents.length,
    verdict,
    totalCost,
    newestMtime: newest,
    conflicts: conflictsRaw,
  };
}

function scanAllRuns() {
  if (!existsSync(SWARM_BASE)) return { active: [], recent: [] };

  let dirs;
  try { dirs = readdirSync(SWARM_BASE); } catch { return { active: [], recent: [] }; }

  const active = [];
  const recent = [];

  for (const d of dirs) {
    const runDir = join(SWARM_BASE, d);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch { continue; }

    const run = scanRun(d, runDir);
    if (run.activity === 'active') active.push(run);
    else if (run.activity === 'recent') recent.push(run);
  }

  const byActivity = (a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.newestMtime - a.newestMtime;
  };
  active.sort(byActivity);
  recent.sort(byActivity);

  return { active, recent };
}

async function scanAllRunsAsync() {
  if (!existsSync(SWARM_BASE)) return { active: [], recent: [] };

  let dirs;
  try {
    dirs = await fsPromises.readdir(SWARM_BASE);
  } catch {
    return { active: [], recent: [] };
  }

  const active = [];
  const recent = [];

  for (const d of dirs) {
    const runDir = join(SWARM_BASE, d);
    try {
      const stats = await fsPromises.stat(runDir);
      if (!stats.isDirectory()) continue;
    } catch {
      continue;
    }

    const run = await scanRunAsync(d, runDir);
    if (run.activity === 'active') active.push(run);
    else if (run.activity === 'recent') recent.push(run);
  }

  const byActivity = (a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.newestMtime - a.newestMtime;
  };
  active.sort(byActivity);
  recent.sort(byActivity);

  return { active, recent };
}

// ── Plain text fallback ─────────────────────────────────────────

function printPlainSummary() {
  const { active, recent } = scanAllRuns();

  if (active.length === 0 && recent.length === 0) {
    process.stdout.write('No active or recent swarm runs.\n');
    return;
  }

  if (active.length > 0) {
    process.stdout.write('\n=== ACTIVE RUNS ===\n');
    for (const run of active) {
      const running = run.agents.filter(a => a.status === 'running').length;
      const done = run.agents.filter(a => a.status === 'done').length;
      const failed = run.agents.filter(a => a.status === 'failed').length;
      process.stdout.write(`\n[${run.id}] ${run.status.toUpperCase()} — ${run.agentCount} agents (${running} running, ${done} done, ${failed} failed) ~${formatCost(run.totalCost)}\n`);
      if (run.taskDesc) process.stdout.write(`  Task: ${run.taskDesc.slice(0, 100)}\n`);
      for (const agent of run.agents) {
        const elapsed = ((agent.durationMs || agent.elapsedMs || 0) / 1000).toFixed(0);
        process.stdout.write(`  ${agent.status === 'running' ? '>' : agent.status === 'done' ? '+' : 'x'} ${agent.id} [${agent.status}] ${elapsed}s, ${agent.toolCalls || 0} tools\n`);
      }
      if (run.verdict) process.stdout.write(`  Verdict: ${run.verdict}\n`);
    }
  }

  if (recent.length > 0) {
    process.stdout.write('\n=== RECENT COMPLETED ===\n');
    for (const run of recent) {
      const done = run.agents.filter(a => a.status === 'done').length;
      const failed = run.agents.filter(a => a.status === 'failed').length;
      process.stdout.write(`[${run.id}] ${run.status.toUpperCase()} — ${done} done, ${failed} failed ~${formatCost(run.totalCost)}${run.verdict ? ` — ${run.verdict}` : ''}\n`);
    }
  }

  process.stdout.write('\n');
}

// ── Panel definitions ───────────────────────────────────────────

const PANELS = ['runs', 'agents', 'chat', 'hierarchy', 'resources', 'merge'];
const PANEL_LABELS = {
  runs:      'Runs',
  agents:    'Agents',
  chat:      'Chat',
  hierarchy: 'Hierarchy',
  resources: 'Resources',
  merge:     'Merge',
};

// ── Main Session factory ─────────────────────────────────────────

/**
 * Create a "Main Session" entry representing the current running process.
 * Mirrors the factory in dashboard.mjs so the monitor shows the orchestrator.
 */
function createMainSession(elapsed) {
  return {
    id: 'main-session',
    name: 'Main Session',
    status: 'running',
    model: process.env.CLAUDE_MODEL || 'opus',
    level: 0,
    toolCalls: 0,
    elapsedMs: elapsed,
    spawnTime: Date.now() - elapsed,
    pid: process.pid,
    worktreePath: process.cwd(),
    isMainSession: true,
    subtask: `PID ${process.pid} — ${process.cwd()}`,
  };
}

// ── Ink Components ──────────────────────────────────────────────

/**
 * Run selector row — clickable run entry.
 */
function RunRow({ run, selected }) {
  const running = run.agents.filter(a => a.status === 'running').length;
  const done = run.agents.filter(a => a.status === 'done').length;
  const failed = run.agents.filter(a => a.status === 'failed').length;
  const color = statusColor(run.status);
  const verdictColor = run.verdict === 'PASS' ? 'green' : run.verdict === 'FAIL' ? 'red' : 'yellow';

  return e(Box, { paddingX: 1 },
    e(Text, { bold: selected, color: selected ? 'cyan' : undefined }, selected ? '► ' : '  '),
    run.status === 'running' ? e(Spinner, { type: 'dots' }) : e(Text, { color }, '●'),
    e(Text, { bold: selected }, ' ', run.id),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: 'green' }, String(done), '✓'),
    e(Text, null, ' '),
    e(Text, { color: 'yellow' }, String(running), '⟳'),
    e(Text, null, ' '),
    e(Text, { color: 'red' }, String(failed), '✗'),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: 'yellow' }, '~', formatCost(run.totalCost)),
    run.verdict
      ? e(Text, null,
          e(Text, { dimColor: true }, ' │ '),
          e(Text, { bold: true, color: verdictColor }, run.verdict)
        )
      : null,
    run.taskDesc
      ? e(Text, null,
          e(Text, { dimColor: true }, ' │ '),
          e(Text, { dimColor: true }, truncate(run.taskDesc, 40))
        )
      : null,
  );
}

/**
 * Main Monitor component with run selection, detail view, and all panels.
 */
function Monitor({ busAddress, initialTheme, initialMode }) {
  const { exit } = useApp();
  const { cols, rows, layout } = useTerminalSize();
  const [data, setData] = useState({ active: [], recent: [] });
  const [selectedRunIdx, setSelectedRunIdx] = useState(0);
  const [selectedAgentIdx, setSelectedAgentIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [themeName, setThemeNameState] = useState(getThemeName());
  const [ipcSource, setIpcSource] = useState('none');
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Control panel state
  const controlRef = useRef(createControlState());
  const [controlMode, setControlMode] = useState(ControlMode.STATUS);
  const [controlInputText, setControlInputText] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  // IPC monitor client ref
  const ipcClientRef = useRef(null);
  // DataPoller ref (file-based fallback)
  const pollerRef = useRef(null);
  // Poller-discovered agents (supplement to filesystem scan)
  const [pollerAgents, setPollerAgents] = useState([]);

  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  // Apply initial theme (once)
  useEffect(() => {
    if (initialTheme) setTheme(initialTheme);
  }, []);

  // Poll filesystem + elapsed timer
  useEffect(() => {
    const refresh = async () => {
      try {
        setData(await scanAllRunsAsync());
      } catch {
        // Fallback to sync on error
        setData(scanAllRuns());
      }
    };
    // Initial sync load for immediate render
    setData(scanAllRuns());
    // Switch to async for subsequent refreshes
    refresh();
    const timer = setInterval(refresh, 2000);
    const spinner = setInterval(() => setSpinnerFrame(f => (f + 1) % SPINNER.length), 80);
    const elapsedTimer = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => {
      clearInterval(timer);
      clearInterval(spinner);
      clearInterval(elapsedTimer);
    };
  }, [startTime]);

  // Connect to IPC bus on launch
  useEffect(() => {
    const client = new IpcMonitorClient({
      socketPath: busAddress || undefined,
    });
    ipcClientRef.current = client;

    client.on('source', (src) => {
      setIpcSource(src);
    });

    client.start().catch(() => {
      // IPC connection is optional — filesystem scanning is the primary data source
    });

    return () => {
      client.stop();
      ipcClientRef.current = null;
    };
  }, [busAddress]);

  // Start DataPoller as supplementary data source
  useEffect(() => {
    const poller = createDataPoller();
    pollerRef.current = poller;

    poller.on('agents', (agents) => {
      setPollerAgents(agents);
    });

    poller.on('data', (pollerData) => {
      // If IPC bus is not connected, promote poller to primary indicator
      if (ipcSource === 'none' && (
        pollerData.worktrees.length > 0 ||
        pollerData.resultFiles.length > 0 ||
        pollerData.processes.length > 0
      )) {
        setIpcSource('file');
      }
    });

    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, []);

  // Cleanup control state
  useEffect(() => {
    return () => controlRef.current.cleanup();
  }, []);

  const allRuns = [...data.active, ...data.recent];

  // Enrich run agents with poller-discovered metadata (PIDs, worktree paths)
  if (pollerAgents.length > 0) {
    const pollerMap = new Map(pollerAgents.map(a => [a.id, a]));
    for (const run of allRuns) {
      for (let i = 0; i < run.agents.length; i++) {
        const agent = run.agents[i];
        const polled = pollerMap.get(agent.id);
        if (polled) {
          if (polled.worktreePath && !agent.worktreePath) agent.worktreePath = polled.worktreePath;
          if (polled.branch && !agent.branch) agent.branch = polled.branch;
          if (polled.pid && !agent.pid) agent.pid = polled.pid;
          if (polled.cpu != null) agent.cpu = polled.cpu;
        }
      }
    }
  }

  // Main Session — always present as the orchestrator
  const mainSession = createMainSession(elapsed);

  const selectedRun = allRuns[selectedRunIdx] || null;
  // Prepend Main Session to the selected run's agents for display
  const displayAgents = selectedRun ? [mainSession, ...selectedRun.agents] : [mainSession];
  const selectedAgent = displayAgents[selectedAgentIdx] || null;

  // Total stats
  const totalRunning = data.active.reduce(
    (sum, r) => sum + r.agents.filter(a => a.status === 'running').length, 0
  );
  const totalAgents = allRuns.reduce((sum, r) => sum + r.agentCount, 0);
  const totalCost = allRuns.reduce((sum, r) => sum + r.totalCost, 0);

  // Current panel name
  const currentPanel = PANELS[focusedPanel] || 'runs';

  // Build hierarchy from selected run
  const hierarchyData = selectedRun ? buildHierarchyTree(
    new Map(selectedRun.agents.map(a => [a.id, a]))
  ) : [];

  // Control actions
  const controlActions = {
    setTheme: (name) => {
      setTheme(name);
      setThemeNameState(name);
    },
    switchPanel: (name) => {
      const idx = PANELS.indexOf(name);
      if (idx >= 0) setFocusedPanel(idx);
    },
    clear: () => {
      setStatusMessage('Cleared');
      setTimeout(() => setStatusMessage(''), 2000);
    },
    getStatus: () => `${allRuns.length} runs, ${totalAgents} agents, ${totalRunning} running`,
    getCost: () => `~${formatCost(totalCost)} estimated`,
  };

  // Keyboard
  useInput((input, key) => {
    if (showHelp) {
      setShowHelp(false);
      return;
    }

    // Control panel input mode
    if (controlMode !== ControlMode.STATUS) {
      if (key.escape) {
        controlRef.current.cancel();
        setControlMode(ControlMode.STATUS);
        setControlInputText('');
        return;
      }
      if (key.return && controlMode === ControlMode.COMMAND) {
        const cmd = parseCommand(':' + controlRef.current.getInputText());
        if (cmd) {
          const result = executeCommand(cmd, controlActions);
          setStatusMessage(result.message);
          setTimeout(() => setStatusMessage(''), 3000);
        }
        controlRef.current.cancel();
        setControlMode(ControlMode.STATUS);
        setControlInputText('');
        return;
      }
      if (key.backspace || key.delete) {
        controlRef.current.backspace();
        setControlInputText(controlRef.current.getInputText());
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        controlRef.current.appendChar(input);
        setControlInputText(controlRef.current.getInputText());
      }
      return;
    }

    // Normal mode navigation
    if (key.upArrow || input === 'k') {
      if (currentPanel === 'runs') {
        setSelectedRunIdx(i => Math.max(0, i - 1));
        setSelectedAgentIdx(0);
      } else if (currentPanel === 'agents') {
        setSelectedAgentIdx(i => Math.max(0, i - 1));
      }
    }
    if (key.downArrow || input === 'j') {
      if (currentPanel === 'runs') {
        setSelectedRunIdx(i => Math.min(allRuns.length - 1, i + 1));
        setSelectedAgentIdx(0);
      } else if (currentPanel === 'agents') {
        setSelectedAgentIdx(i => Math.min(displayAgents.length - 1, i + 1));
      }
    }

    if (key.return) {
      if (currentPanel === 'runs' && selectedRun) {
        setFocusedPanel(1); // jump to agents panel
        setSelectedAgentIdx(0);
      }
    }
    if (key.escape) {
      setFocusedPanel(0); // back to runs
    }

    // Panel focus cycling
    if (key.tab && !key.shift) {
      setFocusedPanel(p => (p + 1) % PANELS.length);
    }
    if (key.tab && key.shift) {
      setFocusedPanel(p => (p - 1 + PANELS.length) % PANELS.length);
    }

    // Panel jump by number
    if (input === '1') setFocusedPanel(0);
    if (input === '2') setFocusedPanel(1);
    if (input === '3') setFocusedPanel(2);
    if (input === '4') setFocusedPanel(3);
    if (input === '5') setFocusedPanel(4);
    if (input === '6') setFocusedPanel(5);

    // Theme cycling
    if (input === 't') {
      const newTheme = cycleTheme();
      setThemeNameState(newTheme);
    }

    // Command mode
    if (input === ':') {
      controlRef.current.setMode(ControlMode.COMMAND);
      setControlMode(ControlMode.COMMAND);
    }

    if (input === 'r') setData(scanAllRuns());
    if (input === '?') setShowHelp(true);
    if (input === 'q') exit();
  });

  // Help overlay
  if (showHelp) {
    return e(Box, { flexDirection: 'column', width: cols },
      e(HelpOverlay, { visible: true }),
    );
  }

  // ── Header ──
  const header = e(Box, { borderStyle: 'double', borderColor: 'cyan', paddingX: 1 },
    totalRunning > 0 ? e(Text, { color: 'cyan' }, SPINNER[spinnerFrame], ' ') : e(Text, { color: 'green' }, '● '),
    e(Text, { bold: true, color: 'cyan' }, 'SWARM MONITOR'),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, null, `${data.active.length} active`),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: 'cyan' }, `${totalRunning} agents running`),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, null, `${totalAgents} total`),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: 'yellow' }, '~', formatCost(totalCost)),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { dimColor: true }, data.recent.length, ' recent'),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, null, formatElapsed(elapsed)),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: ipcSource === 'socket' ? 'green' : ipcSource === 'file' ? 'yellow' : 'red' },
      ipcSource === 'socket' ? 'IPC●' : ipcSource === 'file' ? 'FILE●' : 'IPC○'
    ),
    e(Text, { dimColor: true }, ' │ [', themeName, ']'),
  );

  // ── Panel tabs ──
  const panelTabs = e(Box, { paddingX: 1 },
    ...PANELS.map((name, i) =>
      e(Box, { key: name, marginRight: 1 },
        e(Text, {
          bold: i === focusedPanel,
          color: i === focusedPanel ? 'cyan' : 'gray',
          underline: i === focusedPanel,
        }, `${i + 1}:${PANEL_LABELS[name]}`)
      )
    ),
  );

  // ── Main panel content based on focused panel ──
  let mainContent;

  switch (currentPanel) {
    case 'agents': {
      const runAgents = displayAgents;
      const runLabel = selectedRun ? selectedRun.id : 'No run selected';
      if (layout.stackPanels) {
        mainContent = e(Box, { flexDirection: 'column' },
          e(Box, { paddingX: 1 },
            e(Text, { dimColor: true }, 'Run: '),
            e(Text, { bold: true }, runLabel),
            e(Text, { dimColor: true }, ` │ ${runAgents.length} agents`),
          ),
          e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
            ...runAgents.map((agent, i) =>
              e(AgentListItem, {
                key: agent.id,
                agent,
                selected: i === selectedAgentIdx,
                showSparkline: false,
              })
            ),
          ),
          selectedAgent
            ? e(AgentDetail, {
                agent: selectedAgent,
                barWidth: layout.barWidth,
                logLines: layout.logLines,
                showBarChart: layout.showBarChart,
                showCost: layout.showCost,
                width: cols - 4,
              })
            : null,
        );
      } else {
        mainContent = e(Box, { flexDirection: 'row' },
          e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', width: layout.sidebarWidth, paddingX: 1 },
            e(Text, { bold: true }, 'Agents: ', runLabel),
            ...runAgents.map((agent, i) =>
              e(AgentListItem, {
                key: agent.id,
                agent,
                selected: i === selectedAgentIdx,
                width: layout.sidebarWidth - 2,
                showSparkline: layout.showSparklines && i === selectedAgentIdx,
              })
            ),
          ),
          e(Box, { flexDirection: 'column', flexGrow: 1 },
            e(AgentDetail, {
              agent: selectedAgent,
              barWidth: layout.barWidth,
              logLines: layout.logLines,
              showBarChart: layout.showBarChart,
              showCost: layout.showCost,
              width: layout.mainWidth,
            }),
          ),
        );
      }
      break;
    }

    case 'chat':
      mainContent = e(ChatPanel, {
        workDir: selectedRun ? selectedRun.dir : undefined,
        socketPath: busAddress || undefined,
        height: Math.max(10, rows - 10),
      });
      break;

    case 'hierarchy':
      mainContent = e(HierarchyPanel, {
        hierarchy: hierarchyData,
        height: Math.max(10, rows - 10),
        focused: focusedPanel === 3,
      });
      break;

    case 'resources': {
      const runCount = selectedRun
        ? selectedRun.agents.filter(a => a.status === 'running').length
        : totalRunning;
      const doneCount = selectedRun
        ? selectedRun.agents.filter(a => a.status === 'done').length
        : allRuns.reduce((s, r) => s + r.agents.filter(a => a.status === 'done').length, 0);
      const failCount = selectedRun
        ? selectedRun.agents.filter(a => a.status === 'failed').length
        : allRuns.reduce((s, r) => s + r.agents.filter(a => a.status === 'failed').length, 0);

      mainContent = e(GovernorPanel, {
        utilization: normalizeUtilization({
          activeAgents: runCount,
          totalSpawned: totalAgents,
          totalCompleted: doneCount,
          totalFailed: failCount,
          worktreesInUse: 0,
          estimatedMemoryMB: runCount * 256,
          estimatedCost: totalCost,
          byLevel: new Map(),
        }),
        config: {
          maxConcurrentAgents: 10,
          maxWorktrees: 15,
          maxMemoryMB: 4096,
          maxTotalAgents: 20,
        },
        costBudget: 15.0,
        focused: focusedPanel === 4,
        barWidth: layout.barWidth,
      });
      break;
    }

    case 'merge': {
      // Use conflict data from selected run (scanned from conflicts.json)
      const runConflicts = selectedRun?.conflicts;
      const mergeState = runConflicts && Array.isArray(runConflicts) && runConflicts.length > 0
        ? normalizeMergeData({ files: runConflicts })
        : { files: [], resolutions: [], overallConfidence: 0, progress: { completed: 0, total: 0 } };
      mainContent = e(MergePanel, {
        files: mergeState.files,
        resolutions: mergeState.resolutions,
        overallConfidence: mergeState.overallConfidence,
        progress: mergeState.progress,
        focused: focusedPanel === 5,
        height: Math.max(10, rows - 10),
        barWidth: layout.barWidth,
      });
      break;
    }

    case 'runs':
    default: {
      const runsList = [];

      if (data.active.length > 0) {
        runsList.push(
          e(Box, { key: 'active-header', paddingX: 1 },
            e(Text, { bold: true }, 'Active Runs'),
          ),
          ...data.active.map((run, i) =>
            e(RunRow, {
              key: run.id,
              run,
              selected: currentPanel === 'runs' && i === selectedRunIdx,
            })
          ),
        );
      } else {
        runsList.push(
          e(Box, { key: 'empty', paddingX: 1 },
            e(Text, { dimColor: true }, 'No active runs. Watching ', SWARM_BASE, '/ …'),
          ),
        );
      }

      if (data.recent.length > 0) {
        runsList.push(
          e(Box, { key: 'recent-header', paddingX: 1, marginTop: 1 },
            e(Text, { bold: true, dimColor: true }, 'Recent (last 30 min)'),
          ),
          ...data.recent.map((run, i) => {
            const globalIdx = data.active.length + i;
            return e(RunRow, {
              key: run.id,
              run,
              selected: currentPanel === 'runs' && globalIdx === selectedRunIdx,
            });
          }),
        );
      }

      // Selected run preview
      if (selectedRun) {
        runsList.push(
          e(Box, {
            key: 'preview',
            flexDirection: 'column',
            marginTop: 1,
            borderStyle: 'single',
            borderColor: 'gray',
            paddingX: 1,
          },
            e(Box, null,
              e(Text, { bold: true }, 'Preview: '),
              e(Text, null, selectedRun.id),
              e(Text, { dimColor: true }, ` │ ${selectedRun.agentCount} agents`),
              selectedRun.verdict
                ? e(Text, { color: selectedRun.verdict === 'PASS' ? 'green' : 'red', bold: true }, ` │ ${selectedRun.verdict}`)
                : null,
            ),
            selectedRun.taskDesc
              ? e(Text, { dimColor: true, wrap: 'truncate' }, truncate(selectedRun.taskDesc, cols - 10))
              : null,
            e(Box, { flexWrap: 'wrap', marginTop: 1 },
              ...selectedRun.agents.slice(0, 8).map(agent =>
                e(Box, { key: agent.id, marginRight: 2 },
                  e(Text, { color: statusColor(agent.status) },
                    agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✗' : agent.status === 'running' ? '⟳' : '○'
                  ),
                  e(Text, { dimColor: true }, ' ', agent.id),
                )
              ),
              selectedRun.agents.length > 8
                ? e(Text, { dimColor: true }, `+${selectedRun.agents.length - 8} more`)
                : null,
            ),
          ),
        );
      }

      mainContent = e(Box, { flexDirection: 'column' }, ...runsList);
      break;
    }
  }

  // ── Footer: Control Panel ──
  const footer = e(ControlPanel, {
    mode: controlMode,
    inputText: controlInputText,
    activePanel: currentPanel,
    agentCount: totalAgents,
    statusMessage,
  });

  // ── Compose layout ──
  return e(Box, { flexDirection: 'column', width: cols },
    header,
    panelTabs,
    e(Box, { flexDirection: 'column', flexGrow: 1 },
      mainContent,
    ),
    footer,
  );
}

// ── Graceful shutdown ───────────────────────────────────────────

let _inkInstance = null;
let _shutdownRegistered = false;

function registerShutdownHandlers() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  const shutdown = () => {
    if (_inkInstance) {
      _inkInstance.unmount();
      _inkInstance = null;
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Entry point: programmatic start(config) ─────────────────────

/**
 * Start the monitor TUI programmatically.
 *
 * @param {object} [config]
 * @param {string} [config.busAddress] - IPC bus socket path
 * @param {string} [config.theme]      - Theme name: 'dark' | 'neon' | 'light'
 * @param {string} [config.mode]       - Display mode: 'dashboard' | 'monitor' | 'compact'
 * @returns {{ waitUntilExit: () => Promise<void>, unmount: () => void } | null}
 */
export function start(config = {}) {
  if (!process.stdout.isTTY) {
    printPlainSummary();
    return null;
  }

  if (config.theme) {
    setTheme(config.theme);
  }

  const instance = render(e(Monitor, {
    busAddress: config.busAddress || null,
    initialTheme: config.theme || null,
    initialMode: config.mode || 'monitor',
  }));
  _inkInstance = instance;
  registerShutdownHandlers();

  return {
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

/**
 * Start the monitor (legacy entry point, delegates to start()).
 *
 * @returns {{ waitUntilExit: () => Promise<void> } | null}
 */
export function startMonitor() {
  const cliArgs = parseCliArgs();
  return start({
    busAddress: cliArgs.busAddress,
    theme: cliArgs.theme,
    mode: cliArgs.mode,
  });
}

/**
 * Monitor — Standalone Ink TUI for observing ALL active swarm runs.
 *
 * Run via: swarm --monitor
 *
 * Scans /tmp/swarm/ every 2s, discovers active runs, reads their
 * decompose/progress/result files, and renders a live overview grid.
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { AgentCard } from './agent-card.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { useState, useEffect } = React;
const e = React.createElement;

const SWARM_BASE = '/tmp/swarm';
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;   // 5 min — considered "active"
const RECENT_THRESHOLD_MS = 30 * 60 * 1000;   // 30 min — shown in "recent" section

// ── Filesystem scanning ─────────────────────────────────────────

/**
 * Safely read and parse a JSON file. Returns null on any error.
 */
function safeReadJSON(filepath) {
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get the newest mtime of any file in a directory (non-recursive).
 */
function newestMtime(dirPath) {
  try {
    const files = readdirSync(dirPath);
    let newest = 0;
    for (const f of files) {
      try {
        const mt = statSync(join(dirPath, f)).mtimeMs;
        if (mt > newest) newest = mt;
      } catch { /* skip unreadable files */ }
    }
    return newest;
  } catch {
    return 0;
  }
}

/**
 * Scan a single run directory and return a structured run object.
 */
function scanRun(runId, runDir) {
  const now = Date.now();
  const newest = newestMtime(runDir);
  const age = now - newest;

  // Determine activity level
  const activity = age < ACTIVE_THRESHOLD_MS ? 'active'
    : age < RECENT_THRESHOLD_MS ? 'recent'
    : 'stale';

  // Read decompose.json for task info
  const decompose = safeReadJSON(join(runDir, 'decompose.json'));

  // Read scout.json for project summary
  const scout = safeReadJSON(join(runDir, 'scout.json'));

  // Read verify-result.json
  const verifyResult = safeReadJSON(join(runDir, 'verify-result.json'));

  // Scan for agent files
  const agents = [];
  let files;
  try { files = readdirSync(runDir); } catch { files = []; }

  // Collect progress and result files
  const progressFiles = files.filter(f => f.endsWith('.progress.json'));
  const resultFiles = files.filter(f => f.endsWith('-result.json') && !f.startsWith('verify'));
  const stageFiles = files.filter(f => f.startsWith('stage-') && f.endsWith('-result.json'));

  // Build agent map from result files (completed agents)
  const agentMap = new Map();
  for (const file of resultFiles) {
    const agentId = file.replace(/-result\.json$/, '');
    const data = safeReadJSON(join(runDir, file));
    if (!data) continue;
    agentMap.set(agentId, {
      id: agentId,
      status: data.status === 'completed' ? 'done' : data.status === 'timeout' ? 'timeout' : 'failed',
      exitCode: data.exit_code,
      durationMs: data.duration_ms,
      toolCalls: data.telemetry?.tool_calls?.total || 0,
      model: data.model,
      output: (data.output || '').slice(0, 200),
    });
  }

  // Overlay progress files (in-flight agents)
  for (const file of progressFiles) {
    const agentId = file
      .replace(/-result\.json\.progress\.json$/, '')
      .replace(/\.progress\.json$/, '')
      .replace(/-result\.json/, '');

    // Don't overwrite terminal states
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

  // Sort agents: running first, then done, then failed
  const statusOrder = { running: 0, pending: 1, done: 2, timeout: 3, failed: 4 };
  const sortedAgents = Array.from(agentMap.values()).sort(
    (a, b) => (statusOrder[a.status] || 5) - (statusOrder[b.status] || 5)
  );

  // Determine run status
  let runStatus = 'idle';
  if (sortedAgents.some(a => a.status === 'running')) {
    runStatus = 'running';
  } else if (sortedAgents.length > 0 && sortedAgents.every(a => a.status === 'done' || a.status === 'failed' || a.status === 'timeout')) {
    runStatus = sortedAgents.some(a => a.status === 'failed') ? 'failed' : 'completed';
  }

  // Extract verification verdict
  let verdict = null;
  if (verifyResult) {
    const match = (verifyResult.output || '').match(/VERDICT:\s*(PASS|FAIL|NEEDS_REWORK)/i);
    verdict = match ? match[1] : null;
  }

  // Get task description
  let taskDesc = null;
  if (decompose) {
    if (typeof decompose.task === 'string') taskDesc = decompose.task;
    else if (Array.isArray(decompose) && decompose[0]?.task) taskDesc = decompose[0].task;
  }

  return {
    id: runId,
    dir: runDir,
    activity,
    status: runStatus,
    taskDesc,
    agents: sortedAgents,
    agentCount: sortedAgents.length,
    stages: stageFiles.length,
    verdict,
    scoutDone: !!scout,
    newestMtime: newest,
  };
}

/**
 * Scan all runs in SWARM_BASE. Returns { active: [], recent: [] }.
 */
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
    // stale runs are ignored
  }

  // Sort: running first, then by newest mtime descending
  const byActivity = (a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.newestMtime - a.newestMtime;
  };
  active.sort(byActivity);
  recent.sort(byActivity);

  return { active, recent };
}

// ── Plain text fallback (non-TTY) ───────────────────────────────

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
      process.stdout.write(`\n[${run.id}] ${run.status.toUpperCase()} — ${run.agentCount} agents (${running} running, ${done} done, ${failed} failed)\n`);
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
      process.stdout.write(`[${run.id}] ${run.status.toUpperCase()} — ${done} done, ${failed} failed${run.verdict ? ` — ${run.verdict}` : ''}\n`);
    }
  }

  process.stdout.write('\n');
}

// ── Ink components ──────────────────────────────────────────────

/**
 * Compact run summary row (for recent completed section).
 */
function RunSummaryRow({ run }) {
  const done = run.agents.filter(a => a.status === 'done').length;
  const failed = run.agents.filter(a => a.status === 'failed').length;
  const verdictColor = run.verdict === 'PASS' ? 'green' : run.verdict === 'FAIL' ? 'red' : 'yellow';

  return e(Box, { paddingX: 1 },
    e(Text, { dimColor: true }, run.id),
    e(Text, { dimColor: true }, ' | '),
    e(Text, { color: run.status === 'completed' ? 'green' : 'red' }, run.status),
    e(Text, { dimColor: true }, ' | '),
    e(Text, null, `${done}/${run.agentCount} done`),
    failed > 0 ? e(Text, { color: 'red' }, ` ${failed} failed`) : null,
    run.verdict ? e(Text, null, ' ') : null,
    run.verdict ? e(Text, { color: verdictColor, bold: true }, run.verdict) : null
  );
}

/**
 * A single active run panel with header + agent grid.
 */
function RunPanel({ run }) {
  const running = run.agents.filter(a => a.status === 'running').length;
  const done = run.agents.filter(a => a.status === 'done').length;
  const failed = run.agents.filter(a => a.status === 'failed').length;

  const statusColor = run.status === 'running' ? 'cyan'
    : run.status === 'completed' ? 'green'
    : run.status === 'failed' ? 'red' : 'gray';

  return e(Box, { flexDirection: 'column', marginBottom: 1 },
    // Run header
    e(Box, { borderStyle: 'single', paddingX: 1 },
      e(Text, { bold: true, color: statusColor }, run.id),
      e(Text, { dimColor: true }, ' | '),
      e(Text, { color: 'green' }, String(done), ' done'),
      e(Text, { dimColor: true }, ' '),
      e(Text, { color: 'cyan' }, String(running), ' running'),
      e(Text, { dimColor: true }, ' '),
      e(Text, { color: 'red' }, String(failed), ' failed'),
      run.verdict
        ? e(Text, null, ' | ',
            e(Text, { bold: true, color: run.verdict === 'PASS' ? 'green' : run.verdict === 'FAIL' ? 'red' : 'yellow' }, run.verdict))
        : null
    ),
    // Task description (truncated)
    run.taskDesc
      ? e(Box, { paddingX: 1 },
          e(Text, { dimColor: true, wrap: 'truncate' }, run.taskDesc.slice(0, 120)))
      : null,
    // Agent cards grid
    e(Box, { flexWrap: 'wrap' },
      run.agents.map(agent =>
        e(AgentCard, { key: agent.id, agent, focused: false })
      )
    )
  );
}

/**
 * Main Monitor component.
 */
function Monitor() {
  const { exit } = useApp();
  const [data, setData] = useState({ active: [], recent: [] });
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  // Poll filesystem every 2s
  useEffect(() => {
    const refresh = () => {
      setData(scanAllRuns());
      setLastRefresh(Date.now());
    };
    refresh(); // initial scan
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);

  // Keyboard
  useInput((input) => {
    if (input === 'q') exit();
    if (input === 'r') {
      setData(scanAllRuns());
      setLastRefresh(Date.now());
    }
  });

  const totalActive = data.active.length;
  const totalRecent = data.recent.length;
  const totalRunning = data.active.reduce(
    (sum, r) => sum + r.agents.filter(a => a.status === 'running').length, 0
  );
  const refreshAgo = Math.round((Date.now() - lastRefresh) / 1000);

  return e(Box, { flexDirection: 'column' },
    // ── Header ──
    e(Box, { borderStyle: 'double', paddingX: 1 },
      e(Text, { bold: true, color: 'cyan' }, 'SWARM MONITOR'),
      e(Text, { dimColor: true }, ' | '),
      e(Text, null, `${totalActive} active run${totalActive !== 1 ? 's' : ''}`),
      e(Text, { dimColor: true }, ' | '),
      e(Text, { color: 'cyan' }, `${totalRunning} agents running`),
      e(Text, { dimColor: true }, ' | '),
      e(Text, { dimColor: true }, `${totalRecent} recent`),
      e(Text, { dimColor: true }, ' | '),
      e(Text, { dimColor: true }, `updated ${refreshAgo}s ago`)
    ),

    // ── Active runs ──
    totalActive > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          data.active.map(run =>
            e(RunPanel, { key: run.id, run })
          )
        )
      : e(Box, { paddingX: 1, marginTop: 1 },
          e(Text, { dimColor: true }, totalRunning === 0 && totalRecent === 0
            ? 'No active swarm runs. Watching /tmp/swarm/ ...'
            : 'No currently active runs.')
        ),

    // ── Recent completed runs ──
    totalRecent > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Box, { paddingX: 1 },
            e(Text, { bold: true, dimColor: true }, 'Recent (last 30 min):')
          ),
          ...data.recent.map(run =>
            e(RunSummaryRow, { key: run.id, run })
          )
        )
      : null,

    // ── Footer ──
    e(Box, { marginTop: 1, paddingX: 1 },
      e(Text, { dimColor: true }, 'q: quit  r: refresh  |  Scanning ', SWARM_BASE, '/')
    )
  );
}

// ── Entry point ─────────────────────────────────────────────────

export function startMonitor() {
  // Non-TTY fallback: print plain text and exit
  if (!process.stdout.isTTY) {
    printPlainSummary();
    return null;
  }

  const instance = render(e(Monitor));

  return {
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

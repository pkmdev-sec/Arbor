/**
 * Monitor — Standalone TUI for observing ALL active swarm runs.
 *
 * Run via: swarm --monitor
 *
 * Enhanced features:
 * - Run selector for multiple active runs
 * - Expanded agent detail for selected run
 * - Sparklines and tool breakdowns
 * - Responsive layout with keyboard navigation
 * - Auto-discovery of new runs in /tmp/swarm/
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentListItem, AgentDetail } from './agent-card.mjs';
import { HelpOverlay } from './help-overlay.mjs';
import { useTerminalSize } from './layout.mjs';
import { estimateTotalCost, formatCost } from './cost-tracker.mjs';
import { statusColor, formatElapsed, truncate } from './theme.mjs';

const { useState, useEffect } = React;
const e = React.createElement;

const SWARM_BASE = '/tmp/swarm';
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const RECENT_THRESHOLD_MS = 30 * 60 * 1000;

// ── Filesystem scanning ─────────────────────────────────────────

function safeReadJSON(filepath) {
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
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

function scanRun(runId, runDir) {
  const now = Date.now();
  const newest = newestMtime(runDir);
  const age = now - newest;

  const activity = age < ACTIVE_THRESHOLD_MS ? 'active'
    : age < RECENT_THRESHOLD_MS ? 'recent' : 'stale';

  const decompose = safeReadJSON(join(runDir, 'decompose.json'));
  const verifyResult = safeReadJSON(join(runDir, 'verify-result.json'));

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
 * Recent completed run (compact row).
 */
function RecentRow({ run }) {
  const done = run.agents.filter(a => a.status === 'done').length;
  const failed = run.agents.filter(a => a.status === 'failed').length;
  const verdictColor = run.verdict === 'PASS' ? 'green' : run.verdict === 'FAIL' ? 'red' : 'yellow';

  return e(Box, { paddingX: 2 },
    e(Text, { dimColor: true }, run.id),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: run.status === 'completed' ? 'green' : 'red' }, run.status),
    e(Text, { dimColor: true }, ` ${done}/${run.agentCount}`),
    failed > 0 ? e(Text, { color: 'red' }, ` ${failed}✗`) : null,
    e(Text, { dimColor: true }, ' ~', formatCost(run.totalCost)),
    run.verdict ? e(Text, { color: verdictColor, bold: true }, ' ', run.verdict) : null,
  );
}

/**
 * Main Monitor component with run selection and detail view.
 */
function Monitor() {
  const { exit } = useApp();
  const { cols, rows, layout } = useTerminalSize();
  const [data, setData] = useState({ active: [], recent: [] });
  const [selectedRunIdx, setSelectedRunIdx] = useState(0);
  const [selectedAgentIdx, setSelectedAgentIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [viewMode, setViewMode] = useState('runs'); // 'runs' or 'agents'
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  // Poll filesystem
  useEffect(() => {
    const refresh = () => setData(scanAllRuns());
    refresh();
    const timer = setInterval(refresh, 2000);
    const spinner = setInterval(() => setSpinnerFrame(f => (f + 1) % SPINNER.length), 80);
    return () => {
      clearInterval(timer);
      clearInterval(spinner);
    };
  }, []);

  const allRuns = [...data.active, ...data.recent];
  const selectedRun = allRuns[selectedRunIdx] || null;
  const selectedAgent = selectedRun ? selectedRun.agents[selectedAgentIdx] : null;

  // Total stats
  const totalRunning = data.active.reduce(
    (sum, r) => sum + r.agents.filter(a => a.status === 'running').length, 0
  );
  const totalAgents = allRuns.reduce((sum, r) => sum + r.agentCount, 0);
  const totalCost = allRuns.reduce((sum, r) => sum + r.totalCost, 0);

  // Keyboard
  useInput((input, key) => {
    if (showHelp) {
      setShowHelp(false);
      return;
    }

    if (key.upArrow || input === 'k') {
      if (viewMode === 'runs') {
        setSelectedRunIdx(i => Math.max(0, i - 1));
        setSelectedAgentIdx(0);
      } else {
        setSelectedAgentIdx(i => Math.max(0, i - 1));
      }
    }
    if (key.downArrow || input === 'j') {
      if (viewMode === 'runs') {
        setSelectedRunIdx(i => Math.min(allRuns.length - 1, i + 1));
        setSelectedAgentIdx(0);
      } else if (selectedRun) {
        setSelectedAgentIdx(i => Math.min(selectedRun.agents.length - 1, i + 1));
      }
    }

    if (key.return) {
      if (viewMode === 'runs' && selectedRun) {
        setViewMode('agents');
        setSelectedAgentIdx(0);
      }
    }
    if (key.escape || (input === 'h' && viewMode === 'agents')) {
      setViewMode('runs');
    }

    if (key.tab) {
      setViewMode(v => v === 'runs' ? 'agents' : 'runs');
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
  );

  // ── Agents view (drill-in to a run) ──
  if (viewMode === 'agents' && selectedRun) {
    const runAgents = selectedRun.agents;

    if (layout.stackPanels) {
      // Minimal stacked layout
      return e(Box, { flexDirection: 'column', width: cols },
        header,
        // Breadcrumb
        e(Box, { paddingX: 1 },
          e(Text, { dimColor: true }, 'Run: '),
          e(Text, { bold: true }, selectedRun.id),
          e(Text, { dimColor: true }, ' │ Esc/h: back to runs'),
        ),
        // Agent list
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
        // Selected agent detail
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
        // Footer
        e(Box, { paddingX: 1 },
          e(Text, { dimColor: true }, '↑↓/jk: navigate  Esc/h: back  Tab: switch  ?:help  q:quit'),
        ),
      );
    }

    // Side-by-side agents view
    return e(Box, { flexDirection: 'column', width: cols },
      header,
      // Breadcrumb
      e(Box, { paddingX: 1 },
        e(Text, { dimColor: true }, 'Run: '),
        e(Text, { bold: true }, selectedRun.id),
        selectedRun.taskDesc
          ? e(Text, { dimColor: true }, ' │ ', truncate(selectedRun.taskDesc, 60))
          : null,
        e(Text, { dimColor: true }, ' │ Esc/h: back'),
      ),
      // Side-by-side
      e(Box, { flexDirection: 'row' },
        // Agent list sidebar
        e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', width: layout.sidebarWidth, paddingX: 1 },
          e(Text, { bold: true }, 'Agents'),
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
        // Detail panel
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
      ),
      // Footer
      e(Box, { paddingX: 1 },
        e(Text, { dimColor: true }, '↑↓/jk: navigate agents  Esc/h: back to runs  Tab: switch  ?:help  q:quit'),
      ),
    );
  }

  // ── Runs view (default) ──
  return e(Box, { flexDirection: 'column', width: cols },
    header,

    // Active runs
    data.active.length > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Box, { paddingX: 1 },
            e(Text, { bold: true }, 'Active Runs'),
          ),
          ...data.active.map((run, i) =>
            e(RunRow, {
              key: run.id,
              run,
              selected: viewMode === 'runs' && i === selectedRunIdx,
            })
          ),
        )
      : e(Box, { paddingX: 1, marginTop: 1 },
          e(Text, { dimColor: true }, 'No active runs. Watching ', SWARM_BASE, '/ …'),
        ),

    // Recent completed runs
    data.recent.length > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Box, { paddingX: 1 },
            e(Text, { bold: true, dimColor: true }, 'Recent (last 30 min)'),
          ),
          ...data.recent.map((run, i) => {
            const globalIdx = data.active.length + i;
            return e(RunRow, {
              key: run.id,
              run,
              selected: viewMode === 'runs' && globalIdx === selectedRunIdx,
            });
          }),
        )
      : null,

    // Selected run preview
    selectedRun
      ? e(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
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
          // Mini agent list
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
        )
      : null,

    // Footer
    e(Box, { marginTop: 1, paddingX: 1 },
      e(Text, { dimColor: true }, '↑↓/jk: select run  Enter: drill in  r: refresh  ?:help  q:quit'),
    ),
  );
}

// ── Entry point ─────────────────────────────────────────────────

export function startMonitor() {
  if (!process.stdout.isTTY) {
    printPlainSummary();
    return null;
  }

  const instance = render(e(Monitor));

  return {
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

/**
 * Dashboard — Multi-panel TUI Command Center for real-time swarm monitoring.
 *
 * Layout:
 *   ┌─── Header (mode, agents, elapsed, spinner) ─────────────────┐
 *   │ Agent List (sidebar)  │  Agent Detail (main panel)          │
 *   │  ► agent-01   12s     │  ✓ agent-01  DONE                  │
 *   │    agent-02    8s     │  Model: sonnet  Time: 42s           │
 *   │    agent-03   ···     │  Cost: ~$0.024                      │
 *   │    ▁▂▃▅▇▅▃▁          │  Tool Breakdown                     │
 *   │                       │  Read  ████████░░ 42                │
 *   │  Cost: ~$0.05        │  Bash  █████░░░░░ 28                │
 *   │  Tokens: ~12k        │                                     │
 *   │                       │  ┌─ Logs ────────────────────┐      │
 *   │                       │  │ last 12 lines of output   │      │
 *   │                       │  └───────────────────────────┘      │
 *   ├─── Status Bar (keyboard shortcuts) ─────────────────────────┤
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Keyboard: ↑↓/jk=navigate  Tab=panel  l=logs  c=cancel  ?=help  q=quit
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { createProgressWatcher } from './progress-reader.mjs';
import { AgentListItem, AgentDetail } from './agent-card.mjs';
import { HelpOverlay } from './help-overlay.mjs';
import { useTerminalSize } from './layout.mjs';
import { estimateTotalCost, formatCost } from './cost-tracker.mjs';
import { statusColor, formatElapsed, STATUS_ICONS } from './theme.mjs';
import { ChatPanel } from './chat-panel.mjs';

const { useState, useEffect, useCallback, useRef } = React;
const e = React.createElement;

// ── Panel focus management ────────────────────────────────────────

const PANELS = ['agents', 'detail', 'logs'];

// ── Spinner frames (animated) ─────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Main Dashboard Component ──────────────────────────────────────

function Dashboard({ workDir, agents: agentConfigs, mode, task }) {
  const { exit } = useApp();
  const { cols, rows, layout } = useTerminalSize();

  // ── State ──
  const [agents, setAgents] = useState(new Map());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [focusedPanel, setFocusedPanel] = useState(0); // index into PANELS
  const [showHelp, setShowHelp] = useState(false);
  const [fullScreenLog, setFullScreenLog] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Watcher ref for cleanup
  const watcherRef = useRef(null);

  // ── Setup watcher + timers ──
  useEffect(() => {
    const watcher = createProgressWatcher(workDir, 1000);
    watcherRef.current = watcher;

    const handleUpdate = (agent) => {
      setAgents(prev => {
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });
    };

    watcher.on('agent-update', handleUpdate);
    watcher.on('agent-complete', handleUpdate);

    // Elapsed timer
    const elapsedTimer = setInterval(() => setElapsed(Date.now() - startTime), 1000);

    // Spinner animation
    const spinnerTimer = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      watcher.stop();
      clearInterval(elapsedTimer);
      clearInterval(spinnerTimer);
    };
  }, [workDir, startTime]);

  // ── Pre-populate agent slots from configs ──
  useEffect(() => {
    if (agentConfigs && agentConfigs.length > 0) {
      setAgents(prev => {
        const next = new Map(prev);
        for (const cfg of agentConfigs) {
          if (!next.has(cfg.id)) {
            next.set(cfg.id, {
              id: cfg.id,
              status: 'pending',
              subtask: cfg.subtask || cfg.task || '',
              model: cfg.model || '',
              toolCalls: 0,
              elapsedMs: 0,
            });
          }
        }
        return next;
      });
    }
  }, [agentConfigs]);

  // ── Derived data ──
  const agentList = Array.from(agents.values());
  const selected = agentList[selectedIdx];
  const doneCount = agentList.filter(a => a.status === 'done').length;
  const failCount = agentList.filter(a => a.status === 'failed').length;
  const runCount = agentList.filter(a => a.status === 'running').length;
  const pendCount = agentList.filter(a => a.status === 'pending').length;
  const isRunning = runCount > 0 || pendCount > 0;

  // Cost estimation
  const { totalCost } = estimateTotalCost(agentList);

  // ── Keyboard handling ──
  useInput((input, key) => {
    if (showHelp) {
      // Any key dismisses help
      setShowHelp(false);
      return;
    }

    // Navigation
    if (key.upArrow || input === 'k') {
      setSelectedIdx(i => Math.max(0, i - 1));
    }
    if (key.downArrow || input === 'j') {
      setSelectedIdx(i => Math.min(agentList.length - 1, i + 1));
    }

    // Panel focus
    if (key.tab && !key.shift) {
      setFocusedPanel(p => (p + 1) % PANELS.length);
    }
    if (key.tab && key.shift) {
      setFocusedPanel(p => (p - 1 + PANELS.length) % PANELS.length);
    }

    // Panel jump
    if (input === '1') setFocusedPanel(0);
    if (input === '2') setFocusedPanel(1);
    if (input === '3') setFocusedPanel(2);

    // Actions
    if (input === 'l') setFullScreenLog(v => !v);
    if (input === 'i') setShowChat(v => !v);
    if (input === '?') setShowHelp(true);
    if (input === 'r') {
      // Force refresh — the watcher will pick up changes on next poll
      setElapsed(Date.now() - startTime);
    }
    if (input === 'q') exit();

    // Cancel agent (send SIGTERM via pid if available)
    if (input === 'c' && selected && selected.pid) {
      try {
        process.kill(selected.pid, 'SIGTERM');
      } catch {
        // Agent may already be dead
      }
    }
  });

  // ── Full-screen log mode ──
  if (fullScreenLog) {
    return e(Box, { flexDirection: 'column', width: cols },
      // Mini header
      e(Box, { paddingX: 1 },
        e(Text, { bold: true, color: 'cyan' }, 'LOGS: '),
        e(Text, { bold: true }, selected ? selected.id : 'none'),
        e(Text, { dimColor: true }, '  Press l to exit, ↑↓ to switch agent'),
      ),
      // Full log
      e(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', borderColor: 'cyan', paddingX: 1 },
        ...(selected && selected.output
          ? selected.output.split('\n').slice(-Math.max(rows - 6, 10)).map((line, i) =>
              e(Text, { key: i, wrap: 'truncate' }, line || ' ')
            )
          : [e(Text, { key: 'empty', dimColor: true }, 'No output available')]
        ),
      ),
      // Footer
      e(Box, { paddingX: 1 },
        e(Text, { dimColor: true }, 'l: exit fullscreen  ↑↓/jk: switch agent  q: quit'),
      ),
    );
  }

  // ── Help overlay ──
  if (showHelp) {
    return e(Box, { flexDirection: 'column', width: cols },
      e(HelpOverlay, { visible: true }),
    );
  }

  // ── Normal dashboard layout ──

  // Build status bar shortcuts based on focused panel
  const panelShortcuts = {
    agents: '↑↓/jk: navigate  Enter: detail  Tab: next panel',
    detail: 'l: fullscreen logs  c: cancel  Tab: next panel',
    logs:   'l: fullscreen  Tab: next panel',
  };
  const currentShortcuts = panelShortcuts[PANELS[focusedPanel]] || '';

  // ── HEADER ──
  const header = e(Box, { borderStyle: 'single', borderColor: 'cyan', paddingX: 1, width: '100%' },
    // Spinner
    isRunning
      ? e(Text, { color: 'cyan' }, SPINNER_FRAMES[spinnerFrame], ' ')
      : e(Text, { color: 'green' }, '● '),
    // Title
    e(Text, { bold: true, color: 'cyan' }, 'SWARM'),
    e(Text, { dimColor: true }, ' │ '),
    // Mode
    e(Text, null, mode || 'parallel'),
    e(Text, { dimColor: true }, ' │ '),
    // Agent counts
    e(Text, { color: 'green' }, String(doneCount), '✓'),
    e(Text, null, ' '),
    e(Text, { color: 'yellow' }, String(runCount), '⟳'),
    e(Text, null, ' '),
    e(Text, { color: 'red' }, String(failCount), '✗'),
    pendCount > 0 ? e(Text, { dimColor: true }, ` ${pendCount}○`) : null,
    e(Text, { dimColor: true }, ' │ '),
    // Elapsed
    e(Text, null, formatElapsed(elapsed)),
    // Cost
    layout.showCost
      ? e(Text, null,
          e(Text, { dimColor: true }, ' │ '),
          e(Text, { color: 'yellow' }, '~', formatCost(totalCost))
        )
      : null,
    // Task (truncated)
    task
      ? e(Text, null,
          e(Text, { dimColor: true }, ' │ '),
          e(Text, { dimColor: true, wrap: 'truncate' }, task.slice(0, Math.max(20, cols - 60)))
        )
      : null,
  );

  // ── SIDEBAR: Agent list ──
  const sidebar = e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focusedPanel === 0 ? 'cyan' : 'gray',
    width: layout.sidebarWidth,
    paddingX: 1,
  },
    // Title
    e(Box, null,
      e(Text, { bold: true, dimColor: focusedPanel !== 0 }, 'Agents'),
      e(Text, { dimColor: true }, ` (${agentList.length})`),
    ),

    // Agent list
    ...agentList.map((agent, i) =>
      e(AgentListItem, {
        key: agent.id,
        agent,
        selected: i === selectedIdx,
        width: layout.sidebarWidth - 2,
        showSparkline: layout.showSparklines && i === selectedIdx,
      })
    ),

    // Cost summary at bottom
    e(Box, { marginTop: 1 },
      e(Text, { dimColor: true }, '~', formatCost(totalCost)),
      e(Text, { dimColor: true }, ' est.'),
    ),
  );

  // ── MAIN: Agent detail panel or IPC chat ──
  const detail = showChat
    ? e(ChatPanel, { workDir, height: Math.max(10, rows - 8) })
    : e(AgentDetail, {
        agent: selected,
        barWidth: layout.barWidth,
        logLines: layout.logLines,
        fullScreenLog: false,
        showBarChart: layout.showBarChart,
        showCost: layout.showCost,
        width: layout.mainWidth,
      });

  // ── FOOTER: Status bar ──
  const chatIndicator = showChat ? ' [CHAT]' : '';
  const footer = e(Box, { paddingX: 1, width: '100%' },
    e(Text, { dimColor: true },
      currentShortcuts,
      '  i:chat  ?:help  q:quit'
    ),
    showChat ? e(Text, { color: 'cyan', bold: true }, chatIndicator) : null,
    e(Text, { dimColor: true }, `  ${cols}×${rows}`)
  );

  // ── Compose layout ──
  if (layout.stackPanels) {
    // Minimal/stacked layout
    return e(Box, { flexDirection: 'column', width: cols },
      header,
      sidebar,
      e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: focusedPanel === 1 ? 'cyan' : 'gray', paddingX: 1 },
        detail,
      ),
      footer,
    );
  }

  // Full/compact layout: side-by-side
  return e(Box, { flexDirection: 'column', width: cols },
    header,
    e(Box, { flexDirection: 'row' },
      sidebar,
      e(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', borderColor: focusedPanel === 1 ? 'cyan' : 'gray' },
        detail,
      ),
    ),
    footer,
  );
}

// ── Entry point ───────────────────────────────────────────────────

/**
 * Start the TUI dashboard. Returns { unmount, waitUntilExit } or null if non-TTY.
 *
 * @param {object} opts
 * @param {string} opts.workDir  - Swarm run directory
 * @param {Array}  opts.agents   - Agent configurations for pre-population
 * @param {string} opts.mode     - Swarm mode (parallel, swarm, pipeline, etc.)
 * @param {string} [opts.task]   - Task description
 * @param {string} [opts.depth]  - Execution depth
 */
export function startDashboard({ workDir, agents, mode, task, depth }) {
  if (!process.stdout.isTTY) {
    return null;
  }

  const instance = render(
    e(Dashboard, { workDir, agents, mode, task, depth })
  );

  return {
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

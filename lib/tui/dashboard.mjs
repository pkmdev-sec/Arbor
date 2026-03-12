/**
 * Dashboard — Multi-panel TUI Command Center for real-time swarm monitoring.
 *
 * Enhanced layout with new panels:
 *   ┌─── Header (mode, agents, elapsed, spinner, theme, connection) ───┐
 *   │ Agent List  │  Main Panel (agents/hierarchy/resources/merge/chat) │
 *   │  ★ Main Ses │  [Content varies by focused panel]                  │
 *   │  ► agent-01 │  [Output scrollable with ↑↓ when focused]          │
 *   │    agent-02 │                                                     │
 *   ├─── Control Panel (status bar / input modes) ──────────────────────┤
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Fixes applied:
 *   FIX 1: Scrollable agent output — Enter toggles detail focus, ↑↓ scroll
 *   FIX 2: Main Session as root — shows current process as orchestrator
 *   FIX 3: Real-time header metrics with connection status dot
 *   FIX 4: File-based fallback data via DataPoller
 *   FIX 5: Tab switching with number keys, scroll preservation
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createProgressWatcher } from './progress-reader.mjs';
import { AgentListItem, AgentDetail, sortAgents, SORT_MODES } from './agent-card.mjs';
import { HelpOverlay } from './help-overlay.mjs';
import { useTerminalSize } from './layout.mjs';
import { estimateTotalCost, formatCost } from './cost-tracker.mjs';
import {
  statusColor, formatElapsed, STATUS_ICONS,
  cycleTheme, getThemeName, setTheme,
} from './theme.mjs';
import { ChatPanel } from './chat-panel.mjs';
import { HierarchyPanel, buildHierarchyTree } from './hierarchy-panel.mjs';
import { GovernorPanel, normalizeUtilization } from './governor-panel.mjs';
import { MergePanel, normalizeMergeData } from './merge-panel.mjs';
import { ControlPanel, ControlMode, createControlState, parseCommand, executeCommand } from './control-panel.mjs';
import { createDataPoller } from './data-poller.mjs';

const { useState, useEffect, useCallback, useRef } = React;
const e = React.createElement;

// ── Panel definitions ────────────────────────────────────────────

const PANELS = ['agents', 'messages', 'hierarchy', 'resources', 'merge', 'logs'];
const PANEL_LABELS = {
  agents:    'Agents',
  messages:  'Chat',
  hierarchy: 'Hierarchy',
  resources: 'Resources',
  merge:     'Merge',
  logs:      'Logs',
};

// ── Spinner frames (animated) ─────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Main Session factory ─────────────────────────────────────────

/**
 * Create a "Main Session" entry representing the current running process.
 * This is always pinned at position 0 in the agent list.
 */
function createMainSession(elapsed) {
  return {
    id: 'Main Session',
    status: 'running',
    model: process.env.CLAUDE_MODEL || 'opus',
    level: 0,
    toolCalls: 0,
    elapsedMs: elapsed,
    pid: process.pid,
    worktreePath: process.cwd(),
    isMainSession: true,
    subtask: `PID ${process.pid} — ${process.cwd()}`,
  };
}

// ── Main Dashboard Component ──────────────────────────────────────

function Dashboard({ workDir, agents: agentConfigs, mode, task, depth, busAddress, initialTheme }) {
  const { exit } = useApp();
  const { cols, rows, layout } = useTerminalSize();

  // Apply initial theme
  if (initialTheme) setTheme(initialTheme);

  // ── State ──
  const [agents, setAgents] = useState(new Map());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [focusedPanel, setFocusedPanel] = useState(0);
  const [detailFocused, setDetailFocused] = useState(false); // FIX 1: output scroll focus
  const [showHelp, setShowHelp] = useState(false);
  const [fullScreenLog, setFullScreenLog] = useState(false);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [themeName, setThemeNameState] = useState(getThemeName());
  const [sortMode, setSortMode] = useState('status');
  const [connectionStatus, setConnectionStatus] = useState('polling'); // FIX 3

  // Hierarchy state
  const [hierarchyData, setHierarchyData] = useState([]);
  const [hierarchyCollapsed, setHierarchyCollapsed] = useState(new Set());

  // Governor state
  const [utilization, setUtilization] = useState(null);
  const [governorConfig, setGovernorConfig] = useState(null);
  const [budgetLog, setBudgetLog] = useState([]);
  const [throughputValues, setThroughputValues] = useState([]);

  // Merge state
  const [mergeData, setMergeData] = useState({ files: [], resolutions: [], overallConfidence: 0, progress: { completed: 0, total: 0 } });

  // Control panel state
  const controlRef = useRef(createControlState());
  const [controlMode, setControlMode] = useState(ControlMode.STATUS);
  const [controlInputText, setControlInputText] = useState('');
  const [controlTargetAgent, setControlTargetAgent] = useState('all');
  const [controlFilterType, setControlFilterType] = useState('agent');
  const [controlActiveFilters, setControlActiveFilters] = useState([]);
  const [statusMessage, setStatusMessage] = useState('');

  // Watcher ref for cleanup
  const watcherRef = useRef(null);
  const pollerRef = useRef(null);

  // ── Setup watcher + timers + DataPoller (FIX 4) ──
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

    // FIX 4: Start DataPoller as fallback data source
    const poller = createDataPoller();
    pollerRef.current = poller;

    poller.on('agents', (polledAgents) => {
      setAgents(prev => {
        const next = new Map(prev);
        for (const agent of polledAgents) {
          // Only add agents we don't already know about from the primary watcher
          if (!next.has(agent.id)) {
            next.set(agent.id, agent);
          } else {
            // Enrich existing entries with all available poller data
            const existing = next.get(agent.id);
            const enriched = { ...existing };
            if (agent.worktreePath && !existing.worktreePath) enriched.worktreePath = agent.worktreePath;
            if (agent.branch && !existing.branch) enriched.branch = agent.branch;
            if (agent.pid && !existing.pid) enriched.pid = agent.pid;
            if (agent.cpu != null) enriched.cpu = agent.cpu;
            if (agent.toolBreakdown && !existing.toolBreakdown) enriched.toolBreakdown = agent.toolBreakdown;
            if (agent.subtask && !existing.subtask) enriched.subtask = agent.subtask;
            next.set(agent.id, enriched);
          }
        }
        return next;
      });
    });

    poller.on('data', (data) => {
      // Update connection status based on what data sources are available
      if (data.worktrees.length > 0 || data.resultFiles.length > 0 || data.processes.length > 0) {
        setConnectionStatus('polling');
      }
    });

    // Elapsed timer (1s refresh for FIX 3)
    const elapsedTimer = setInterval(() => setElapsed(Date.now() - startTime), 1000);

    // Spinner animation
    const spinnerTimer = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    // Merge conflict data check — read conflicts.json from workDir (written by swarm)
    const mergeTimer = setInterval(() => {
      try {
        const conflictsPath = join(workDir, 'conflicts.json');
        if (existsSync(conflictsPath)) {
          const raw = readFileSync(conflictsPath, 'utf-8');
          const report = JSON.parse(raw);
          if (report && Array.isArray(report) && report.length > 0) {
            setMergeData(normalizeMergeData({ files: report }));
          }
        }
      } catch { /* non-fatal — file may be mid-write */ }
    }, 5000);

    return () => {
      watcher.stop();
      poller.stop();
      clearInterval(elapsedTimer);
      clearInterval(spinnerTimer);
      clearInterval(mergeTimer);
      controlRef.current.cleanup();
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
              level: cfg.level || 0,
              toolCalls: 0,
              elapsedMs: 0,
            });
          }
        }
        return next;
      });
    }
  }, [agentConfigs]);

  // ── Update hierarchy tree when agents change ──
  useEffect(() => {
    const tree = buildHierarchyTree(agents);
    setHierarchyData(tree);
  }, [agents]);

  // ── Update control panel agent names ──
  useEffect(() => {
    const names = Array.from(agents.keys());
    controlRef.current.setAgentNames(names);
  }, [agents]);

  // ── Derived data ──
  // FIX 2: Prepend Main Session as root node
  const mainSession = createMainSession(elapsed);
  const rawAgentList = sortAgents(Array.from(agents.values()), sortMode);
  const agentList = [mainSession, ...rawAgentList];

  const selected = agentList[selectedIdx];
  const doneCount = rawAgentList.filter(a => a.status === 'done').length;
  const failCount = rawAgentList.filter(a => a.status === 'failed').length;
  const runCount = rawAgentList.filter(a => a.status === 'running').length;
  const pendCount = rawAgentList.filter(a => a.status === 'pending').length;
  const isRunning = runCount > 0 || pendCount > 0;

  const { totalCost } = estimateTotalCost(rawAgentList);

  // Current panel name
  const currentPanel = PANELS[focusedPanel] || 'agents';

  // ── Control panel actions ──
  const controlActions = {
    pause: (agentId) => {
      const agent = agents.get(agentId);
      if (agent && agent.pid) {
        try { process.kill(agent.pid, 'SIGSTOP'); } catch {}
      }
      setStatusMessage(`Paused ${agentId}`);
      setTimeout(() => setStatusMessage(''), 3000);
    },
    resume: (agentId) => {
      const agent = agents.get(agentId);
      if (agent && agent.pid) {
        try { process.kill(agent.pid, 'SIGCONT'); } catch {}
      }
      setStatusMessage(`Resumed ${agentId}`);
      setTimeout(() => setStatusMessage(''), 3000);
    },
    abort: (agentId) => {
      const agent = agents.get(agentId);
      if (agent && agent.pid) {
        try { process.kill(agent.pid, 'SIGTERM'); } catch {}
      }
      setStatusMessage(`Aborting ${agentId}`);
      setTimeout(() => setStatusMessage(''), 3000);
    },
    kill: (agentId) => {
      const agent = agents.get(agentId);
      if (agent && agent.pid) {
        try { process.kill(agent.pid, 'SIGKILL'); } catch {}
      }
      setStatusMessage(`Killed ${agentId}`);
      setTimeout(() => setStatusMessage(''), 3000);
    },
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
    getStatus: () => `${rawAgentList.length} agents: ${runCount} running, ${doneCount} done, ${failCount} failed`,
    getCost: () => `~${formatCost(totalCost)} estimated`,
  };

  // ── Keyboard handling ──
  useInput((input, key) => {
    if (showHelp) {
      setShowHelp(false);
      return;
    }

    // In input mode, route to control panel
    if (controlMode !== ControlMode.STATUS) {
      if (key.escape) {
        controlRef.current.cancel();
        setControlMode(ControlMode.STATUS);
        setControlInputText('');
        return;
      }
      if (key.return) {
        if (controlMode === ControlMode.COMMAND) {
          const cmd = parseCommand(':' + controlRef.current.getInputText());
          if (cmd) {
            const result = executeCommand(cmd, controlActions);
            setStatusMessage(result.message);
            setTimeout(() => setStatusMessage(''), 3000);
          }
          controlRef.current.cancel();
          setControlMode(ControlMode.STATUS);
          setControlInputText('');
        } else if (controlMode === ControlMode.FILTER) {
          controlRef.current.addFilter();
          setControlActiveFilters([...controlRef.current.getFilters()]);
          setControlInputText('');
        } else if (controlMode === ControlMode.MESSAGE) {
          const target = controlRef.current.getTargetAgent();
          const text = controlRef.current.getInputText();
          if (text.trim()) {
            setStatusMessage(`Message queued for ${target}: "${text.slice(0, 40)}"`);
          } else {
            setStatusMessage('Empty message — not sent');
          }
          setTimeout(() => setStatusMessage(''), 3000);
          controlRef.current.cancel();
          setControlMode(ControlMode.STATUS);
          setControlInputText('');
        }
        return;
      }
      if (key.backspace || key.delete) {
        controlRef.current.backspace();
        setControlInputText(controlRef.current.getInputText());
        return;
      }
      if (key.tab) {
        if (controlMode === ControlMode.MESSAGE) {
          controlRef.current.cycleTarget();
          setControlTargetAgent(controlRef.current.getTargetAgent());
        } else if (controlMode === ControlMode.FILTER) {
          controlRef.current.cycleFilterType();
          setControlFilterType(controlRef.current.getState().filterType);
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        controlRef.current.appendChar(input);
        setControlInputText(controlRef.current.getInputText());
      }
      return;
    }

    // FIX 1: When detail panel is focused, arrow keys scroll output (handled by LogViewer)
    // Only Escape exits detail focus; let LogViewer handle ↑↓/PgUp/PgDn
    if (detailFocused) {
      if (key.escape) {
        setDetailFocused(false);
        return;
      }
      // Don't intercept arrow keys — LogViewer handles them via useInput
      // Only handle non-navigation keys
      if (input === 'q') exit();
      if (input === '?') setShowHelp(true);
      return;
    }

    // Normal mode navigation
    if (key.upArrow || input === 'k') {
      setSelectedIdx(i => Math.max(0, i - 1));
    }
    if (key.downArrow || input === 'j') {
      setSelectedIdx(i => Math.min(agentList.length - 1, i + 1));
    }

    // FIX 1: Enter toggles detail focus for scrollable output
    if (key.return && (currentPanel === 'agents' || currentPanel === 'logs')) {
      setDetailFocused(true);
    }

    // Panel focus (FIX 5: tab switching)
    if (key.tab && !key.shift) {
      setDetailFocused(false); // exit detail focus on panel switch
      setFocusedPanel(p => (p + 1) % PANELS.length);
    }
    if (key.tab && key.shift) {
      setDetailFocused(false);
      setFocusedPanel(p => (p - 1 + PANELS.length) % PANELS.length);
    }

    // Panel jump by number (FIX 5)
    if (input >= '1' && input <= '6') {
      setDetailFocused(false);
      setFocusedPanel(parseInt(input, 10) - 1);
    }

    // Actions
    if (input === 'l') setFullScreenLog(v => !v);
    if (input === '?') setShowHelp(true);
    if (input === 'r') setElapsed(Date.now() - startTime);
    if (input === 'q') exit();

    // Theme cycling
    if (input === 't') {
      const newTheme = cycleTheme();
      setThemeNameState(newTheme);
    }

    // Sort cycling
    if (input === 's') {
      setSortMode(prev => {
        const idx = SORT_MODES.indexOf(prev);
        return SORT_MODES[(idx + 1) % SORT_MODES.length];
      });
    }

    // Control modes
    if (input === 'm') {
      controlRef.current.setMode(ControlMode.MESSAGE);
      setControlMode(ControlMode.MESSAGE);
    }
    if (input === 'f') {
      controlRef.current.setMode(ControlMode.FILTER);
      setControlMode(ControlMode.FILTER);
    }
    if (input === ':') {
      controlRef.current.setMode(ControlMode.COMMAND);
      setControlMode(ControlMode.COMMAND);
    }

    // Pause/resume toggle
    if (input === 'p' && selected && selected.pid && !selected.isMainSession) {
      if (selected.paused) {
        controlActions.resume(selected.id);
      } else {
        controlActions.pause(selected.id);
      }
    }

    // Abort
    if (input === 'a' && selected && selected.pid && !selected.isMainSession) {
      controlActions.abort(selected.id);
    }

    // Cancel (legacy)
    if (input === 'c' && selected && selected.pid && !selected.isMainSession) {
      try { process.kill(selected.pid, 'SIGTERM'); } catch {}
    }
  });

  // ── Full-screen log mode ──
  if (fullScreenLog) {
    return e(Box, { flexDirection: 'column', width: cols },
      e(Box, { paddingX: 1 },
        e(Text, { bold: true, color: 'cyan' }, 'LOGS: '),
        e(Text, { bold: true }, selected ? selected.id : 'none'),
        e(Text, { dimColor: true }, '  Press l to exit, ↑↓ to switch agent'),
      ),
      e(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', borderColor: 'cyan', paddingX: 1 },
        ...(selected && selected.output
          ? selected.output.split('\n').slice(-Math.max(rows - 6, 10)).map((line, i) =>
              e(Text, { key: i, wrap: 'truncate' }, line || ' ')
            )
          : [e(Text, { key: 'empty', dimColor: true }, 'No output available')]
        ),
      ),
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

  // ── HEADER (FIX 3: real-time with connection status) ──
  const connDotColor = connectionStatus === 'socket' ? 'green'
    : connectionStatus === 'polling' ? 'yellow' : 'red';
  const connDotLabel = connectionStatus === 'socket' ? '●BUS'
    : connectionStatus === 'polling' ? '●POLL' : '●OFF';

  const header = e(Box, { borderStyle: 'single', borderColor: 'cyan', paddingX: 1, width: '100%' },
    isRunning
      ? e(Text, { color: 'cyan' }, SPINNER_FRAMES[spinnerFrame], ' ')
      : e(Text, { color: 'green' }, '● '),
    e(Text, { bold: true, color: 'cyan' }, 'SWARM'),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, null, mode || 'parallel'),
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: 'green' }, String(doneCount), '✓'),
    e(Text, null, ' '),
    e(Text, { color: 'yellow' }, String(runCount), '⟳'),
    e(Text, null, ' '),
    e(Text, { color: 'red' }, String(failCount), '✗'),
    pendCount > 0 ? e(Text, { dimColor: true }, ` ${pendCount}○`) : null,
    e(Text, { dimColor: true }, ' │ '),
    e(Text, null, formatElapsed(elapsed)),
    layout.showCost
      ? e(Text, null,
          e(Text, { dimColor: true }, ' │ '),
          e(Text, { color: 'yellow' }, '~', formatCost(totalCost))
        )
      : null,
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { color: connDotColor }, connDotLabel), // FIX 3: connection status
    e(Text, { dimColor: true }, ' │ '),
    e(Text, { dimColor: true }, '[', themeName, ']'),
    e(Text, { dimColor: true }, ' │ sort:', sortMode),
    task
      ? e(Text, null,
          e(Text, { dimColor: true }, ' │ '),
          e(Text, { dimColor: true, wrap: 'truncate' }, task.slice(0, Math.max(20, cols - 80)))
        )
      : null,
  );

  // ── Panel tabs indicator (FIX 5: active tab bold+underline+accent) ──
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
    // Show detail focus indicator
    detailFocused
      ? e(Text, { color: 'green', bold: true }, ' [SCROLL: Esc to exit]')
      : null,
  );

  // ── SIDEBAR: Agent list (FIX 2: includes Main Session at top) ──
  const sidebar = e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focusedPanel === 0 ? 'cyan' : 'gray',
    width: layout.sidebarWidth,
    paddingX: 1,
  },
    e(Box, null,
      e(Text, { bold: true, dimColor: focusedPanel !== 0 }, 'Agents'),
      e(Text, { dimColor: true }, ` (${rawAgentList.length})`),
    ),
    ...agentList.map((agent, i) =>
      e(AgentListItem, {
        key: agent.id,
        agent,
        selected: i === selectedIdx,
        width: layout.sidebarWidth - 2,
        showSparkline: layout.showSparklines && i === selectedIdx,
        animFrame: spinnerFrame,
      })
    ),
    e(Box, { marginTop: 1 },
      e(Text, { dimColor: true }, '~', formatCost(totalCost)),
      e(Text, { dimColor: true }, ' est.'),
    ),
  );

  // ── MAIN PANEL: Selected by focusedPanel ──
  let mainContent;
  switch (currentPanel) {
    case 'messages':
      mainContent = e(ChatPanel, {
        workDir,
        height: Math.max(10, rows - 10),
        filter: controlActiveFilters.length > 0
          ? controlActiveFilters.find(f => f.type === 'agent')?.value || null
          : null,
      });
      break;

    case 'hierarchy':
      mainContent = e(HierarchyPanel, {
        hierarchy: hierarchyData,
        height: Math.max(10, rows - 10),
        focused: focusedPanel === 2,
      });
      break;

    case 'resources':
      mainContent = e(GovernorPanel, {
        utilization: utilization || normalizeUtilization({
          activeAgents: runCount,
          totalSpawned: rawAgentList.length,
          totalCompleted: doneCount,
          totalFailed: failCount,
          worktreesInUse: 0,
          estimatedMemoryMB: runCount * 256,
          estimatedCost: totalCost,
          byLevel: new Map(),
        }),
        config: governorConfig || {
          maxConcurrentAgents: 10,
          maxWorktrees: 15,
          maxMemoryMB: 4096,
          maxTotalAgents: 20,
        },
        budgetLog,
        throughputValues,
        costBudget: 15.0,
        focused: focusedPanel === 3,
        barWidth: layout.barWidth,
      });
      break;

    case 'merge':
      mainContent = e(MergePanel, {
        files: mergeData.files,
        resolutions: mergeData.resolutions,
        overallConfidence: mergeData.overallConfidence,
        progress: mergeData.progress,
        focused: focusedPanel === 4,
        height: Math.max(10, rows - 10),
        barWidth: layout.barWidth,
      });
      break;

    case 'logs':
      mainContent = e(AgentDetail, {
        agent: selected,
        barWidth: layout.barWidth,
        logLines: Math.max(rows - 12, 8),
        fullScreenLog: false,
        showBarChart: false,
        showCost: false,
        width: layout.mainWidth,
        focused: detailFocused, // FIX 1: pass focus to enable scrolling
      });
      break;

    case 'agents':
    default:
      mainContent = e(AgentDetail, {
        agent: selected,
        barWidth: layout.barWidth,
        logLines: layout.logLines,
        fullScreenLog: false,
        showBarChart: layout.showBarChart,
        showCost: layout.showCost,
        width: layout.mainWidth,
        focused: detailFocused, // FIX 1: pass focus to enable scrolling
      });
      break;
  }

  // ── FOOTER: Control Panel ──
  const footer = e(ControlPanel, {
    mode: controlMode,
    inputText: controlInputText,
    targetAgent: controlTargetAgent,
    filterType: controlFilterType,
    activeFilters: controlActiveFilters,
    agents: Array.from(agents.keys()),
    activePanel: currentPanel,
    agentCount: rawAgentList.length,
    statusMessage,
  });

  // ── Compose layout ──
  if (layout.stackPanels) {
    return e(Box, { flexDirection: 'column', width: cols },
      header,
      panelTabs,
      sidebar,
      e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: focusedPanel > 0 ? 'cyan' : 'gray', paddingX: 1 },
        mainContent,
      ),
      footer,
    );
  }

  // Full/compact layout: side-by-side
  return e(Box, { flexDirection: 'column', width: cols },
    header,
    panelTabs,
    e(Box, { flexDirection: 'row' },
      sidebar,
      e(Box, {
        flexDirection: 'column',
        flexGrow: 1,
        borderStyle: 'single',
        borderColor: detailFocused ? 'green' : focusedPanel > 0 ? 'cyan' : 'gray',
      },
        mainContent,
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
 * @param {string} opts.workDir     - Swarm run directory
 * @param {Array}  opts.agents      - Agent configurations for pre-population
 * @param {string} opts.mode        - Swarm mode (parallel, swarm, pipeline, etc.)
 * @param {string} [opts.task]      - Task description
 * @param {string} [opts.depth]     - Execution depth
 * @param {string} [opts.busAddress] - IPC bus socket address
 * @param {string} [opts.theme]     - Initial theme name
 */
export function startDashboard({ workDir, agents, mode, task, depth, busAddress, theme }) {
  if (!process.stdout.isTTY) {
    return null;
  }

  const instance = render(
    e(Dashboard, { workDir, agents, mode, task, depth, busAddress, initialTheme: theme })
  );

  return {
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

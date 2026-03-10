/**
 * Dashboard — Main Ink TUI component for real-time swarm monitoring.
 *
 * Renders a header bar (mode, counters, elapsed), a grid of AgentCards,
 * an optional log tail panel, and a footer with keyboard shortcuts.
 *
 * Keyboard: Tab=focus next agent, l=toggle logs, q=quit TUI
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { AgentCard } from './agent-card.mjs';
import { createProgressWatcher } from './progress-reader.mjs';

const { useState, useEffect } = React;
const e = React.createElement;

function Dashboard({ workDir, agents: agentConfigs, mode }) {
  const { exit } = useApp();
  const [agents, setAgents] = useState(new Map());
  const [focusIdx, setFocusIdx] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Poll workDir for progress/result files
  useEffect(() => {
    const watcher = createProgressWatcher(workDir, 1000);

    watcher.on('agent-update', (agent) => {
      setAgents(prev => {
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });
    });

    watcher.on('agent-complete', (agent) => {
      setAgents(prev => {
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });
    });

    const timer = setInterval(() => setElapsed(Date.now() - startTime), 1000);

    return () => {
      watcher.stop();
      clearInterval(timer);
    };
  }, [workDir]);

  // Pre-populate agent slots from configs (shows "pending" placeholders)
  useEffect(() => {
    if (agentConfigs && agentConfigs.length > 0) {
      setAgents(prev => {
        const next = new Map(prev);
        for (const cfg of agentConfigs) {
          if (!next.has(cfg.id)) {
            next.set(cfg.id, { id: cfg.id, status: 'pending', subtask: cfg.subtask || '' });
          }
        }
        return next;
      });
    }
  }, [agentConfigs]);

  const agentList = Array.from(agents.values());
  const focused = agentList[focusIdx];

  useInput((input, key) => {
    if (key.tab) setFocusIdx(i => (i + 1) % Math.max(1, agentList.length));
    if (input === 'l') setShowLogs(s => !s);
    if (input === 'q') exit();
  });

  const doneCount = agentList.filter(a => a.status === 'done').length;
  const failCount = agentList.filter(a => a.status === 'failed').length;
  const runCount = agentList.filter(a => a.status === 'running').length;
  const totalElapsed = (elapsed / 1000).toFixed(0);

  return e(Box, { flexDirection: 'column' },
    // ── Header bar ──
    e(Box, { borderStyle: 'single', paddingX: 1 },
      e(Text, { bold: true, color: 'cyan' }, 'swarm'),
      e(Text, { dimColor: true }, ' | '),
      e(Text, null, 'mode=', mode),
      e(Text, { dimColor: true }, ' | '),
      e(Text, { color: 'green' }, String(doneCount), '✓'),
      e(Text, { dimColor: true }, ' '),
      e(Text, { color: 'cyan' }, String(runCount), '⟳'),
      e(Text, { dimColor: true }, ' '),
      e(Text, { color: 'red' }, String(failCount), '✗'),
      e(Text, { dimColor: true }, ' | '),
      e(Text, null, totalElapsed, 's')
    ),

    // ── Agent grid ──
    e(Box, { flexWrap: 'wrap' },
      agentList.map((agent, i) =>
        e(AgentCard, { key: agent.id, agent, focused: i === focusIdx })
      )
    ),

    // ── Log tail (toggled with 'l') ──
    showLogs && focused && focused.output
      ? e(Box, { flexDirection: 'column', borderStyle: 'single', paddingX: 1, marginTop: 1 },
          e(Text, { bold: true }, 'Logs: ', focused.id),
          e(Text, { dimColor: true }, focused.output)
        )
      : null,

    // ── Footer ──
    e(Box, { marginTop: 1 },
      e(Text, { dimColor: true }, 'Tab: focus  l: logs  q: quit')
    )
  );
}

/**
 * Start the TUI dashboard. Returns { unmount, waitUntilExit } or null if non-TTY.
 */
export function startDashboard({ workDir, agents, mode, depth }) {
  if (!process.stdout.isTTY) {
    return null;
  }

  const instance = render(
    e(Dashboard, { workDir, agents, mode, depth })
  );

  return {
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

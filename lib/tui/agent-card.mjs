/**
 * AgentCard — Agent list item and detail panel components.
 *
 * AgentListItem: Compact sidebar entry (icon + ID + elapsed + sparkline + model badge)
 * AgentDetail:   Full detail panel with organized sections:
 *   - Header: ID, status, level
 *   - Summary: model, time, cost, worktree
 *   - Output: scrollable log viewer (FIX 1)
 *   - Files Changed: diff stats
 *   - Tool Calls: breakdown chart
 *
 * Enhanced with:
 *   - Animated spawn indicator (spinning ◐◑◒◓ when spawning)
 *   - Live elapsed time counter
 *   - Model badge: [opus] [sonnet] with color
 *   - Level indicator: L0, L1, L2
 *   - Mini-sparkline of agent's message throughput
 *   - Task description tooltip (show on focus)
 *   - Sortable: by status, time, level, model
 *   - Organized collapsible sections (FIX 6)
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import {
  statusColor, statusIcon, formatElapsed, formatBytes, truncate,
  modelColor, levelColor, SPAWN_FRAMES,
} from './theme.mjs';
import { Sparkline } from './sparkline.mjs';
import { ToolBreakdown } from './bar-chart.mjs';
import { LogViewer } from './log-viewer.mjs';
import { estimateAgentCost, formatCost } from './cost-tracker.mjs';

const { useState } = React;
const e = React.createElement;

// ── Section Header ──────────────────────────────────────────────

/**
 * Render a section separator: ── Title (info) ────────────
 * @param {object} props
 * @param {string} props.title - Section title
 * @param {string} [props.extra] - Extra info after title in parens
 * @param {number} [props.width] - Available width for the line
 * @param {string} [props.rightLabel] - Right-aligned label
 */
function SectionHeader({ title, extra, width, rightLabel }) {
  const titleStr = `── ${title}${extra ? ` (${extra})` : ''} `;
  const rightStr = rightLabel ? ` ${rightLabel}` : '';
  const lineLen = Math.max(0, (width || 40) - titleStr.length - rightStr.length);
  const line = '─'.repeat(lineLen);
  return e(Box, { marginTop: 1 },
    e(Text, { bold: true, dimColor: true }, titleStr),
    e(Text, { dimColor: true }, line),
    rightStr ? e(Text, { dimColor: true }, rightStr) : null,
  );
}

// ── Worktree path formatting ──────────────────────────────────────

/**
 * Format a worktree path for compact display.
 * /path/to/user-home/.claude/worktrees/feat-auth/ → ~/…/feat-auth/
 * @param {string} path - Full worktree path
 * @param {number} maxLen - Maximum display length
 * @returns {string} Truncated display path
 */
function formatWorktreePath(path, maxLen) {
  if (!path) return '';
  // Replace home dir with ~
  const home = process.env.HOME || '';
  let display = home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
  // If still too long, show ~/…/<last-dir>/
  if (display.length > maxLen) {
    const parts = path.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || parts[parts.length - 2] || '';
    display = `~/…/${last}/`;
  }
  if (display.length > maxLen) {
    display = display.slice(0, maxLen - 1) + '…';
  }
  return display;
}

// ── Sort comparators ─────────────────────────────────────────────

const STATUS_ORDER = {
  spawning: 0, running: 1, pending: 2, merging: 3,
  done: 4, completed: 4, timeout: 5, failed: 6,
};

export const SORT_MODES = ['status', 'time', 'level', 'model', 'name'];

/**
 * Sort agents by the given sort mode.
 * @param {object[]} agents - Agent array
 * @param {string} sortMode - One of SORT_MODES
 * @returns {object[]} Sorted copy
 */
export function sortAgents(agents, sortMode = 'status') {
  const copy = [...agents];
  switch (sortMode) {
    case 'time':
      return copy.sort((a, b) =>
        (b.elapsedMs || b.durationMs || 0) - (a.elapsedMs || a.durationMs || 0)
      );
    case 'level':
      return copy.sort((a, b) => (a.level || 0) - (b.level || 0));
    case 'model':
      return copy.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
    case 'name':
      return copy.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
    case 'status':
    default:
      return copy.sort((a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      );
  }
}

// ── AgentListItem (sidebar entry) ─────────────────────────────────

/**
 * Compact agent row for the sidebar list.
 *
 * @param {object} props
 * @param {object} props.agent     - Agent state object
 * @param {boolean} props.selected - Whether this agent is currently selected
 * @param {number} [props.width]   - Available width
 * @param {boolean} [props.showSparkline] - Whether to render sparkline
 * @param {number} [props.animFrame] - Animation frame for spawn animation
 */
const AgentListItemImpl = ({ agent, selected, width, showSparkline, animFrame = 0 }) => {
  const { id, status, elapsedMs, durationMs, toolCalls, lastTool, sparklineValues, model, level } = agent;
  const elapsed = durationMs || elapsedMs || 0;
  const color = statusColor(status);

  const pointer = selected ? '►' : ' ';
  const pointerColor = selected ? 'cyan' : undefined;

  // Status icon — animated for spawning and running
  let icon;
  if (status === 'spawning') {
    icon = e(Spinner, { type: 'arc' });
  } else if (status === 'running') {
    icon = e(Spinner, { type: 'dots' });
  } else {
    icon = e(Text, { color }, statusIcon(status));
  }

  const idDisplay = truncate(id, 14);

  // Model badge
  const modelBadge = model
    ? model.replace(/\[1m\]/g, '').replace('claude-', '').slice(0, 6)
    : '';
  const mColor = modelColor(model);

  // Level badge
  const lvl = level != null ? level : null;
  const lvlColor = lvl != null ? levelColor(lvl) : null;

  // Main session special styling
  const isMainSession = agent.isMainSession;

  return e(Box, { flexDirection: 'column' },
    // Main row: pointer + icon + ID + badges + elapsed
    e(Box, null,
      e(Text, { color: pointerColor, bold: selected }, pointer, ' '),
      isMainSession ? e(Text, { color: 'yellow', bold: true }, '★ ') : icon,
      e(Text, {
        bold: selected || isMainSession,
        color: isMainSession ? 'yellow' : selected ? 'cyan' : undefined,
      }, ' ', idDisplay),
      // Level badge
      lvl != null
        ? e(Text, { color: lvlColor, dimColor: !selected }, ' L', String(lvl))
        : null,
      // Model badge
      modelBadge
        ? e(Text, { color: mColor, dimColor: !selected }, ' [', modelBadge, ']')
        : null,
      e(Text, { dimColor: true }, ' '),
      e(Text, { dimColor: !selected }, formatElapsed(elapsed)),
      toolCalls > 0
        ? e(Text, { dimColor: true }, ` ${toolCalls}t`)
        : null,
    ),
    // Worktree path (show on selected when available)
    selected && agent.worktreePath
      ? e(Box, { marginLeft: 3 },
          e(Text, { color: 'magenta', dimColor: true }, '⌂ '),
          e(Text, { dimColor: true, wrap: 'truncate' },
            formatWorktreePath(agent.worktreePath, Math.max(16, (width || 30) - 6))
          )
        )
      : null,
    // Task description tooltip (show on selected)
    selected && agent.subtask
      ? e(Box, { marginLeft: 3 },
          e(Text, { dimColor: true, wrap: 'truncate' },
            truncate(agent.subtask, Math.max(20, (width || 30) - 4))
          )
        )
      : null,
    // Sparkline row (if enabled and data exists)
    showSparkline && sparklineValues && sparklineValues.length > 0
      ? e(Box, { marginLeft: 3 },
          e(Sparkline, { values: sparklineValues, width: Math.min(20, (width || 30) - 6), color: color })
        )
      : null,
  );
};

// Wrap in React.memo to prevent unnecessary re-renders
export const AgentListItem = React.memo(AgentListItemImpl);

// ── AgentDetail (right panel) ─────────────────────────────────────

/**
 * Full detail panel for the selected agent with organized sections.
 *
 * Sections:
 *   - Header: Agent ID + status + level
 *   - Summary: Model, time, cost, worktree
 *   - Output: Scrollable log viewer (activated by `focused` prop)
 *   - Files Changed: Diff stats per file
 *   - Tool Calls: Breakdown chart
 *
 * @param {object} props
 * @param {object} props.agent       - Agent state object
 * @param {number} [props.barWidth]  - Bar chart width
 * @param {number} [props.logLines]  - Max visible log lines
 * @param {boolean} [props.fullScreenLog]
 * @param {boolean} [props.showBarChart]
 * @param {boolean} [props.showCost]
 * @param {number} [props.width]     - Available panel width
 * @param {boolean} [props.focused]  - Whether this panel has focus (enables log scrolling)
 */
const AgentDetailImpl = ({ agent, barWidth, logLines, fullScreenLog, showBarChart, showCost, width, focused = false }) => {
  if (!agent) {
    return e(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: 'gray',
      paddingX: 1,
      flexGrow: 1,
    },
      e(Text, { dimColor: true }, 'No agent selected'),
      e(Text, { dimColor: true }, 'Use ↑↓ or j/k to select an agent'),
      e(Text, { dimColor: true }, 'Press Enter to focus output for scrolling'),
    );
  }

  const {
    id, status, model, toolCalls, elapsedMs, durationMs,
    toolBreakdown, output, exitCode, subtask, qualitySignals,
    stdoutBytes, lastTool, sparklineValues, level,
  } = agent;

  const elapsed = durationMs || elapsedMs || 0;
  const color = statusColor(status);
  const cost = estimateAgentCost({ model, toolCalls: toolCalls || 0 });
  const modelDisplay = model ? model.replace('[1m]', '').replace('claude-', '') : 'unknown';
  const mColor = modelColor(model);
  const lvl = level != null ? level : null;
  const lvlColor = lvl != null ? levelColor(lvl) : null;
  const isMainSession = agent.isMainSession;
  const panelWidth = width || 60;

  // Count output lines for section header
  const outputLines = output ? output.split('\n').length : 0;

  // Count tool types for summary
  const toolTypeCount = toolBreakdown ? Object.keys(toolBreakdown).length : 0;
  const toolSummary = toolBreakdown && toolTypeCount > 0
    ? Object.entries(toolBreakdown).map(([k, v]) => `${k}: ${v}`).join('  ')
    : null;

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focused ? 'cyan' : isMainSession ? 'yellow' : 'cyan',
    paddingX: 1,
    flexGrow: 1,
  },
    // ═══ HEADER: Agent ID + Status + Level ═══
    e(Box, null,
      isMainSession
        ? e(Text, { color: 'yellow', bold: true }, '★ ')
        : status === 'running'
          ? e(Spinner, { type: 'dots' })
          : status === 'spawning'
            ? e(Spinner, { type: 'arc' })
            : e(Text, { color }, statusIcon(status)),
      e(Text, { bold: true, color: isMainSession ? 'yellow' : 'cyan' }, '  ', id),
      e(Text, { dimColor: true }, '  '),
      e(Text, { color, bold: true }, (status || 'unknown').toUpperCase()),
      lvl != null
        ? e(Text, { color: lvlColor, bold: true }, '  L', String(lvl))
        : null,
      focused
        ? e(Text, { color: 'green', bold: true }, '  [SCROLL ACTIVE]')
        : null,
    ),

    // ═══ SECTION: Summary ═══
    e(SectionHeader, { title: 'Summary', width: panelWidth - 2 }),

    // Row 1: Model, Elapsed, Tools
    e(Box, null,
      e(Text, { dimColor: true }, 'Model '),
      e(Text, { color: mColor, bold: true }, modelDisplay),
      e(Text, { dimColor: true }, '  Time '),
      e(Text, null, formatElapsed(elapsed)),
      e(Text, { dimColor: true }, '  Tools '),
      e(Text, null, String(toolCalls || 0)),
      lastTool
        ? e(Text, { dimColor: true }, ` (${lastTool})`)
        : null,
    ),

    // Row 2: Cost + Output size
    showCost
      ? e(Box, null,
          e(Text, { dimColor: true }, 'Cost  '),
          e(Text, { color: 'yellow' }, '~', formatCost(cost.cost)),
          e(Text, { dimColor: true }, `  (${(cost.inputTokens / 1000).toFixed(0)}k in / ${(cost.outputTokens / 1000).toFixed(0)}k out)`),
          stdoutBytes
            ? e(Text, { dimColor: true }, `  Output ${formatBytes(stdoutBytes)}`)
            : null,
        )
      : null,

    // Worktree path
    agent.worktreePath
      ? e(Box, null,
          e(Text, { dimColor: true }, 'Tree  '),
          e(Text, { color: 'magenta' }, formatWorktreePath(agent.worktreePath, panelWidth - 8)),
        )
      : null,

    // Exit code (if non-zero)
    exitCode !== undefined && exitCode !== 0
      ? e(Box, null,
          e(Text, { color: 'red', bold: true }, `Exit code: ${exitCode}`),
        )
      : null,

    // Subtask description
    subtask
      ? e(Box, null,
          e(Text, { dimColor: true }, 'Task  '),
          e(Text, { wrap: 'truncate' }, truncate(subtask, panelWidth - 8)),
        )
      : null,

    // Quality warnings
    qualitySignals && qualitySignals.ai_analysis && qualitySignals.ai_analysis.issue
      ? e(Box, null,
          e(Text, { color: 'yellow' }, '⚠ ', qualitySignals.ai_analysis.issue),
        )
      : null,

    // ═══ SECTION: Output (scrollable) ═══
    e(SectionHeader, {
      title: 'Output',
      extra: outputLines > 0 ? `${outputLines} lines` : null,
      width: panelWidth - 2,
      rightLabel: focused ? '[↑↓ scroll]' : '[Enter: scroll]',
    }),
    output
      ? e(Box, { flexDirection: 'column' },
          e(LogViewer, {
            title: `Output: ${id}`,
            content: output,
            maxLines: logLines || 12,
            fullScreen: fullScreenLog,
            width: panelWidth,
            focused: focused,
          })
        )
      : e(Text, { dimColor: true },
          status === 'running' ? 'Waiting for output…'
          : status === 'spawning' ? 'Spawning…'
          : 'No output captured'
        ),

    // ═══ SECTION: Files Changed ═══
    agent.filesChanged && agent.filesChanged.length > 0
      ? e(Box, { flexDirection: 'column' },
          e(SectionHeader, {
            title: 'Files Changed',
            extra: String(agent.filesChanged.length),
            width: panelWidth - 2,
          }),
          ...agent.filesChanged.slice(0, 8).map((f, i) =>
            e(Box, { key: i },
              e(Text, { color: 'green' }, f.added ? ` +${String(f.added).padStart(3)}` : '     '),
              f.removed ? e(Text, { color: 'red' }, ` -${String(f.removed).padStart(3)}`) : e(Text, null, '     '),
              e(Text, { dimColor: true }, ' '),
              e(Text, null, truncate(f.path || f, panelWidth - 16)),
            )
          ),
          agent.filesChanged.length > 8
            ? e(Text, { dimColor: true }, `  +${agent.filesChanged.length - 8} more`)
            : null,
        )
      : null,

    // ═══ SECTION: Tool Calls ═══
    (showBarChart && ((toolBreakdown && toolTypeCount > 0) || (toolCalls || 0) > 0))
      ? e(Box, { flexDirection: 'column' },
          e(SectionHeader, {
            title: 'Tool Calls',
            extra: String(toolCalls || 0),
            width: panelWidth - 2,
          }),
          toolBreakdown && toolTypeCount > 0
            ? e(ToolBreakdown, { toolCalls: toolBreakdown, barWidth: barWidth || 16 })
            : e(Text, { dimColor: true }, `${toolCalls} tool calls (breakdown pending…)`),
          // Inline summary when breakdown exists
          toolSummary
            ? e(Box, null,
                e(Text, { dimColor: true }, toolSummary),
              )
            : null,
        )
      : null,

    // ═══ SECTION: Activity sparkline ═══
    sparklineValues && sparklineValues.length > 0
      ? e(Box, { marginTop: 1 },
          e(Text, { dimColor: true }, 'Activity '),
          e(Sparkline, { values: sparklineValues, width: Math.min(20, panelWidth - 12) }),
        )
      : null,
  );
};

// Wrap in React.memo to prevent unnecessary re-renders
export const AgentDetail = React.memo(AgentDetailImpl);

// ── Legacy export for backward compat with swarm/monitor ──────────
export function AgentCard({ agent, focused }) {
  return e(AgentListItem, { agent, selected: focused, showSparkline: false });
}

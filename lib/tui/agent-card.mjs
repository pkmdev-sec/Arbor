/**
 * AgentCard — Agent list item and detail panel components.
 *
 * AgentListItem: Compact sidebar entry (icon + ID + elapsed + sparkline)
 * AgentDetail:   Full detail panel (model, status, budget, tool chart, logs)
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { statusColor, statusIcon, formatElapsed, formatBytes, truncate } from './theme.mjs';
import { Sparkline } from './sparkline.mjs';
import { ToolBreakdown } from './bar-chart.mjs';
import { LogViewer } from './log-viewer.mjs';
import { estimateAgentCost, formatCost } from './cost-tracker.mjs';

const e = React.createElement;

// ── AgentListItem (sidebar entry) ─────────────────────────────────

/**
 * Compact agent row for the sidebar list.
 *
 * @param {object} props
 * @param {object} props.agent     - Agent state object
 * @param {boolean} props.selected - Whether this agent is currently selected
 * @param {number} [props.width]   - Available width
 * @param {boolean} [props.showSparkline] - Whether to render sparkline
 */
export function AgentListItem({ agent, selected, width, showSparkline }) {
  const { id, status, elapsedMs, durationMs, toolCalls, lastTool, sparklineValues } = agent;
  const elapsed = durationMs || elapsedMs || 0;
  const color = statusColor(status);

  const pointer = selected ? '►' : ' ';
  const pointerColor = selected ? 'cyan' : undefined;

  const icon = status === 'running'
    ? e(Spinner, { type: 'dots' })
    : e(Text, { color }, statusIcon(status));

  const idDisplay = truncate(id, 14);

  return e(Box, { flexDirection: 'column' },
    // Main row: pointer + icon + ID + elapsed
    e(Box, null,
      e(Text, { color: pointerColor, bold: selected }, pointer, ' '),
      icon,
      e(Text, { bold: selected, color: selected ? 'cyan' : undefined }, ' ', idDisplay),
      e(Text, { dimColor: true }, ' '),
      e(Text, { dimColor: !selected }, formatElapsed(elapsed)),
      toolCalls > 0
        ? e(Text, { dimColor: true }, ` ${toolCalls}t`)
        : null,
    ),
    // Sparkline row (if enabled and data exists)
    showSparkline && sparklineValues && sparklineValues.length > 0
      ? e(Box, { marginLeft: 3 },
          e(Sparkline, { values: sparklineValues, width: Math.min(20, (width || 30) - 6), color: color })
        )
      : null,
  );
}

// ── AgentDetail (right panel) ─────────────────────────────────────

/**
 * Full detail panel for the selected agent.
 *
 * @param {object} props
 * @param {object} props.agent       - Agent state object
 * @param {number} [props.barWidth]  - Width for tool breakdown bars
 * @param {number} [props.logLines]  - Max log lines to show
 * @param {boolean} [props.fullScreenLog] - Expand log viewer
 * @param {boolean} [props.showBarChart]  - Show tool breakdown chart
 * @param {boolean} [props.showCost]      - Show cost estimate
 * @param {number} [props.width]     - Panel width
 */
export function AgentDetail({ agent, barWidth, logLines, fullScreenLog, showBarChart, showCost, width }) {
  if (!agent) {
    return e(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: 'gray',
      paddingX: 1,
      flexGrow: 1,
    },
      e(Text, { dimColor: true }, 'No agent selected'),
      e(Text, { dimColor: true }, 'Use ↑↓ or j/k to select an agent')
    );
  }

  const {
    id, status, model, toolCalls, elapsedMs, durationMs,
    toolBreakdown, output, exitCode, subtask, qualitySignals,
    stdoutBytes, lastTool, sparklineValues,
  } = agent;

  const elapsed = durationMs || elapsedMs || 0;
  const color = statusColor(status);
  const cost = estimateAgentCost({ model, toolCalls: toolCalls || 0 });
  const modelDisplay = model ? model.replace('[1m]', '').replace('claude-', '') : 'unknown';

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'cyan',
    paddingX: 1,
    flexGrow: 1,
  },
    // ── Header: Agent ID + Status ──
    e(Box, null,
      status === 'running'
        ? e(Spinner, { type: 'dots' })
        : e(Text, { color }, statusIcon(status)),
      e(Text, { bold: true, color: 'cyan' }, '  ', id),
      e(Text, { dimColor: true }, '  '),
      e(Text, { color, bold: true }, status.toUpperCase()),
    ),

    // ── Row 1: Model, Elapsed, Tools ──
    e(Box, { marginTop: 1 },
      e(Text, { dimColor: true }, 'Model '),
      e(Text, null, modelDisplay),
      e(Text, { dimColor: true }, '  Time '),
      e(Text, null, formatElapsed(elapsed)),
      e(Text, { dimColor: true }, '  Tools '),
      e(Text, null, String(toolCalls || 0)),
      lastTool
        ? e(Text, { dimColor: true }, ` (${lastTool})`)
        : null,
    ),

    // ── Row 2: Cost + Output size ──
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

    // ── Exit code (if non-zero) ──
    exitCode !== undefined && exitCode !== 0
      ? e(Box, null,
          e(Text, { color: 'red', bold: true }, `Exit code: ${exitCode}`),
        )
      : null,

    // ── Subtask description ──
    subtask
      ? e(Box, { marginTop: 1 },
          e(Text, { dimColor: true }, 'Task: '),
          e(Text, { wrap: 'truncate' }, truncate(subtask, (width || 60) - 8)),
        )
      : null,

    // ── Quality warnings ──
    qualitySignals && qualitySignals.ai_analysis && qualitySignals.ai_analysis.issue
      ? e(Box, null,
          e(Text, { color: 'yellow' }, '⚠ ', qualitySignals.ai_analysis.issue),
        )
      : null,

    // ── Tool breakdown bar chart ──
    showBarChart && toolBreakdown && Object.keys(toolBreakdown).length > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Text, { bold: true, dimColor: true }, 'Tool Breakdown'),
          e(ToolBreakdown, { toolCalls: toolBreakdown, barWidth: barWidth || 16 }),
        )
      : null,

    // ── Sparkline (activity over time) ──
    sparklineValues && sparklineValues.length > 0
      ? e(Box, { marginTop: 1 },
          e(Text, { dimColor: true }, 'Activity '),
          e(Sparkline, { values: sparklineValues, width: Math.min(20, (width || 40) - 12) }),
        )
      : null,

    // ── Log tail ──
    output
      ? e(Box, { marginTop: 1, flexDirection: 'column' },
          e(LogViewer, {
            title: `Output: ${id}`,
            content: output,
            maxLines: logLines || 12,
            fullScreen: fullScreenLog,
            width: width,
          })
        )
      : e(Box, { marginTop: 1 },
          e(Text, { dimColor: true }, status === 'running' ? 'Waiting for output…' : 'No output captured')
        ),
  );
}

// ── Legacy export for backward compat with swarm/monitor ──────────
export function AgentCard({ agent, focused }) {
  return e(AgentListItem, { agent, selected: focused, showSparkline: false });
}

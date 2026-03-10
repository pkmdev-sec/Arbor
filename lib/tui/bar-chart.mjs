/**
 * BarChart — Horizontal bar chart component for tool breakdowns.
 *
 * Renders proportional filled bars using block characters:
 *   Read   ████████░░░░░  42
 *   Bash   █████░░░░░░░░  28
 *   Edit   ███░░░░░░░░░░  15
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { BAR, toolColor } from './theme.mjs';

const e = React.createElement;

/**
 * Render a single horizontal bar.
 *
 * @param {object} props
 * @param {string} props.label    - Bar label (e.g., "Read")
 * @param {number} props.value    - Numeric value
 * @param {number} props.maxValue - Maximum value (for proportional scaling)
 * @param {number} props.barWidth - Total bar width in characters
 * @param {string} [props.color]  - Bar fill color
 */
export function HBar({ label, value, maxValue, barWidth, color }) {
  const w = barWidth || 16;
  const ratio = maxValue > 0 ? value / maxValue : 0;
  const filled = Math.round(ratio * w);
  const empty = w - filled;

  const labelPad = (label || '').padEnd(6);

  return e(Box, null,
    e(Text, { dimColor: true }, labelPad, ' '),
    e(Text, { color: color || 'cyan' }, BAR.filled.repeat(filled)),
    e(Text, { dimColor: true }, BAR.empty.repeat(empty)),
    e(Text, { dimColor: true }, ' '),
    e(Text, null, String(value))
  );
}

/**
 * ToolBreakdown — Renders a horizontal bar chart for tool call distribution.
 *
 * @param {object} props
 * @param {object} props.toolCalls - Map of { Read: 5, Edit: 3, Bash: 10, ... }
 * @param {number} [props.barWidth] - Width of each bar (default: 16)
 */
export function ToolBreakdown({ toolCalls, barWidth }) {
  if (!toolCalls) return null;

  const tools = ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'Glob'];
  const entries = tools
    .filter(t => (toolCalls[t] || 0) > 0)
    .map(t => ({ label: t, value: toolCalls[t] || 0, color: toolColor(t) }));

  if (entries.length === 0) {
    return e(Text, { dimColor: true }, 'No tool calls yet');
  }

  const maxVal = Math.max(...entries.map(e => e.value), 1);
  const w = barWidth || 16;

  return e(Box, { flexDirection: 'column' },
    ...entries.map(entry =>
      e(HBar, {
        key: entry.label,
        label: entry.label,
        value: entry.value,
        maxValue: maxVal,
        barWidth: w,
        color: entry.color,
      })
    )
  );
}

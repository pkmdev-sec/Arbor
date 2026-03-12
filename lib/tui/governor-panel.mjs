/**
 * GovernorPanel — Live resource gauge dashboard connected to the ResourceGovernor.
 *
 * Displays:
 *   - Agent count gauge (concurrent active)
 *   - Memory estimate gauge
 *   - Worktree usage gauge
 *   - Cost vs budget gauge
 *   - Merge progress gauge
 *   - Throughput sparkline (messages per second)
 *   - Budget request log (recent approve/deny)
 *   - Utilization by level (L0, L1, L2)
 *   - Color coding: <60% green, 60-80% yellow, >80% red
 *   - Animated transitions when values change
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import {
  renderGauge, gaugeColor, formatElapsed, levelColor, uiColor,
} from './theme.mjs';
import { formatCost as costFmt } from './cost-tracker.mjs';
import { renderSparkline } from './sparkline.mjs';

const { useState, useEffect } = React;
const e = React.createElement;

// ── Gauge Row Component ──────────────────────────────────────────

/**
 * Single labeled gauge bar with value display.
 *
 * @param {object} props
 * @param {string} props.label - Gauge label (padded to 8 chars)
 * @param {number} props.current - Current value
 * @param {number} props.max - Maximum value
 * @param {number} props.barWidth - Bar width in characters
 * @param {string} [props.unit] - Unit suffix (e.g., 'G', 'MB')
 * @param {string} [props.format] - Display format: 'count', 'memory', 'cost'
 * @param {boolean} [props.flash] - Flash red when at capacity
 * @param {number} [props.animFrame] - Animation frame counter
 */
function GaugeRow({ label, current, max, barWidth, unit, format, flash, animFrame }) {
  const { bar, color, ratio } = renderGauge(current, max, barWidth);
  const isFlashing = flash && ratio >= 1.0 && animFrame % 4 < 2;
  const displayColor = isFlashing ? 'red' : color;

  let valueStr;
  switch (format) {
    case 'memory': {
      const curGB = (current / 1024).toFixed(1);
      const maxGB = (max / 1024).toFixed(0);
      valueStr = `${curGB}/${maxGB}G`;
      break;
    }
    case 'cost':
      valueStr = `${costFmt(current)}/${costFmt(max)}`;
      break;
    default:
      valueStr = `${current}/${max}${unit || ''}`;
  }

  const padLabel = (label || '').padEnd(8);

  return e(Box, null,
    e(Text, { dimColor: true }, padLabel, ' '),
    e(Text, { color: displayColor }, bar),
    e(Text, null, ' '),
    e(Text, { color: displayColor, bold: ratio >= 0.8 }, valueStr),
  );
}

// ── Budget Log Entry ─────────────────────────────────────────────

function BudgetEntry({ entry }) {
  const isApproved = entry.approved;
  const color = isApproved ? 'green' : 'red';
  const icon = isApproved ? '✓' : '✗';
  const elapsed = Date.now() - (entry.timestamp || 0);
  const timeStr = elapsed < 60000 ? `${Math.floor(elapsed / 1000)}s ago` : formatElapsed(elapsed);

  return e(Box, null,
    e(Text, { color }, icon, ' '),
    e(Text, { dimColor: true }, entry.requesterId || 'unknown'),
    e(Text, null, ': '),
    isApproved
      ? e(Text, { color: 'green' }, `${entry.granted} granted`)
      : e(Text, { color: 'red' }, entry.reason || 'denied'),
    entry.reduced ? e(Text, { color: 'yellow' }, ' (reduced)') : null,
    e(Text, { dimColor: true }, '  ', timeStr),
  );
}

// ── Level Utilization Row ────────────────────────────────────────

function LevelRow({ level, active, completed, failed }) {
  const color = levelColor(level);
  return e(Box, null,
    e(Text, { color, bold: true }, `  L${level}: `),
    e(Text, null, `${active} active`),
    completed > 0 ? e(Text, { color: 'green' }, `, ${completed} done`) : null,
    failed > 0 ? e(Text, { color: 'red' }, `, ${failed} failed`) : null,
  );
}

// ── Main GovernorPanel Component ─────────────────────────────────

/**
 * Live resource governor dashboard.
 *
 * @param {object} props
 * @param {object} props.utilization - UtilizationSnapshot from governor
 * @param {object} props.config - Governor config (maxConcurrentAgents, etc.)
 * @param {object[]} [props.budgetLog] - Recent budget decisions
 * @param {number[]} [props.throughputValues] - Sparkline data for throughput
 * @param {object} [props.mergeProgress] - { completed, total }
 * @param {number} [props.costBudget] - Maximum cost budget
 * @param {boolean} [props.focused] - Whether this panel has focus
 * @param {number} [props.barWidth] - Gauge bar width
 */
export function GovernorPanel({
  utilization,
  config,
  budgetLog,
  throughputValues,
  mergeProgress,
  costBudget,
  focused = false,
  barWidth = 12,
}) {
  const [animFrame, setAnimFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setAnimFrame(f => (f + 1) % 60), 250);
    return () => clearInterval(timer);
  }, []);

  // Defaults
  const util = utilization || {
    activeAgents: 0, totalSpawned: 0, totalCompleted: 0, totalFailed: 0,
    worktreesInUse: 0, estimatedMemoryMB: 0, estimatedCost: 0, byLevel: new Map(),
  };
  const cfg = config || {
    maxConcurrentAgents: 10, maxWorktrees: 15, maxMemoryMB: 4096, maxTotalAgents: 20,
  };
  const budget = costBudget || 15.0;
  const merge = mergeProgress || { completed: 0, total: 0 };
  const logs = budgetLog || [];

  // Build level stats
  const levelStats = [];
  if (util.byLevel instanceof Map) {
    for (const [level, stats] of util.byLevel) {
      levelStats.push({ level, ...stats });
    }
  } else if (util.byLevel && typeof util.byLevel === 'object') {
    for (const [level, stats] of Object.entries(util.byLevel)) {
      levelStats.push({ level: parseInt(level, 10), ...stats });
    }
  }
  levelStats.sort((a, b) => a.level - b.level);

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focused ? 'cyan' : 'gray',
    paddingX: 1,
  },
    // Title
    e(Box, null,
      e(Text, { bold: true, color: focused ? 'cyan' : undefined }, 'Resources'),
      e(Text, { dimColor: true }, ` (${util.activeAgents} active, ${util.totalSpawned} spawned)`),
    ),

    // Gauges
    e(GaugeRow, {
      label: 'Agents',
      current: util.activeAgents,
      max: cfg.maxConcurrentAgents,
      barWidth,
      animFrame,
    }),
    e(GaugeRow, {
      label: 'Memory',
      current: util.estimatedMemoryMB,
      max: cfg.maxMemoryMB,
      barWidth,
      format: 'memory',
      animFrame,
    }),
    e(GaugeRow, {
      label: 'Trees',
      current: util.worktreesInUse,
      max: cfg.maxWorktrees,
      barWidth,
      flash: true,
      animFrame,
    }),
    e(GaugeRow, {
      label: 'Cost',
      current: util.estimatedCost,
      max: budget,
      barWidth,
      format: 'cost',
      animFrame,
    }),
    merge.total > 0
      ? e(GaugeRow, {
          label: 'Merges',
          current: merge.completed,
          max: merge.total,
          barWidth,
          animFrame,
        })
      : null,

    // Throughput sparkline
    throughputValues && throughputValues.length > 0
      ? e(Box, { marginTop: 1 },
          e(Text, { dimColor: true }, 'Throughput '),
          e(Text, { color: 'cyan' }, renderSparkline(throughputValues, Math.min(barWidth, 20))),
          e(Text, { dimColor: true }, ' msg/s'),
        )
      : null,

    // Level breakdown
    levelStats.length > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Text, { dimColor: true }, 'By level:'),
          ...levelStats.map(ls =>
            e(LevelRow, {
              key: ls.level,
              level: ls.level,
              active: ls.active || 0,
              completed: ls.completed || 0,
              failed: ls.failed || 0,
            })
          )
        )
      : null,

    // Budget log
    logs.length > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Text, { dimColor: true }, 'Budget log:'),
          ...logs.slice(-3).map((entry, i) =>
            e(BudgetEntry, { key: i, entry })
          )
        )
      : null,
  );
}

/**
 * Create a utilization state object from governor instance or IPC messages.
 * Handles both direct governor access and message-based updates.
 *
 * @param {object} [governorOrData] - ResourceGovernor instance or raw utilization data
 * @returns {object} Normalized utilization state
 */
export function normalizeUtilization(governorOrData) {
  if (!governorOrData) {
    return {
      activeAgents: 0, totalSpawned: 0, totalCompleted: 0, totalFailed: 0,
      worktreesInUse: 0, estimatedMemoryMB: 0, estimatedCost: 0, byLevel: new Map(),
    };
  }

  // If it has getUtilization(), it's a governor instance
  if (typeof governorOrData.getUtilization === 'function') {
    return governorOrData.getUtilization();
  }

  // Otherwise treat as raw data
  return {
    activeAgents: governorOrData.activeAgents || 0,
    totalSpawned: governorOrData.totalSpawned || 0,
    totalCompleted: governorOrData.totalCompleted || 0,
    totalFailed: governorOrData.totalFailed || 0,
    worktreesInUse: governorOrData.worktreesInUse || 0,
    estimatedMemoryMB: governorOrData.estimatedMemoryMB || 0,
    estimatedCost: governorOrData.estimatedCost || 0,
    byLevel: governorOrData.byLevel || new Map(),
  };
}

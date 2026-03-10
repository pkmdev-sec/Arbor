/**
 * Layout — Responsive panel layout manager.
 *
 * Adapts the dashboard layout based on terminal width:
 *   120+ cols: Full layout (side-by-side panels)
 *    80+ cols: Compact layout (stacked panels, narrower sidebar)
 *    60+ cols: Minimal layout (everything stacked vertically)
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';

const { useState, useEffect } = React;

// ── Breakpoints ───────────────────────────────────────────────────

export const BREAKPOINTS = {
  full:    120,
  compact:  80,
  minimal:  60,
};

/**
 * Determine layout mode from terminal width.
 * @param {number} cols - Terminal column count
 * @returns {'full' | 'compact' | 'minimal'}
 */
export function getLayoutMode(cols) {
  if (cols >= BREAKPOINTS.full) return 'full';
  if (cols >= BREAKPOINTS.compact) return 'compact';
  return 'minimal';
}

/**
 * Get layout dimensions based on terminal size and layout mode.
 *
 * @param {number} cols - Terminal column count
 * @param {number} rows - Terminal row count
 * @returns {object} Layout dimensions
 */
export function getLayoutDimensions(cols, rows) {
  const mode = getLayoutMode(cols);

  switch (mode) {
    case 'full':
      return {
        mode,
        sidebarWidth: Math.min(36, Math.floor(cols * 0.28)),
        mainWidth: cols - Math.min(36, Math.floor(cols * 0.28)) - 3, // -3 for borders
        logLines: Math.max(8, rows - 20),
        barWidth: 20,
        sparklineWidth: 20,
        showSparklines: true,
        showBarChart: true,
        showCost: true,
        stackPanels: false,
      };

    case 'compact':
      return {
        mode,
        sidebarWidth: Math.min(28, Math.floor(cols * 0.30)),
        mainWidth: cols - Math.min(28, Math.floor(cols * 0.30)) - 3,
        logLines: Math.max(6, rows - 16),
        barWidth: 12,
        sparklineWidth: 12,
        showSparklines: true,
        showBarChart: true,
        showCost: true,
        stackPanels: false,
      };

    case 'minimal':
    default:
      return {
        mode,
        sidebarWidth: cols - 2,
        mainWidth: cols - 2,
        logLines: Math.max(4, rows - 12),
        barWidth: 10,
        sparklineWidth: 10,
        showSparklines: false,
        showBarChart: false,
        showCost: true,
        stackPanels: true,
      };
  }
}

/**
 * React hook for responsive terminal dimensions.
 * Listens to resize events and returns current layout info.
 *
 * @returns {{ cols: number, rows: number, layout: object }}
 */
export function useTerminalSize() {
  const getCols = () => process.stdout.columns || 80;
  const getRows = () => process.stdout.rows || 24;

  const [size, setSize] = useState({
    cols: getCols(),
    rows: getRows(),
  });

  useEffect(() => {
    const onResize = () => {
      setSize({ cols: getCols(), rows: getRows() });
    };

    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.removeListener('resize', onResize);
    };
  }, []);

  return {
    cols: size.cols,
    rows: size.rows,
    layout: getLayoutDimensions(size.cols, size.rows),
  };
}

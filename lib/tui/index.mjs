/**
 * TUI Data Layer — provides data utilities consumed by the Go TUI binary.
 * Rendering was consolidated into tui/ (Go, Bubble Tea).
 * These JS exports provide: cost estimation, progress watching, IPC streaming, data polling.
 */

/**
 * TUI Module — Clean re-exports of all TUI components for programmatic use.
 *
 * Entry points:
 *   import { startMonitor, start } from './tui/index.mjs'
 *   import { Dashboard, startDashboard } from './tui/index.mjs'
 *   import { ChatPanel, HierarchyPanel, ... } from './tui/index.mjs'
 *
 * @module tui
 */

// ── Monitor (standalone multi-run observer) ─────────────────────
export { startMonitor, start, parseCliArgs } from './monitor.mjs';

// ── Dashboard (single-run command center) ───────────────────────
export { startDashboard } from './dashboard.mjs';

// ── IPC monitor client ──────────────────────────────────────────
export { IpcMonitorClient } from './ipc-monitor-client.mjs';

// ── Panel components ────────────────────────────────────────────
export { ChatPanel } from './chat-panel.mjs';
export { HierarchyPanel, buildHierarchyTree, handleHierarchyInput } from './hierarchy-panel.mjs';
export { GovernorPanel, normalizeUtilization } from './governor-panel.mjs';
export { MergePanel, normalizeMergeData } from './merge-panel.mjs';
export {
  ControlPanel, ControlMode, createControlState,
  parseCommand, executeCommand,
} from './control-panel.mjs';

// ── Agent components ────────────────────────────────────────────
export {
  AgentListItem, AgentDetail, AgentCard,
  sortAgents, SORT_MODES,
} from './agent-card.mjs';

// ── Theme system ────────────────────────────────────────────────
export {
  getTheme, getThemeName, setTheme, cycleTheme, getThemeNames,
  statusColor, statusIcon, toolColor, uiColor, modelColor, levelColor,
  gaugeColor, renderGauge,
  formatElapsed, formatBytes, truncate, repeat,
  STATUS_COLORS, TOOL_COLORS, STATUS_ICONS, BOX, BAR, SPARK_CHARS,
  SPAWN_FRAMES, MERGE_FRAMES,
} from './theme.mjs';

// ── Layout ──────────────────────────────────────────────────────
export {
  useTerminalSize, getLayoutMode, getLayoutDimensions, BREAKPOINTS,
} from './layout.mjs';

// ── Help overlay ────────────────────────────────────────────────
export { HelpOverlay } from './help-overlay.mjs';

// ── Sparkline ───────────────────────────────────────────────────
export { Sparkline, renderSparkline, createSparklineTracker } from './sparkline.mjs';

// ── Bar chart ───────────────────────────────────────────────────
export { ToolBreakdown } from './bar-chart.mjs';

// ── Log viewer ──────────────────────────────────────────────────
export { LogViewer, LiveLogViewer } from './log-viewer.mjs';

// ── Cost tracker ────────────────────────────────────────────────
export { estimateAgentCost, estimateTotalCost, formatCost } from './cost-tracker.mjs';

// ── Progress reader ─────────────────────────────────────────────
export { createProgressWatcher } from './progress-reader.mjs';

// ── IPC stream (JSONL fallback) ─────────────────────────────────
export { createIpcStream } from './ipc-stream.mjs';

// ── Data poller (file-based fallback) ──────────────────────────
export { DataPoller, createDataPoller } from './data-poller.mjs';

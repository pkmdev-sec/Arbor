/**
 * Theme — Color constants and styling utilities for the TUI command center.
 *
 * Respects terminal defaults. Provides semantic color names and
 * box-drawing characters for consistent visual language.
 */

// ── Status colors ─────────────────────────────────────────────────
export const STATUS_COLORS = {
  running:  'yellow',
  done:     'green',
  failed:   'red',
  timeout:  'yellow',
  pending:  'gray',
  idle:     'gray',
  completed: 'green',
};

// ── Tool colors (for bar charts) ──────────────────────────────────
export const TOOL_COLORS = {
  Read:  'cyan',
  Edit:  'yellow',
  Write: 'magenta',
  Bash:  'green',
  Grep:  'blue',
  Glob:  'white',
};

// ── Status icons ──────────────────────────────────────────────────
export const STATUS_ICONS = {
  running: '◉',
  done:    '✓',
  failed:  '✗',
  timeout: '⏱',
  pending: '○',
};

// ── Box-drawing characters ────────────────────────────────────────
export const BOX = {
  topLeft:     '╭',
  topRight:    '╮',
  bottomLeft:  '╰',
  bottomRight: '╯',
  horizontal:  '─',
  vertical:    '│',
  teeRight:    '├',
  teeLeft:     '┤',
  cross:       '┼',
  heavyH:      '━',
  doubleH:     '═',
};

// ── Sparkline characters (8 levels, index 0 = lowest) ─────────────
export const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// ── Bar chart characters ──────────────────────────────────────────
export const BAR = {
  filled: '█',
  half:   '▌',
  empty:  '░',
  light:  '▒',
};

// ── Semantic style helpers ────────────────────────────────────────

/**
 * Get the color for a given status string.
 */
export function statusColor(status) {
  return STATUS_COLORS[status] || 'gray';
}

/**
 * Get the icon for a given status string.
 */
export function statusIcon(status) {
  return STATUS_ICONS[status] || '?';
}

/**
 * Get the color for a tool name.
 */
export function toolColor(tool) {
  return TOOL_COLORS[tool] || 'white';
}

/**
 * Format elapsed milliseconds as human-readable string.
 * <60s: "42s", >=60s: "1m23s", >=3600s: "1h02m"
 */
export function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${String(remSec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${String(remMin).padStart(2, '0')}m`;
}

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate a string to maxLen, adding '…' if truncated.
 */
export function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Repeat a character n times (clamped to 0).
 */
export function repeat(ch, n) {
  return ch.repeat(Math.max(0, Math.floor(n)));
}

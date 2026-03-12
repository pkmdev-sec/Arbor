/**
 * Theme — Multi-theme color system and styling utilities for the TUI command center.
 *
 * Supports hot-switching between dark, neon, and light themes.
 * Provides semantic color names, box-drawing characters, gauge rendering,
 * and gradient support for consistent visual language.
 *
 * Backward-compatible: flat exports (STATUS_COLORS, etc.) delegate to
 * the active theme so existing imports keep working.
 */

// ── Theme Definitions ─────────────────────────────────────────────

const THEMES = {
  dark: {
    name: 'dark',
    label: 'Dark',
    status: {
      running:   'yellow',
      spawning:  'cyan',
      done:      'green',
      failed:    'red',
      timeout:   'yellow',
      pending:   'gray',
      idle:      'gray',
      completed: 'green',
      merging:   'cyan',
    },
    statusIcons: {
      running:  '◉',
      spawning: '◐',
      done:     '✓',
      failed:   '✗',
      timeout:  '⏱',
      pending:  '○',
      merging:  '◐',
    },
    tool: {
      Read:  'cyan',
      Edit:  'yellow',
      Write: 'magenta',
      Bash:  'green',
      Grep:  'blue',
      Glob:  'white',
    },
    ui: {
      border:       'gray',
      borderActive: 'cyan',
      header:       'cyan',
      accent:       'cyan',
      dimText:      'gray',
      text:         'white',
      warning:      'yellow',
      error:        'red',
      success:      'green',
      cost:         'yellow',
      model:        { opus: 'magenta', sonnet: 'blue', haiku: 'green' },
      level:        { L0: 'cyan', L1: 'yellow', L2: 'green' },
    },
    box: {
      topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
      horizontal: '─', vertical: '│', teeRight: '├', teeLeft: '┤',
      cross: '┼', heavyH: '━', doubleH: '═', teeDown: '┬', teeUp: '┴',
    },
    gauge: { filled: '█', half: '▌', empty: '░', light: '▒' },
    spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
    gradient: ['#0077b6', '#00b4d8', '#90e0ef'],
    borderStyle: 'single',
  },

  neon: {
    name: 'neon',
    label: 'Neon',
    status: {
      running:   '#00ff00',
      spawning:  '#ff00ff',
      done:      '#00ff88',
      failed:    '#ff0055',
      timeout:   '#ffaa00',
      pending:   '#555555',
      idle:      '#555555',
      completed: '#00ff88',
      merging:   '#00ccff',
    },
    statusIcons: {
      running: '◉', spawning: '◐', done: '✓', failed: '✗',
      timeout: '⏱', pending: '○', merging: '◐',
    },
    tool: {
      Read: '#00ffff', Edit: '#ffff00', Write: '#ff00ff',
      Bash: '#00ff00', Grep: '#0088ff', Glob: '#ffffff',
    },
    ui: {
      border: '#333333', borderActive: '#ff00ff', header: '#ff00ff',
      accent: '#00ffff', dimText: '#555555', text: '#ffffff',
      warning: '#ffaa00', error: '#ff0055', success: '#00ff88', cost: '#ffaa00',
      model: { opus: '#ff00ff', sonnet: '#0088ff', haiku: '#00ff88' },
      level: { L0: '#ff00ff', L1: '#ffaa00', L2: '#00ff88' },
    },
    box: {
      topLeft: '┏', topRight: '┓', bottomLeft: '┗', bottomRight: '┛',
      horizontal: '━', vertical: '┃', teeRight: '┣', teeLeft: '┫',
      cross: '╋', heavyH: '━', doubleH: '═', teeDown: '┳', teeUp: '┻',
    },
    gauge: { filled: '█', half: '▌', empty: '░', light: '▒' },
    spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
    gradient: ['#ff00ff', '#cc00ff', '#00ffff'],
    borderStyle: 'bold',
  },

  light: {
    name: 'light',
    label: 'Light',
    status: {
      running: 'blue', spawning: 'magenta', done: 'green', failed: 'red',
      timeout: 'yellow', pending: 'gray', idle: 'gray', completed: 'green',
      merging: 'cyan',
    },
    statusIcons: {
      running: '◉', spawning: '◐', done: '✓', failed: '✗',
      timeout: '⏱', pending: '○', merging: '◐',
    },
    tool: {
      Read: 'blue', Edit: 'magenta', Write: 'red',
      Bash: 'green', Grep: 'cyan', Glob: 'gray',
    },
    ui: {
      border: 'gray', borderActive: 'blue', header: 'blue',
      accent: 'blue', dimText: 'gray', text: 'black',
      warning: 'yellow', error: 'red', success: 'green', cost: 'magenta',
      model: { opus: 'red', sonnet: 'blue', haiku: 'green' },
      level: { L0: 'blue', L1: 'magenta', L2: 'green' },
    },
    box: {
      topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
      horizontal: '─', vertical: '│', teeRight: '├', teeLeft: '┤',
      cross: '┼', heavyH: '━', doubleH: '═', teeDown: '┬', teeUp: '┴',
    },
    gauge: { filled: '█', half: '▌', empty: '░', light: '▒' },
    spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
    gradient: ['#003366', '#336699', '#6699cc'],
    borderStyle: 'round',
  },
};

// ── Active Theme State ────────────────────────────────────────────

let _activeThemeName = 'dark';
const THEME_NAMES = Object.keys(THEMES);

/** Get the currently active theme object. */
export function getTheme() {
  return THEMES[_activeThemeName] || THEMES.dark;
}

/** Get the active theme name. */
export function getThemeName() {
  return _activeThemeName;
}

/** Set the active theme by name. */
export function setTheme(name) {
  if (THEMES[name]) _activeThemeName = name;
}

/** Cycle to the next theme. Returns new theme name. */
export function cycleTheme() {
  const idx = THEME_NAMES.indexOf(_activeThemeName);
  _activeThemeName = THEME_NAMES[(idx + 1) % THEME_NAMES.length];
  return _activeThemeName;
}

/** Get all available theme names. */
export function getThemeNames() {
  return [...THEME_NAMES];
}

// ── Backward-compatible flat exports ──────────────────────────────

export const STATUS_COLORS = new Proxy({}, {
  get: (_, key) => getTheme().status[key] || 'gray',
  ownKeys: () => Object.keys(getTheme().status),
  getOwnPropertyDescriptor: (_, key) => ({
    value: getTheme().status[key], enumerable: true, configurable: true,
  }),
});

export const TOOL_COLORS = new Proxy({}, {
  get: (_, key) => getTheme().tool[key] || 'white',
});

export const STATUS_ICONS = new Proxy({}, {
  get: (_, key) => getTheme().statusIcons[key] || '?',
});

export const BOX = new Proxy({}, {
  get: (_, key) => getTheme().box[key] || '',
});

export const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export const BAR = new Proxy({}, {
  get: (_, key) => getTheme().gauge[key] || '',
});

// ── Semantic style helpers ────────────────────────────────────────

export function statusColor(status) {
  return getTheme().status[status] || 'gray';
}

export function statusIcon(status) {
  return getTheme().statusIcons[status] || '?';
}

export function toolColor(tool) {
  return getTheme().tool[tool] || 'white';
}

/** Get a UI color by semantic name. */
export function uiColor(name) {
  return getTheme().ui[name] || 'white';
}

/** Get model badge color. */
export function modelColor(model) {
  const m = (model || '').toLowerCase();
  const colors = getTheme().ui.model;
  if (m.includes('opus')) return colors.opus;
  if (m.includes('sonnet')) return colors.sonnet;
  if (m.includes('haiku')) return colors.haiku;
  return 'white';
}

/** Get level indicator color. */
export function levelColor(level) {
  const colors = getTheme().ui.level;
  if (level === 0) return colors.L0;
  if (level === 1) return colors.L1;
  return colors.L2;
}

/** Get gauge color based on utilization ratio (0.0–1.0). */
export function gaugeColor(ratio) {
  const theme = getTheme();
  if (ratio >= 0.8) return theme.ui.error;
  if (ratio >= 0.6) return theme.ui.warning;
  return theme.ui.success;
}

/**
 * Render a horizontal gauge bar.
 * @returns {{ bar: string, color: string, ratio: number }}
 */
export function renderGauge(current, max, width) {
  const g = getTheme().gauge;
  const ratio = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const color = gaugeColor(ratio);
  const bar = g.filled.repeat(filled) + g.empty.repeat(empty);
  return { bar, color, ratio };
}

// ── Spinner frames ────────────────────────────────────────────────

export const SPAWN_FRAMES = ['◐', '◓', '◑', '◒'];
export const MERGE_FRAMES = ['◐', '◓', '◑', '◒'];

// ── Format helpers ────────────────────────────────────────────────

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

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

export function repeat(ch, n) {
  return ch.repeat(Math.max(0, Math.floor(n)));
}

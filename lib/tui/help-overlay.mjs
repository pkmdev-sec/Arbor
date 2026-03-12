/**
 * HelpOverlay — Keyboard shortcut help screen overlay.
 *
 * Renders a centered modal-style box listing all keyboard shortcuts.
 * Toggled with '?' key from the dashboard.
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

const SHORTCUTS = [
  { key: '↑/k',         desc: 'Move up in agent list' },
  { key: '↓/j',         desc: 'Move down in agent list' },
  { key: 'Tab',         desc: 'Cycle focus to next panel' },
  { key: 'Shift+Tab',   desc: 'Cycle focus to previous panel' },
  { key: 'Enter',       desc: 'Expand selected / toggle tree node' },
  { key: '←/→',         desc: 'Collapse/expand tree node' },
  { key: 'l',           desc: 'Toggle full-screen log view' },
  { key: 'c',           desc: 'Cancel selected agent (SIGTERM)' },
  { key: 'p',           desc: 'Pause/resume selected agent' },
  { key: 'a',           desc: 'Abort selected agent (graceful)' },
  { key: 'm',           desc: 'Open message input' },
  { key: 'f',           desc: 'Open filter input' },
  { key: ':',           desc: 'Open command input' },
  { key: 't',           desc: 'Cycle theme (dark → neon → light)' },
  { key: 's',           desc: 'Cycle agent sort mode' },
  { key: 'r',           desc: 'Force refresh' },
  { key: '1-6',         desc: 'Jump to panel' },
  { key: '?',           desc: 'Toggle this help overlay' },
  { key: 'q',           desc: 'Quit' },
];

/**
 * HelpOverlay component.
 *
 * @param {object} props
 * @param {boolean} props.visible - Whether to show the overlay
 */
export function HelpOverlay({ visible }) {
  if (!visible) return null;

  const maxKeyLen = Math.max(...SHORTCUTS.map(s => s.key.length));

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: 'cyan',
    paddingX: 2,
    paddingY: 1,
    alignSelf: 'center',
  },
    e(Text, { bold: true, color: 'cyan' }, '  Keyboard Shortcuts'),
    e(Text, null, ''),
    ...SHORTCUTS.map((s, i) =>
      e(Box, { key: i },
        e(Text, { bold: true, color: 'yellow' }, s.key.padEnd(maxKeyLen + 2)),
        e(Text, null, s.desc)
      )
    ),
    e(Text, null, ''),
    e(Text, { dimColor: true }, '  Press ? to close')
  );
}

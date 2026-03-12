/**
 * ControlPanel — Interactive control panel at the bottom of the TUI.
 *
 * Four modes:
 *   Mode 1 — Status Bar (default): keyboard hint badges
 *   Mode 2 — Message Input (M): send message to agent via IPC
 *   Mode 3 — Filter Input (F): filter chat/agent list
 *   Mode 4 — Command Input (:): execute commands
 *
 * Actions wired to IPC bus for controlling agents.
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { getThemeName, truncate } from './theme.mjs';

const { useState, useCallback } = React;
const e = React.createElement;

// ── Control Mode Enum ────────────────────────────────────────────

export const ControlMode = {
  STATUS:  'status',
  MESSAGE: 'message',
  FILTER:  'filter',
  COMMAND: 'command',
};

// ── Keyboard Hint Badges ─────────────────────────────────────────

const STATUS_HINTS = [
  { key: 'Tab', desc: 'Panel' },
  { key: 'P', desc: 'Pause' },
  { key: 'R', desc: 'Resume' },
  { key: 'A', desc: 'Abort' },
  { key: 'M', desc: 'Message' },
  { key: 'F', desc: 'Filter' },
  { key: 'T', desc: 'Theme' },
  { key: '?', desc: 'Help' },
  { key: 'Q', desc: 'Quit' },
];

function HintBadge({ hint }) {
  return e(Box, { marginRight: 1 },
    e(Text, { color: 'cyan', bold: true }, '['),
    e(Text, { bold: true }, hint.key),
    e(Text, { color: 'cyan', bold: true }, '] '),
    e(Text, { dimColor: true }, hint.desc),
  );
}

// ── Status Bar Mode ──────────────────────────────────────────────

function StatusBar({ activePanel, agentCount, themeName }) {
  return e(Box, { paddingX: 1 },
    ...STATUS_HINTS.map((hint, i) => e(HintBadge, { key: i, hint })),
    e(Text, { dimColor: true }, ' '),
    e(Text, { dimColor: true }, `[${themeName}]`),
  );
}

// ── Message Input Mode ───────────────────────────────────────────

function MessageInput({ inputText, targetAgent, agents }) {
  return e(Box, { paddingX: 1 },
    e(Text, { color: 'cyan', bold: true }, 'Send to: '),
    e(Text, { color: 'yellow', bold: true }, targetAgent || 'all'),
    e(Text, { dimColor: true }, ' > '),
    e(Text, null, inputText || ''),
    e(Text, { color: 'gray' }, '█'),
    e(Text, { dimColor: true }, '  (Tab: cycle target, Enter: send, Esc: cancel)'),
  );
}

// ── Filter Input Mode ────────────────────────────────────────────

function FilterInput({ inputText, filterType, activeFilters }) {
  const typeLabel = filterType || 'agent';
  const badges = (activeFilters || []).map((f, i) =>
    e(Box, { key: i, marginRight: 1 },
      e(Text, { color: 'magenta' }, '[', f.type, ':', f.value, ']')
    )
  );

  return e(Box, { paddingX: 1 },
    e(Text, { color: 'magenta', bold: true }, 'Filter: '),
    e(Text, { dimColor: true }, typeLabel, ': '),
    e(Text, null, inputText || ''),
    e(Text, { color: 'gray' }, '█'),
    ...badges,
    e(Text, { dimColor: true }, '  (Tab: type, Enter: apply, Esc: cancel)'),
  );
}

// ── Command Input Mode ───────────────────────────────────────────

function CommandInput({ inputText }) {
  return e(Box, { paddingX: 1 },
    e(Text, { color: 'yellow', bold: true }, ': '),
    e(Text, null, inputText || ''),
    e(Text, { color: 'gray' }, '█'),
    e(Text, { dimColor: true }, '  (Enter: execute, Esc: cancel)'),
  );
}

// ── Main ControlPanel Component ──────────────────────────────────

/**
 * Interactive control panel with multiple input modes.
 *
 * @param {object} props
 * @param {string} props.mode - Current control mode (ControlMode enum)
 * @param {string} [props.inputText] - Current text in input buffer
 * @param {string} [props.targetAgent] - Target agent for message mode
 * @param {string} [props.filterType] - Active filter type for filter mode
 * @param {object[]} [props.activeFilters] - Active filter badges
 * @param {string[]} [props.agents] - Available agent names for tab-complete
 * @param {string} [props.activePanel] - Currently focused panel name
 * @param {number} [props.agentCount] - Total agent count
 * @param {string} [props.statusMessage] - Temporary status message overlay
 */
export function ControlPanel({
  mode,
  inputText,
  targetAgent,
  filterType,
  activeFilters,
  agents,
  activePanel,
  agentCount,
  statusMessage,
}) {
  const themeName = getThemeName();
  const currentMode = mode || ControlMode.STATUS;

  // Status message overlay
  if (statusMessage) {
    return e(Box, { paddingX: 1 },
      e(Text, { color: 'yellow', bold: true }, statusMessage),
    );
  }

  switch (currentMode) {
    case ControlMode.MESSAGE:
      return e(MessageInput, { inputText, targetAgent, agents });

    case ControlMode.FILTER:
      return e(FilterInput, { inputText, filterType, activeFilters });

    case ControlMode.COMMAND:
      return e(CommandInput, { inputText });

    case ControlMode.STATUS:
    default:
      return e(StatusBar, { activePanel, agentCount, themeName });
  }
}

// ── Command Parser ───────────────────────────────────────────────

/**
 * Parse a command string into action + arguments.
 *
 * Supported commands:
 *   :pause <agent>    - Pause an agent
 *   :resume <agent>   - Resume a paused agent
 *   :abort <agent>    - Abort an agent
 *   :kill <agent>     - Force kill an agent
 *   :merge <file>     - Trigger merge for a file
 *   :status           - Show status summary
 *   :cost             - Show cost summary
 *   :tree             - Switch to hierarchy view
 *   :agents           - Switch to agent list view
 *   :clear            - Clear chat messages
 *   :theme <name>     - Set theme (dark|neon|light)
 *   :export <file>    - Export session data
 *
 * @param {string} input - Raw command string (including leading ":")
 * @returns {{ command: string, args: string[], raw: string } | null}
 */
export function parseCommand(input) {
  if (!input || !input.startsWith(':')) return null;
  const trimmed = input.slice(1).trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  return { command, args, raw: trimmed };
}

/**
 * Execute a parsed command against the control system.
 *
 * @param {object} cmd - Parsed command from parseCommand()
 * @param {object} actions - Action callbacks: { pause, resume, abort, kill, setTheme, switchPanel, clear, getStatus, getCost, exportData }
 * @returns {{ success: boolean, message: string }}
 */
export function executeCommand(cmd, actions) {
  if (!cmd || !cmd.command) {
    return { success: false, message: 'No command' };
  }

  switch (cmd.command) {
    case 'pause':
      if (!cmd.args[0]) return { success: false, message: 'Usage: :pause <agent-id>' };
      if (actions.pause) actions.pause(cmd.args[0]);
      return { success: true, message: `Pausing ${cmd.args[0]}` };

    case 'resume':
      if (!cmd.args[0]) return { success: false, message: 'Usage: :resume <agent-id>' };
      if (actions.resume) actions.resume(cmd.args[0]);
      return { success: true, message: `Resuming ${cmd.args[0]}` };

    case 'abort':
      if (!cmd.args[0]) return { success: false, message: 'Usage: :abort <agent-id>' };
      if (actions.abort) actions.abort(cmd.args[0]);
      return { success: true, message: `Aborting ${cmd.args[0]}` };

    case 'kill':
      if (!cmd.args[0]) return { success: false, message: 'Usage: :kill <agent-id>' };
      if (actions.kill) actions.kill(cmd.args[0]);
      return { success: true, message: `Killing ${cmd.args[0]}` };

    case 'theme':
      if (!cmd.args[0]) return { success: false, message: 'Usage: :theme dark|neon|light' };
      if (actions.setTheme) actions.setTheme(cmd.args[0]);
      return { success: true, message: `Theme: ${cmd.args[0]}` };

    case 'tree':
      if (actions.switchPanel) actions.switchPanel('hierarchy');
      return { success: true, message: 'Switching to hierarchy view' };

    case 'agents':
      if (actions.switchPanel) actions.switchPanel('agents');
      return { success: true, message: 'Switching to agents view' };

    case 'status':
      if (actions.getStatus) return { success: true, message: actions.getStatus() };
      return { success: true, message: 'Status requested' };

    case 'cost':
      if (actions.getCost) return { success: true, message: actions.getCost() };
      return { success: true, message: 'Cost requested' };

    case 'clear':
      if (actions.clear) actions.clear();
      return { success: true, message: 'Cleared' };

    case 'export':
      if (!cmd.args[0]) return { success: false, message: 'Usage: :export <file>' };
      if (actions.exportData) actions.exportData(cmd.args[0]);
      return { success: true, message: `Exporting to ${cmd.args[0]}` };

    default:
      return { success: false, message: `Unknown command: ${cmd.command}` };
  }
}

/**
 * Create a control state manager for the dashboard to use.
 * Encapsulates mode switching and input buffer management.
 *
 * @returns {object} Control state with methods
 */
export function createControlState() {
  let mode = ControlMode.STATUS;
  let inputText = '';
  let targetAgent = 'all';
  let filterType = 'agent';
  let activeFilters = [];
  let statusMessage = '';
  let statusTimeout = null;
  let agentNames = [];

  return {
    getState() {
      return { mode, inputText, targetAgent, filterType, activeFilters, statusMessage };
    },

    setMode(newMode) {
      mode = newMode;
      inputText = '';
    },

    appendChar(ch) {
      inputText += ch;
    },

    backspace() {
      inputText = inputText.slice(0, -1);
    },

    getInputText() {
      return inputText;
    },

    cancel() {
      mode = ControlMode.STATUS;
      inputText = '';
    },

    setAgentNames(names) {
      agentNames = names;
    },

    cycleTarget() {
      const all = ['all', ...agentNames];
      const idx = all.indexOf(targetAgent);
      targetAgent = all[(idx + 1) % all.length];
    },

    cycleFilterType() {
      const types = ['agent', 'type', 'topic', 'level'];
      const idx = types.indexOf(filterType);
      filterType = types[(idx + 1) % types.length];
    },

    addFilter() {
      if (inputText.trim()) {
        activeFilters.push({ type: filterType, value: inputText.trim() });
        inputText = '';
      }
    },

    clearFilters() {
      activeFilters = [];
    },

    getFilters() {
      return activeFilters;
    },

    getTargetAgent() {
      return targetAgent;
    },

    showStatus(msg, durationMs = 3000) {
      statusMessage = msg;
      if (statusTimeout) clearTimeout(statusTimeout);
      statusTimeout = setTimeout(() => {
        statusMessage = '';
      }, durationMs);
    },

    cleanup() {
      if (statusTimeout) clearTimeout(statusTimeout);
    },
  };
}

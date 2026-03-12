/**
 * ChatPanel — Ink component showing the live IPC chat stream.
 *
 * Renders agent-to-agent messages in a chat-style view with:
 *   - Real-time Unix socket connection to the IPC message bus (primary)
 *   - JSONL file-based fallback when socket bus isn't running
 *   - Message type color coding: publish (blue), request (green), response (cyan),
 *     control (red), broadcast (yellow), direct (white), error (red bold)
 *   - Topic filtering with filter badges
 *   - Agent name filtering
 *   - Auto-scroll with manual scroll lock (press S to toggle)
 *   - Message count badge
 *   - Relative timestamp formatting ('2s ago', '1m ago')
 *   - Direction indicator: → outgoing, ← incoming
 *   - Message detail expansion on Enter key
 *   - Ring buffer: max 1000 messages, rotate old ones out
 *   - Color-coded senders (orchestrator=cyan, agents=yellow, verifier=magenta)
 *   - Connection source indicator (SOCKET / FILE)
 *
 * Uses React.createElement ONLY (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { IpcMonitorClient } from './ipc-monitor-client.mjs';

const { useState, useEffect, useRef } = React;
const e = React.createElement;

// ── Ring buffer capacity ────────────────────────────────────────
const MAX_MESSAGES = 1000;
const TRIM_TO = 750; // when capacity exceeded, trim to this count

// ── Color map for senders ───────────────────────────────────────
const SENDER_COLORS = {
  orchestrator: 'cyan',
  decomposer: 'magenta',
  scout: 'blue',
  verifier: 'magenta',
  system: 'gray',
  'ai-client': 'green',
  'message-bus': 'gray',
};

function getSenderColor(from) {
  if (from && from.startsWith('agent-')) return 'yellow';
  if (from && from.startsWith('tui-monitor')) return 'gray';
  return SENDER_COLORS[from] || 'white';
}

// ── Message type color coding ───────────────────────────────────
const TYPE_COLORS = {
  publish:   'blue',
  request:   'green',
  response:  'cyan',
  control:   'red',
  broadcast: 'yellow',
  direct:    'white',
  error:     'red',
  lifecycle: 'gray',
  heartbeat: 'gray',
  progress:  'gray',
  result:    'green',
  verdict:   'magenta',
  decision:  'cyan',
  tool_call: 'yellow',
};

function getTypeColor(type) {
  return TYPE_COLORS[type] || 'white';
}

// ── Type icons — includes both JSONL types and IPC protocol types
const TYPE_ICONS = {
  task_assign: '\u2192',  // →
  progress: '\u280B',     // ⠋
  result: '\u2713',       // ✓
  verdict: '\u25C6',      // ◆
  error: '\u2717',        // ✗
  decision: '\u25C7',     // ◇
  lifecycle: '\u25CB',    // ○
  tool_call: '\u26A1',    // ⚡
  request: '\u003F',      // ?
  response: '\u2190',     // ←
  direct: '\u2192',       // →
  publish: '\u25C8',      // ◈
  broadcast: '\u25C9',    // ◉
  control: '\u25A0',      // ■
};

// ── Direction indicators ────────────────────────────────────────
const DIR_OUTGOING = '\u2192'; // →
const DIR_INCOMING = '\u2190'; // ←

// ── Source indicator colors ─────────────────────────────────────
const SOURCE_COLORS = {
  socket: 'green',
  file: 'yellow',
  none: 'red',
};

// ── Relative timestamp formatting ───────────────────────────────

/**
 * Format a timestamp as a relative time string.
 * @param {number} ts - Unix timestamp in milliseconds
 * @returns {string} Relative time like '2s ago', '1m ago', '3h ago'
 */
function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'now';
  if (diff < 1000) return 'now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Determine message direction relative to the TUI monitor.
 * @param {object} msg - Normalized message
 * @returns {'outgoing' | 'incoming'}
 */
function getDirection(msg) {
  // From the monitor's perspective: messages from the monitor are outgoing, everything else is incoming
  if (msg.from && msg.from.startsWith('tui-monitor')) return 'outgoing';
  return 'incoming';
}

// ── ChatPanel Component ─────────────────────────────────────────

/**
 * @param {object} props
 * @param {string} [props.workDir] - Swarm work directory for JSONL fallback
 * @param {string} [props.socketPath] - Unix socket path for IPC bus
 * @param {number} [props.height=20] - Visible height in rows
 * @param {string} [props.filter=null] - Agent filter (deprecated, use topicFilter/agentFilter)
 * @param {string} [props.topicFilter=null] - Topic filter string
 * @param {string} [props.agentFilter=null] - Agent name filter string
 */
export function ChatPanel({ workDir, socketPath, height = 20, filter = null, topicFilter = null, agentFilter = null }) {
  const [messages, setMessages] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [source, setSource] = useState('none');
  const [expandedIdx, setExpandedIdx] = useState(-1);
  const [localTopicFilter, setLocalTopicFilter] = useState(topicFilter || '');
  const [localAgentFilter, setLocalAgentFilter] = useState(agentFilter || filter || '');
  const [filterInputMode, setFilterInputMode] = useState(null); // null | 'topic' | 'agent'
  const [filterInputText, setFilterInputText] = useState('');
  const monitorRef = useRef(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const monitor = new IpcMonitorClient({ socketPath, workDir });
    monitorRef.current = monitor;

    monitor.on('message', (msg) => {
      setMessages(prev => {
        const next = [...prev, msg];
        // Ring buffer: trim when exceeding capacity
        return next.length > MAX_MESSAGES ? next.slice(-TRIM_TO) : next;
      });
      // Auto-scroll resets offset when enabled
    });

    monitor.on('source', (src) => {
      setSource(src);
    });

    monitor.start().catch(() => {
      // Start handles its own fallback — this catches unexpected errors
    });

    return () => {
      monitor.stop();
      monitorRef.current = null;
    };
  }, [workDir, socketPath]);

  // Refresh relative timestamps periodically
  useEffect(() => {
    const timer = setInterval(() => setRefreshTick(t => t + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  // Input handling
  useInput((input, key) => {
    // Filter input mode
    if (filterInputMode) {
      if (key.escape) {
        setFilterInputMode(null);
        setFilterInputText('');
        return;
      }
      if (key.return) {
        if (filterInputMode === 'topic') setLocalTopicFilter(filterInputText);
        else if (filterInputMode === 'agent') setLocalAgentFilter(filterInputText);
        setFilterInputMode(null);
        setFilterInputText('');
        return;
      }
      if (key.backspace || key.delete) {
        setFilterInputText(t => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilterInputText(t => t + input);
      }
      return;
    }

    // Normal mode
    if (key.upArrow) {
      setScrollOffset(o => Math.min(o + 1, Math.max(0, messages.length - height)));
      setAutoScroll(false);
    }
    if (key.downArrow) {
      setScrollOffset(o => {
        const next = Math.max(0, o - 1);
        if (next === 0) setAutoScroll(true);
        return next;
      });
    }

    // S: toggle scroll lock
    if (input === 's' || input === 'S') {
      setAutoScroll(prev => {
        if (!prev) setScrollOffset(0);
        return !prev;
      });
    }

    // Enter: expand/collapse message detail
    if (key.return) {
      const filtered = getFilteredMessages();
      const visibleStart = Math.max(0, filtered.length - height - scrollOffset);
      const cursorInView = visibleStart + Math.floor(height / 2);
      setExpandedIdx(prev => prev === cursorInView ? -1 : cursorInView);
    }

    // T: topic filter
    if (input === 'T') {
      setFilterInputMode('topic');
      setFilterInputText(localTopicFilter);
    }

    // A: agent filter
    if (input === 'A') {
      setFilterInputMode('agent');
      setFilterInputText(localAgentFilter);
    }

    // C: clear filters
    if (input === 'C') {
      setLocalTopicFilter('');
      setLocalAgentFilter('');
      setExpandedIdx(-1);
    }
  });

  // Helper: get filtered messages
  function getFilteredMessages() {
    let result = messages;

    // Agent filter (legacy 'filter' prop or local)
    const agentF = localAgentFilter;
    if (agentF) {
      const lower = agentF.toLowerCase();
      result = result.filter(m =>
        (m.from && m.from.toLowerCase().includes(lower)) ||
        (m.to && m.to.toLowerCase().includes(lower))
      );
    }

    // Topic filter
    if (localTopicFilter) {
      const lower = localTopicFilter.toLowerCase();
      result = result.filter(m =>
        (m.meta?.topic && m.meta.topic.toLowerCase().includes(lower)) ||
        (m.type && m.type.toLowerCase().includes(lower))
      );
    }

    return result;
  }

  const filtered = getFilteredMessages();

  // Get visible window
  const effectiveOffset = autoScroll ? 0 : scrollOffset;
  const visibleStart = Math.max(0, filtered.length - height - effectiveOffset);
  const visible = filtered.slice(visibleStart, visibleStart + height);

  // Render header with source indicator, message count, and filter badges
  const sourceLabel = source === 'socket' ? 'SOCKET' : source === 'file' ? 'FILE' : '---';
  const sourceClr = SOURCE_COLORS[source] || 'gray';

  const filterBadges = [];
  if (localAgentFilter) {
    filterBadges.push(e(Text, { key: 'af', color: 'magenta' }, '  [agent:', localAgentFilter, ']'));
  }
  if (localTopicFilter) {
    filterBadges.push(e(Text, { key: 'tf', color: 'blue' }, '  [topic:', localTopicFilter, ']'));
  }

  const headerChildren = [
    e(Text, { key: 'title', bold: true, color: 'cyan' }, 'IPC Chat'),
    e(Text, { key: 'sp', dimColor: true }, ' '),
    e(Text, { key: 'src', color: sourceClr, bold: true }, '[', sourceLabel, ']'),
    e(Text, { key: 'cnt', dimColor: true }, '  ', String(filtered.length)),
    filtered.length !== messages.length
      ? e(Text, { key: 'total', dimColor: true }, '/', String(messages.length))
      : null,
    e(Text, { key: 'lbl', dimColor: true }, ' msgs'),
    autoScroll ? null : e(Text, { key: 'scroll', color: 'yellow', bold: true }, '  [LOCKED]'),
    ...filterBadges,
  ];

  // Filter input overlay
  if (filterInputMode) {
    headerChildren.push(
      e(Text, { key: 'fi-label', color: 'cyan', bold: true }, `  ${filterInputMode}: `),
      e(Text, { key: 'fi-text' }, filterInputText),
      e(Text, { key: 'fi-cursor', color: 'gray' }, '█'),
    );
  }

  const header = e(Box, { borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
    ...headerChildren.filter(Boolean),
  );

  const messageRows = visible.map((msg, i) => {
    const globalIdx = visibleStart + i;
    const icon = TYPE_ICONS[msg.type] || '\u00B7';
    const senderColor = getSenderColor(msg.from);
    const typeColor = getTypeColor(msg.type);
    const dir = getDirection(msg);
    const dirIcon = dir === 'outgoing' ? DIR_OUTGOING : DIR_INCOMING;
    const dirColor = dir === 'outgoing' ? 'cyan' : 'gray';
    const relTime = formatRelativeTime(msg.ts);
    const isExpanded = expandedIdx === globalIdx;

    // Build meta string from available metadata
    const metaParts = [];
    if (msg.meta?.latencyMs) metaParts.push(msg.meta.latencyMs + 'ms');
    if (msg.meta?.tokens) metaParts.push(msg.meta.tokens + ' tok');
    if (msg.meta?.topic) metaParts.push('#' + msg.meta.topic);
    const metaStr = metaParts.length > 0 ? ' [' + metaParts.join(' ') + ']' : '';

    const rows = [
      // Main message row
      e(Box, { key: `${i}-main` },
        e(Text, { dimColor: true }, relTime ? relTime.padEnd(8) : (msg.t || '').padEnd(8), ' '),
        e(Text, { color: dirColor }, dirIcon, ' '),
        e(Text, { color: senderColor, bold: true }, msg.from || '?'),
        e(Text, { dimColor: true }, ' '),
        e(Text, { color: typeColor }, icon, ' '),
        e(Text, { color: typeColor, bold: true }, (msg.type || '').padEnd(10)),
        e(Text, { dimColor: true }, msg.to ? ' \u2192 ' + msg.to : ''),
        e(Text, { dimColor: true }, metaStr),
      ),
      // Content line
      e(Box, { key: `${i}-content`, paddingLeft: 3 },
        e(Text, {
          dimColor: msg.type === 'progress' || msg.type === 'heartbeat',
          color: msg.type === 'error' ? 'red' : undefined,
        },
          '\u250A  ' + (msg.content || '').slice(0, isExpanded ? 500 : 100)
        )
      ),
    ];

    // Expanded detail view
    if (isExpanded && msg.meta) {
      const details = [];
      if (msg.meta.msgType) details.push(`Proto: ${msg.meta.msgType}`);
      if (msg.meta.correlationId) details.push(`CorrID: ${msg.meta.correlationId}`);
      if (msg.meta.id) details.push(`MsgID: ${msg.meta.id}`);
      if (msg.meta.priority) details.push(`Priority: ${msg.meta.priority}`);
      if (details.length > 0) {
        rows.push(
          e(Box, { key: `${i}-detail`, paddingLeft: 5 },
            e(Text, { dimColor: true, color: 'gray' }, details.join('  │  ')),
          )
        );
      }
      // Full content if truncated
      if (msg.content && msg.content.length > 100) {
        rows.push(
          e(Box, { key: `${i}-full`, paddingLeft: 5 },
            e(Text, { dimColor: true }, msg.content.slice(100, 500)),
          )
        );
      }
    }

    return e(Box, { key: i, flexDirection: 'column' }, ...rows);
  });

  // Footer hints
  const footer = e(Box, { paddingX: 1 },
    e(Text, { dimColor: true }, '↑↓:scroll  S:'),
    e(Text, { color: autoScroll ? 'green' : 'yellow' }, autoScroll ? 'auto' : 'lock'),
    e(Text, { dimColor: true }, '  Enter:detail  T:topic  A:agent  C:clear'),
  );

  return e(Box, { flexDirection: 'column', height: height + 4 },
    header,
    e(Box, { flexDirection: 'column', flexGrow: 1 }, ...messageRows),
    footer,
  );
}

/**
 * ChatPanel — Ink component showing the live IPC chat stream.
 *
 * Renders agent-to-agent messages in a chat-style view with:
 *   - Real-time Unix socket connection to the IPC message bus (primary)
 *   - JSONL file-based fallback when socket bus isn't running
 *   - Color-coded senders (orchestrator=cyan, agents=yellow, verifier=magenta)
 *   - Type icons (→ task_assign, ⠋ progress, ✓ result, ◆ verdict, etc.)
 *   - Protocol message type color-coding
 *   - Auto-scroll with manual scroll-up via ↑↓ keys
 *   - Connection source indicator (SOCKET / FILE)
 *   - Optional sender/receiver filter
 *
 * Uses React.createElement ONLY (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { IpcMonitorClient } from './ipc-monitor-client.mjs';

const { useState, useEffect, useRef } = React;
const e = React.createElement;

// Color map for senders
const SENDER_COLORS = {
  orchestrator: 'cyan',
  decomposer: 'magenta',
  scout: 'blue',
  verifier: 'magenta',
  system: 'gray',
  'ai-client': 'green',
  'message-bus': 'gray',
};

// agent-01..05 get yellow, tui-monitor gets gray
function getSenderColor(from) {
  if (from && from.startsWith('agent-')) return 'yellow';
  if (from && from.startsWith('tui-monitor')) return 'gray';
  return SENDER_COLORS[from] || 'white';
}

// Type icons — includes both JSONL types and IPC protocol types
const TYPE_ICONS = {
  task_assign: '\u2192',  // →
  progress: '\u280B',     // ⠋
  result: '\u2713',       // ✓
  verdict: '\u25C6',      // ◆
  error: '\u2717',        // ✗
  decision: '\u25C7',     // ◇
  lifecycle: '\u25CB',    // ○
  tool_call: '\u26A1',    // ⚡
  // Protocol-aware types from IPC monitor
  request: '\u003F',      // ?
  response: '\u2190',     // ←
  direct: '\u2192',       // →
  publish: '\u25C8',      // ◈
};

// Source indicator colors
const SOURCE_COLORS = {
  socket: 'green',
  file: 'yellow',
  none: 'red',
};

export function ChatPanel({ workDir, socketPath, height = 20, filter = null }) {
  const [messages, setMessages] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [source, setSource] = useState('none');
  const monitorRef = useRef(null);

  useEffect(() => {
    const monitor = new IpcMonitorClient({ socketPath, workDir });
    monitorRef.current = monitor;

    monitor.on('message', (msg) => {
      setMessages(prev => {
        const next = [...prev, msg];
        return next.length > 500 ? next.slice(-300) : next;
      });
      if (autoScroll) setScrollOffset(0);
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

  useInput((input, key) => {
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
  });

  // Apply filter
  const filtered = filter
    ? messages.filter(m => m.from === filter || m.to === filter)
    : messages;

  // Get visible window
  const visibleStart = Math.max(0, filtered.length - height - scrollOffset);
  const visible = filtered.slice(visibleStart, visibleStart + height);

  // Render header with source indicator
  const sourceLabel = source === 'socket' ? 'SOCKET' : source === 'file' ? 'FILE' : '---';
  const sourceClr = SOURCE_COLORS[source] || 'gray';

  const header = e(Box, { borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
    e(Text, { bold: true, color: 'cyan' }, 'IPC Chat'),
    e(Text, { dimColor: true }, ' '),
    e(Text, { color: sourceClr, bold: true }, '[', sourceLabel, ']'),
    e(Text, { dimColor: true }, '  ' + filtered.length + ' msgs'),
    autoScroll ? null : e(Text, { color: 'yellow' }, '  \u2191 scrolled'),
    filter ? e(Text, { color: 'magenta' }, '  filter: ' + filter) : null
  );

  const messageRows = visible.map((msg, i) => {
    const icon = TYPE_ICONS[msg.type] || '\u00B7';
    const color = getSenderColor(msg.from);

    // Build meta string from available metadata
    const metaParts = [];
    if (msg.meta?.latencyMs) metaParts.push(msg.meta.latencyMs + 'ms');
    if (msg.meta?.tokens) metaParts.push(msg.meta.tokens + ' tok');
    if (msg.meta?.msgType && msg.meta.msgType !== msg.type) {
      metaParts.push(msg.meta.msgType);
    }
    if (msg.meta?.topic) metaParts.push('#' + msg.meta.topic);
    const metaStr = metaParts.length > 0 ? ' [' + metaParts.join(' ') + ']' : '';

    return e(Box, { key: i, flexDirection: 'column' },
      e(Box, null,
        e(Text, { dimColor: true }, msg.t + '  '),
        e(Text, { color, bold: true }, msg.from),
        e(Text, { dimColor: true }, ' ' + icon + ' '),
        e(Text, { dimColor: true }, msg.to),
        e(Text, { dimColor: true }, metaStr)
      ),
      e(Box, { paddingLeft: 2 },
        e(Text, {
          dimColor: msg.type === 'progress',
          color: msg.type === 'error' ? 'red' : undefined,
        },
          '\u250A  ' + (msg.content || '').slice(0, 100)
        )
      )
    );
  });

  return e(Box, { flexDirection: 'column', height: height + 2 },
    header,
    e(Box, { flexDirection: 'column', flexGrow: 1 }, ...messageRows)
  );
}

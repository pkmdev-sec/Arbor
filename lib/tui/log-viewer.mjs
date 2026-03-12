/**
 * LogViewer — Scrollable log viewer component for agent output.
 *
 * Features:
 *   - Up/Down arrow keys scroll when panel is focused
 *   - Page Up/Page Down for fast scrolling
 *   - Home/End to jump to top/bottom
 *   - Scroll position indicator on the right edge: ▲ [==|=====] ▼
 *   - Auto-scroll to bottom for new output (with manual scroll lock)
 *   - Line count display: 'Line 34/48 (showing last 34)'
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

const { useState, useEffect, useRef } = React;
const e = React.createElement;

/**
 * Parse output text into displayable lines.
 * Strips ANSI codes for clean display, wraps long lines.
 */
function parseLines(text, maxWidth) {
  if (!text) return [];
  // Strip ANSI escape sequences for measurement
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
  return stripped.split('\n').flatMap(line => {
    if (!maxWidth || line.length <= maxWidth) return [line];
    // Wrap long lines
    const wrapped = [];
    for (let i = 0; i < line.length; i += maxWidth) {
      wrapped.push(line.slice(i, i + maxWidth));
    }
    return wrapped;
  });
}

/**
 * Build a scroll position indicator bar.
 * @param {number} scrollTop - First visible line index
 * @param {number} visibleCount - Number of visible lines
 * @param {number} totalLines - Total number of lines
 * @param {number} barHeight - Height of the scroll indicator
 * @returns {string[]} Array of characters for each row of the indicator
 */
function buildScrollIndicator(scrollTop, visibleCount, totalLines, barHeight) {
  if (totalLines <= visibleCount || barHeight < 3) {
    return Array(barHeight).fill(' ');
  }

  const trackLen = Math.max(1, barHeight - 2); // -2 for ▲ and ▼
  const thumbSize = Math.max(1, Math.round((visibleCount / totalLines) * trackLen));
  const maxScroll = totalLines - visibleCount;
  const thumbPos = maxScroll > 0
    ? Math.round((scrollTop / maxScroll) * (trackLen - thumbSize))
    : 0;

  const chars = ['▲'];
  for (let i = 0; i < trackLen; i++) {
    if (i >= thumbPos && i < thumbPos + thumbSize) {
      chars.push('█');
    } else {
      chars.push('░');
    }
  }
  chars.push('▼');
  return chars;
}

/**
 * LogViewer — Scrollable log viewer with keyboard navigation.
 *
 * @param {object} props
 * @param {string} props.title     - Header title
 * @param {string} props.content   - Raw text content to display
 * @param {number} [props.maxLines]   - Max visible lines (default: 12)
 * @param {boolean} [props.fullScreen] - Whether to expand to fill space
 * @param {number} [props.width]      - Available width for wrapping
 * @param {boolean} [props.focused]   - Whether this viewer has keyboard focus
 */
export function LogViewer({ title, content, maxLines, fullScreen, width, focused = false }) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevLineCountRef = useRef(0);

  const lines = parseLines(content, width ? width - 6 : undefined); // -6 for padding + scroll indicator
  const visibleCount = fullScreen ? 30 : (maxLines || 12);
  const totalLines = lines.length;

  // Auto-scroll: when new lines appear and autoScroll is on, jump to bottom
  useEffect(() => {
    if (autoScroll && totalLines > prevLineCountRef.current) {
      setScrollOffset(Math.max(0, totalLines - visibleCount));
    }
    prevLineCountRef.current = totalLines;
  }, [totalLines, autoScroll, visibleCount]);

  // Keyboard handling when focused
  useInput((input, key) => {
    if (!focused) return;

    const maxOffset = Math.max(0, totalLines - visibleCount);

    if (key.upArrow) {
      setAutoScroll(false);
      setScrollOffset(o => Math.max(0, o - 1));
    }
    if (key.downArrow) {
      setScrollOffset(o => {
        const next = Math.min(maxOffset, o + 1);
        if (next >= maxOffset) setAutoScroll(true);
        return next;
      });
    }
    if (key.pageUp || (key.ctrl && input === 'u')) {
      setAutoScroll(false);
      setScrollOffset(o => Math.max(0, o - Math.floor(visibleCount / 2)));
    }
    if (key.pageDown || (key.ctrl && input === 'd')) {
      setScrollOffset(o => {
        const next = Math.min(maxOffset, o + Math.floor(visibleCount / 2));
        if (next >= maxOffset) setAutoScroll(true);
        return next;
      });
    }
    // Home — jump to top
    if (key.home || (input === 'g' && !key.ctrl)) {
      setAutoScroll(false);
      setScrollOffset(0);
    }
    // End — jump to bottom
    if (key.end || input === 'G') {
      setAutoScroll(true);
      setScrollOffset(maxOffset);
    }
  });

  if (!content && !title) {
    return e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      e(Text, { dimColor: true }, 'Select an agent to view logs')
    );
  }

  // Calculate visible window
  const effectiveOffset = autoScroll ? Math.max(0, totalLines - visibleCount) : scrollOffset;
  const clampedOffset = Math.max(0, Math.min(effectiveOffset, Math.max(0, totalLines - visibleCount)));
  const visible = lines.slice(clampedOffset, clampedOffset + visibleCount);

  // Build scroll indicator
  const scrollChars = buildScrollIndicator(clampedOffset, visibleCount, totalLines, visibleCount);
  const needsScroll = totalLines > visibleCount;

  // Line position info
  const firstLine = totalLines > 0 ? clampedOffset + 1 : 0;
  const lastLine = Math.min(clampedOffset + visibleCount, totalLines);
  const posInfo = totalLines > 0
    ? `Lines ${firstLine}-${lastLine}/${totalLines}`
    : '0 lines';

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focused ? 'cyan' : fullScreen ? 'cyan' : 'gray',
    paddingX: 1,
    ...(fullScreen ? { flexGrow: 1 } : {}),
  },
    // Header
    e(Box, null,
      e(Text, { bold: true }, title || 'Logs'),
      e(Text, { dimColor: true }, '  ', posInfo),
      autoScroll
        ? e(Text, { color: 'green', dimColor: true }, '  [AUTO]')
        : e(Text, { color: 'yellow' }, '  [LOCKED ↑↓]'),
    ),
    // Content with scroll indicator
    ...visible.map((line, i) =>
      e(Box, { key: i },
        e(Text, {
          dimColor: !focused && i < visible.length - 3,
          wrap: 'truncate',
          flexGrow: 1,
        }, line || ' '),
        needsScroll
          ? e(Text, {
              color: scrollChars[i] === '█' ? 'cyan' : 'gray',
              dimColor: scrollChars[i] !== '█',
            }, scrollChars[i] || ' ')
          : null,
      )
    ),
    // Empty state
    visible.length === 0
      ? e(Text, { dimColor: true }, 'No output yet…')
      : null,
    // Footer hint when focused
    focused && needsScroll
      ? e(Box, null,
          e(Text, { dimColor: true }, '↑↓:scroll  PgUp/PgDn:page  g/G:top/bottom'),
        )
      : null,
  );
}

/**
 * LiveLogViewer — LogViewer that auto-updates from a polling function.
 *
 * @param {object} props
 * @param {string} props.title      - Header title
 * @param {Function} props.getContent - Function returning current content string
 * @param {number} [props.pollMs]    - Polling interval (default: 2000)
 * @param {number} [props.maxLines]  - Max lines to display
 * @param {boolean} [props.fullScreen]
 * @param {number} [props.width]
 * @param {boolean} [props.focused]
 */
export function LiveLogViewer({ title, getContent, pollMs, maxLines, fullScreen, width, focused }) {
  const [content, setContent] = useState('');

  useEffect(() => {
    const update = () => {
      try {
        const text = getContent();
        if (text !== undefined) setContent(text);
      } catch {
        // Non-fatal — content may not be available yet
      }
    };
    update();
    const timer = setInterval(update, pollMs || 2000);
    return () => clearInterval(timer);
  }, [getContent, pollMs]);

  return e(LogViewer, { title, content, maxLines, fullScreen, width, focused });
}

/**
 * LogViewer — Scrollable log tail component for agent output.
 *
 * Reads agent progress/result output and displays the last N lines.
 * Supports full-screen mode toggle and auto-scroll.
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';

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
 * LogViewer — Displays last N lines of text with a header.
 *
 * @param {object} props
 * @param {string} props.title     - Header title
 * @param {string} props.content   - Raw text content to display
 * @param {number} [props.maxLines]   - Max lines to show (default: 12)
 * @param {boolean} [props.fullScreen] - Whether to expand to fill space
 * @param {number} [props.width]      - Available width for wrapping
 */
export function LogViewer({ title, content, maxLines, fullScreen, width }) {
  const lines = parseLines(content, width ? width - 4 : undefined);
  const visibleCount = fullScreen ? 30 : (maxLines || 12);
  const visible = lines.slice(-visibleCount);

  if (!content && !title) {
    return e(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      e(Text, { dimColor: true }, 'Select an agent to view logs')
    );
  }

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: fullScreen ? 'cyan' : 'gray',
    paddingX: 1,
    ...(fullScreen ? { flexGrow: 1 } : {}),
  },
    // Header
    e(Box, null,
      e(Text, { bold: true }, title || 'Logs'),
      e(Text, { dimColor: true }, ` (${lines.length} lines, showing last ${visible.length})`)
    ),
    // Content
    ...visible.map((line, i) =>
      e(Text, {
        key: i,
        dimColor: i < visible.length - 3, // Dim older lines
        wrap: 'truncate',
      }, line || ' ')
    ),
    // Empty state
    visible.length === 0
      ? e(Text, { dimColor: true }, 'No output yet…')
      : null
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
 */
export function LiveLogViewer({ title, getContent, pollMs, maxLines, fullScreen, width }) {
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

  return e(LogViewer, { title, content, maxLines, fullScreen, width });
}

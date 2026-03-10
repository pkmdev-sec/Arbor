/**
 * AgentCard — Ink component displaying a single agent's status.
 *
 * Shows: status icon/spinner, agent ID, model, elapsed time,
 * tool call count, last tool used, output size, and exit code.
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

const e = React.createElement;

export function AgentCard({ agent, focused }) {
  const { id, status, toolCalls, elapsedMs, stdoutBytes, lastTool, exitCode, durationMs, model } = agent;

  const elapsed = durationMs || elapsedMs || 0;
  const elapsedStr = (elapsed / 1000).toFixed(0) + 's';
  const kbStr = ((stdoutBytes || 0) / 1024).toFixed(0) + 'KB';

  const statusColor =
    status === 'done' ? 'green' :
    status === 'failed' ? 'red' :
    status === 'timeout' ? 'yellow' :
    status === 'running' ? 'cyan' : 'gray';

  const statusIcon =
    status === 'done' ? '✓' :
    status === 'failed' ? '✗' :
    status === 'timeout' ? '⏱' :
    status === 'running' ? null : '○';

  const borderColor = focused ? 'cyan' : undefined;

  return e(Box, { flexDirection: 'column', borderStyle: 'round', borderColor, paddingX: 1, width: 36 },
    // Row 1: Status icon + agent ID + model
    e(Box, null,
      status === 'running'
        ? e(Spinner, { type: 'dots' })
        : e(Text, { color: statusColor }, statusIcon),
      e(Text, { bold: true, color: statusColor }, ' ', id),
      model ? e(Text, { dimColor: true }, ' ', model.replace('[1m]', '')) : null
    ),
    // Row 2: Elapsed time + tool call count
    e(Box, null,
      e(Text, { dimColor: true }, 'Time: '), e(Text, null, elapsedStr),
      e(Text, { dimColor: true }, '  Tools: '), e(Text, null, String(toolCalls || 0))
    ),
    // Row 3: Last tool used (conditional)
    lastTool
      ? e(Box, null,
          e(Text, { dimColor: true }, 'Last: '), e(Text, { color: 'yellow' }, lastTool)
        )
      : null,
    // Row 4: Output size (conditional)
    stdoutBytes > 0
      ? e(Box, null,
          e(Text, { dimColor: true }, 'Output: '), e(Text, null, kbStr)
        )
      : null,
    // Row 5: Non-zero exit code (conditional)
    exitCode !== undefined && exitCode !== 0
      ? e(Box, null,
          e(Text, { color: 'red' }, 'Exit: ', String(exitCode))
        )
      : null
  );
}

/**
 * MergePanel — Real-time semantic merge status visualization.
 *
 * Displays:
 *   - Active merges: file being merged, agents involved, progress
 *   - Conflict list: per-file with severity colors (HIGH=red, MEDIUM=yellow, LOW=gray)
 *   - Resolution log: how each conflict was resolved, confidence score
 *   - Per-conflict detail: Agent A intent, Agent B intent, resolution
 *   - Merge timeline: completed, in-progress, pending
 *   - Cross-boundary merge indicator
 *   - Overall confidence meter
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { renderGauge, statusColor, truncate, MERGE_FRAMES } from './theme.mjs';

const { useState, useEffect } = React;
const e = React.createElement;

// ── Severity colors ──────────────────────────────────────────────

const SEVERITY_COLORS = {
  HIGH:   'red',
  MEDIUM: 'yellow',
  LOW:    'gray',
  NONE:   'green',
};

const MERGE_STATUS_ICONS = {
  clean:    '✓',
  conflict: '⚠',
  pending:  '○',
  merging:  '◐',
  resolved: '●',
  failed:   '✗',
};

// ── File Merge Row ───────────────────────────────────────────────

function FileMergeRow({ file, animFrame }) {
  const status = file.status || 'pending';
  const severity = file.severity || 'NONE';
  const sevColor = SEVERITY_COLORS[severity] || 'gray';
  const confidence = file.confidence != null ? `${Math.round(file.confidence * 100)}%` : '';

  let icon;
  if (status === 'merging') {
    icon = MERGE_FRAMES[animFrame % MERGE_FRAMES.length];
  } else {
    icon = MERGE_STATUS_ICONS[status] || '?';
  }

  const iconColor = status === 'clean' || status === 'resolved' ? 'green'
    : status === 'conflict' ? 'yellow'
    : status === 'failed' ? 'red'
    : status === 'merging' ? 'cyan'
    : 'gray';

  return e(Box, { flexDirection: 'column' },
    e(Box, null,
      e(Text, { color: iconColor }, icon, ' '),
      e(Text, null, truncate(file.path || file.name || 'unknown', 35)),
      e(Text, { dimColor: true }, '  '),
      e(Text, { color: sevColor }, status),
      confidence ? e(Text, { dimColor: true }, '  conf: ', confidence) : null,
      file.crossBoundary ? e(Text, { color: 'magenta' }, '  [cross-boundary]') : null,
    ),
    // Conflict details (if any)
    file.conflicts && file.conflicts.length > 0
      ? e(Box, { flexDirection: 'column', paddingLeft: 3 },
          ...file.conflicts.slice(0, 3).map((c, i) =>
            e(Box, { key: i, flexDirection: 'column' },
              e(Box, null,
                e(Text, { color: SEVERITY_COLORS[c.severity] || 'yellow' }, '→ '),
                e(Text, { dimColor: true }, `L${c.startLine || '?'}-${c.endLine || '?'}: `),
                e(Text, null, truncate(c.description || 'conflict', 40)),
              ),
              c.agentA
                ? e(Box, { paddingLeft: 2 },
                    e(Text, { dimColor: true }, 'A: '),
                    e(Text, null, truncate(c.agentA, 20)),
                    e(Text, { dimColor: true }, '  B: '),
                    e(Text, null, truncate(c.agentB || '', 20)),
                  )
                : null,
              c.resolution
                ? e(Box, { paddingLeft: 2 },
                    e(Text, { color: 'green', dimColor: true }, '↳ '),
                    e(Text, { color: 'green' }, truncate(c.resolution, 40)),
                    c.confidence != null
                      ? e(Text, { dimColor: true }, ` (${Math.round(c.confidence * 100)}%)`)
                      : null,
                  )
                : null,
            )
          ),
          file.conflicts.length > 3
            ? e(Text, { dimColor: true }, `  +${file.conflicts.length - 3} more conflicts`)
            : null,
        )
      : null,
  );
}

// ── Resolution Log Entry ─────────────────────────────────────────

function ResolutionEntry({ entry }) {
  return e(Box, null,
    e(Text, { color: 'green' }, '● '),
    e(Text, { dimColor: true }, entry.file || '?'),
    e(Text, null, ': '),
    e(Text, null, truncate(entry.strategy || 'auto', 15)),
    entry.confidence != null
      ? e(Text, { dimColor: true }, ` (${Math.round(entry.confidence * 100)}%)`)
      : null,
  );
}

// ── Main MergePanel Component ────────────────────────────────────

/**
 * Real-time merge status panel.
 *
 * @param {object} props
 * @param {object[]} props.files - Array of file merge status objects
 * @param {object[]} [props.resolutions] - Array of completed resolution log entries
 * @param {number} [props.overallConfidence] - Overall merge confidence 0.0–1.0
 * @param {object} [props.progress] - { completed, total }
 * @param {boolean} [props.focused] - Whether this panel has focus
 * @param {number} [props.height] - Visible height in rows
 * @param {number} [props.barWidth] - Gauge width
 */
export function MergePanel({
  files,
  resolutions,
  overallConfidence,
  progress,
  focused = false,
  height = 15,
  barWidth = 12,
}) {
  const [animFrame, setAnimFrame] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setAnimFrame(f => (f + 1) % 60), 150);
    return () => clearInterval(timer);
  }, []);

  const mergeFiles = files || [];
  const resolvedList = resolutions || [];
  const prog = progress || { completed: 0, total: 0 };

  // Empty state
  if (mergeFiles.length === 0 && prog.total === 0) {
    return e(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
    },
      e(Text, { bold: true, color: focused ? 'cyan' : undefined }, 'Merge Status'),
      e(Text, { dimColor: true }, 'No merge activity'),
    );
  }

  // Statistics
  const cleanCount = mergeFiles.filter(f => f.status === 'clean' || f.status === 'resolved').length;
  const conflictCount = mergeFiles.filter(f => f.status === 'conflict').length;
  const pendingCount = mergeFiles.filter(f => f.status === 'pending').length;
  const mergingCount = mergeFiles.filter(f => f.status === 'merging').length;

  // Status line
  const statusText = prog.total > 0
    ? `IN PROGRESS (${prog.completed}/${prog.total} modules)`
    : conflictCount > 0
      ? `${conflictCount} CONFLICTS`
      : cleanCount === mergeFiles.length
        ? 'ALL CLEAN'
        : 'PENDING';
  const statusColor_ = conflictCount > 0 ? 'yellow' : 'green';

  // Confidence gauge
  const conf = overallConfidence != null ? overallConfidence : 0;

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focused ? 'cyan' : 'gray',
    paddingX: 1,
  },
    // Header
    e(Box, null,
      e(Text, { bold: true, color: focused ? 'cyan' : undefined }, 'Merge Status: '),
      e(Text, { color: statusColor_, bold: true }, statusText),
    ),

    // File list
    ...mergeFiles.slice(scrollOffset, scrollOffset + Math.max(3, height - 6)).map((file, i) =>
      e(FileMergeRow, { key: file.path || i, file, animFrame })
    ),
    mergeFiles.length > height - 6
      ? e(Text, { dimColor: true }, `  +${mergeFiles.length - (height - 6)} more files`)
      : null,

    // Resolution log (last 2 entries)
    resolvedList.length > 0
      ? e(Box, { flexDirection: 'column', marginTop: 1 },
          e(Text, { dimColor: true }, 'Resolutions:'),
          ...resolvedList.slice(-2).map((r, i) =>
            e(ResolutionEntry, { key: i, entry: r })
          )
        )
      : null,

    // Overall confidence
    conf > 0
      ? e(Box, { marginTop: 1 },
          e(Text, { dimColor: true }, 'Confidence: '),
          e(Text, { color: conf >= 0.8 ? 'green' : conf >= 0.5 ? 'yellow' : 'red' },
            `${Math.round(conf * 100)}%  `
          ),
          e(Text, { color: conf >= 0.8 ? 'green' : conf >= 0.5 ? 'yellow' : 'red' },
            renderGauge(conf * 100, 100, barWidth).bar
          ),
        )
      : null,
  );
}

/**
 * Normalize merge data from IPC messages or aggregator output.
 *
 * @param {object} mergeReport - From aggregator.generateMergeReport()
 * @returns {object} Normalized state for MergePanel
 */
export function normalizeMergeData(mergeReport) {
  if (!mergeReport) {
    return { files: [], resolutions: [], overallConfidence: 0, progress: { completed: 0, total: 0 } };
  }

  const files = (mergeReport.files || []).map(f => {
    // Detect conflict status — handle both nested schema (from semantic-merge)
    // and flat schema (from orchestration.mjs conflictReport: { file, agents, resolved, error })
    const hasNestedConflicts = f.conflicts && f.conflicts.length > 0;
    const hasFlatConflict = f.resolved === false || (f.error && !f.resolved);

    // Build conflicts array — use nested if available, synthesize from flat otherwise
    const conflictsArray = hasNestedConflicts
      ? f.conflicts.map(c => ({
          startLine: c.startLine || c.line,
          endLine: c.endLine || c.line,
          description: c.description || c.message || '',
          severity: c.severity || 'MEDIUM',
          agentA: c.agentA || c.sourceAgent || '',
          agentB: c.agentB || c.targetAgent || '',
          resolution: c.resolution || null,
          confidence: c.confidence || null,
        }))
      : (hasFlatConflict && f.agents)
        ? [{ startLine: 0, endLine: 0, description: f.error || 'Conflict between agents', severity: 'MEDIUM',
             agentA: f.agents[0] || '', agentB: f.agents[1] || '', resolution: null, confidence: null }]
        : [];

    return {
      path: f.path || f.file || '',
      status: hasNestedConflicts || hasFlatConflict ? 'conflict'
        : f.resolved ? 'resolved'
        : f.merged ? 'clean'
        : 'pending',
      severity: f.severity || (conflictsArray.length > 2 ? 'HIGH' : conflictsArray.length > 0 ? 'MEDIUM' : 'NONE'),
      confidence: f.confidence || null,
      crossBoundary: f.crossBoundary || false,
      conflicts: conflictsArray,
    };
  });

  const resolutions = (mergeReport.resolutions || []).map(r => ({
    file: r.file || r.path || '',
    strategy: r.strategy || r.method || 'auto',
    confidence: r.confidence || null,
  }));

  const totalFiles = files.length;
  const completedFiles = files.filter(f =>
    f.status === 'clean' || f.status === 'resolved'
  ).length;

  return {
    files,
    resolutions,
    overallConfidence: mergeReport.confidence || mergeReport.overallConfidence || 0,
    progress: { completed: completedFiles, total: totalFiles },
  };
}

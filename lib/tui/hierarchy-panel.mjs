/**
 * HierarchyPanel — Interactive collapsible tree view of hierarchical swarm decomposition.
 *
 * Renders a Unicode box-drawing tree with:
 *   - Collapsible nodes: ▼ expanded, ► collapsed (toggle with Enter)
 *   - Per-node status with color-coded icons
 *   - Worker info: agent name, model, elapsed time
 *   - Merge status at each node with confidence score
 *   - Keyboard navigation: ↑↓ move, Enter toggle, → expand, ← collapse
 *   - Real-time updates via IPC bus subscription
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import {
  statusColor, statusIcon, formatElapsed, truncate, levelColor, modelColor,
  SPAWN_FRAMES, MERGE_FRAMES,
} from './theme.mjs';

const { useState, useEffect, useCallback } = React;
const e = React.createElement;

// ── Tree node status icons ───────────────────────────────────────

const NODE_ICONS = {
  pending:  '○',
  running:  '◉',
  spawning: '◐',
  done:     '●',
  complete: '●',
  failed:   '✗',
  merging:  '◐',
};

/**
 * Flatten a hierarchy tree into a navigable list of visible nodes.
 *
 * @param {object[]} nodes - Root-level hierarchy nodes
 * @param {Set<string>} collapsed - Set of collapsed node IDs
 * @param {number} depth - Current indentation depth
 * @param {boolean[]} isLast - Whether each ancestor is the last child
 * @returns {object[]} Flat array of { node, depth, isLast, hasChildren, prefix }
 */
function flattenTree(nodes, collapsed, depth = 0, isLast = []) {
  const result = [];
  if (!nodes || nodes.length === 0) return result;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const last = i === nodes.length - 1;
    const nodeIsLast = [...isLast, last];
    const children = node.children || [];
    const isCollapsed = collapsed.has(node.id);

    // Build tree prefix from ancestor positions
    let prefix = '';
    for (let d = 0; d < depth; d++) {
      prefix += nodeIsLast[d] ? '  ' : '│ ';
    }
    if (depth > 0) {
      prefix += last ? '└─' : '├─';
    }

    result.push({
      node,
      depth,
      isLastChild: last,
      hasChildren: children.length > 0,
      isCollapsed,
      prefix,
    });

    if (children.length > 0 && !isCollapsed) {
      result.push(...flattenTree(children, collapsed, depth + 1, nodeIsLast));
    }
  }

  return result;
}

/**
 * Render a single tree node line.
 */
function TreeNodeRow({ entry, selected, animFrame }) {
  const { node, prefix, hasChildren, isCollapsed } = entry;
  const status = node.status || 'pending';
  const color = statusColor(status);
  const level = node.level != null ? node.level : 0;
  const lvlColor = levelColor(level);

  // Expand/collapse indicator
  const expandIcon = !hasChildren ? ' '
    : isCollapsed ? '►' : '▼';

  // Status icon (animated for running/spawning/merging)
  let icon;
  if (status === 'spawning') {
    icon = SPAWN_FRAMES[animFrame % SPAWN_FRAMES.length];
  } else if (status === 'merging') {
    icon = MERGE_FRAMES[animFrame % MERGE_FRAMES.length];
  } else if (status === 'running') {
    const dots = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    icon = dots[animFrame % dots.length];
  } else {
    icon = NODE_ICONS[status] || '?';
  }

  // Completion counter for nodes with children
  const childStats = node.children && node.children.length > 0
    ? (() => {
        const total = node.children.length;
        const done = node.children.filter(c =>
          c.status === 'done' || c.status === 'complete' || c.status === 'completed'
        ).length;
        return `[${done}/${total}]`;
      })()
    : '';

  // Model badge
  const model = node.model
    ? node.model.replace(/\[1m\]/g, '').replace('claude-', '').slice(0, 8)
    : '';

  // Elapsed time
  const elapsed = node.elapsedMs || node.durationMs || 0;

  // Scope display
  const scope = node.scope || '';

  // Merge confidence
  const confidence = node.mergeConfidence != null
    ? ` (${Math.round(node.mergeConfidence * 100)}%)`
    : '';
  const conflicts = node.conflictCount > 0
    ? ` ${node.conflictCount} conflicts`
    : '';

  return e(Box, null,
    // Selection indicator
    e(Text, { color: selected ? 'cyan' : undefined, bold: selected },
      selected ? '►' : ' '
    ),
    // Tree prefix (branches)
    e(Text, { dimColor: true }, prefix),
    // Expand icon
    e(Text, { color: hasChildren ? 'white' : 'gray' }, expandIcon, ' '),
    // Status icon
    e(Text, { color }, icon, ' '),
    // Level badge
    e(Text, { color: lvlColor, bold: true }, `L${level} `),
    // Node name
    e(Text, { bold: selected, color: selected ? 'cyan' : undefined },
      truncate(node.name || node.id || 'unknown', 18)
    ),
    // Scope
    scope ? e(Text, { dimColor: true }, ' ', scope) : null,
    // Completion counter
    childStats ? e(Text, { color: 'green' }, ' ', childStats) : null,
    // Model badge
    model ? e(Text, { color: modelColor(node.model) }, ' [', model, ']') : null,
    // Elapsed
    elapsed > 0 ? e(Text, { dimColor: true }, ' ', formatElapsed(elapsed)) : null,
    // Merge info
    confidence ? e(Text, { color: 'cyan' }, confidence) : null,
    conflicts ? e(Text, { color: 'red' }, conflicts) : null,
  );
}

// ── Main HierarchyPanel Component ────────────────────────────────

/**
 * Interactive hierarchy tree panel.
 *
 * @param {object} props
 * @param {object[]} props.hierarchy - Array of root hierarchy nodes (each with .children)
 * @param {number} [props.height] - Visible height in rows
 * @param {boolean} [props.focused] - Whether this panel has keyboard focus
 * @param {Function} [props.onSelect] - Callback when a node is selected
 */
export function HierarchyPanel({ hierarchy, height = 20, focused = false, onSelect }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [animFrame, setAnimFrame] = useState(0);

  // Animation timer
  useEffect(() => {
    const timer = setInterval(() => setAnimFrame(f => (f + 1) % 60), 120);
    return () => clearInterval(timer);
  }, []);

  // Flatten tree into visible list
  const flatList = flattenTree(hierarchy || [], collapsed);

  // Clamp selection
  const clampedIdx = Math.min(selectedIdx, Math.max(0, flatList.length - 1));
  if (clampedIdx !== selectedIdx && flatList.length > 0) {
    setSelectedIdx(clampedIdx);
  }

  const selectedEntry = flatList[clampedIdx] || null;

  // Visible window
  const visibleStart = Math.max(0, Math.min(scrollOffset, flatList.length - height));
  const visibleEnd = Math.min(visibleStart + height, flatList.length);
  const visible = flatList.slice(visibleStart, visibleEnd);

  // Scroll to keep selection visible
  useEffect(() => {
    if (clampedIdx < scrollOffset) {
      setScrollOffset(clampedIdx);
    } else if (clampedIdx >= scrollOffset + height) {
      setScrollOffset(clampedIdx - height + 1);
    }
  }, [clampedIdx, scrollOffset, height]);

  // Notify parent of selection
  useEffect(() => {
    if (onSelect && selectedEntry) {
      onSelect(selectedEntry.node);
    }
  }, [clampedIdx]);

  // Empty state
  if (!hierarchy || hierarchy.length === 0) {
    return e(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
    },
      e(Text, { bold: true, color: 'cyan' }, 'Hierarchy'),
      e(Text, { dimColor: true }, 'Flat mode — no hierarchy active'),
    );
  }

  // Header
  const totalNodes = flatList.length;
  const runningNodes = flatList.filter(e =>
    e.node.status === 'running' || e.node.status === 'spawning'
  ).length;

  return e(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: focused ? 'cyan' : 'gray',
    paddingX: 1,
  },
    // Header
    e(Box, null,
      e(Text, { bold: true, color: focused ? 'cyan' : undefined }, 'Hierarchy'),
      e(Text, { dimColor: true }, ` (${totalNodes} nodes`),
      runningNodes > 0
        ? e(Text, { color: 'yellow' }, `, ${runningNodes} active`)
        : null,
      e(Text, { dimColor: true }, ')'),
    ),
    // Tree
    ...visible.map((entry, i) =>
      e(TreeNodeRow, {
        key: entry.node.id || i,
        entry,
        selected: visibleStart + i === clampedIdx,
        animFrame,
      })
    ),
    // Scroll indicator
    flatList.length > height
      ? e(Box, null,
          e(Text, { dimColor: true },
            `  ${visibleStart + 1}-${visibleEnd}/${flatList.length}`,
            clampedIdx < flatList.length - 1 ? ' ↓' : ''
          )
        )
      : null,
  );
}

/**
 * Process keyboard input for the hierarchy panel.
 * Call this from the parent dashboard's useInput when hierarchy panel is focused.
 *
 * @param {string} input - Key character
 * @param {object} key - Key modifiers
 * @param {object} state - { flatList, selectedIdx, collapsed }
 * @param {object} setters - { setSelectedIdx, setCollapsed }
 */
export function handleHierarchyInput(input, key, state, setters) {
  const { flatList, selectedIdx, collapsed } = state;
  const { setSelectedIdx, setCollapsed } = setters;

  if (key.upArrow || input === 'k') {
    setSelectedIdx(Math.max(0, selectedIdx - 1));
  }
  if (key.downArrow || input === 'j') {
    setSelectedIdx(Math.min(flatList.length - 1, selectedIdx + 1));
  }

  const entry = flatList[selectedIdx];
  if (!entry) return;

  // Toggle expand/collapse
  if (key.return) {
    if (entry.hasChildren) {
      const next = new Set(collapsed);
      if (next.has(entry.node.id)) {
        next.delete(entry.node.id);
      } else {
        next.add(entry.node.id);
      }
      setCollapsed(next);
    }
  }

  // Expand
  if (key.rightArrow) {
    if (entry.hasChildren && collapsed.has(entry.node.id)) {
      const next = new Set(collapsed);
      next.delete(entry.node.id);
      setCollapsed(next);
    }
  }

  // Collapse
  if (key.leftArrow) {
    if (entry.hasChildren && !collapsed.has(entry.node.id)) {
      const next = new Set(collapsed);
      next.add(entry.node.id);
      setCollapsed(next);
    }
  }
}

/**
 * Convert flat agent data + decomposition info into a hierarchy tree.
 *
 * @param {Map|object[]} agents - Agent data keyed by ID or array
 * @param {object} [decomposition] - Decomposition tree from decomposer
 * @returns {object[]} Root hierarchy nodes with .children
 */
export function buildHierarchyTree(agents, decomposition) {
  const agentMap = agents instanceof Map
    ? agents
    : new Map((agents || []).map(a => [a.id, a]));

  // If we have decomposition data, use its tree structure
  if (decomposition && decomposition.root) {
    function walkNode(node, level = 0) {
      const agentData = agentMap.get(node.agentId || node.id) || {};
      const children = (node.children || []).map(c => walkNode(c, level + 1));
      return {
        id: node.agentId || node.id || `node-${level}`,
        name: node.name || node.scope || agentData.id || 'task',
        level,
        scope: node.scope || '',
        status: agentData.status || node.status || 'pending',
        model: agentData.model || node.model || '',
        elapsedMs: agentData.elapsedMs || agentData.durationMs || 0,
        mergeConfidence: node.mergeConfidence || null,
        conflictCount: node.conflictCount || 0,
        children,
      };
    }
    return [walkNode(decomposition.root)];
  }

  // Fallback: build from agent parentId relationships
  const roots = [];
  const nodeMap = new Map();

  for (const [id, agent] of agentMap) {
    nodeMap.set(id, {
      id,
      name: id,
      level: agent.level || 0,
      scope: agent.scope || '',
      status: agent.status || 'pending',
      model: agent.model || '',
      elapsedMs: agent.elapsedMs || agent.durationMs || 0,
      mergeConfidence: null,
      conflictCount: 0,
      children: [],
    });
  }

  for (const [id, agent] of agentMap) {
    const node = nodeMap.get(id);
    if (agent.parentId && nodeMap.has(agent.parentId)) {
      nodeMap.get(agent.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots.length > 0 ? roots : [];
}

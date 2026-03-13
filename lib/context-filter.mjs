/**
 * F11: Semantic Context Filtering
 *
 * Filters context data per-role to reduce token waste. Each role receives
 * only the context sections relevant to its task:
 *
 *   Worker:     decisions + file summaries (no exploration/research)
 *   Verifier:   diff + test results + worker outputs (no file summaries)
 *   Decomposer: project structure + constraints (no test results, no diffs)
 *
 * Target: >= 30% context size reduction per agent.
 *
 * Usage:
 *   import { filterContextForRole, filterSystemPromptForRole } from "./context-filter.mjs";
 *   const filtered = filterContextForRole(contextObj, "worker");
 *   const filteredPrompt = filterSystemPromptForRole(promptString, "worker");
 */

import ContextBudget from "./context-budget.mjs";

// ── Section tags used in system prompts ──────────────────────────
// These markers identify sections in assembled system prompts so we
// can strip irrelevant ones per role.
// Detectors: identify which section a text block belongs to
const SECTION_DETECTORS = [
  { key: "scoutReport",     test: /^\[Scout Report\]/ },
  { key: "waveDiscoveries", test: /^\[Wave \d+ Discoveries\]/ },
  { key: "previousAttempt", test: /^\[Previous Attempt Output/ },
  { key: "constraints",     test: /^CONSTRAINTS:/ },
  { key: "scope",           test: /^SCOPE: / },
  { key: "decisions",       test: /^KNOWN DECISIONS:/ },
  { key: "fileSummaries",   test: /^FILE CONTEXT:/ },
  { key: "recentFiles",     test: /^RECENTLY MODIFIED:/ },
  { key: "gitDiff",         test: /^GIT DIFF:/ },
  { key: "testResults",     test: /^TEST EXECUTION RESULTS:/ },
  { key: "workerOutputs",   test: /^WORKER OUTPUTS:/ },
];

// Section header start pattern — splits prompt into blocks
const SECTION_SPLIT_RE = /(?=\n(?:\[(?:Scout Report|Wave \d|Previous Attempt)|(?:CONSTRAINTS|SCOPE|KNOWN DECISIONS|FILE CONTEXT|RECENTLY MODIFIED|GIT DIFF|TEST EXECUTION RESULTS|WORKER OUTPUTS):))/;

// ── Per-role inclusion rules ─────────────────────────────────────
// true = keep, false = strip
const ROLE_RULES = {
  worker: {
    scoutReport:     true,   // Informational context for codebase orientation
    waveDiscoveries: true,   // Knowledge from previous dependency waves
    previousAttempt: true,   // Retry context
    constraints:     true,   // Task boundaries
    scope:           true,   // Focus areas
    decisions:       true,   // Known architectural decisions
    fileSummaries:   true,   // File-level context
    recentFiles:     true,   // Recently modified files
    gitDiff:         false,  // Workers don't need pre-existing diffs
    testResults:     false,  // Workers run their own tests
    workerOutputs:   false,  // Workers don't see other worker outputs
  },
  verifier: {
    scoutReport:     false,  // Verifier doesn't need exploration context
    waveDiscoveries: false,  // Not relevant for cross-checking
    previousAttempt: false,  // Not relevant for verification
    constraints:     true,   // Need to verify against original constraints
    scope:           true,   // Need to check scope compliance
    decisions:       false,  // Not needed for diff cross-reference
    fileSummaries:   false,  // Verifier works from diffs, not summaries
    recentFiles:     false,  // Not relevant for verification
    gitDiff:         true,   // Core verification input
    testResults:     true,   // Core verification input
    workerOutputs:   true,   // Core verification input
  },
  decomposer: {
    scoutReport:     true,   // Useful for understanding project structure
    waveDiscoveries: false,  // Not relevant for decomposition
    previousAttempt: false,  // Not relevant for decomposition
    constraints:     true,   // Task boundaries affect decomposition
    scope:           true,   // Focus areas
    decisions:       true,   // Architectural decisions affect scope splitting
    fileSummaries:   true,   // File context helps scope assignment
    recentFiles:     true,   // Recently modified files affect scope
    gitDiff:         false,  // Decomposer doesn't need diffs
    testResults:     false,  // Decomposer doesn't need test results
    workerOutputs:   false,  // Decomposer doesn't see worker outputs
  },
  "sub-coordinator": {
    scoutReport:     true,   // Sub-coordinator needs project context
    waveDiscoveries: true,   // Needs to see previous wave discoveries
    previousAttempt: false,  // Not relevant for sub-coordination
    constraints:     true,   // Task boundaries
    scope:           true,   // Focus areas
    decisions:       true,   // Architectural decisions
    fileSummaries:   false,  // Sub-coordinator works at higher level
    recentFiles:     false,  // Not relevant for sub-coordination
    gitDiff:         false,  // Sub-coordinator doesn't need diffs
    testResults:     false,  // Sub-coordinator doesn't need test results
    workerOutputs:   true,   // Needs to see worker outputs for coordination
  },
  governor: {
    scoutReport:     false,  // Governor doesn't need exploration context
    waveDiscoveries: false,  // Not relevant for governance
    previousAttempt: false,  // Not relevant for governance
    constraints:     true,   // Need to verify against constraints
    scope:           true,   // Need to check scope compliance
    decisions:       false,  // Not needed for governance
    fileSummaries:   false,  // Governor works at policy level
    recentFiles:     false,  // Not relevant for governance
    gitDiff:         false,  // Governor doesn't need diffs
    testResults:     false,  // Governor doesn't need test results
    workerOutputs:   false,  // Governor doesn't see worker outputs
  },
  aggregator: {
    scoutReport:     false,  // Aggregator doesn't need exploration context
    waveDiscoveries: false,  // Not relevant for aggregation
    previousAttempt: false,  // Not relevant for aggregation
    constraints:     true,   // Task boundaries
    scope:           true,   // Focus areas
    decisions:       false,  // Not needed for aggregation
    fileSummaries:   false,  // Aggregator works from outputs
    recentFiles:     false,  // Not relevant for aggregation
    gitDiff:         true,   // Core aggregation input
    testResults:     true,   // Core aggregation input
    workerOutputs:   true,   // Core aggregation input
  },
};

// ── Per-role content transformers ────────────────────────────────────
// Content-level transforms that go beyond binary keep/strip.
// Each role gets transforms that reduce token waste by filtering
// or summarizing content within kept sections.
export const ROLE_CONTEXT_FILTERS = {
  worker: {
    include: ['decisions', 'fileSummaries', 'scope', 'constraints', 'recentFiles', 'previousAttempt', 'waveDiscoveries', 'scoutReport'],
    transform: {
      fileSummaries: (content, scope) => {
        // Only include summaries for files in the worker's scope
        // scope is an array of path prefixes from ARBOR_SCOPE env var
        if (!scope || scope.length === 0) return content;
        const lines = content.split('\n');
        return lines.filter(line => {
          // Keep header lines, empty lines, and lines matching scope
          if (!line.startsWith('- ')) return true;
          return scope.some(s => line.includes(s));
        }).join('\n');
      },
      decisions: (content, scope) => {
        // Only include decisions relevant to the worker's assigned files
        if (!scope || scope.length === 0) return content;
        const lines = content.split('\n');
        return lines.filter(line => {
          if (!line.startsWith('- ')) return true;
          // Keep decisions that mention any scope path, or generic decisions
          return scope.some(s => line.toLowerCase().includes(s.toLowerCase())) || !line.includes('/');
        }).join('\n');
      }
    }
  },
  verifier: {
    include: ['gitDiff', 'testResults', 'workerOutputs', 'constraints', 'scope'],
    transform: {
      workerOutputs: (content) => {
        // Summarize worker outputs to just: what changed, where, why
        // Strip tool call logs and intermediate reasoning
        const lines = content.split('\n');
        const summary = lines.filter(line => {
          const l = line.toLowerCase();
          return l.includes('changed') || l.includes('modified') || l.includes('added') ||
                 l.includes('removed') || l.includes('fixed') || l.includes('created') ||
                 l.startsWith('- ') || l.startsWith('## ') || l.startsWith('# ');
        });
        return summary.join('\n');
      },
      gitDiff: (content) => {
        // If diff is over 500 lines, extract only the stat summary + first 20 lines per file
        const lines = content.split('\n');
        if (lines.length <= 500) return content;
        const result = [];
        let currentFile = null;
        let fileLineCount = 0;
        for (const line of lines) {
          if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
            currentFile = line;
            fileLineCount = 0;
            result.push(line);
          } else if (line.startsWith('@@')) {
            fileLineCount = 0;
            result.push(line);
          } else if (fileLineCount < 20) {
            result.push(line);
            fileLineCount++;
          }
        }
        result.push('\n... [diff truncated for verifier context efficiency]');
        return result.join('\n');
      }
    }
  },
  decomposer: {
    include: ['scoutReport', 'constraints', 'scope', 'decisions', 'fileSummaries', 'recentFiles'],
    transform: {
      fileSummaries: (content) => {
        // Collapse to directory-level summaries for high-level view
        const lines = content.split('\n');
        const dirMap = new Map();
        for (const line of lines) {
          const match = line.match(/^- ([^:]+):/);
          if (match) {
            const parts = match[1].split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : match[1];
            dirMap.set(dir, (dirMap.get(dir) || 0) + 1);
          }
        }
        if (dirMap.size === 0) return content;
        const header = lines.find(l => !l.startsWith('- ')) || '';
        const dirSummaries = [...dirMap.entries()]
          .map(([dir, count]) => '- ' + dir + ' — ' + count + ' files')
          .join('\n');
        return (header ? header + '\n' : '') + dirSummaries;
      },
      scoutReport: (content) => {
        // Extract only: project structure, module boundaries, dependency graph
        // Strip code-level details
        const lines = content.split('\n');
        return lines.filter(line => {
          const l = line.toLowerCase();
          return l.includes('structure') || l.includes('module') || l.includes('depend') ||
                 l.includes('boundary') || l.includes('directory') || l.includes('component') ||
                 l.startsWith('#') || l.startsWith('- ') || line.trim() === '';
        }).join('\n');
      }
    }
  }
};

/**
 * Filter a structured context object for a specific role.
 * Removes sections that aren't relevant to the role's task.
 *
 * @param {object} ctx - Raw context object (from context JSON file)
 * @param {string} role - Agent role: "worker", "verifier", "decomposer"
 * @returns {object} Filtered context object (new object, original unchanged)
 */
export function filterContextForRole(ctx, role) {
  if (!ctx || typeof ctx !== "object") return ctx;
  const rules = ROLE_RULES[role];
  if (!rules) return ctx; // Unknown role — pass through unfiltered

  const filtered = {};

  // task section — always include (constraints + scope filtered below)
  if (ctx.task) {
    filtered.task = { ...ctx.task };
    if (!rules.constraints) delete filtered.task.constraints;
    if (!rules.scope) delete filtered.task.scope;
  }

  // prior_knowledge section
  if (ctx.prior_knowledge) {
    filtered.prior_knowledge = {};
    if (rules.decisions && ctx.prior_knowledge.decisions) {
      filtered.prior_knowledge.decisions = ctx.prior_knowledge.decisions;
    }
    if (rules.fileSummaries && ctx.prior_knowledge.file_summaries) {
      filtered.prior_knowledge.file_summaries = ctx.prior_knowledge.file_summaries;
    }
    // Remove empty prior_knowledge
    if (Object.keys(filtered.prior_knowledge).length === 0) {
      delete filtered.prior_knowledge;
    }
  }

  // project section
  if (ctx.project) {
    filtered.project = {};
    if (rules.recentFiles && ctx.project.recent_files) {
      filtered.project.recent_files = ctx.project.recent_files;
    }
    if (Object.keys(filtered.project).length === 0) {
      delete filtered.project;
    }
  }

  // metadata — always pass through
  if (ctx.metadata) {
    filtered.metadata = ctx.metadata;
  }

  return filtered;
}

/**
 * Filter an assembled system prompt string for a specific role.
 * Strips sections identified by SECTION_PATTERNS based on role rules.
 *
 * @param {string} prompt - Assembled system prompt string
 * @param {string} role - Agent role: "worker", "verifier", "decomposer"
 * @returns {string} Filtered prompt string
 */
export function filterSystemPromptForRole(prompt, role) {
  if (!prompt || typeof prompt !== "string") return prompt;
  const rules = ROLE_RULES[role];
  if (!rules) return prompt; // Unknown role — pass through

  const budget = new ContextBudget();

  // Split prompt into sections at known header boundaries
  const blocks = prompt.split(SECTION_SPLIT_RE);
  const kept = [];

  for (const block of blocks) {
    const trimmed = block.replace(/^\n+/, ""); // strip leading newlines for detection
    let sectionKey = null;

    for (const { key, test } of SECTION_DETECTORS) {
      if (test.test(trimmed)) {
        sectionKey = key;
        break;
      }
    }

    if (sectionKey === null) {
      // Not a recognized section — keep it (preamble text, etc.)
      kept.push(block);
    } else if (rules[sectionKey]) {
      // Role wants this section — keep it
      kept.push(block);
    }
    // else: role doesn't want this section — skip it
  }

  // Clean up: collapse multiple blank lines to max 2
  const filtered = kept.join("").replace(/\n{3,}/g, "\n\n").trim();

  // Track budget utilization for logging
  const tokens = budget.estimateTokens(filtered);
  budget.allocations.set("system_prompt", tokens);
  const utilization = budget.utilizationPct();
  process.stderr.write(`[context-filter] ${role} prompt: ${tokens} tokens (${utilization.toFixed(1)}% of budget)\n`);

  return filtered;
}

/**
 * Helper to map camelCase section names to UPPER_CASE headers used in prompts.
 *
 * @param {string} section - CamelCase section name
 * @returns {string} Header pattern used in prompts
 */
function _sectionToHeader(section) {
  const map = {
    fileSummaries: 'FILE CONTEXT',
    decisions: 'KNOWN DECISIONS',
    scope: 'SCOPE',
    constraints: 'CONSTRAINTS',
    recentFiles: 'RECENTLY MODIFIED',
    gitDiff: 'GIT DIFF',
    testResults: 'TEST EXECUTION RESULTS',
    workerOutputs: 'WORKER OUTPUTS',
    scoutReport: '\\[Scout Report\\]',
    previousAttempt: '\\[Previous Attempt Output',
    waveDiscoveries: '\\[Wave \\d+ Discoveries\\]'
  };
  return map[section] || section.toUpperCase();
}

/**
 * Apply semantic content filtering to a prompt based on role and scope.
 * This goes beyond section-level filtering (ROLE_RULES) to transform content
 * within kept sections, reducing token waste by 30%+ for scoped prompts.
 *
 * @param {string} prompt - Assembled system prompt string
 * @param {string} role - Agent role: "worker", "verifier", "decomposer"
 * @param {string|string[]} scope - ARBOR_SCOPE value (comma-separated string or array)
 * @returns {string} Semantically filtered prompt
 */
export function filterContextSemantically(prompt, role, scope) {
  // First apply existing section-level filtering (ROLE_RULES via filterSystemPromptForRole)
  let filtered = filterSystemPromptForRole(prompt, role);

  // Then apply content-level transforms from ROLE_CONTEXT_FILTERS
  const roleFilter = ROLE_CONTEXT_FILTERS[role];
  if (!roleFilter) return filtered; // Unknown role — return section-filtered only

  // Parse scope from string to array (ARBOR_SCOPE is comma-separated)
  const scopeArray = typeof scope === 'string' ? scope.split(',').map(s => s.trim()).filter(Boolean) : (scope || []);

  // Apply transforms to matching sections in the filtered prompt
  for (const [section, transform] of Object.entries(roleFilter.transform || {})) {
    // Find section in the prompt text (sections are delimited by headers)
    const headerPattern = _sectionToHeader(section);
    const sectionPattern = new RegExp('(' + headerPattern + '[^]*?)(?=\\n(?:\\[(?:Scout Report|Wave \\d|Previous Attempt)|(?:CONSTRAINTS|SCOPE|KNOWN DECISIONS|FILE CONTEXT|RECENTLY MODIFIED|GIT DIFF|TEST EXECUTION RESULTS|WORKER OUTPUTS):)|$)', '');
    const match = filtered.match(sectionPattern);
    if (match) {
      const original = match[1];
      const transformed = transform(original, scopeArray);
      filtered = filtered.replace(original, transformed);
    }
  }

  return filtered;
}

/**
 * Compute filtering stats for diagnostics.
 *
 * @param {string} original - Original prompt
 * @param {string} filtered - Filtered prompt
 * @returns {{ originalSize: number, filteredSize: number, reductionPct: number }}
 */
export function filteringStats(original, filtered) {
  const originalSize = original ? original.length : 0;
  const filteredSize = filtered ? filtered.length : 0;
  const reductionPct = originalSize > 0
    ? Math.round((1 - filteredSize / originalSize) * 100)
    : 0;
  return { originalSize, filteredSize, reductionPct };
}

/**
 * Get the list of sections that will be stripped for a given role.
 * Useful for logging/diagnostics.
 *
 * @param {string} role - Agent role
 * @returns {string[]} List of section names that will be stripped
 */
export function getStrippedSections(role) {
  const rules = ROLE_RULES[role];
  if (!rules) return [];
  return Object.entries(rules)
    .filter(([, keep]) => !keep)
    .map(([section]) => section);
}

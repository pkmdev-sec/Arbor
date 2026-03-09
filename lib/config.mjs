/**
 * Configuration constants extracted from agent-entry.mjs and swarm.mjs
 *
 * Sources:
 *   - MAX_BUFFER_SIZE:    agent-entry.mjs line ~81
 *   - TOOL_CALL_RE:       agent-entry.mjs line ~84
 *   - ALLOWED_MODELS:     agent-entry.mjs lines ~128-131
 *   - resolveModel():     agent-entry.mjs lines ~133-140
 *   - ROLE_PROMPTS:       agent-entry.mjs lines ~143-190
 *   - DEPTH:              swarm.mjs lines ~36-40
 *   - DEFAULT_EXCLUDES:   swarm.mjs line ~596
 *   - BACKUP_EXTENSIONS:  swarm.mjs line ~597
 */

// ── Buffer limits ────────────────────────────────────────────────
export const MAX_BUFFER_SIZE = 52428800; // 50MB cap for stdout/stderr accumulation

// ── Tool call detection pattern (for progress tracking) ──────────
export const TOOL_CALL_RE = /\b(Read|Grep|Bash|Edit|Write|Glob|WebSearch|WebFetch)\(/;

// ── Allowed models (1M context only) ─────────────────────────────
export const ALLOWED_MODELS = {
  "sonnet":    "sonnet",       // resolves to claude-sonnet-4-6 with 1M
  "opus":      "opus",         // resolves to claude-opus-4-6 with 1M
};

export function resolveModel(input) {
  const key = input.toLowerCase().replace(/[^a-z0-9[\]]/g, "");
  // Accept: sonnet, opus, sonnet4.6, opus4.6, claude-sonnet-4-6, etc.
  // Always append [1m] to ensure 1M context window
  if (key.includes("sonnet")) return "sonnet[1m]";
  if (key.includes("opus"))   return "opus[1m]";
  return null;
}

// ── Role-specific system prompts ─────────────────────────────────
export const ROLE_PROMPTS = {
  worker: [
    "You are a worker agent in a swarm. Execute your assigned subtask thoroughly.",
    "At the END of your response, produce a COMPLETION CHECKLIST:",
    "```checklist",
    "- [PASS] Item you completed successfully",
    "- [FAIL] Item you could not complete (with reason)",
    "- [SKIP] Item you intentionally skipped (with reason)",
    "```",
    "Every item from your assignment must appear in the checklist. Do NOT omit items silently.",
    "If you are uncertain about any item, mark it [FAIL] with explanation rather than claiming success.",
  ].join("\n"),

  verifier: [
    "You are a VERIFIER agent. Your job is adversarial cross-checking.",
    "You will receive: (1) the original task, (2) worker agent outputs, (3) actual file changes (git diff).",
    "Your job:",
    "1. For each claim a worker made, verify it against the actual file changes",
    "2. List any SILENT OMISSIONS — work that was assigned but not done and not mentioned",
    "3. List any EDGE CASES that were not handled",
    "4. Run tests if a test command is available",
    "5. Produce a VERDICT: PASS (all good), FAIL (critical issues), NEEDS_REWORK (minor issues)",
    "",
    "Output format:",
    "```verdict",
    "VERDICT: PASS|FAIL|NEEDS_REWORK",
    "ISSUES: [list of specific issues found]",
    "EDGE_CASES_CHECKED: [list of edge cases you verified]",
    "SILENT_OMISSIONS: [list of work claimed but not done]",
    "```",
  ].join("\n"),

  decomposer: [
    "You are a DECOMPOSER agent. Break the given task into independent subtasks.",
    "Output ONLY valid JSON — no markdown, no explanation, just the JSON array.",
    "Each subtask must be independently executable by a separate agent.",
    "",
    "Output format (JSON array):",
    '[{"title": "...", "task": "detailed description", "scope": ["file/dir paths"], "turns": 20, "model": "sonnet"}]',
    "",
    "Rules:",
    "- Each subtask should be scoped to specific files/directories",
    "- Subtasks must not conflict (no two agents writing the same file)",
    "- Include 1 subtask for tests if the task involves code changes",
    "- Estimate turns conservatively (better to over-estimate)",
    "- 2-5 subtasks is ideal. Never exceed 5.",
  ].join("\n"),
};

// ── Depth presets (from swarm) ───────────────────────────────────
export const DEPTH = {
  shallow:  { turns: 10, budget: 5,  verifyModel: "sonnet" },
  normal:   { turns: 25, budget: 15, verifyModel: "sonnet" },
  thorough: { turns: 50, budget: 25, verifyModel: "opus" },
};

// ── Overlay worktree isolation constants (from swarm) ────────────
export const DEFAULT_EXCLUDES = ["node_modules", ".git", ".beads", "__pycache__", ".DS_Store"];
export const BACKUP_EXTENSIONS = /\.(mjs|js|cjs|ts|tsx|jsx|py|json|yaml|yml|toml|sh|bash)$/;

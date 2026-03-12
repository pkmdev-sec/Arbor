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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── Role-specific tool restrictions ──────────────────────────────
// Passed to Claude CLI via --disallowed-tools flag. null = no restrictions (default).
// Space-separated tool names to BLOCK. More future-proof than allowlists —
// new tools added by Claude Code are automatically available without updating config.
//
// NOTE: Tool search awareness — Claude auto-switches to tool-search mode when tool
// definitions exceed ~10% of context window. Our MCP coordinator adds only 4 small
// tools (~500 tokens), well under threshold. Keep total tool count under ~50 to
// avoid auto-tool-search overhead.
export const ROLE_DISALLOWED_TOOLS = {
  worker: null,  // Full access — workers need all tools
  verifier: "Write Edit NotebookEdit Agent",  // Block modifications — read-only + bash for tests
  decomposer: "Write Edit Bash NotebookEdit Agent",  // Block everything except discovery tools
};

// ── F4: Role-specific resource tuning ────────────────────────────
// Applied via MAX_THINKING_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS, BASH_MAX_OUTPUT_LENGTH
export const ROLE_THINKING_TOKENS = {
  worker: 8000,
  verifier: 32000,
  decomposer: 16000,
};

export const ROLE_OUTPUT_TOKENS = {
  worker: 64000,
  verifier: 16000,
  decomposer: 8000,
};

export const ROLE_BASH_LIMIT = {
  worker: 200000,
  verifier: 200000,
  decomposer: 50000,
};

// ── Role-specific system prompts ─────────────────────────────────
export const ROLE_PROMPTS = {
  worker: [
    "You are an autonomous code execution agent operating in an isolated worktree with a fresh 1M context window.",
    "Your purpose: complete the assigned subtask fully and correctly, then report exactly what happened.",
    "",
    "## Execution Protocol",
    "1. READ before you write — always verify file contents before modifying",
    "2. VERIFY your changes compile/parse after each edit (run relevant lint/build commands)",
    "3. SCOPE — only modify files within your assigned scope. If you discover a dependency outside your scope, document it but do not modify it",
    "4. COMPLETE — finish the entire subtask. Partial completion is worse than a well-documented failure",
    "",
    "## Tool Usage",
    "- Use Glob/Grep to discover files — never guess paths",
    "- Use Read before Edit/Write — never modify a file you haven't read this session",
    "- Use Bash for builds, tests, and verification commands",
    "- Prefer Edit over Write for existing files (preserves unrelated content)",
    "- If swarm coordination MCP tools are available (swarm_report_progress, swarm_report_result), use them:",
    "  - Call swarm_report_progress at ~25%, 50%, 75% completion with a brief step description",
    "  - Call swarm_report_result once at the end with your final status and file list",
    "",
    "## Anti-Patterns (avoid these)",
    "- DO NOT claim to have made changes you didn't actually make",
    "- DO NOT skip error investigation — if something fails, diagnose why before retrying",
    "- DO NOT modify files outside your assigned scope",
    "- DO NOT retry the same failing command more than twice without changing approach",
    "- DO NOT produce output without a completion checklist",
    "",
    "## Completion Contract",
    "At the END of your response, produce EXACTLY this format:",
    "```checklist",
    "- [PASS] <item completed — cite the specific file:line changed>",
    "- [FAIL] <item that failed — state root cause and what you tried>",
    "- [SKIP] <item intentionally skipped — justify why>",
    "```",
    "Rules:",
    "- Every item from your assignment MUST appear — silent omissions are the worst failure mode",
    "- If uncertain about an item, mark it [FAIL] with honest explanation rather than claiming success",
    "- Include file paths for all changes made",
  ].join("\n"),

  verifier: [
    "You are a verification agent performing adversarial cross-checking of worker agent outputs.",
    "Your purpose: find discrepancies between claims and reality, catch silent omissions, and surface unhandled edge cases.",
    "",
    "## Verification Methodology (execute in order)",
    "",
    "### Step 1: Claim Extraction",
    "Read each worker output. Extract every factual claim:",
    '- "I modified file X" → verify X appears in git diff',
    '- "I added function Y" → verify Y exists with correct signature in diff',
    '- "Tests pass" → verify test output shows passing',
    '- "I handled edge case Z" → verify handling exists in the code',
    "",
    "### Step 2: Diff Cross-Reference",
    "For each file in the git diff:",
    "- Is this change claimed by a worker? Unclaimed changes are suspicious.",
    "- Does the change match the description? Compare description vs actual diff.",
    "- Are there unintended side effects? Check for regressions, broken imports, removed code.",
    "",
    "### Step 3: Omission Detection",
    "Compare the ORIGINAL TASK against ALL worker outputs:",
    "- What was asked for but never mentioned in any output?",
    "- What was partially addressed but not completed?",
    "- What was claimed as done but has no corresponding diff evidence?",
    "",
    "### Step 4: Edge Case Audit",
    "For each code change, check: null/undefined inputs, empty collections, error paths, boundary conditions.",
    "",
    "### Step 5: Evaluate Test Results",
    "Test execution results are included in the verification data when available.",
    "- If tests were executed and PASSED: note as positive evidence of correctness.",
    "- If tests were executed and FAILED: flag specific failures as CRITICAL issues.",
    "- If tests were NOT executed but the task involved code changes: flag as MAJOR issue — test evidence is missing.",
    "- If no test command was detected: note in TEST_RESULTS but do not penalize.",
    "",
    "## Severity Classification",
    "- CRITICAL: Claimed work not done, broken functionality, data loss risk, security vulnerability",
    "- MAJOR: Missing edge cases, incomplete error handling, silent behavior changes",
    "- MINOR: Style issues, suboptimal but functional approach",
    "",
    "## Output Format (MANDATORY)",
    "```verdict",
    "VERDICT: PASS|FAIL|NEEDS_REWORK",
    "CRITICAL_ISSUES: [list — each with file:line evidence]",
    "MAJOR_ISSUES: [list — each with file:line evidence]",
    "MINOR_ISSUES: [list — each with file:line evidence]",
    "SILENT_OMISSIONS: [what was assigned but not done and not mentioned]",
    "EDGE_CASES_CHECKED: [specific cases you verified]",
    "TEST_RESULTS: [pass/fail counts or 'no test command available']",
    "```",
    "Decision criteria:",
    "- PASS: Zero critical, zero major, all assigned items completed",
    "- NEEDS_REWORK: Zero critical, but major issues or omissions exist",
    "- FAIL: Any critical issue, multiple major issues, or >50% of assigned work missing",
  ].join("\n"),

  decomposer: [
    "You are a task decomposition agent. Analyze the task and project structure, then split work into independent subtasks for parallel execution.",
    "",
    "## Scope Isolation (CRITICAL)",
    "- Each subtask MUST specify exact file paths or directory prefixes it will modify",
    "- NO TWO subtasks may have overlapping file scopes — this causes merge conflicts",
    "- If two subtasks need the same file, merge them into one subtask",
    "- Shared config files (package.json, tsconfig, etc.) go to exactly one subtask",
    "",
    "## Dependency Detection",
    "- If subtask B imports from files subtask A creates, note the dependency",
    "- Prefer independent subtasks — restructure scope to eliminate dependencies when possible",
    "- The test subtask should depend on implementation subtasks",
    "",
    "## Sizing Guidelines",
    "- Each subtask: completable in 10-30 turns. More than 8 files = too large, split it",
    "- 2-5 subtasks is ideal. Never exceed the requested count",
    "- If the task involves code changes, include one subtask for running tests and fixing failures",
    "",
    "## Output Format",
    "Respond with a JSON object containing a `subtasks` array — no markdown fences, no explanation, no preamble.",
    '{"subtasks": [{"title": "Short name (3-8 words)", "task": "Detailed instructions with specific files", "scope": ["src/module/", "src/shared/types.ts"], "turns": 20, "model": "sonnet", "effort": "medium", "depends_on": []}]}',
    "",
    "Field requirements:",
    "- title: 3-8 words describing the deliverable",
    "- task: 2-5 sentences, specific enough for an agent with zero prior context",
    "- scope: file paths or directory prefixes this agent will touch",
    "- turns: conservative estimate (over-estimate by 20%)",
    '- model: "sonnet" for implementation, "opus" for complex reasoning/review',
    '- effort: thinking depth — "low" for file discovery/grep, "medium" for implementation, "high" for complex architecture/review',
    "- depends_on: array of titles this subtask must wait for (empty if independent)",
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

// ── F8: Decomposer JSON schema (structured output enforcement) ──
export const DECOMPOSER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title:      { type: "string", description: "Short name (3-8 words)" },
          task:       { type: "string", description: "Detailed instructions with specific files" },
          scope:      { type: "array", items: { type: "string" }, description: "File paths or directory prefixes this agent will touch" },
          turns:      { type: "number", description: "Conservative turn estimate (over-estimate by 20%)" },
          model:      { type: "string", enum: ["sonnet", "opus"], description: "Model choice" },
          effort:     { type: "string", enum: ["low", "medium", "high"], description: "Thinking depth" },
          depends_on: { type: "array", items: { type: "string" }, description: "Titles this subtask must wait for" },
        },
        required: ["title", "task", "scope", "turns", "model"],
        additionalProperties: false,
      },
    },
  },
  required: ["subtasks"],
  additionalProperties: false,
};

// ── Configuration schemas ────────────────────────────────────────

/**
 * Schema for config/policy-limits.json
 * Defines agent execution limits and policies
 */
export const POLICY_LIMITS_SCHEMA = {
  type: "object",
  properties: {
    maxTurns: {
      type: "number",
      required: false,
      min: 1,
      max: 100,
      default: 50,
      description: "Maximum conversation turns per agent"
    },
    maxCost: {
      type: "number",
      required: false,
      min: 0.01,
      max: 100,
      default: 25,
      description: "Maximum cost in USD per agent execution"
    },
    timeout: {
      type: "number",
      required: false,
      min: 1000,
      max: 3600000,
      default: 600000,
      description: "Execution timeout in milliseconds"
    },
    maxAgents: {
      type: "number",
      required: false,
      min: 1,
      max: 10,
      default: 5,
      description: "Maximum number of concurrent agents"
    },
    restrictions: {
      type: "object",
      required: false,
      properties: {
        allow_product_feedback: { type: "object", properties: { allowed: { type: "boolean" } } },
        allow_remote_sessions: { type: "object", properties: { allowed: { type: "boolean" } } },
        allow_remote_control: { type: "object", properties: { allowed: { type: "boolean" } } }
      }
    }
  }
};

/**
 * Schema for config/settings.json
 * Defines Claude Code execution settings
 */
export const SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    permissions: {
      type: "object",
      required: true,
      properties: {
        allow: {
          type: "array",
          required: true,
          itemType: "string",
          description: "List of allowed tools or ['*'] for all"
        },
        deny: {
          type: "array",
          required: true,
          itemType: "string",
          description: "List of denied tools"
        },
        defaultMode: {
          type: "string",
          required: true,
          enum: ["ask", "dontAsk", "deny"],
          description: "Default permission mode"
        }
      }
    },
    disableAllHooks: {
      type: "boolean",
      required: true,
      description: "Whether to disable all hooks"
    },
    includeCoAuthoredBy: {
      type: "boolean",
      required: false,
      description: "Whether to include co-authored-by in commits"
    }
  }
};

// ── Configuration validation ─────────────────────────────────────

/**
 * Hand-rolled configuration validator (~100 LOC)
 * Validates config against schema without external dependencies
 *
 * @param {any} config - Configuration object to validate
 * @param {object} schema - Schema definition
 * @param {string} filename - Config filename for error messages
 * @returns {void}
 * @throws {Error} Validation error with detailed field-level errors
 */
export function validateConfig(config, schema, filename) {
  const errors = [];

  // Helper: validate a single field
  function validateField(value, fieldSchema, path) {
    // Type validation
    if (fieldSchema.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push({
          path,
          expected: "object",
          got: typeof value === "object" && Array.isArray(value) ? "array" : typeof value
        });
        return;
      }

      // Validate nested properties if defined
      if (fieldSchema.properties) {
        for (const [key, subSchema] of Object.entries(fieldSchema.properties)) {
          if (key in value) {
            validateField(value[key], subSchema, `${path}.${key}`);
          } else if (subSchema.required) {
            errors.push({
              path: `${path}.${key}`,
              expected: `required ${subSchema.type}`,
              got: "missing"
            });
          }
        }
      }
    } else if (fieldSchema.type === "array") {
      if (!Array.isArray(value)) {
        errors.push({
          path,
          expected: "array",
          got: typeof value
        });
        return;
      }

      // Validate array item types if specified
      if (fieldSchema.itemType) {
        value.forEach((item, idx) => {
          if (typeof item !== fieldSchema.itemType) {
            errors.push({
              path: `${path}[${idx}]`,
              expected: fieldSchema.itemType,
              got: typeof item
            });
          }
        });
      }
    } else if (fieldSchema.type === "string") {
      if (typeof value !== "string") {
        errors.push({
          path,
          expected: "string",
          got: typeof value
        });
        return;
      }

      // Enum validation
      if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
        errors.push({
          path,
          expected: `one of [${fieldSchema.enum.join(", ")}]`,
          got: value
        });
      }
    } else if (fieldSchema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({
          path,
          expected: "number",
          got: typeof value
        });
        return;
      }

      // Range validation
      if (fieldSchema.min !== undefined && value < fieldSchema.min) {
        errors.push({
          path,
          expected: `>= ${fieldSchema.min}`,
          got: value
        });
      }
      if (fieldSchema.max !== undefined && value > fieldSchema.max) {
        errors.push({
          path,
          expected: `<= ${fieldSchema.max}`,
          got: value
        });
      }
    } else if (fieldSchema.type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push({
          path,
          expected: "boolean",
          got: typeof value
        });
      }
    }
  }

  // Validate root object
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(
      `[${filename}] Invalid config: expected object, got ${typeof config === "object" && Array.isArray(config) ? "array" : typeof config}`
    );
  }

  // Validate each top-level property
  if (schema.properties) {
    for (const [key, fieldSchema] of Object.entries(schema.properties)) {
      if (key in config) {
        validateField(config[key], fieldSchema, key);
      } else if (fieldSchema.required) {
        errors.push({
          path: key,
          expected: `required ${fieldSchema.type}`,
          got: "missing"
        });
      }
    }

    // Apply defaults for missing optional fields (root-level only;
    // nested defaults are not currently needed by any schema)
    for (const [key, fieldSchema] of Object.entries(schema.properties)) {
      if (!(key in config) && fieldSchema.default !== undefined) {
        config[key] = fieldSchema.default;
      }
    }
  }

  // Throw if validation failed
  if (errors.length > 0) {
    const errorList = errors
      .map(e => `  - ${e.path}: expected ${e.expected}, got ${e.got}`)
      .join("\n");
    throw new Error(`[${filename}] Validation failed:\n${errorList}`);
  }
}

// ── Configuration loading and caching ────────────────────────────

// Module-scope cache for validated configs
const configCache = {
  policyLimits: null,
  settings: null
};

/**
 * Load and validate config/policy-limits.json
 * @param {string} configDir - Path to config directory
 * @returns {object} Validated policy limits configuration
 */
export function loadPolicyLimits(configDir) {
  if (configCache.policyLimits) {
    return configCache.policyLimits;
  }

  const filename = "policy-limits.json";
  const filepath = join(configDir, filename);

  try {
    const raw = readFileSync(filepath, "utf-8");
    const config = JSON.parse(raw);
    validateConfig(config, POLICY_LIMITS_SCHEMA, filename);
    configCache.policyLimits = config;
    return config;
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`[${filename}] Config file not found at ${filepath}`);
    } else if (err instanceof SyntaxError) {
      throw new Error(`[${filename}] Invalid JSON: ${err.message}`);
    } else {
      // Re-throw validation errors and other errors as-is
      throw err;
    }
  }
}

/**
 * Load and validate config/settings.json
 * @param {string} configDir - Path to config directory
 * @returns {object} Validated settings configuration
 */
export function loadSettings(configDir) {
  if (configCache.settings) {
    return configCache.settings;
  }

  const filename = "settings.json";
  const filepath = join(configDir, filename);

  try {
    const raw = readFileSync(filepath, "utf-8");
    const config = JSON.parse(raw);
    validateConfig(config, SETTINGS_SCHEMA, filename);
    configCache.settings = config;
    return config;
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`[${filename}] Config file not found at ${filepath}`);
    } else if (err instanceof SyntaxError) {
      throw new Error(`[${filename}] Invalid JSON: ${err.message}`);
    } else {
      // Re-throw validation errors and other errors as-is
      throw err;
    }
  }
}

/**
 * Clear config cache (useful for testing or config reload)
 */
export function clearConfigCache() {
  configCache.policyLimits = null;
  configCache.settings = null;
}

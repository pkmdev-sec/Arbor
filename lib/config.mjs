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
      required: true,
      min: 1,
      max: 100,
      description: "Maximum conversation turns per agent"
    },
    maxCost: {
      type: "number",
      required: true,
      min: 0.01,
      max: 100,
      description: "Maximum cost in USD per agent execution"
    },
    timeout: {
      type: "number",
      required: true,
      min: 1000,
      max: 3600000,
      description: "Execution timeout in milliseconds"
    },
    maxAgents: {
      type: "number",
      required: true,
      min: 1,
      max: 10,
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

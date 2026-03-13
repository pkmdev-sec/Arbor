/**
 * Prompt audit trail
 *
 * Persists full prompt per agent for debugging and analysis.
 * Inspired by Fernis REQ-011: maintain complete invocation history for troubleshooting.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Constants ────────────────────────────────────────────────────

/** Base directory for audit logs */
const DEFAULT_BASE_DIR = join(tmpdir(), "arbor-audit");

// ── AuditTrail class ─────────────────────────────────────────────

/**
 * Audit trail for agent invocations and results.
 * Stores complete context per agent for debugging.
 *
 * @example
 * const audit = new AuditTrail();
 * audit.recordInvocation("agent-123", {
 *   systemPrompt: "...",
 *   taskPrompt: "...",
 *   model: "claude-sonnet-4-6"
 * });
 * audit.recordResult("agent-123", { output: "...", turnsUsed: 5 });
 */
export default class AuditTrail {
  /**
   * Create an audit trail instance.
   *
   * @param {string} baseDir - Base directory for audit logs (defaults to tmpdir/arbor-audit/{timestamp})
   */
  constructor(baseDir) {
    // Create timestamped subdirectory
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.baseDir = baseDir || join(DEFAULT_BASE_DIR, timestamp);

    // Ensure directory exists
    this._ensureDir();
  }

  /**
   * Record a complete agent invocation for later debugging.
   *
   * @param {string} agentId - Unique agent identifier
   * @param {object} invocation - Full agent context
   * @param {string} invocation.systemPrompt - System prompt used
   * @param {string} invocation.taskPrompt - Task-specific prompt
   * @param {object} invocation.contextInjected - Context injected into prompt
   * @param {string} invocation.model - Model used (e.g., "claude-sonnet-4-6")
   * @param {Array<string>} invocation.tools - Tools available to agent
   * @param {number} invocation.maxTurns - Maximum turns allowed
   * @param {object} invocation.learningContext - Learning context provided
   */
  recordInvocation(agentId, invocation) {
    const filePath = this._getAgentPath(agentId);

    const record = {
      agentId,
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      type: "invocation",
      invocation: {
        // Preserve all fields from input
        ...invocation,
        // Apply defaults for standard fields only if missing
        systemPrompt: invocation.systemPrompt ?? null,
        taskPrompt: invocation.taskPrompt ?? null,
        contextInjected: invocation.contextInjected ?? null,
        model: invocation.model ?? null,
        tools: invocation.tools ?? [],
        maxTurns: invocation.maxTurns ?? null,
        learningContext: invocation.learningContext ?? null,
      },
    };

    // Create or update agent audit file
    let audit = { agentId, records: [] };
    if (existsSync(filePath)) {
      try {
        const existing = readFileSync(filePath, "utf-8");
        audit = JSON.parse(existing);
      } catch (err) {
        // If file is corrupt, start fresh
        audit = { agentId, records: [] };
      }
    }

    audit.records.push(record);
    this._writeAuditFile(filePath, audit);
  }

  /**
   * Record agent result after completion.
   *
   * @param {string} agentId - Unique agent identifier
   * @param {object} result - Agent result data
   * @param {string} result.output - Agent output text
   * @param {number} result.turnsUsed - Number of turns used
   * @param {number} result.durationMs - Execution duration in milliseconds
   * @param {Array} result.toolCalls - Tool calls made by agent
   * @param {Array<string>} result.filesChanged - Files changed by agent
   * @param {number} result.exitCode - Exit code (0 for success)
   * @param {number} result.validationScore - Validation score from output validator
   */
  recordResult(agentId, result) {
    const filePath = this._getAgentPath(agentId);

    const record = {
      agentId,
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      type: "result",
      result: {
        // Preserve all fields from input
        ...result,
        // Apply defaults for standard fields only if missing
        output: result.output ?? null,
        turnsUsed: result.turnsUsed ?? 0,
        durationMs: result.durationMs ?? 0,
        toolCalls: result.toolCalls ?? [],
        filesChanged: result.filesChanged ?? [],
        exitCode: result.exitCode ?? null,
        validationScore: result.validationScore ?? null,
      },
    };

    // Load existing audit
    let audit = { agentId, records: [] };
    if (existsSync(filePath)) {
      try {
        const existing = readFileSync(filePath, "utf-8");
        audit = JSON.parse(existing);
      } catch (err) {
        // If file is corrupt, start fresh
        audit = { agentId, records: [] };
      }
    }

    audit.records.push(record);
    this._writeAuditFile(filePath, audit);
  }

  /**
   * Get audit directory path.
   *
   * @returns {string} Audit directory path
   */
  getAuditDir() {
    return this.baseDir;
  }

  /**
   * Get full audit for an agent.
   *
   * @param {string} agentId - Agent identifier
   * @returns {object|null} Full audit data or null if not found
   */
  getAgentAudit(agentId) {
    const filePath = this._getAgentPath(agentId);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const data = readFileSync(filePath, "utf-8");
      return JSON.parse(data);
    } catch (err) {
      return null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Ensure audit directory exists.
   * @private
   */
  _ensureDir() {
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (err) {
      // Directory may already exist
    }
  }

  /**
   * Get file path for an agent's audit log.
   *
   * @param {string} agentId - Agent identifier
   * @returns {string} File path
   * @private
   */
  _getAgentPath(agentId) {
    return join(this.baseDir, `${agentId}.json`);
  }

  /**
   * Write audit file with pretty formatting.
   *
   * @param {string} filePath - Path to write
   * @param {object} data - Data to write
   * @private
   */
  _writeAuditFile(filePath, data) {
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      // Silent fail - audit is not critical path
      console.error(`Failed to write audit file: ${err.message}`);
    }
  }
}

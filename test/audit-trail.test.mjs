import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AuditTrail from "../lib/audit-trail.mjs";

const TEST_BASE_DIR = join(tmpdir(), "arbor-audit-test");

describe("AuditTrail", () => {
  after(() => {
    // Clean up test directory
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true, force: true });
    }
  });

  it("creates audit directory on initialization", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const auditDir = audit.getAuditDir();

    assert.ok(existsSync(auditDir));
  });

  it("records an agent invocation", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-001";

    audit.recordInvocation(agentId, {
      systemPrompt: "You are a helpful coding assistant",
      taskPrompt: "Fix the bug in auth.mjs",
      contextInjected: { projectType: "nodejs" },
      model: "claude-sonnet-4-6",
      tools: ["read", "write", "bash"],
      maxTurns: 10,
      learningContext: { patterns: [] },
    });

    const agentAudit = audit.getAgentAudit(agentId);

    assert.ok(agentAudit);
    assert.equal(agentAudit.agentId, agentId);
    assert.equal(agentAudit.records.length, 1);
    assert.equal(agentAudit.records[0].type, "invocation");
    assert.equal(agentAudit.records[0].invocation.model, "claude-sonnet-4-6");
    assert.equal(agentAudit.records[0].invocation.systemPrompt, "You are a helpful coding assistant");
  });

  it("records an agent result", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-002";

    audit.recordResult(agentId, {
      output: "Successfully fixed the authentication bug",
      turnsUsed: 5,
      durationMs: 12345,
      toolCalls: [
        { tool: "read", file: "lib/auth.mjs" },
        { tool: "write", file: "lib/auth.mjs" },
      ],
      filesChanged: ["lib/auth.mjs"],
      exitCode: 0,
      validationScore: 0.95,
    });

    const agentAudit = audit.getAgentAudit(agentId);

    assert.ok(agentAudit);
    assert.equal(agentAudit.records.length, 1);
    assert.equal(agentAudit.records[0].type, "result");
    assert.equal(agentAudit.records[0].result.turnsUsed, 5);
    assert.equal(agentAudit.records[0].result.exitCode, 0);
    assert.equal(agentAudit.records[0].result.validationScore, 0.95);
  });

  it("records multiple records for same agent", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-003";

    // Record invocation
    audit.recordInvocation(agentId, {
      systemPrompt: "You are a refactoring expert",
      taskPrompt: "Refactor the authentication module",
      model: "claude-sonnet-4-6",
      tools: ["read", "write"],
      maxTurns: 15,
    });

    // Record result
    audit.recordResult(agentId, {
      output: "Refactored authentication module successfully",
      turnsUsed: 8,
      durationMs: 45000,
      filesChanged: ["lib/auth.mjs", "lib/tokens.mjs"],
      exitCode: 0,
    });

    const agentAudit = audit.getAgentAudit(agentId);

    assert.equal(agentAudit.records.length, 2);
    assert.equal(agentAudit.records[0].type, "invocation");
    assert.equal(agentAudit.records[1].type, "result");
  });

  it("handles missing optional fields gracefully", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-004";

    // Record with minimal data
    audit.recordInvocation(agentId, {
      taskPrompt: "Do something",
    });

    const agentAudit = audit.getAgentAudit(agentId);

    assert.ok(agentAudit);
    assert.equal(agentAudit.records[0].invocation.systemPrompt, null);
    assert.equal(agentAudit.records[0].invocation.model, null);
    assert.deepEqual(agentAudit.records[0].invocation.tools, []);
  });

  it("returns null for non-existent agent", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentAudit = audit.getAgentAudit("non-existent-agent");

    assert.equal(agentAudit, null);
  });

  it("includes timestamps on all records", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-005";

    const beforeTime = Date.now();

    audit.recordInvocation(agentId, {
      taskPrompt: "Test timestamps",
      model: "claude-sonnet-4-6",
    });

    const afterTime = Date.now();

    const agentAudit = audit.getAgentAudit(agentId);
    const record = agentAudit.records[0];

    assert.ok(record.timestamp >= beforeTime);
    assert.ok(record.timestamp <= afterTime);
    assert.ok(record.timestampISO);
    assert.ok(typeof record.timestampISO === "string");
  });

  it("handles corrupt audit file gracefully", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-006";

    // Create a corrupt file
    const filePath = join(audit.getAuditDir(), `${agentId}.json`);
    writeFileSync(filePath, "{ invalid json", "utf-8");

    // Should overwrite corrupt file with new record
    audit.recordInvocation(agentId, {
      taskPrompt: "Test recovery",
      model: "claude-sonnet-4-6",
    });

    const agentAudit = audit.getAgentAudit(agentId);

    assert.ok(agentAudit);
    assert.equal(agentAudit.records.length, 1);
  });

  it("stores complete tool call data", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "test-agent-007";

    const toolCalls = [
      { tool: "read", file: "lib/auth.mjs", lines: 150 },
      { tool: "grep", pattern: "export.*function", matches: 5 },
      { tool: "write", file: "lib/auth.mjs", linesWritten: 165 },
    ];

    audit.recordResult(agentId, {
      output: "Task completed",
      turnsUsed: 3,
      durationMs: 8000,
      toolCalls,
      filesChanged: ["lib/auth.mjs"],
      exitCode: 0,
    });

    const agentAudit = audit.getAgentAudit(agentId);
    const result = agentAudit.records[0].result;

    assert.deepEqual(result.toolCalls, toolCalls);
  });

  it("handles file path with agent ID correctly", () => {
    const audit = new AuditTrail(TEST_BASE_DIR);
    const agentId = "agent-with-special-chars-123";

    audit.recordInvocation(agentId, {
      taskPrompt: "Test file path handling",
      model: "claude-sonnet-4-6",
    });

    const expectedPath = join(audit.getAuditDir(), `${agentId}.json`);
    assert.ok(existsSync(expectedPath));
  });

  it("creates timestamped subdirectory by default", () => {
    // Don't provide baseDir - should create timestamped one
    const audit = new AuditTrail();
    const auditDir = audit.getAuditDir();

    assert.ok(auditDir.includes("arbor-audit"));
    assert.ok(existsSync(auditDir));

    // Clean up
    rmSync(auditDir, { recursive: true, force: true });
  });
});

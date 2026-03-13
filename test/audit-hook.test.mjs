/**
 * Tests for Audit Trail Hook
 *
 * Tests audit hook integration with MessageBus, message capture,
 * redaction, filtering, and statistics.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import AuditTrail from "../lib/audit-trail.mjs";
import { createAuditHook, getAuditStats } from "../lib/ipc/audit-hook.mjs";

describe("Audit Hook", () => {
  let auditTrail;
  let testDir;

  beforeEach(() => {
    // Create unique test directory
    testDir = join(tmpdir(), `audit-hook-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    auditTrail = new AuditTrail(testDir);
  });

  afterEach(() => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("createAuditHook", () => {
    it("should create hook object with required methods", () => {
      const hook = createAuditHook(auditTrail);

      assert.ok(hook.onMessageReceived);
      assert.ok(hook.onAgentConnected);
      assert.ok(hook.onAgentDisconnected);
      assert.strictEqual(typeof hook.onMessageReceived, "function");
      assert.strictEqual(typeof hook.onAgentConnected, "function");
      assert.strictEqual(typeof hook.onAgentDisconnected, "function");
    });

    it("should use default options when none provided", () => {
      const hook = createAuditHook(auditTrail);
      // Should not throw and should work with defaults
      const result = hook.onMessageReceived(
        { type: "PUBLISH", from: "test-agent", topic: "test.topic", payload: { data: "value" } },
        {}
      );
      assert.strictEqual(result, true);
    });
  });

  describe("onMessageReceived", () => {
    it("should capture message metadata", () => {
      const hook = createAuditHook(auditTrail);

      const msg = {
        type: "PUBLISH",
        from: "agent-123",
        to: "agent-456",
        topic: "test.topic",
        id: "corr-123",
        timestamp: Date.now(),
        payload: { data: "test" },
      };

      const result = hook.onMessageReceived(msg, {});
      assert.strictEqual(result, true);

      // Verify audit was recorded
      const audit = auditTrail.getAgentAudit("agent-123");
      assert.ok(audit);
      assert.strictEqual(audit.records.length, 1);

      const record = audit.records[0];
      assert.strictEqual(record.invocation.type, "ipc_message");
      assert.strictEqual(record.invocation.messageType, "PUBLISH");
      assert.strictEqual(record.invocation.target, "agent-456");
      assert.strictEqual(record.invocation.topic, "test.topic");
      assert.strictEqual(record.invocation.correlationId, "corr-123");
    });

    it("should capture payload when captureContent is true", () => {
      const hook = createAuditHook(auditTrail, { captureContent: true });

      const msg = {
        type: "REQUEST",
        from: "agent-a",
        payload: { key: "value", nested: { data: 123 } },
      };

      hook.onMessageReceived(msg, {});

      const audit = auditTrail.getAgentAudit("agent-a");
      assert.ok(audit.records[0].invocation.payload);
      assert.deepStrictEqual(audit.records[0].invocation.payload, {
        key: "value",
        nested: { data: 123 },
      });
    });

    it("should not capture payload when captureContent is false", () => {
      const hook = createAuditHook(auditTrail, { captureContent: false });

      const msg = {
        type: "DIRECT_SEND",
        from: "agent-b",
        payload: { secret: "data" },
      };

      hook.onMessageReceived(msg, {});

      const audit = auditTrail.getAgentAudit("agent-b");
      assert.strictEqual(audit.records[0].invocation.payload, undefined);
    });

    it("should redact sensitive patterns from payload", () => {
      const hook = createAuditHook(auditTrail, {
        captureContent: true,
        redactPatterns: [/password/gi, /token:\s*"[^"]+"/gi],
      });

      const msg = {
        type: "REQUEST",
        from: "agent-c",
        payload: {
          username: "user",
          password: "secret123",
          token: "abc-xyz-789",
        },
      };

      hook.onMessageReceived(msg, {});

      const audit = auditTrail.getAgentAudit("agent-c");
      const payload = audit.records[0].invocation.payload;

      // Check that sensitive data was redacted
      const payloadStr = JSON.stringify(payload);
      assert.ok(payloadStr.includes("[REDACTED]"));
      assert.ok(!payloadStr.includes("secret123"));
    });

    it("should handle multiple redaction patterns", () => {
      const hook = createAuditHook(auditTrail, {
        captureContent: true,
        redactPatterns: [/"apiKey":"[^"]+"/g, /"secret":"[^"]+"/g],
      });

      const msg = {
        type: "PUBLISH",
        from: "agent-d",
        payload: {
          apiKey: "key-123",
          secret: "secret-456",
          public: "visible",
        },
      };

      hook.onMessageReceived(msg, {});

      const audit = auditTrail.getAgentAudit("agent-d");
      const payload = audit.records[0].invocation.payload;
      const payloadStr = JSON.stringify(payload);

      assert.ok(payloadStr.includes("[REDACTED]"));
      assert.ok(payloadStr.includes("visible")); // Public data should remain
    });

    it("should filter messages by exact topic", () => {
      const hook = createAuditHook(auditTrail, {
        topicFilter: "agent.status",
      });

      // Message matching filter
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-e", topic: "agent.status" },
        {}
      );

      // Message not matching filter
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-e", topic: "agent.other" },
        {}
      );

      const audit = auditTrail.getAgentAudit("agent-e");
      // Only one message should be audited (the matching one)
      assert.strictEqual(audit.records.length, 1);
      assert.strictEqual(audit.records[0].invocation.topic, "agent.status");
    });

    it("should filter messages by wildcard topic pattern", () => {
      const hook = createAuditHook(auditTrail, {
        topicFilter: "agent.*",
      });

      // Messages matching filter
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-f", topic: "agent.status" },
        {}
      );
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-f", topic: "agent.health" },
        {}
      );

      // Message not matching filter
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-f", topic: "system.status" },
        {}
      );

      const audit = auditTrail.getAgentAudit("agent-f");
      // Only two messages should be audited
      assert.strictEqual(audit.records.length, 2);
      assert.strictEqual(audit.records[0].invocation.topic, "agent.status");
      assert.strictEqual(audit.records[1].invocation.topic, "agent.health");
    });

    it("should filter messages by multi-segment wildcard (**)", () => {
      const hook = createAuditHook(auditTrail, {
        topicFilter: "agent.**",
      });

      // Messages matching filter (multi-level)
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-g", topic: "agent.status.health" },
        {}
      );
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-g", topic: "agent.metrics.cpu.usage" },
        {}
      );

      // Message not matching filter
      hook.onMessageReceived(
        { type: "PUBLISH", from: "agent-g", topic: "system.alert" },
        {}
      );

      const audit = auditTrail.getAgentAudit("agent-g");
      // Only two messages should be audited
      assert.strictEqual(audit.records.length, 2);
    });

    it("should ALWAYS return true (never block messages)", () => {
      const hook = createAuditHook(auditTrail);

      // Test various message types
      assert.strictEqual(
        hook.onMessageReceived({ type: "PUBLISH", from: "a" }, {}),
        true
      );
      assert.strictEqual(
        hook.onMessageReceived({ type: "REQUEST", from: "a" }, {}),
        true
      );
      assert.strictEqual(
        hook.onMessageReceived({ type: "RESPONSE", from: "a" }, {}),
        true
      );
      assert.strictEqual(
        hook.onMessageReceived({ type: "DIRECT_SEND", from: "a" }, {}),
        true
      );

      // Even with filter that doesn't match
      const filteredHook = createAuditHook(auditTrail, {
        topicFilter: "never.match",
      });
      assert.strictEqual(
        filteredHook.onMessageReceived(
          { type: "PUBLISH", from: "a", topic: "other.topic" },
          {}
        ),
        true
      );
    });

    it("should handle messages with missing fields gracefully", () => {
      const hook = createAuditHook(auditTrail);

      // Message with minimal fields
      const result = hook.onMessageReceived({ from: "agent-h" }, {});
      assert.strictEqual(result, true);

      // Verify some audit was recorded despite missing fields
      const audit = auditTrail.getAgentAudit("agent-h");
      assert.ok(audit);
      assert.strictEqual(audit.records.length, 1);
    });

    it("should handle unknown agent (no 'from' field)", () => {
      const hook = createAuditHook(auditTrail);

      const result = hook.onMessageReceived({ type: "PUBLISH" }, {});
      assert.strictEqual(result, true);

      // Should be recorded under 'unknown'
      const audit = auditTrail.getAgentAudit("unknown");
      assert.ok(audit);
    });

    it("should not throw on audit errors", () => {
      // Create hook with invalid audit trail to trigger errors
      const invalidAuditTrail = {
        recordInvocation: () => {
          throw new Error("Audit failure");
        },
      };

      const hook = createAuditHook(invalidAuditTrail);

      // Should not throw - errors are caught internally
      assert.doesNotThrow(() => {
        hook.onMessageReceived({ type: "PUBLISH", from: "agent-i" }, {});
      });
    });
  });

  describe("onAgentConnected", () => {
    it("should log connection event", () => {
      const hook = createAuditHook(auditTrail);

      const mockSocket = { remoteAddress: "127.0.0.1" };
      hook.onAgentConnected("agent-connect", mockSocket);

      const audit = auditTrail.getAgentAudit("agent-connect");
      assert.ok(audit);
      assert.strictEqual(audit.records.length, 1);
      assert.strictEqual(audit.records[0].invocation.type, "ipc_connect");
      assert.ok(audit.records[0].invocation.timestamp);
    });

    it("should handle missing socket gracefully", () => {
      const hook = createAuditHook(auditTrail);

      assert.doesNotThrow(() => {
        hook.onAgentConnected("agent-j", null);
      });

      const audit = auditTrail.getAgentAudit("agent-j");
      assert.ok(audit);
      assert.strictEqual(audit.records.length, 1);
    });

    it("should not throw on audit errors", () => {
      const invalidAuditTrail = {
        recordInvocation: () => {
          throw new Error("Connection audit failure");
        },
      };

      const hook = createAuditHook(invalidAuditTrail);

      assert.doesNotThrow(() => {
        hook.onAgentConnected("agent-k", {});
      });
    });
  });

  describe("onAgentDisconnected", () => {
    it("should log disconnection event with reason", () => {
      const hook = createAuditHook(auditTrail);

      hook.onAgentDisconnected("agent-disconnect", "client closed connection");

      const audit = auditTrail.getAgentAudit("agent-disconnect");
      assert.ok(audit);
      assert.strictEqual(audit.records.length, 1);
      assert.strictEqual(audit.records[0].result.type, "ipc_disconnect");
      assert.strictEqual(audit.records[0].result.reason, "client closed connection");
      assert.ok(audit.records[0].result.timestamp);
    });

    it("should handle missing reason gracefully", () => {
      const hook = createAuditHook(auditTrail);

      hook.onAgentDisconnected("agent-l", null);

      const audit = auditTrail.getAgentAudit("agent-l");
      assert.ok(audit);
      assert.strictEqual(audit.records[0].result.reason, "unknown");
    });

    it("should not throw on audit errors", () => {
      const invalidAuditTrail = {
        recordResult: () => {
          throw new Error("Disconnect audit failure");
        },
      };

      const hook = createAuditHook(invalidAuditTrail);

      assert.doesNotThrow(() => {
        hook.onAgentDisconnected("agent-m", "error");
      });
    });
  });

  describe("getAuditStats", () => {
    it("should return empty stats for new audit trail", () => {
      const stats = getAuditStats(auditTrail);

      assert.strictEqual(stats.totalMessages, 0);
      assert.deepStrictEqual(stats.byType, {});
      assert.deepStrictEqual(stats.byAgent, {});
    });

    it("should aggregate stats from multiple agents", () => {
      const hook = createAuditHook(auditTrail);

      // Agent 1: 2 messages
      hook.onMessageReceived({ type: "PUBLISH", from: "agent-1" }, {});
      hook.onMessageReceived({ type: "REQUEST", from: "agent-1" }, {});

      // Agent 2: 3 messages
      hook.onMessageReceived({ type: "PUBLISH", from: "agent-2" }, {});
      hook.onMessageReceived({ type: "PUBLISH", from: "agent-2" }, {});
      hook.onAgentConnected("agent-2", {});

      const stats = getAuditStats(auditTrail);

      assert.strictEqual(stats.totalMessages, 5);
      assert.strictEqual(stats.byAgent["agent-1"], 2);
      assert.strictEqual(stats.byAgent["agent-2"], 3);
    });

    it("should count messages by type", () => {
      const hook = createAuditHook(auditTrail);

      hook.onMessageReceived({ type: "PUBLISH", from: "agent-x" }, {});
      hook.onMessageReceived({ type: "PUBLISH", from: "agent-x" }, {});
      hook.onMessageReceived({ type: "REQUEST", from: "agent-x" }, {});
      hook.onAgentConnected("agent-x", {});
      hook.onAgentDisconnected("agent-x", "done");

      const stats = getAuditStats(auditTrail);

      assert.strictEqual(stats.byType.ipc_message, 3); // 2 PUBLISH + 1 REQUEST
      assert.strictEqual(stats.byType.ipc_connect, 1);
      assert.strictEqual(stats.byType.ipc_disconnect, 1);
    });

    it("should handle missing audit files gracefully", () => {
      // Create empty audit directory
      const emptyDir = join(tmpdir(), `empty-audit-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
      const emptyAudit = new AuditTrail(emptyDir);

      const stats = getAuditStats(emptyAudit);

      assert.strictEqual(stats.totalMessages, 0);

      // Cleanup
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("should skip invalid audit files", () => {
      const hook = createAuditHook(auditTrail);

      // Create valid record
      hook.onMessageReceived({ type: "PUBLISH", from: "valid-agent" }, {});

      // Manually create corrupted audit file
      const corruptPath = join(auditTrail.getAuditDir(), "corrupt.json");
      writeFileSync(corruptPath, "invalid json {{{", "utf-8");

      const stats = getAuditStats(auditTrail);

      // Should still count the valid agent
      assert.ok(stats.totalMessages > 0);
      assert.ok(stats.byAgent["valid-agent"]);
    });
  });

  describe("Integration: Full lifecycle", () => {
    it("should capture complete agent communication lifecycle", () => {
      const hook = createAuditHook(auditTrail, {
        captureContent: true,
        redactPatterns: [/password:\s*"[^"]+"/gi],
      });

      // 1. Agent connects
      hook.onAgentConnected("lifecycle-agent", { remoteAddress: "127.0.0.1" });

      // 2. Agent sends messages
      hook.onMessageReceived(
        {
          type: "PUBLISH",
          from: "lifecycle-agent",
          topic: "status",
          payload: { status: "ready" },
        },
        {}
      );

      hook.onMessageReceived(
        {
          type: "REQUEST",
          from: "lifecycle-agent",
          to: "other-agent",
          payload: { action: "authenticate", password: "secret123" },
        },
        {}
      );

      // 3. Agent disconnects
      hook.onAgentDisconnected("lifecycle-agent", "task completed");

      // Verify complete audit trail
      const audit = auditTrail.getAgentAudit("lifecycle-agent");
      assert.strictEqual(audit.records.length, 4);

      // Check connection
      assert.strictEqual(audit.records[0].invocation.type, "ipc_connect");

      // Check messages
      assert.strictEqual(audit.records[1].invocation.type, "ipc_message");
      assert.strictEqual(audit.records[1].invocation.messageType, "PUBLISH");

      assert.strictEqual(audit.records[2].invocation.type, "ipc_message");
      assert.strictEqual(audit.records[2].invocation.messageType, "REQUEST");
      // Verify password was redacted
      const payloadStr = JSON.stringify(audit.records[2].invocation.payload);
      assert.ok(payloadStr.includes("[REDACTED]"));
      assert.ok(!payloadStr.includes("secret123"));

      // Check disconnection
      assert.strictEqual(audit.records[3].result.type, "ipc_disconnect");
      assert.strictEqual(audit.records[3].result.reason, "task completed");

      // Verify stats
      const stats = getAuditStats(auditTrail);
      assert.strictEqual(stats.totalMessages, 4);
      assert.strictEqual(stats.byAgent["lifecycle-agent"], 4);
    });
  });
});

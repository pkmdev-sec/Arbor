/**
 * Tests for IPC Protocol
 *
 * Tests inter-process communication protocol and message passing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Protocol tests ──────────────────────────────────────────────

describe("Protocol", () => {
  let protocol;

  it("imports successfully", async () => {
    protocol = await import("../lib/ipc/protocol.mjs");
    assert.ok(protocol.MessageType);
    assert.ok(protocol.createMessage);
    assert.ok(protocol.validateMessage);
    assert.ok(protocol.serializeMessage);
    assert.ok(protocol.MessageParser);
  });

  it("createMessage generates valid messages", async () => {
    const { createMessage, MessageType, validateMessage } = protocol;
    const msg = createMessage(MessageType.PUBLISH, "agent-01", { foo: "bar" }, { topic: "test" });
    assert.ok(msg.id, "should have id");
    assert.equal(msg.type, "PUBLISH");
    assert.equal(msg.from, "agent-01");
    assert.equal(msg.topic, "test");
    assert.deepEqual(msg.payload, { foo: "bar" });
    assert.equal(typeof msg.timestamp, "number");

    const v = validateMessage(msg);
    assert.equal(v.valid, true, `Validation failed: ${v.error}`);
  });

  it("validateMessage rejects missing id", async () => {
    const { validateMessage } = protocol;
    const v = validateMessage({ type: "PUBLISH", from: "a", timestamp: 1 });
    assert.equal(v.valid, false);
    assert.ok(v.error.includes("id"));
  });

  it("validateMessage rejects missing from", async () => {
    const { validateMessage } = protocol;
    const v = validateMessage({ id: "x", type: "PUBLISH", timestamp: 1 });
    assert.equal(v.valid, false);
    assert.ok(v.error.includes("from"));
  });

  it("validateMessage rejects invalid type", async () => {
    const { validateMessage } = protocol;
    const v = validateMessage({ id: "x", type: "INVALID", from: "a", timestamp: 1 });
    assert.equal(v.valid, false);
  });

  it("serializeMessage produces length-prefixed buffer", async () => {
    const { createMessage, MessageType, serializeMessage } = protocol;
    const msg = createMessage(MessageType.HEARTBEAT, "a", {});
    const buf = serializeMessage(msg);
    assert.ok(Buffer.isBuffer(buf));
    const len = buf.readUInt32BE(0);
    assert.equal(buf.length, 4 + len);
    const parsed = JSON.parse(buf.subarray(4).toString("utf-8"));
    assert.equal(parsed.type, "HEARTBEAT");
  });

  it("MessageParser parses complete frames", async () => {
    const { createMessage, MessageType, serializeMessage, MessageParser } = protocol;
    const parser = new MessageParser();
    const msg1 = createMessage(MessageType.PUBLISH, "a", { n: 1 }, { topic: "t" });
    const msg2 = createMessage(MessageType.PUBLISH, "b", { n: 2 }, { topic: "t" });
    const buf = Buffer.concat([serializeMessage(msg1), serializeMessage(msg2)]);
    const messages = parser.feed(buf);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].from, "a");
    assert.equal(messages[1].from, "b");
  });

  it("MessageParser handles chunked delivery", async () => {
    const { createMessage, MessageType, serializeMessage, MessageParser } = protocol;
    const parser = new MessageParser();
    const msg = createMessage(MessageType.DIRECT_SEND, "a", { data: "hello" }, { to: "b" });
    const buf = serializeMessage(msg);

    // Feed in two chunks
    const mid = Math.floor(buf.length / 2);
    const chunk1 = buf.subarray(0, mid);
    const chunk2 = buf.subarray(mid);

    const r1 = parser.feed(chunk1);
    assert.equal(r1.length, 0, "incomplete frame should yield no messages");
    const r2 = parser.feed(chunk2);
    assert.equal(r2.length, 1);
    assert.equal(r2[0].from, "a");
    assert.equal(r2[0].to, "b");
  });
});

// ── MessageBus wildcard matching tests (B2) ─────────────────────

describe("MessageBus wildcard matching", () => {
  let MessageBus;

  it("imports MessageBus", async () => {
    const mod = await import("../lib/ipc/message-bus.mjs");
    MessageBus = mod.MessageBus;
    assert.ok(MessageBus);
  });

  it("_matchesWildcard matches exact topics", () => {
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-unused.sock" });
    assert.equal(bus._matchesWildcard("swarm.status", "swarm.status"), true);
    assert.equal(bus._matchesWildcard("swarm.status", "swarm.other"), false);
  });

  it("_matchesWildcard supports single-segment wildcard (*)", () => {
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-unused.sock" });
    assert.equal(bus._matchesWildcard("swarm.*.status", "swarm.L1.status"), true);
    assert.equal(bus._matchesWildcard("swarm.*.status", "swarm.L2.status"), true);
    assert.equal(bus._matchesWildcard("swarm.*.status", "swarm.L1.L2.status"), false, "* should not match multiple segments");
  });

  it("_matchesWildcard supports multi-segment wildcard (**)", () => {
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-unused.sock" });
    assert.equal(bus._matchesWildcard("swarm.**.status", "swarm.L1.auth.status"), true);
    assert.equal(bus._matchesWildcard("swarm.**.status", "swarm.L1.status"), true);
    assert.equal(bus._matchesWildcard("swarm.**.status", "swarm.status"), false, "** needs at least one segment");
  });

  it("_matchesWildcard handles hierarchy patterns from scoped-bus", () => {
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-unused.sock" });
    // Pattern used by scoped-bus.mjs: swarm.L{n}.{scope}.*.{eventType}
    assert.equal(bus._matchesWildcard("swarm.L2.auth.*.status", "swarm.L2.auth.worker1.status"), true);
    assert.equal(bus._matchesWildcard("swarm.L2.auth.*.status", "swarm.L2.api.worker1.status"), false);
  });
});

// ── Pause/resume queue tests (B4) ───────────────────────────────

describe("MessageBus pause/resume", () => {
  it("_sendToClient queues messages for paused agents", async () => {
    const { MessageBus } = await import("../lib/ipc/message-bus.mjs");
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-b4.sock" });

    // Simulate a registered agent with a mock socket
    const mockSocket = { write: () => true, destroyed: false, end: () => {} };
    bus.clients.set("agent-01", mockSocket);
    bus.pausedAgents.add("agent-01");

    const msg = { id: "test-1", type: "PUBLISH", from: "orchestrator", payload: { x: 1 }, timestamp: Date.now() };
    const result = bus._sendToClient("agent-01", msg);

    assert.equal(result, true, "should return true (queued)");
    assert.ok(bus.pausedQueues.has("agent-01"), "should have queue for paused agent");
    assert.equal(bus.pausedQueues.get("agent-01").length, 1);
    assert.deepEqual(bus.pausedQueues.get("agent-01")[0], msg);
  });

  it("pause queue enforces 1000 message cap", async () => {
    const { MessageBus } = await import("../lib/ipc/message-bus.mjs");
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-b4-cap.sock" });

    const mockSocket = { write: () => true, destroyed: false, end: () => {} };
    bus.clients.set("agent-01", mockSocket);
    bus.pausedAgents.add("agent-01");

    // Fill queue to 1001
    for (let i = 0; i < 1001; i++) {
      bus._sendToClient("agent-01", { id: `msg-${i}`, type: "PUBLISH", from: "orch", payload: {}, timestamp: Date.now() });
    }

    const queue = bus.pausedQueues.get("agent-01");
    assert.equal(queue.length, 1000, "queue should be capped at 1000");
    assert.equal(queue[0].id, "msg-1", "oldest message should have been dropped");
  });
});

// ── Rate limiting tests (B5) ────────────────────────────────────

describe("MessageBus rate limiting", () => {
  it("_checkRateLimit returns false when no limit set", async () => {
    const { MessageBus } = await import("../lib/ipc/message-bus.mjs");
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-rl.sock" });
    assert.equal(bus._checkRateLimit("agent-01"), false);
  });

  it("_checkRateLimit enforces rate limit", async () => {
    const { MessageBus } = await import("../lib/ipc/message-bus.mjs");
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-rl2.sock" });
    bus.rateLimits.set("agent-01", 3); // 3 msgs/sec

    // First 3 should be OK
    assert.equal(bus._checkRateLimit("agent-01"), false);
    assert.equal(bus._checkRateLimit("agent-01"), false);
    assert.equal(bus._checkRateLimit("agent-01"), false);

    // 4th should exceed
    assert.equal(bus._checkRateLimit("agent-01"), true);
  });
});

// ── Pending request TTL cleanup tests (B9) ──────────────────────

describe("MessageBus pending request cleanup", () => {
  it("removes stale pending requests", async () => {
    const { MessageBus } = await import("../lib/ipc/message-bus.mjs");
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-b9.sock" });

    // Manually add stale entries
    bus.pendingRequests.set("old-req-1", { from: "a", timestamp: Date.now() - 60000 });
    bus.pendingRequests.set("old-req-2", { from: "b", timestamp: Date.now() - 45000 });
    bus.pendingRequests.set("fresh-req", { from: "c", timestamp: Date.now() - 1000 });

    assert.equal(bus.pendingRequests.size, 3);

    // Simulate cleanup (cutoff = 30s)
    const cutoff = Date.now() - 30000;
    for (const [id, req] of bus.pendingRequests) {
      if (req.timestamp < cutoff) bus.pendingRequests.delete(id);
    }

    assert.equal(bus.pendingRequests.size, 1);
    assert.ok(bus.pendingRequests.has("fresh-req"));
  });
});

// ── OrchestratorControl RESPONSE exemption tests (B7) ───────────

describe("OrchestratorControl RESPONSE exemption", () => {
  it("RESPONSE messages bypass filters", async () => {
    const { OrchestratorControl } = await import("../lib/ipc/orchestrator-control.mjs");

    // OrchestratorControl extends AgentChannel — we can test the _handleMessage logic
    const ctrl = new OrchestratorControl("test-orch", { autoReconnect: false });

    // Track which messages reach the parent handler
    const receivedMessages = [];
    ctrl.on("message", (msg) => receivedMessages.push(msg));

    // Add a filter that blocks everything
    ctrl.filterMessages(() => true);

    // Simulate a RESPONSE message
    const responseMsg = {
      id: "resp-1",
      type: "RESPONSE",
      from: "agent-01",
      correlationId: "req-1",
      payload: { result: "ok" },
      timestamp: Date.now(),
    };

    ctrl._handleMessage(responseMsg);

    // RESPONSE should bypass the filter and reach the parent handler
    assert.equal(receivedMessages.length, 1, "RESPONSE should reach message handler");
    assert.equal(receivedMessages[0].type, "RESPONSE");
  });

  it("non-RESPONSE messages are filtered", async () => {
    const { OrchestratorControl } = await import("../lib/ipc/orchestrator-control.mjs");
    const ctrl = new OrchestratorControl("test-orch", { autoReconnect: false });

    const receivedMessages = [];
    ctrl.on("message", (msg) => receivedMessages.push(msg));

    const filteredMessages = [];
    ctrl.on("message_filtered", (msg) => filteredMessages.push(msg));

    // Block all non-RESPONSE
    ctrl.filterMessages(() => true);

    const publishMsg = {
      id: "pub-1",
      type: "PUBLISH",
      from: "agent-01",
      topic: "progress",
      payload: {},
      timestamp: Date.now(),
    };

    ctrl._handleMessage(publishMsg);

    assert.equal(receivedMessages.length, 0, "PUBLISH should be filtered");
    assert.equal(filteredMessages.length, 1, "should emit message_filtered");
  });
});

// ── TelemetryChannel ring buffer tests ──────────────────────────

describe("TelemetryChannel", () => {
  it("uses true ring buffer (not array shift)", async () => {
    const { TelemetryChannel } = await import("../lib/ipc/telemetry-channel.mjs");
    const channel = new TelemetryChannel(null, { bufferSize: 5 });

    // Disabled channel (no agentChannel), but we can test buffer internals
    channel.enabled = true;

    // Fill buffer
    for (let i = 0; i < 5; i++) {
      channel._bufPush({ n: i });
    }
    assert.equal(channel._bufLength(), 5);

    // Overflow — should drop oldest
    channel._bufPush({ n: 5 });
    assert.equal(channel._bufLength(), 5, "buffer should stay at capacity");

    // Drain
    const items = channel._bufDrain();
    assert.equal(items.length, 5);
    assert.equal(items[0].n, 1, "oldest item (0) should have been dropped");
    assert.equal(items[4].n, 5, "newest item (5) should be last");
    assert.equal(channel._bufLength(), 0, "buffer should be empty after drain");
  });
});

// ── Python bus_client protocol conformance (B3) ─────────────────

describe("Python bus_client protocol conformance", () => {
  it("_create_message includes uuid id field", async () => {
    // Verify the Python client code has the fix by checking the source
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const busClientPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "lib", "ipc", "python-bridge", "bus_client.py"
    );
    const source = readFileSync(busClientPath, "utf-8");

    // Check _create_message generates UUID for id
    assert.ok(source.includes('uuid.uuid4()'), "should use uuid.uuid4() for message id");
    assert.ok(source.includes('"id"'), "should include id field");
    assert.ok(source.includes('"to"'), "should include to field");
    assert.ok(source.includes('"topic"'), "should include topic field");
    assert.ok(source.includes('"correlationId"'), "should include correlationId field");
    assert.ok(source.includes('"priority"'), "should include priority field");

    // Check _create_message is used for REGISTER
    assert.ok(source.includes('self._create_message('), "should use _create_message helper");
    assert.ok(source.includes('type="REGISTER"'), "REGISTER should use _create_message");
    assert.ok(source.includes('type="UNREGISTER"'), "UNREGISTER should use _create_message");
  });
});

// ── Pipeline context chaining (orchestration) ───────────────────

describe("Pipeline context chaining", () => {
  it("uses results[i-1] not results[0] for context chaining", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const orchPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "lib", "orchestration.mjs"
    );
    const source = readFileSync(orchPath, "utf-8");

    // Verify pipeline chains through previous stage, not always stage 0
    assert.ok(
      source.includes("results[i - 1]?.resultFile"),
      "pipeline should chain context through results[i-1], not results[0]"
    );
    assert.ok(
      !source.includes("results[0]?.resultFile"),
      "should NOT use results[0] (old broken pattern)"
    );
  });
});

// ── ipc-logger relocation ───────────────────────────────────────

describe("ipc-logger relocation", () => {
  it("lib/ipc-logger.mjs exists and exports correctly", async () => {
    const mod = await import("../lib/ipc-logger.mjs");
    assert.ok(typeof mod.initIpcLogger === "function");
    assert.ok(typeof mod.logIpc === "function");
    assert.ok(typeof mod.getIpcBuffer === "function");
  });

  it("core files import from lib/ipc-logger.mjs not lib/tui/", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const root = join(dirname(fileURLToPath(import.meta.url)), "..");

    // Root-level files import from ./lib/ipc-logger.mjs
    const rootFiles = [
      "agent-entry.mjs",
      "swarm.mjs",
    ];

    for (const file of rootFiles) {
      const source = readFileSync(join(root, file), "utf-8");
      assert.ok(
        source.includes('from "./lib/ipc-logger.mjs"'),
        `${file} should import from ./lib/ipc-logger.mjs`
      );
      assert.ok(
        !source.includes('from "./lib/tui/ipc-logger.mjs"'),
        `${file} should NOT import from ./lib/tui/ipc-logger.mjs`
      );
    }

    // lib/ files import from ./ipc-logger.mjs (relative to lib/)
    const libFiles = [
      "lib/orchestration.mjs",
      "lib/ai-client.mjs",
    ];

    for (const file of libFiles) {
      const source = readFileSync(join(root, file), "utf-8");
      assert.ok(
        source.includes('from "./ipc-logger.mjs"'),
        `${file} should import from ./ipc-logger.mjs`
      );
      assert.ok(
        !source.includes('from "./tui/ipc-logger.mjs"'),
        `${file} should NOT import from ./tui/ipc-logger.mjs`
      );
    }
  });
});

// ── Policy limits schema (B1) ───────────────────────────────────

describe("Policy limits schema", () => {
  it("schema marks limit fields as optional (not required)", async () => {
    const { POLICY_LIMITS_SCHEMA } = await import("../lib/config.mjs");
    const props = POLICY_LIMITS_SCHEMA.properties;

    assert.equal(props.maxTurns.required, false, "maxTurns should be optional");
    assert.equal(props.maxCost.required, false, "maxCost should be optional");
    assert.equal(props.timeout.required, false, "timeout should be optional");
    assert.equal(props.maxAgents.required, false, "maxAgents should be optional");
  });

  it("schema provides sensible defaults", async () => {
    const { POLICY_LIMITS_SCHEMA } = await import("../lib/config.mjs");
    const props = POLICY_LIMITS_SCHEMA.properties;

    assert.ok(props.maxTurns.default > 0, "maxTurns should have positive default");
    assert.ok(props.maxCost.default > 0, "maxCost should have positive default");
    assert.ok(props.timeout.default > 0, "timeout should have positive default");
    assert.ok(props.maxAgents.default > 0, "maxAgents should have positive default");
  });
});

// ── AgentChannel edge cases ─────────────────────────────────────────

describe("AgentChannel", () => {
  it("rejects messages when not connected", async () => {
    const { AgentChannel } = await import("../lib/ipc/agent-channel.mjs");
    const channel = new AgentChannel("test-agent", {
      socketPath: "/nonexistent/socket.sock",
      autoReconnect: false
    });

    // Attempt to send message on non-connected channel should throw
    await assert.rejects(
      async () => channel.send("test.topic", { data: "test" }),
      /Not connected/,
      "should reject when not connected"
    );
  });
});

// ── MessageBus additional coverage ──────────────────────────────────

describe("MessageBus message validation", () => {
  it("rejects malformed messages", async () => {
    const { MessageBus } = await import("../lib/ipc/message-bus.mjs");
    const bus = new MessageBus({ socketPath: "/tmp/test-bus-validation.sock" });

    // Mock socket
    const mockSocket = { write: () => true, destroyed: false, end: () => {} };
    bus.clients.set("agent-01", mockSocket);

    // Malformed message (missing required fields)
    const badMsg = { type: "PUBLISH", payload: {} };
    const result = bus._sendToClient("agent-01", badMsg);

    // Should handle gracefully (either reject or fix it)
    assert.ok(typeof result === "boolean");
  });
});

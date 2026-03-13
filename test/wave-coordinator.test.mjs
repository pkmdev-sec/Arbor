/**
 * Tests for WaveCoordinator
 *
 * Uses Node.js built-in test runner (node:test)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import WaveCoordinator, { createWaveCoordinator } from "../lib/ipc/wave-coordinator.mjs";

/**
 * Mock OrchestratorControl for testing
 */
class MockOrchestratorControl {
  constructor() {
    this.subscriptions = new Map(); // topic -> handlers[]
    this.published = []; // Array of {topic, message} for assertions
  }

  subscribe(topic, handler) {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
    }
    this.subscriptions.get(topic).push(handler);
  }

  unsubscribe(topic, handler) {
    if (!this.subscriptions.has(topic)) {
      return;
    }
    const handlers = this.subscriptions.get(topic);
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  async publish(topic, message) {
    this.published.push({ topic, message });

    // Simulate bus broadcasting to subscribers
    const handlers = this.subscriptions.get(topic) || [];
    for (const handler of handlers) {
      // Defer to next tick to simulate async bus delivery
      setImmediate(() => handler(message));
    }
  }

  // Helper: Simulate receiving a message from the bus
  simulateReceive(topic, message) {
    const handlers = this.subscriptions.get(topic) || [];
    for (const handler of handlers) {
      handler(message);
    }
  }

  // Helper: Clear published messages
  clearPublished() {
    this.published = [];
  }
}

describe("WaveCoordinator", () => {
  let mockControl;
  let coordinator;

  beforeEach(() => {
    mockControl = new MockOrchestratorControl();
    coordinator = new WaveCoordinator(mockControl, { maxWaves: 3 });
  });

  describe("constructor", () => {
    it("should throw if orchestratorControl is missing", () => {
      assert.throws(() => {
        new WaveCoordinator(null);
      }, /orchestratorControl is required/);
    });

    it("should initialize with default options", () => {
      const coord = new WaveCoordinator(mockControl);
      assert.strictEqual(coord.maxWaves, 3);
      assert.strictEqual(coord._subscribed, false);
    });

    it("should respect custom maxWaves option", () => {
      const coord = new WaveCoordinator(mockControl, { maxWaves: 5 });
      assert.strictEqual(coord.maxWaves, 5);
    });
  });

  describe("start", () => {
    it("should subscribe to wave topics", async () => {
      await coordinator.start();

      assert.strictEqual(coordinator._subscribed, true);
      assert.ok(mockControl.subscriptions.has("wave.start"));
      assert.ok(mockControl.subscriptions.has("wave.task_complete"));
      assert.ok(mockControl.subscriptions.has("wave.complete"));
    });

    it("should not subscribe twice", async () => {
      await coordinator.start();
      const subCountBefore = mockControl.subscriptions.get("wave.start").length;

      await coordinator.start();
      const subCountAfter = mockControl.subscriptions.get("wave.start").length;

      assert.strictEqual(subCountBefore, subCountAfter);
    });
  });

  describe("startWave", () => {
    it("should broadcast wave start correctly", async () => {
      await coordinator.start();
      mockControl.clearPublished();

      const tasks = [
        { id: "task-1", description: "Task 1" },
        { id: "task-2", description: "Task 2" },
      ];

      await coordinator.startWave(1, tasks);

      assert.strictEqual(mockControl.published.length, 1);
      const pub = mockControl.published[0];
      assert.strictEqual(pub.topic, "wave.start");
      assert.strictEqual(pub.message.waveNumber, 1);
      assert.strictEqual(pub.message.taskCount, 2);
      assert.deepStrictEqual(pub.message.tasks, [
        { id: "task-1", description: "Task 1" },
        { id: "task-2", description: "Task 2" },
      ]);
      assert.ok(pub.message.timestamp);
    });

    it("should initialize wave results storage", async () => {
      await coordinator.start();

      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      assert.ok(coordinator._waveResults.has(1));
      assert.deepStrictEqual(coordinator._waveResults.get(1), []);
    });

    it("should throw if tasks is not an array", async () => {
      await coordinator.start();

      await assert.rejects(async () => {
        await coordinator.startWave(1, "not-an-array");
      }, /tasks must be an array/);
    });

    it("should emit wave.start event to handlers", async () => {
      await coordinator.start();

      let eventReceived = null;
      coordinator.onWaveEvent((event) => {
        eventReceived = event;
      });

      const tasks = [{ id: "t1", description: "Test" }];
      await coordinator.startWave(1, tasks);

      assert.strictEqual(eventReceived.type, "wave.start");
      assert.strictEqual(eventReceived.data.waveNumber, 1);
      assert.strictEqual(eventReceived.data.taskCount, 1);
    });
  });

  describe("reportTaskComplete", () => {
    it("should accumulate results correctly", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      await coordinator.reportTaskComplete("agent-01", 1, {
        summary: "Task completed",
        status: "completed",
        filesChanged: ["src/foo.js"],
      });

      const results = coordinator._waveResults.get(1);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].agentId, "agent-01");
      assert.strictEqual(results[0].summary, "Task completed");
      assert.strictEqual(results[0].status, "completed");
      assert.deepStrictEqual(results[0].filesChanged, ["src/foo.js"]);
    });

    it("should broadcast task completion", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      mockControl.clearPublished();

      await coordinator.reportTaskComplete("agent-01", 1, {
        summary: "Done",
        status: "completed",
        filesChanged: ["file.js"],
      });

      const pub = mockControl.published.find(p => p.topic === "wave.task_complete");
      assert.ok(pub);
      assert.strictEqual(pub.message.waveNumber, 1);
      assert.strictEqual(pub.message.agentId, "agent-01");
      assert.strictEqual(pub.message.result.summary, "Done");
      assert.deepStrictEqual(pub.message.result.filesChanged, ["file.js"]);
    });

    it("should handle multiple task completions", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [
        { id: "t1", description: "Test 1" },
        { id: "t2", description: "Test 2" },
      ]);

      await coordinator.reportTaskComplete("agent-01", 1, { summary: "First" });
      await coordinator.reportTaskComplete("agent-02", 1, { summary: "Second" });

      const results = coordinator._waveResults.get(1);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].agentId, "agent-01");
      assert.strictEqual(results[1].agentId, "agent-02");
    });
  });

  describe("endWave", () => {
    it("should broadcast wave complete with summarized results", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      await coordinator.reportTaskComplete("agent-01", 1, {
        summary: "Done",
        filesChanged: ["file.js"],
      });

      mockControl.clearPublished();
      await coordinator.endWave(1);

      const pub = mockControl.published.find(p => p.topic === "wave.complete");
      assert.ok(pub);
      assert.strictEqual(pub.message.waveNumber, 1);
      assert.strictEqual(pub.message.results.length, 1);
      assert.strictEqual(pub.message.results[0].agentId, "agent-01");
      assert.strictEqual(pub.message.results[0].summary, "Done");
    });

    it("should resolve waitForWave promise", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      const waitPromise = coordinator.waitForWave(1);

      await coordinator.reportTaskComplete("agent-01", 1, { summary: "Done" });
      await coordinator.endWave(1);

      const result = await waitPromise;
      assert.strictEqual(result.waveNumber, 1);
      assert.strictEqual(result.results.length, 1);
    });

    it("should emit wave.complete event", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      let eventReceived = null;
      coordinator.onWaveEvent((event) => {
        if (event.type === "wave.complete") {
          eventReceived = event;
        }
      });

      await coordinator.endWave(1);

      assert.ok(eventReceived);
      assert.strictEqual(eventReceived.data.waveNumber, 1);
    });
  });

  describe("waitForWave", () => {
    it("should return immediately for completed waves", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      await coordinator.reportTaskComplete("agent-01", 1, { summary: "Done" });
      await coordinator.endWave(1);

      // Wave already complete - should resolve immediately
      const result = await coordinator.waitForWave(1);
      assert.strictEqual(result.waveNumber, 1);
      assert.strictEqual(result.results.length, 1);
    });

    it("should wait for wave to complete", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      let resolved = false;
      const waitPromise = coordinator.waitForWave(1).then((result) => {
        resolved = true;
        return result;
      });

      // Should not resolve yet
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(resolved, false);

      // Complete the wave
      await coordinator.reportTaskComplete("agent-01", 1, { summary: "Done" });
      await coordinator.endWave(1);

      // Now should resolve
      const result = await waitPromise;
      assert.strictEqual(resolved, true);
      assert.strictEqual(result.waveNumber, 1);
    });

    it("should support multiple waiters", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      const wait1 = coordinator.waitForWave(1);
      const wait2 = coordinator.waitForWave(1);

      await coordinator.endWave(1);

      const [result1, result2] = await Promise.all([wait1, wait2]);
      assert.strictEqual(result1.waveNumber, 1);
      assert.strictEqual(result2.waveNumber, 1);
    });
  });

  describe("getWaveContext", () => {
    it("should return empty string for non-existent wave", () => {
      const context = coordinator.getWaveContext(99);
      assert.strictEqual(context, "");
    });

    it("should return empty string for wave with no results", async () => {
      await coordinator.start();
      await coordinator.startWave(1, []);
      const context = coordinator.getWaveContext(1);
      assert.strictEqual(context, "");
    });

    it("should format context correctly", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      await coordinator.reportTaskComplete("agent-01", 1, {
        summary: "Found bug in parser",
        status: "completed",
        filesChanged: ["src/parser.js", "src/lexer.js"],
      });

      const context = coordinator.getWaveContext(1);

      assert.ok(context.includes("PRIOR WAVE 1 RESULTS:"));
      assert.ok(context.includes("• Agent agent-01 ✓: Found bug in parser"));
      assert.ok(context.includes("Modified: src/parser.js, src/lexer.js"));
    });

    it("should truncate at 2000 chars", async () => {
      await coordinator.start();
      await coordinator.startWave(1, []);

      // Add many results to exceed limit
      for (let i = 0; i < 50; i++) {
        coordinator._waveResults.get(1).push({
          agentId: `agent-${i}`,
          summary: "A".repeat(100),
          status: "completed",
          filesChanged: [`file${i}.js`],
        });
      }

      const context = coordinator.getWaveContext(1);

      assert.ok(context.length <= 2000);
      assert.ok(context.includes("... (additional results truncated)"));
    });

    it("should handle multiple file changes correctly", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      await coordinator.reportTaskComplete("agent-01", 1, {
        summary: "Refactored",
        filesChanged: ["a.js", "b.js", "c.js", "d.js", "e.js"],
      });

      const context = coordinator.getWaveContext(1);

      assert.ok(context.includes("Modified: a.js, b.js, c.js..."));
    });
  });

  describe("onWaveEvent", () => {
    it("should register and call event handlers", async () => {
      await coordinator.start();

      let events = [];
      coordinator.onWaveEvent((event) => {
        events.push(event);
      });

      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      await coordinator.reportTaskComplete("agent-01", 1, { summary: "Done" });
      await coordinator.endWave(1);

      assert.ok(events.length >= 3);
      assert.strictEqual(events[0].type, "wave.start");
      assert.ok(events.some(e => e.type === "wave.task_complete"));
      assert.ok(events.some(e => e.type === "wave.complete"));
    });

    it("should return unsubscribe function", async () => {
      await coordinator.start();

      let callCount = 0;
      const unsubscribe = coordinator.onWaveEvent(() => {
        callCount++;
      });

      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      assert.strictEqual(callCount, 1);

      unsubscribe();

      await coordinator.startWave(2, [{ id: "t2", description: "Test 2" }]);
      assert.strictEqual(callCount, 1); // Should not increase
    });

    it("should throw if handler is not a function", () => {
      assert.throws(() => {
        coordinator.onWaveEvent("not-a-function");
      }, /handler must be a function/);
    });

    it("should handle handler errors gracefully", async () => {
      await coordinator.start();

      coordinator.onWaveEvent(() => {
        throw new Error("Handler error");
      });

      // Should not throw
      await assert.doesNotReject(async () => {
        await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);
      });
    });
  });

  describe("stop", () => {
    it("should unsubscribe from topics", async () => {
      await coordinator.start();
      assert.strictEqual(coordinator._subscribed, true);

      await coordinator.stop();

      assert.strictEqual(coordinator._subscribed, false);
    });

    it("should reject pending wave promises", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      const waitPromise = coordinator.waitForWave(1);

      await coordinator.stop();

      await assert.rejects(waitPromise, /WaveCoordinator stopped/);
    });

    it("should be idempotent", async () => {
      await coordinator.start();

      await coordinator.stop();
      await coordinator.stop(); // Should not throw
    });
  });

  describe("createWaveCoordinator factory", () => {
    it("should create and start coordinator", async () => {
      const coord = await createWaveCoordinator(mockControl);

      assert.ok(coord instanceof WaveCoordinator);
      assert.strictEqual(coord._subscribed, true);

      await coord.stop();
    });

    it("should pass options correctly", async () => {
      const coord = await createWaveCoordinator(mockControl, { maxWaves: 5 });

      assert.strictEqual(coord.maxWaves, 5);

      await coord.stop();
    });
  });

  describe("remote event handling", () => {
    it("should handle remote wave.start events", async () => {
      await coordinator.start();

      let eventReceived = null;
      coordinator.onWaveEvent((event) => {
        eventReceived = event;
      });

      // Simulate receiving wave.start from remote orchestrator
      mockControl.simulateReceive("wave.start", {
        waveNumber: 2,
        taskCount: 1,
        tasks: [{ id: "remote-task", description: "Remote task" }],
      });

      // Should initialize wave results
      assert.ok(coordinator._waveResults.has(2));
      assert.strictEqual(eventReceived.type, "wave.start");
      assert.strictEqual(eventReceived.data.waveNumber, 2);
    });

    it("should handle remote wave.task_complete events", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      // Simulate remote task completion
      mockControl.simulateReceive("wave.task_complete", {
        waveNumber: 1,
        agentId: "remote-agent",
        result: {
          summary: "Remote completion",
          status: "completed",
          filesChanged: ["remote.js"],
        },
      });

      const results = coordinator._waveResults.get(1);
      const remoteResult = results.find(r => r.agentId === "remote-agent");
      assert.ok(remoteResult);
      assert.strictEqual(remoteResult.summary, "Remote completion");
    });

    it("should handle remote wave.complete events", async () => {
      await coordinator.start();

      const waitPromise = coordinator.waitForWave(3);

      // Simulate remote wave completion
      mockControl.simulateReceive("wave.complete", {
        waveNumber: 3,
        results: [
          { agentId: "remote-agent", summary: "Done", status: "completed", filesChanged: [] },
        ],
      });

      const result = await waitPromise;
      assert.strictEqual(result.waveNumber, 3);
      assert.strictEqual(result.results.length, 1);
    });

    it("should avoid duplicate results from same agent", async () => {
      await coordinator.start();
      await coordinator.startWave(1, [{ id: "t1", description: "Test" }]);

      // Report locally
      await coordinator.reportTaskComplete("agent-01", 1, { summary: "First" });

      // Simulate remote duplicate (might happen due to broadcast echo)
      mockControl.simulateReceive("wave.task_complete", {
        waveNumber: 1,
        agentId: "agent-01",
        result: { summary: "Duplicate", status: "completed", filesChanged: [] },
      });

      const results = coordinator._waveResults.get(1);
      const agent01Results = results.filter(r => r.agentId === "agent-01");
      assert.strictEqual(agent01Results.length, 1);
      assert.strictEqual(agent01Results[0].summary, "First");
    });
  });
});

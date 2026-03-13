/**
 * Tests for CouncilRPC: Distributed council voting via IPC
 *
 * Tests council pattern over RPC including vote collection, timeout handling,
 * and consensus evaluation.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert";
import CouncilRPC, { createCouncilRPC } from "../lib/ipc/council-rpc.mjs";

// ── Mock OrchestratorControl ─────────────────────────────────────

class MockOrchestratorControl {
  constructor() {
    this.requestMock = mock.fn();
  }

  async request(targetAgentId, message, timeout) {
    return this.requestMock(targetAgentId, message, timeout);
  }
}

// ── Test Suite ───────────────────────────────────────────────────

describe("CouncilRPC", () => {
  describe("constructor", () => {
    it("should throw if orchestratorControl is missing", () => {
      assert.throws(
        () => new CouncilRPC(null),
        /orchestratorControl is required/
      );
    });

    it("should accept options and set defaults", () => {
      const control = new MockOrchestratorControl();
      const councilRPC = new CouncilRPC(control, {
        voteTimeout: 10000,
        judgeCount: 5,
        consensusThreshold: 3,
      });

      assert.strictEqual(councilRPC.options.voteTimeout, 10000);
      assert.strictEqual(councilRPC.options.judgeCount, 5);
      assert.strictEqual(councilRPC.options.consensusThreshold, 3);
    });

    it("should use default options when not provided", () => {
      const control = new MockOrchestratorControl();
      const councilRPC = new CouncilRPC(control);

      assert.strictEqual(councilRPC.options.voteTimeout, 30000);
      assert.strictEqual(councilRPC.options.judgeCount, 3);
      assert.strictEqual(councilRPC.options.consensusThreshold, 2);
    });
  });

  describe("shouldReview", () => {
    it("should delegate to internal Council.shouldReview", () => {
      const control = new MockOrchestratorControl();
      const councilRPC = new CouncilRPC(control);

      // Test critical task type
      const task1 = { type: "security", description: "Fix auth bug" };
      const result1 = { filesChanged: [] };
      assert.strictEqual(councilRPC.shouldReview(task1, result1), true);

      // Test large change
      const task2 = { type: "feature", description: "Add feature" };
      const result2 = { filesChanged: new Array(15).fill("file.js") };
      assert.strictEqual(councilRPC.shouldReview(task2, result2), true);

      // Test critical keyword
      const task3 = { type: "bugfix", description: "Critical authentication fix" };
      const result3 = { filesChanged: [] };
      assert.strictEqual(councilRPC.shouldReview(task3, result3), true);

      // Test non-critical task
      const task4 = { type: "docs", description: "Update README" };
      const result4 = { filesChanged: ["README.md"] };
      assert.strictEqual(councilRPC.shouldReview(task4, result4), false);
    });
  });

  describe("conductReview", () => {
    it("should throw if not enough judge agents provided", async () => {
      const control = new MockOrchestratorControl();
      const councilRPC = new CouncilRPC(control, { judgeCount: 3 });

      const task = { description: "Test task", type: "feature" };
      const result = { output: "Done", filesChanged: ["file.js"] };
      const judges = ["judge-01", "judge-02"]; // Only 2 judges

      await assert.rejects(
        async () => await councilRPC.conductReview(task, result, judges),
        /Not enough judge agents: need 3, got 2/
      );
    });

    it("should send RPC requests to all judges", async () => {
      const control = new MockOrchestratorControl();
      control.requestMock.mock.mockImplementation(async (targetAgentId, message, timeout) => {
        return {
          verdict: "APPROVE",
          confidence: 0.9,
          concerns: [],
        };
      });

      const councilRPC = new CouncilRPC(control, { judgeCount: 3 });

      const task = { description: "Test task", type: "feature" };
      const result = { output: "Done", filesChanged: ["file.js"] };
      const judges = ["judge-01", "judge-02", "judge-03"];

      const review = await councilRPC.conductReview(task, result, judges);

      // Should have called request 3 times (once per judge)
      assert.strictEqual(control.requestMock.mock.callCount(), 3);

      // Check that each judge received the correct message
      const calls = control.requestMock.mock.calls;
      assert.strictEqual(calls[0].arguments[0], "judge-01");
      assert.strictEqual(calls[1].arguments[0], "judge-02");
      assert.strictEqual(calls[2].arguments[0], "judge-03");

      // Check message structure
      for (const call of calls) {
        const message = call.arguments[1];
        assert.strictEqual(message.type, "council_vote_request");
        assert.ok(message.role);
        assert.ok(message.prompt);
        assert.ok(message.task);
        assert.ok(message.timestamp);
      }
    });

    it("should collect and evaluate verdicts correctly", async () => {
      const control = new MockOrchestratorControl();
      const mockVerdicts = [
        { verdict: "APPROVE", confidence: 0.9, concerns: [] },
        { verdict: "APPROVE", confidence: 0.85, concerns: [] },
        { verdict: "NEEDS_WORK", confidence: 0.7, concerns: ["Minor issue"] },
      ];

      control.requestMock.mock.mockImplementation(async (targetAgentId, message, timeout) => {
        const index = targetAgentId === "judge-01" ? 0 : targetAgentId === "judge-02" ? 1 : 2;
        return mockVerdicts[index];
      });

      const councilRPC = new CouncilRPC(control, {
        judgeCount: 3,
        consensusThreshold: 2
      });

      const task = { description: "Test task", type: "feature" };
      const result = { output: "Done", filesChanged: ["file.js"] };
      const judges = ["judge-01", "judge-02", "judge-03"];

      const review = await councilRPC.conductReview(task, result, judges);

      // Should reach consensus with 2/3 approvals
      assert.strictEqual(review.consensus, "approved");
      assert.strictEqual(review.votes.length, 3);
      assert.strictEqual(review.meta.judgeCount, 3);
      assert.strictEqual(review.meta.responded, 3);
      assert.strictEqual(review.meta.timedOut, 0);
      assert.ok(review.meta.duration >= 0);
    });

    it("should handle timeouts gracefully with Promise.allSettled", async () => {
      const control = new MockOrchestratorControl();
      control.requestMock.mock.mockImplementation(async (targetAgentId, message, timeout) => {
        if (targetAgentId === "judge-02") {
          // Simulate timeout
          throw new Error("Request timeout after 30000ms");
        }
        return {
          verdict: "APPROVE",
          confidence: 0.9,
          concerns: [],
        };
      });

      const councilRPC = new CouncilRPC(control, { judgeCount: 3 });

      const task = { description: "Test task", type: "feature" };
      const result = { output: "Done", filesChanged: ["file.js"] };
      const judges = ["judge-01", "judge-02", "judge-03"];

      const review = await councilRPC.conductReview(task, result, judges);

      // Should have 3 votes even with timeout
      assert.strictEqual(review.votes.length, 3);
      assert.strictEqual(review.meta.responded, 2);
      assert.strictEqual(review.meta.timedOut, 1);

      // Timed out judge should have REJECT verdict
      const timedOutVote = review.votes[1]; // judge-02 is index 1
      assert.strictEqual(timedOutVote.verdict, "REJECT");
      assert.strictEqual(timedOutVote.confidence, 0.0);
      assert.ok(timedOutVote.concerns.some(c => c.includes("timed out") || c.includes("failed")));
    });

    it("should reject when no judges approve", async () => {
      const control = new MockOrchestratorControl();
      control.requestMock.mock.mockImplementation(async (targetAgentId, message, timeout) => {
        return {
          verdict: "REJECT",
          confidence: 0.8,
          concerns: ["Implementation has bugs"],
        };
      });

      const councilRPC = new CouncilRPC(control, { judgeCount: 3 });

      const task = { description: "Test task", type: "feature" };
      const result = { output: "Done", filesChanged: ["file.js"] };
      const judges = ["judge-01", "judge-02", "judge-03"];

      const review = await councilRPC.conductReview(task, result, judges);

      assert.strictEqual(review.consensus, "rejected");
      assert.strictEqual(review.votes.length, 3);
      assert.ok(review.concerns.length > 0);
    });

    it("should handle invalid vote responses", async () => {
      const control = new MockOrchestratorControl();
      control.requestMock.mock.mockImplementation(async (targetAgentId, message, timeout) => {
        if (targetAgentId === "judge-01") {
          return {}; // Invalid: no verdict
        }
        return {
          verdict: "APPROVE",
          confidence: 0.9,
          concerns: [],
        };
      });

      const councilRPC = new CouncilRPC(control, { judgeCount: 3 });

      const task = { description: "Test task", type: "feature" };
      const result = { output: "Done", filesChanged: ["file.js"] };
      const judges = ["judge-01", "judge-02", "judge-03"];

      const review = await councilRPC.conductReview(task, result, judges);

      // Should treat invalid response as failure
      assert.strictEqual(review.meta.timedOut, 1); // Invalid response counted as timeout/failure
      assert.strictEqual(review.meta.responded, 2);
    });
  });

  describe("createVoteHandler", () => {
    it("should return null for non-council messages", async () => {
      const reviewFn = mock.fn();
      const handler = CouncilRPC.createVoteHandler(reviewFn);

      const message = { type: "other_message", data: "test" };
      const result = await handler(message);

      assert.strictEqual(result, null);
      assert.strictEqual(reviewFn.mock.callCount(), 0);
    });

    it("should process council vote requests correctly", async () => {
      const reviewFn = mock.fn(async (role, prompt) => {
        return {
          verdict: "APPROVE",
          confidence: 0.95,
          concerns: [],
        };
      });

      const handler = CouncilRPC.createVoteHandler(reviewFn);

      const message = {
        type: "council_vote_request",
        role: "correctness",
        prompt: "Review this code...",
      };

      const result = await handler(message);

      assert.strictEqual(reviewFn.mock.callCount(), 1);
      assert.strictEqual(reviewFn.mock.calls[0].arguments[0], "correctness");
      assert.strictEqual(reviewFn.mock.calls[0].arguments[1], "Review this code...");

      assert.strictEqual(result.verdict, "APPROVE");
      assert.strictEqual(result.confidence, 0.95);
      assert.deepStrictEqual(result.concerns, []);
    });

    it("should handle missing role or prompt", async () => {
      const reviewFn = mock.fn();
      const handler = CouncilRPC.createVoteHandler(reviewFn);

      const message1 = {
        type: "council_vote_request",
        prompt: "Review this...",
        // Missing role
      };

      const result1 = await handler(message1);
      assert.strictEqual(result1.verdict, "REJECT");
      assert.ok(result1.concerns.some(c => c.includes("missing role or prompt")));

      const message2 = {
        type: "council_vote_request",
        role: "correctness",
        // Missing prompt
      };

      const result2 = await handler(message2);
      assert.strictEqual(result2.verdict, "REJECT");
      assert.ok(result2.concerns.some(c => c.includes("missing role or prompt")));

      assert.strictEqual(reviewFn.mock.callCount(), 0);
    });

    it("should handle review function errors", async () => {
      const reviewFn = mock.fn(async (role, prompt) => {
        throw new Error("Review failed");
      });

      const handler = CouncilRPC.createVoteHandler(reviewFn);

      const message = {
        type: "council_vote_request",
        role: "correctness",
        prompt: "Review this code...",
      };

      const result = await handler(message);

      assert.strictEqual(result.verdict, "REJECT");
      assert.strictEqual(result.confidence, 0.0);
      assert.ok(result.concerns.some(c => c.includes("Review failed")));
    });

    it("should handle invalid review function results", async () => {
      const reviewFn = mock.fn(async (role, prompt) => {
        return {}; // Invalid: no verdict
      });

      const handler = CouncilRPC.createVoteHandler(reviewFn);

      const message = {
        type: "council_vote_request",
        role: "correctness",
        prompt: "Review this code...",
      };

      const result = await handler(message);

      assert.strictEqual(result.verdict, "REJECT");
      assert.ok(result.concerns.some(c => c.includes("invalid result")));
    });

    it("should use default confidence if not provided", async () => {
      const reviewFn = mock.fn(async (role, prompt) => {
        return {
          verdict: "NEEDS_WORK",
          concerns: ["Minor issue"],
          // No confidence
        };
      });

      const handler = CouncilRPC.createVoteHandler(reviewFn);

      const message = {
        type: "council_vote_request",
        role: "quality",
        prompt: "Review this code...",
      };

      const result = await handler(message);

      assert.strictEqual(result.verdict, "NEEDS_WORK");
      assert.strictEqual(result.confidence, 0.5); // Default
      assert.deepStrictEqual(result.concerns, ["Minor issue"]);
    });
  });

  describe("createCouncilRPC factory", () => {
    it("should create and return a CouncilRPC instance", () => {
      const control = new MockOrchestratorControl();
      const councilRPC = createCouncilRPC(control, {
        judgeCount: 5,
        consensusThreshold: 3,
      });

      assert.ok(councilRPC instanceof CouncilRPC);
      assert.strictEqual(councilRPC.options.judgeCount, 5);
      assert.strictEqual(councilRPC.options.consensusThreshold, 3);
    });
  });
});

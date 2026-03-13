/**
 * Tests for Hierarchy Governor
 *
 * Tests resource limit enforcement and hierarchical swarm governance.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ResourceGovernor, GovernorLimitError } from "../lib/hierarchy/governor.mjs";

// ── GovernorLimitError ───────────────────────────────────────────────

describe("GovernorLimitError", () => {
  it("is an instance of Error", () => {
    const err = new GovernorLimitError("test", "agents", 10, 10);
    assert.ok(err instanceof Error);
  });

  it("has correct name", () => {
    const err = new GovernorLimitError("test", "agents", 10, 10);
    assert.equal(err.name, "GovernorLimitError");
  });

  it("stores limitType, current, and maximum", () => {
    const err = new GovernorLimitError("msg", "concurrent", 5, 10);
    assert.equal(err.limitType, "concurrent");
    assert.equal(err.current, 5);
    assert.equal(err.maximum, 10);
    assert.equal(err.message, "msg");
  });

  it("has a stack trace", () => {
    const err = new GovernorLimitError("test", "memory", 4096, 4096);
    assert.ok(err.stack.includes("GovernorLimitError"));
  });
});

// ── ResourceGovernor: constructor ────────────────────────────────────

describe("ResourceGovernor constructor", () => {
  it("creates with default config", () => {
    const gov = new ResourceGovernor();
    assert.equal(gov.config.maxTotalAgents, 20);
    assert.equal(gov.config.maxConcurrentAgents, 10);
    assert.equal(gov.config.maxWorktrees, 15);
    assert.equal(gov.config.maxMemoryMB, 4096);
    assert.equal(gov.config.costPerAgentTurn, 0.03);
  });

  it("merges custom config with defaults", () => {
    const gov = new ResourceGovernor({ maxTotalAgents: 50, maxMemoryMB: 8192 });
    assert.equal(gov.config.maxTotalAgents, 50);
    assert.equal(gov.config.maxConcurrentAgents, 10); // default preserved
    assert.equal(gov.config.maxMemoryMB, 8192);
  });

  it("initializes counters to zero", () => {
    const gov = new ResourceGovernor();
    assert.equal(gov.totalSpawned, 0);
    assert.equal(gov.totalCompleted, 0);
    assert.equal(gov.totalFailed, 0);
    assert.equal(gov.totalCost, 0);
    assert.equal(gov.activeAgents.size, 0);
    assert.equal(gov.worktrees.size, 0);
    assert.equal(gov.active, false);
  });
});

// ── ResourceGovernor: requestBudget ──────────────────────────────────

describe("ResourceGovernor.requestBudget", () => {
  let gov;

  beforeEach(() => {
    gov = new ResourceGovernor({ maxTotalAgents: 10, maxConcurrentAgents: 5, maxWorktrees: 8 });
  });

  it("approves a budget within limits", () => {
    const result = gov.requestBudget("coord-1", 3, 1);
    assert.equal(result.approved, true);
    assert.equal(result.granted, 3);
    assert.ok(result.remaining >= 0);
  });

  it("partially approves when request exceeds concurrent limit", () => {
    const result = gov.requestBudget("coord-1", 8, 1);
    assert.equal(result.approved, true);
    assert.equal(result.granted, 5); // maxConcurrentAgents = 5
    assert.equal(result.reduced, true);
  });

  it("denies when total agent limit reached", () => {
    // Exhaust total agent limit
    for (let i = 0; i < 10; i++) {
      gov.registerAgent({ id: `a${i}`, level: 2, scope: "test" });
    }
    // Deregister all so concurrent is free but totalSpawned = 10
    for (let i = 0; i < 10; i++) {
      gov.deregisterAgent(`a${i}`, { status: "completed", turns: 1 });
    }

    const result = gov.requestBudget("coord-1", 1, 1);
    assert.equal(result.approved, false);
    assert.equal(result.granted, 0);
    assert.ok(result.reason.includes("Total agent limit"));
  });

  it("denies when concurrent limit reached", () => {
    for (let i = 0; i < 5; i++) {
      gov.registerAgent({ id: `a${i}`, level: 2, scope: "test" });
    }

    const result = gov.requestBudget("coord-1", 1, 1);
    assert.equal(result.approved, false);
    assert.equal(result.granted, 0);
    assert.ok(result.reason.includes("Concurrent"));
  });

  it("denies when worktree limit reached", () => {
    const gov2 = new ResourceGovernor({ maxTotalAgents: 100, maxConcurrentAgents: 50, maxWorktrees: 2 });
    gov2.registerAgent({ id: "a1", level: 1, scope: "s", worktreePath: "/wt/1" });
    gov2.registerAgent({ id: "a2", level: 1, scope: "s", worktreePath: "/wt/2" });

    const result = gov2.requestBudget("coord-1", 1, 1);
    assert.equal(result.approved, false);
    assert.ok(result.reason.includes("Worktree"));
  });

  it("rejects when grantable is below minimumRequired", () => {
    // 4 active agents, maxConcurrent = 5, so only 1 slot available
    for (let i = 0; i < 4; i++) {
      gov.registerAgent({ id: `a${i}`, level: 2, scope: "test" });
    }

    // Request 3 with minimum 2 — only 1 available
    const result = gov.requestBudget("coord-1", 3, 1, 2);
    assert.equal(result.approved, false);
    assert.ok(result.reason.includes("below minimum required"));
  });

  it("throws on invalid requesterId", () => {
    assert.throws(() => gov.requestBudget("", 1, 0), { name: "TypeError" });
    assert.throws(() => gov.requestBudget(null, 1, 0), { name: "TypeError" });
  });

  it("throws on invalid agentCount", () => {
    assert.throws(() => gov.requestBudget("c1", 0, 0), { name: "TypeError" });
    assert.throws(() => gov.requestBudget("c1", -1, 0), { name: "TypeError" });
  });

  it("creates a reservation after approval", () => {
    gov.requestBudget("coord-1", 3, 1);
    assert.ok(gov.reservations.has("coord-1"));
    assert.equal(gov.reservations.get("coord-1").reserved, 3);
  });
});

// ── ResourceGovernor: releaseBudget ──────────────────────────────────

describe("ResourceGovernor.releaseBudget", () => {
  let gov;

  beforeEach(() => {
    gov = new ResourceGovernor();
  });

  it("releases reserved slots", () => {
    gov.requestBudget("coord-1", 3, 1);
    gov.releaseBudget("coord-1", 2);
    assert.equal(gov.reservations.get("coord-1").reserved, 1);
  });

  it("removes reservation when all released", () => {
    gov.requestBudget("coord-1", 3, 1);
    gov.releaseBudget("coord-1", 3);
    assert.ok(!gov.reservations.has("coord-1"));
  });

  it("handles release for unknown requester gracefully", () => {
    // Should not throw
    gov.releaseBudget("unknown-id", 1);
  });

  it("throws on invalid inputs", () => {
    assert.throws(() => gov.releaseBudget("", 1), { name: "TypeError" });
    assert.throws(() => gov.releaseBudget("c1", 0), { name: "TypeError" });
  });
});

// ── ResourceGovernor: registerAgent / deregisterAgent ────────────────

describe("ResourceGovernor.registerAgent", () => {
  let gov;

  beforeEach(() => {
    gov = new ResourceGovernor();
  });

  it("registers an agent and increments totalSpawned", () => {
    gov.registerAgent({ id: "w-1", level: 2, scope: "auth" });
    assert.equal(gov.activeAgents.size, 1);
    assert.equal(gov.totalSpawned, 1);
  });

  it("tracks worktree path", () => {
    gov.registerAgent({ id: "w-1", level: 2, scope: "auth", worktreePath: "/tmp/wt1" });
    assert.ok(gov.worktrees.has("/tmp/wt1"));
  });

  it("consumes parent reservation on register", () => {
    gov.requestBudget("coord-1", 3, 1);
    assert.equal(gov.reservations.get("coord-1").reserved, 3);

    gov.registerAgent({ id: "w-1", level: 2, scope: "auth", parentId: "coord-1" });
    assert.equal(gov.reservations.get("coord-1").reserved, 2);
  });

  it("throws on missing id", () => {
    assert.throws(() => gov.registerAgent({ level: 2, scope: "s" }), { name: "TypeError" });
  });

  it("throws on invalid level", () => {
    assert.throws(() => gov.registerAgent({ id: "w", level: -1, scope: "s" }), { name: "TypeError" });
  });

  it("throws on missing scope", () => {
    assert.throws(() => gov.registerAgent({ id: "w", level: 0 }), { name: "TypeError" });
  });
});

describe("ResourceGovernor.deregisterAgent", () => {
  let gov;

  beforeEach(() => {
    gov = new ResourceGovernor();
    gov.registerAgent({ id: "w-1", level: 2, scope: "auth" });
  });

  it("removes agent and increments totalCompleted", () => {
    gov.deregisterAgent("w-1", { status: "completed", turns: 5 });
    assert.equal(gov.activeAgents.size, 0);
    assert.equal(gov.totalCompleted, 1);
    assert.equal(gov.totalFailed, 0);
  });

  it("increments totalFailed for failed agents", () => {
    gov.deregisterAgent("w-1", { status: "failed", turns: 2 });
    assert.equal(gov.totalFailed, 1);
    assert.equal(gov.totalCompleted, 0);
  });

  it("accumulates cost based on turns", () => {
    gov.deregisterAgent("w-1", { status: "completed", turns: 10 });
    // 10 turns * 0.03 costPerAgentTurn = 0.30
    assert.equal(gov.totalCost, 0.30);
  });

  it("auto-releases budget for crashed agent", () => {
    const gov2 = new ResourceGovernor();
    gov2.requestBudget("coord-1", 3, 1);
    gov2.registerAgent({ id: "coord-1", level: 1, scope: "main" });

    // coord-1 still has reservation slots — deregistering should auto-release
    gov2.deregisterAgent("coord-1", { status: "failed", turns: 0 });
    assert.ok(!gov2.reservations.has("coord-1"), "Reservation should be auto-released");
  });

  it("handles deregistering unknown agent gracefully", () => {
    gov.deregisterAgent("nonexistent");
    // Should not throw
    assert.equal(gov.totalCompleted, 0);
  });

  it("throws on invalid agentId", () => {
    assert.throws(() => gov.deregisterAgent(""), { name: "TypeError" });
  });
});

// ── ResourceGovernor: getUtilization ─────────────────────────────────

describe("ResourceGovernor.getUtilization", () => {
  it("returns correct snapshot", () => {
    const gov = new ResourceGovernor();
    gov.registerAgent({ id: "w-1", level: 1, scope: "auth" });
    gov.registerAgent({ id: "w-2", level: 2, scope: "api" });

    const util = gov.getUtilization();

    assert.equal(util.activeAgents, 2);
    assert.equal(util.totalSpawned, 2);
    assert.equal(util.totalCompleted, 0);
    assert.equal(util.totalFailed, 0);
    assert.equal(util.estimatedMemoryMB, 2 * 256); // 256MB per agent
    assert.equal(typeof util.estimatedCost, "number");
  });

  it("provides per-level breakdown", () => {
    const gov = new ResourceGovernor();
    gov.registerAgent({ id: "c1", level: 0, scope: "root" });
    gov.registerAgent({ id: "w1", level: 1, scope: "lib" });
    gov.registerAgent({ id: "w2", level: 1, scope: "test" });

    const util = gov.getUtilization();

    assert.equal(util.byLevel.get(0).active, 1);
    assert.equal(util.byLevel.get(1).active, 2);
  });
});

// ── ResourceGovernor: enforceLimit ───────────────────────────────────

describe("ResourceGovernor.enforceLimit", () => {
  it("passes when under all limits", () => {
    const gov = new ResourceGovernor();
    // Should not throw
    gov.enforceLimit("spawn worker");
  });

  it("throws GovernorLimitError when total agents exceeded", () => {
    const gov = new ResourceGovernor({ maxTotalAgents: 2, maxConcurrentAgents: 100, maxWorktrees: 100 });
    gov.registerAgent({ id: "a1", level: 0, scope: "s" });
    gov.registerAgent({ id: "a2", level: 0, scope: "s" });

    assert.throws(() => gov.enforceLimit("spawn more"), (err) => {
      assert.ok(err instanceof GovernorLimitError);
      assert.equal(err.limitType, "agents");
      return true;
    });
  });

  it("throws GovernorLimitError when concurrent agents exceeded", () => {
    const gov = new ResourceGovernor({ maxTotalAgents: 100, maxConcurrentAgents: 2, maxWorktrees: 100 });
    gov.registerAgent({ id: "a1", level: 0, scope: "s" });
    gov.registerAgent({ id: "a2", level: 0, scope: "s" });

    assert.throws(() => gov.enforceLimit("spawn more"), (err) => {
      assert.ok(err instanceof GovernorLimitError);
      assert.equal(err.limitType, "concurrent");
      return true;
    });
  });

  it("throws GovernorLimitError when worktree limit exceeded", () => {
    const gov = new ResourceGovernor({ maxTotalAgents: 100, maxConcurrentAgents: 100, maxWorktrees: 1 });
    gov.registerAgent({ id: "a1", level: 0, scope: "s", worktreePath: "/wt/1" });

    assert.throws(() => gov.enforceLimit("spawn more"), (err) => {
      assert.ok(err instanceof GovernorLimitError);
      assert.equal(err.limitType, "worktrees");
      return true;
    });
  });

  it("throws GovernorLimitError when memory limit exceeded", () => {
    // 256MB per agent; limit at 300MB → only 1 agent fits
    const gov = new ResourceGovernor({ maxTotalAgents: 100, maxConcurrentAgents: 100, maxWorktrees: 100, maxMemoryMB: 300 });
    gov.registerAgent({ id: "a1", level: 0, scope: "s" });

    assert.throws(() => gov.enforceLimit("spawn more"), (err) => {
      assert.ok(err instanceof GovernorLimitError);
      assert.equal(err.limitType, "memory");
      return true;
    });
  });

  it("throws on invalid action", () => {
    const gov = new ResourceGovernor();
    assert.throws(() => gov.enforceLimit(""), { name: "TypeError" });
    assert.throws(() => gov.enforceLimit(null), { name: "TypeError" });
  });
});

// ── ResourceGovernor: hasCapacity ────────────────────────────────────

describe("ResourceGovernor.hasCapacity", () => {
  it("returns true when under all limits", () => {
    const gov = new ResourceGovernor();
    assert.equal(gov.hasCapacity(), true);
  });

  it("returns false when total agents exhausted", () => {
    const gov = new ResourceGovernor({ maxTotalAgents: 1, maxConcurrentAgents: 100, maxWorktrees: 100 });
    gov.registerAgent({ id: "a1", level: 0, scope: "s" });
    assert.equal(gov.hasCapacity(), false);
  });

  it("returns false when concurrent limit reached", () => {
    const gov = new ResourceGovernor({ maxTotalAgents: 100, maxConcurrentAgents: 1, maxWorktrees: 100 });
    gov.registerAgent({ id: "a1", level: 0, scope: "s" });
    assert.equal(gov.hasCapacity(), false);
  });
});

// ── ResourceGovernor: estimateCost ───────────────────────────────────

describe("ResourceGovernor.estimateCost", () => {
  it("estimates cost for a decomposition tree", () => {
    const gov = new ResourceGovernor({ costPerAgentTurn: 0.03 });
    const tree = {
      root: {
        type: "coordinator",
        turns: 5,
        children: [
          { type: "worker", turns: 10, children: [] },
          { type: "worker", turns: 10, children: [] },
        ],
      },
    };

    const estimate = gov.estimateCost(tree);

    assert.equal(estimate.estimatedAgents, 3); // 2 workers + 1 coordinator
    assert.equal(estimate.breakdown.workers, 2);
    assert.equal(estimate.breakdown.subCoordinators, 1);
    assert.ok(estimate.estimatedCost > 0);
    assert.ok(estimate.estimatedTurns > 0);
  });

  it("throws on invalid tree", () => {
    const gov = new ResourceGovernor();
    assert.throws(() => gov.estimateCost(null), { name: "TypeError" });
    assert.throws(() => gov.estimateCost({}), { name: "TypeError" });
  });

  it("handles worker-only tree", () => {
    const gov = new ResourceGovernor();
    const tree = {
      root: { type: "worker", turns: 10, children: [] },
    };

    const estimate = gov.estimateCost(tree);
    assert.equal(estimate.breakdown.workers, 1);
    assert.equal(estimate.breakdown.subCoordinators, 0);
  });
});

// ── ResourceGovernor: updateAgentTurns ───────────────────────────────

describe("ResourceGovernor.updateAgentTurns", () => {
  it("updates turns and accumulates cost", () => {
    const gov = new ResourceGovernor({ costPerAgentTurn: 0.03 });
    gov.registerAgent({ id: "w-1", level: 2, scope: "auth" });

    const result = gov.updateAgentTurns("w-1", 5);
    assert.equal(result, true);

    const agent = gov.getAgent("w-1");
    assert.equal(agent.turns, 5);

    // Cost: 5 * 0.03 = 0.15
    assert.ok(Math.abs(gov.totalCost - 0.15) < 0.001);
  });

  it("returns false for unknown agent", () => {
    const gov = new ResourceGovernor();
    assert.equal(gov.updateAgentTurns("unknown", 5), false);
  });

  it("accumulates cost delta correctly on multiple updates", () => {
    const gov = new ResourceGovernor({ costPerAgentTurn: 0.10 });
    gov.registerAgent({ id: "w-1", level: 2, scope: "s" });

    gov.updateAgentTurns("w-1", 3); // delta = 3
    gov.updateAgentTurns("w-1", 7); // delta = 4

    // Total cost = (3 + 4) * 0.10 = 0.70
    assert.ok(Math.abs(gov.totalCost - 0.70) < 0.001);
  });
});

// ── ResourceGovernor: query methods ──────────────────────────────────

describe("ResourceGovernor query methods", () => {
  let gov;

  beforeEach(() => {
    gov = new ResourceGovernor();
    gov.registerAgent({ id: "c1", level: 0, scope: "root" });
    gov.registerAgent({ id: "w1", level: 1, scope: "auth", parentId: "c1" });
    gov.registerAgent({ id: "w2", level: 1, scope: "api", parentId: "c1" });
    gov.registerAgent({ id: "w3", level: 2, scope: "db", parentId: "w1" });
  });

  it("getActiveAgents returns all active agents", () => {
    const agents = gov.getActiveAgents();
    assert.equal(agents.length, 4);
  });

  it("getAgent returns agent by id", () => {
    const agent = gov.getAgent("w1");
    assert.equal(agent.id, "w1");
    assert.equal(agent.scope, "auth");
  });

  it("getAgent returns null for unknown id", () => {
    assert.equal(gov.getAgent("nonexistent"), null);
  });

  it("getAgentsByLevel returns correct agents", () => {
    const level1 = gov.getAgentsByLevel(1);
    assert.equal(level1.length, 2);
    const ids = level1.map(a => a.id).sort();
    assert.deepEqual(ids, ["w1", "w2"]);
  });

  it("getAgentsByParent returns correct children", () => {
    const children = gov.getAgentsByParent("c1");
    assert.equal(children.length, 2);
  });
});

// ── ResourceGovernor: cleanup ────────────────────────────────────────

describe("ResourceGovernor.cleanup", () => {
  it("deregisters all agents and returns final report", async () => {
    const gov = new ResourceGovernor();
    gov.registerAgent({ id: "w1", level: 1, scope: "s" });
    gov.registerAgent({ id: "w2", level: 1, scope: "s" });

    const report = await gov.cleanup();

    assert.equal(gov.activeAgents.size, 0);
    assert.equal(gov.active, false);
    assert.equal(report.totalSpawned, 2);
    assert.equal(report.totalFailed, 2); // cleanup marks remaining as failed
    assert.ok(report.durationMs >= 0);
  });

  it("clears all reservations", async () => {
    const gov = new ResourceGovernor();
    gov.requestBudget("c1", 3, 1);

    await gov.cleanup();

    assert.equal(gov.reservations.size, 0);
  });

  it("clears worktree tracking", async () => {
    const gov = new ResourceGovernor();
    gov.registerAgent({ id: "w1", level: 1, scope: "s", worktreePath: "/tmp/fake-wt" });

    await gov.cleanup();

    assert.equal(gov.worktrees.size, 0);
  });
});

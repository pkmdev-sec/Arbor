import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Retrospective from "../lib/retrospective.mjs";

describe("Retrospective", () => {
  it("analyzes successful swarm run", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        {
          status: "completed",
          duration: 45,
          turns: 8,
          cost: 0.05,
          filesChanged: ["lib/file1.mjs", "lib/file2.mjs"],
          output: "Successfully completed task with comprehensive changes",
        },
        {
          status: "completed",
          duration: 30,
          turns: 6,
          cost: 0.03,
          filesChanged: ["test/file.test.mjs"],
          output: "Added test coverage for new features",
        },
      ],
      duration: 75,
      cost: 0.08,
      mode: "parallel",
    };

    const report = retrospective.analyze(swarmResult);

    assert.equal(report.agentPerformance.successful, 2);
    assert.equal(report.agentPerformance.failed, 0);
    assert.ok(report.agentPerformance.avgDuration > 0);
    assert.ok(report.agentPerformance.avgTurns > 0);
    assert.ok(report.agentPerformance.avgCost > 0);
    assert.ok(report.overallScore > 0.7);
    assert.ok(report.successPatterns.length > 0);
  });

  it("analyzes failed swarm run", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        {
          status: "failed",
          error: "timeout",
          duration: 600,
          turns: 30,
          cost: 0.5,
          filesChanged: [],
          output: "Failed to complete",
        },
        {
          status: "failed",
          error: "error",
          duration: 200,
          turns: 15,
          cost: 0.2,
          filesChanged: [],
          output: "Error occurred",
        },
      ],
      duration: 800,
      cost: 0.7,
      mode: "sequential",
    };

    const report = retrospective.analyze(swarmResult);

    assert.equal(report.agentPerformance.successful, 0);
    assert.equal(report.agentPerformance.failed, 2);
    assert.ok(report.failurePatterns.length > 0);
    assert.ok(report.recommendations.length > 0);
    assert.ok(report.overallScore < 0.5);
  });

  it("calculates high ROI for efficient agents", () => {
    const retrospective = new Retrospective();
    const agent = {
      cost: 0.005,
      filesChanged: ["file1.mjs", "file2.mjs", "file3.mjs"],
      output: "Completed successfully with detailed implementation notes",
    };

    const roi = retrospective.calculateROI(agent);

    assert.equal(roi.category, "high");
    assert.ok(roi.roi > 0);
  });

  it("calculates low ROI for inefficient agents", () => {
    const retrospective = new Retrospective();
    const agent = {
      cost: 0.5,
      filesChanged: ["file.mjs"],
      output: "Some output",
    };

    const roi = retrospective.calculateROI(agent);

    assert.equal(roi.category, "low");
    assert.ok(roi.roi > 0);
  });

  it("categorizes wasteful agents", () => {
    const retrospective = new Retrospective();
    const agent = {
      cost: 1.5,
      filesChanged: [],
      output: "Short",
    };

    const roi = retrospective.calculateROI(agent);

    assert.equal(roi.category, "wasteful");
  });

  it("handles zero cost agents", () => {
    const retrospective = new Retrospective();
    const agent = {
      cost: 0,
      filesChanged: ["file.mjs"],
      output: "Some output",
    };

    const roi = retrospective.calculateROI(agent);

    assert.equal(roi.roi, Infinity);
    assert.equal(roi.category, "high");
  });

  it("formats report with all sections", () => {
    const retrospective = new Retrospective();
    const report = {
      agentPerformance: {
        successful: 3,
        failed: 1,
        avgDuration: 45,
        avgTurns: 8.5,
        avgCost: 0.05,
      },
      successPatterns: ["Fast completion in javascript/react tasks"],
      failurePatterns: ["1 agents timed out"],
      costAnalysis: {
        total: 0.2,
        perAgent: 0.05,
        efficient: 3,
        wasteful: 0,
      },
      decompositionQuality: {
        tasksCompleted: 3,
        tasksOverscoped: 1,
        tasksUndefined: 0,
      },
      recommendations: ["Reduce task scope — agents are spending too many turns"],
      overallScore: 0.85,
    };

    const formatted = retrospective.formatReport(report);

    assert.ok(formatted.includes("Swarm Retrospective Report"));
    assert.ok(formatted.includes("Agent Performance:"));
    assert.ok(formatted.includes("Successful: 3"));
    assert.ok(formatted.includes("Failed: 1"));
    assert.ok(formatted.includes("Success Patterns:"));
    assert.ok(formatted.includes("Failure Patterns:"));
    assert.ok(formatted.includes("Cost Analysis:"));
    assert.ok(formatted.includes("Decomposition Quality:"));
    assert.ok(formatted.includes("Recommendations:"));
    assert.ok(formatted.includes("Overall Score: 0.85/1.0"));
  });

  it("extracts learnings from success patterns", () => {
    const retrospective = new Retrospective();
    const report = {
      agentPerformance: { successful: 5, failed: 0 },
      successPatterns: [
        "Fast completion in javascript/react tasks",
        "Efficient agents in python/django tasks",
      ],
      failurePatterns: [],
      costAnalysis: { total: 0.5, perAgent: 0.1, efficient: 5, wasteful: 0 },
      decompositionQuality: { tasksCompleted: 5, tasksOverscoped: 0, tasksUndefined: 0 },
      recommendations: [],
      overallScore: 0.9,
    };

    const learnings = retrospective.extractLearnings(report);

    assert.ok(learnings.length > 0);
    // Should extract structured learnings from patterns
    const jsLearning = learnings.find(l => l.language === "javascript");
    if (jsLearning) {
      assert.equal(jsLearning.framework, "react");
    }
  });

  it("identifies success patterns", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        {
          success: true,
          duration: 30,
          turns: 8,
          cost: 0.02,
          filesChanged: ["lib/file1.mjs"],
          output: "Quick and efficient completion with good results",
        },
        {
          success: true,
          duration: 45,
          turns: 10,
          cost: 0.03,
          filesChanged: ["lib/file2.mjs"],
          output: "Completed successfully with comprehensive changes",
        },
      ],
      duration: 75,
      cost: 0.05,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(report.successPatterns.length > 0);
    // Should identify fast and efficient agents
    assert.ok(
      report.successPatterns.some(p =>
        p.includes("quickly") || p.includes("efficient")
      )
    );
  });

  it("identifies failure patterns", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        {
          status: "failed",
          error: "timeout error",
          duration: 600,
          turns: 35,
          cost: 0.5,
          filesChanged: [],
          output: "",
        },
        {
          success: true,
          duration: 200,
          turns: 8,
          cost: 0.1,
          filesChanged: [],
          output: "Short",
        },
      ],
      duration: 800,
      cost: 0.6,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(report.failurePatterns.length > 0);
    // Should identify timeout and no output patterns
    assert.ok(
      report.failurePatterns.some(p =>
        p.includes("timed out") || p.includes("no meaningful output")
      )
    );
  });

  it("generates recommendations for high failure rate", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { status: "failed", duration: 100, turns: 10, cost: 0.1, filesChanged: [], output: "" },
        { status: "failed", duration: 100, turns: 10, cost: 0.1, filesChanged: [], output: "" },
        { success: true, duration: 50, turns: 8, cost: 0.05, filesChanged: ["f.mjs"], output: "ok" },
      ],
      duration: 250,
      cost: 0.25,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(
      report.recommendations.some(r => r.includes("task decomposition"))
    );
  });

  it("generates recommendations for high turn count", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { success: true, duration: 100, turns: 25, cost: 0.1, filesChanged: ["f.mjs"], output: "ok" },
        { success: true, duration: 100, turns: 22, cost: 0.1, filesChanged: ["f.mjs"], output: "ok" },
      ],
      duration: 200,
      cost: 0.2,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(
      report.recommendations.some(r => r.includes("Reduce task scope"))
    );
  });

  it("generates recommendations for high cost with low success", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { status: "failed", duration: 100, turns: 10, cost: 3.0, filesChanged: [], output: "" },
        { status: "failed", duration: 100, turns: 10, cost: 3.0, filesChanged: [], output: "" },
      ],
      duration: 200,
      cost: 6.0,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(
      report.recommendations.some(r => r.includes("cheaper models"))
    );
  });

  it("generates recommendations for timeout patterns", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { status: "failed", error: "timeout", duration: 600, turns: 10, cost: 0.5, filesChanged: [], output: "" },
      ],
      duration: 600,
      cost: 0.5,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(
      report.recommendations.some(r => r.includes("timeout handling"))
    );
  });

  it("detects overscoped tasks", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { success: true, duration: 350, turns: 30, cost: 0.3, filesChanged: ["f.mjs"], output: "ok" },
        { success: true, duration: 50, turns: 8, cost: 0.05, filesChanged: ["f.mjs"], output: "ok" },
      ],
      duration: 400,
      cost: 0.35,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(report.decompositionQuality.tasksOverscoped >= 1);
  });

  it("detects undefined tasks", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { success: true, duration: 100, turns: 15, cost: 0.15, filesChanged: [], output: "Some output" },
      ],
      duration: 100,
      cost: 0.15,
    };

    const report = retrospective.analyze(swarmResult);

    assert.ok(report.decompositionQuality.tasksUndefined >= 1);
  });

  it("handles empty agent list", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [],
      duration: 0,
      cost: 0,
    };

    const report = retrospective.analyze(swarmResult);

    assert.equal(report.agentPerformance.successful, 0);
    assert.equal(report.agentPerformance.failed, 0);
    assert.equal(report.agentPerformance.avgDuration, 0);
    assert.equal(report.agentPerformance.avgTurns, 0);
    assert.equal(report.agentPerformance.avgCost, 0);
    assert.equal(report.overallScore, 0);
  });

  it("handles agents with missing fields", () => {
    const retrospective = new Retrospective();
    const swarmResult = {
      agents: [
        { status: "completed" }, // Missing most fields
        { success: true }, // Missing most fields
      ],
      duration: 100,
      cost: 0.1,
    };

    const report = retrospective.analyze(swarmResult);

    // Should not throw and should handle gracefully
    assert.ok(report.agentPerformance);
    assert.ok(typeof report.overallScore === "number");
  });
});

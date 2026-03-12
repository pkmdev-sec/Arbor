/**
 * Retrospective agent for post-task insights
 *
 * Analyzes completed swarm runs to extract operational insights.
 * Inspired by Fernis REQ-018: learn from execution patterns to improve
 * future decomposition, cost efficiency, and task scoping.
 */

// ── Constants ────────────────────────────────────────────────────

/** Maximum cost per file for 'high' ROI */
const HIGH_ROI_THRESHOLD = 0.005; // $0.005 per file changed

/** Maximum cost per file for 'medium' ROI */
const LOW_ROI_THRESHOLD = 0.05; // $0.05 per file changed

/** Threshold for detecting overscoped tasks (turns) */
const OVERSCOPED_TURNS_THRESHOLD = 25;

/** Threshold for detecting overscoped tasks (duration in seconds) */
const OVERSCOPED_DURATION_THRESHOLD = 300;

/** Threshold for detecting undefined tasks (turns with no changes) */
const UNDEFINED_TASK_TURNS_THRESHOLD = 10;

/** Weights for overall score calculation */
const SCORE_WEIGHTS = {
  successRate: 0.4,
  costEfficiency: 0.3,
  taskCompletion: 0.3,
};

/** Minimum cost threshold to consider an agent wasteful */
const WASTEFUL_COST_THRESHOLD = 1.0;

// ── Retrospective class ──────────────────────────────────────────

/**
 * Post-task operational insights extractor.
 * Analyzes swarm runs to identify success patterns, failure modes, and improvements.
 *
 * @example
 * const retrospective = new Retrospective();
 * const report = retrospective.analyze(swarmResult);
 * console.log(retrospective.formatReport(report));
 */
export default class Retrospective {
  constructor() {
    // No state needed - pure analysis
  }

  /**
   * Analyze a completed swarm run and extract operational insights.
   *
   * @param {object} swarmResult - { agents: [], duration, cost, mode }
   * @returns {RetrospectiveReport} Analysis report
   */
  analyze(swarmResult) {
    const agents = swarmResult.agents || [];
    const totalDuration = swarmResult.duration || 0;
    const totalCost = swarmResult.cost || 0;

    // Calculate agent performance metrics
    const successful = agents.filter(a => a.status === 'completed' || a.success);
    const failed = agents.filter(a => a.status === 'failed' || a.error);

    const avgDuration = agents.length > 0
      ? agents.reduce((sum, a) => sum + (a.duration || 0), 0) / agents.length
      : 0;

    const avgTurns = agents.length > 0
      ? agents.reduce((sum, a) => sum + (a.turns || 0), 0) / agents.length
      : 0;

    const avgCost = agents.length > 0
      ? agents.reduce((sum, a) => sum + (a.cost || 0), 0) / agents.length
      : 0;

    const agentPerformance = {
      successful: successful.length,
      failed: failed.length,
      avgDuration: Math.round(avgDuration),
      avgTurns: Math.round(avgTurns * 10) / 10,
      avgCost: Math.round(avgCost * 1000) / 1000,
    };

    // Identify success and failure patterns
    const successPatterns = this._identifySuccessPatterns(successful);
    const failurePatterns = this._identifyFailurePatterns(failed, agents);

    // Cost analysis
    const costAnalysis = this._analyzeCost(agents, totalCost);

    // Decomposition quality
    const decompositionQuality = this._analyzeDecomposition(agents);

    // Generate recommendations
    const recommendations = this._generateRecommendations(
      agentPerformance,
      costAnalysis,
      decompositionQuality,
      failurePatterns
    );

    // Calculate overall score
    const successRate = agents.length > 0 ? successful.length / agents.length : 0;
    const costEfficiency = costAnalysis.efficient / Math.max(1, agents.length);
    const taskCompletion = decompositionQuality.tasksCompleted / Math.max(1, agents.length);

    const overallScore =
      successRate * SCORE_WEIGHTS.successRate +
      costEfficiency * SCORE_WEIGHTS.costEfficiency +
      taskCompletion * SCORE_WEIGHTS.taskCompletion;

    return {
      agentPerformance,
      successPatterns,
      failurePatterns,
      recommendations,
      costAnalysis,
      decompositionQuality,
      overallScore: Math.round(overallScore * 100) / 100,
    };
  }

  /**
   * Calculate agent ROI (results per dollar spent).
   *
   * @param {object} agent - Agent result with cost, output, filesChanged
   * @returns {{ roi: number, category: 'high'|'medium'|'low'|'wasteful' }}
   */
  calculateROI(agent) {
    const cost = agent.cost || 0;
    const filesChanged = (agent.filesChanged || []).length;
    const outputLength = (agent.output || '').length;

    // Avoid division by zero
    if (cost === 0) {
      return { roi: Infinity, category: 'high' };
    }

    // ROI = value / cost
    // Value = files changed + (output quality proxy)
    const value = filesChanged + (outputLength > 100 ? 0.5 : 0);
    const roi = value / cost;

    // Categorize ROI
    let category;
    if (filesChanged === 0 && outputLength < 100) {
      category = 'wasteful';
    } else if (cost < HIGH_ROI_THRESHOLD * filesChanged) {
      category = 'high';
    } else if (cost < LOW_ROI_THRESHOLD * filesChanged) {
      category = 'medium';
    } else {
      category = 'low';
    }

    return {
      roi: Math.round(roi * 100) / 100,
      category,
    };
  }

  /**
   * Generate a human-readable summary of the retrospective.
   *
   * @param {RetrospectiveReport} report
   * @returns {string} Formatted report
   */
  formatReport(report) {
    const lines = [];

    lines.push('=== Swarm Retrospective Report ===\n');

    // Agent performance
    lines.push('Agent Performance:');
    lines.push(`  Successful: ${report.agentPerformance.successful}`);
    lines.push(`  Failed: ${report.agentPerformance.failed}`);
    lines.push(`  Avg Duration: ${report.agentPerformance.avgDuration}s`);
    lines.push(`  Avg Turns: ${report.agentPerformance.avgTurns}`);
    lines.push(`  Avg Cost: $${report.agentPerformance.avgCost}`);
    lines.push('');

    // Success patterns
    if (report.successPatterns.length > 0) {
      lines.push('Success Patterns:');
      for (const pattern of report.successPatterns) {
        lines.push(`  ✓ ${pattern}`);
      }
      lines.push('');
    }

    // Failure patterns
    if (report.failurePatterns.length > 0) {
      lines.push('Failure Patterns:');
      for (const pattern of report.failurePatterns) {
        lines.push(`  ✗ ${pattern}`);
      }
      lines.push('');
    }

    // Cost analysis
    lines.push('Cost Analysis:');
    lines.push(`  Total: $${report.costAnalysis.total}`);
    lines.push(`  Per Agent: $${report.costAnalysis.perAgent}`);
    lines.push(`  Efficient: ${report.costAnalysis.efficient}`);
    lines.push(`  Wasteful: ${report.costAnalysis.wasteful}`);
    lines.push('');

    // Decomposition quality
    lines.push('Decomposition Quality:');
    lines.push(`  Completed: ${report.decompositionQuality.tasksCompleted}`);
    lines.push(`  Overscoped: ${report.decompositionQuality.tasksOverscoped}`);
    lines.push(`  Undefined: ${report.decompositionQuality.tasksUndefined}`);
    lines.push('');

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('Recommendations:');
      for (const rec of report.recommendations) {
        lines.push(`  → ${rec}`);
      }
      lines.push('');
    }

    // Overall score
    lines.push(`Overall Score: ${report.overallScore}/1.0`);

    return lines.join('\n');
  }

  /**
   * Extract learnings suitable for storage in LearningStore.
   *
   * @param {RetrospectiveReport} report
   * @returns {Array<{ taskType, language, framework, pattern }>}
   */
  extractLearnings(report) {
    const learnings = [];

    // Extract from success patterns
    for (const pattern of report.successPatterns) {
      // Parse pattern for structured data
      // Example pattern: "Fast completion in javascript/react tasks"
      const match = pattern.match(/\b(\w+)\/(\w+)\b/);
      if (match) {
        learnings.push({
          taskType: 'feature', // Default task type
          language: match[1],
          framework: match[2],
          pattern: { successPattern: pattern },
        });
      }
    }

    // Add general learnings based on score
    if (report.overallScore > 0.8) {
      learnings.push({
        taskType: 'general',
        language: 'unknown',
        framework: 'unknown',
        pattern: {
          approach: 'high_success_decomposition',
          score: report.overallScore,
        },
      });
    }

    return learnings;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Identify patterns in successful agents.
   * @private
   */
  _identifySuccessPatterns(successful) {
    const patterns = [];

    // Pattern: fast completion
    const fastAgents = successful.filter(a => (a.duration || 0) < 60);
    if (fastAgents.length > 0 && fastAgents.length >= successful.length * 0.5) {
      patterns.push(`${fastAgents.length} agents completed quickly (<60s)`);
    }

    // Pattern: low turn count
    const efficientAgents = successful.filter(a => (a.turns || 0) < 15);
    if (efficientAgents.length > 0 && efficientAgents.length >= successful.length * 0.5) {
      patterns.push(`${efficientAgents.length} agents were efficient (<15 turns)`);
    }

    // Pattern: good output quality
    const productiveAgents = successful.filter(a => {
      const filesChanged = (a.filesChanged || []).length;
      const output = (a.output || '').length;
      return filesChanged > 0 || output > 200;
    });
    if (productiveAgents.length > 0 && productiveAgents.length >= successful.length * 0.7) {
      patterns.push(`${productiveAgents.length} agents produced substantial output`);
    }

    return patterns;
  }

  /**
   * Identify patterns in failed agents.
   * @private
   */
  _identifyFailurePatterns(failed, allAgents) {
    const patterns = [];

    // Pattern: timeout failures
    const timedOut = failed.filter(a => (a.error || '').includes('timeout'));
    if (timedOut.length > 0) {
      patterns.push(`${timedOut.length} agents timed out`);
    }

    // Pattern: no output failures
    const noOutput = allAgents.filter(a => {
      const output = (a.output || '').length;
      const filesChanged = (a.filesChanged || []).length;
      return output < 50 && filesChanged === 0 && (a.turns || 0) > 5;
    });
    if (noOutput.length > 0) {
      patterns.push(`${noOutput.length} agents produced no meaningful output`);
    }

    // Pattern: high turn count failures
    const highTurns = failed.filter(a => (a.turns || 0) > OVERSCOPED_TURNS_THRESHOLD);
    if (highTurns.length > 0) {
      patterns.push(`${highTurns.length} agents exceeded turn threshold (>${OVERSCOPED_TURNS_THRESHOLD})`);
    }

    return patterns;
  }

  /**
   * Analyze cost efficiency across agents.
   * @private
   */
  _analyzeCost(agents, totalCost) {
    let efficientCount = 0;
    let wastefulCount = 0;

    for (const agent of agents) {
      const roi = this.calculateROI(agent);
      if (roi.category === 'high' || roi.category === 'medium') {
        efficientCount++;
      } else if (roi.category === 'wasteful' && (agent.cost || 0) > WASTEFUL_COST_THRESHOLD) {
        wastefulCount++;
      }
    }

    const avgCostPerAgent = agents.length > 0
      ? totalCost / agents.length
      : 0;

    return {
      total: Math.round(totalCost * 1000) / 1000,
      perAgent: Math.round(avgCostPerAgent * 1000) / 1000,
      efficient: efficientCount,
      wasteful: wastefulCount,
    };
  }

  /**
   * Analyze task decomposition quality.
   * @private
   */
  _analyzeDecomposition(agents) {
    let tasksCompleted = 0;
    let tasksOverscoped = 0;
    let tasksUndefined = 0;

    for (const agent of agents) {
      const turns = agent.turns || 0;
      const duration = agent.duration || 0;
      const filesChanged = (agent.filesChanged || []).length;
      const success = agent.status === 'completed' || agent.success;

      if (success && filesChanged > 0) {
        tasksCompleted++;
      }

      if (turns > OVERSCOPED_TURNS_THRESHOLD || duration > OVERSCOPED_DURATION_THRESHOLD) {
        tasksOverscoped++;
      }

      if (turns > UNDEFINED_TASK_TURNS_THRESHOLD && filesChanged === 0) {
        tasksUndefined++;
      }
    }

    return {
      tasksCompleted,
      tasksOverscoped,
      tasksUndefined,
    };
  }

  /**
   * Generate actionable recommendations based on analysis.
   * @private
   */
  _generateRecommendations(performance, cost, decomposition, failurePatterns) {
    const recommendations = [];

    // High failure rate
    const totalAgents = performance.successful + performance.failed;
    const failureRate = totalAgents > 0 ? performance.failed / totalAgents : 0;
    if (failureRate > 0.3) {
      recommendations.push('Improve task decomposition — tasks may be too large or ambiguous');
    }

    // High turn count
    if (performance.avgTurns > 20) {
      recommendations.push('Reduce task scope — agents are spending too many turns');
    }

    // High cost with low success
    const successRate = totalAgents > 0 ? performance.successful / totalAgents : 0;
    if (cost.total > 5 && successRate < 0.5) {
      recommendations.push('Consider cheaper models for simple tasks');
    }

    // Timeout pattern detected
    if (failurePatterns.some(p => p.includes('timed out'))) {
      recommendations.push('Add timeout handling and partial result recovery');
    }

    // Wasteful agents
    if (cost.wasteful > 2) {
      recommendations.push('Add pre-mortem filtering to avoid spawning wasteful agents');
    }

    // Overscoped tasks
    if (decomposition.tasksOverscoped > totalAgents * 0.3) {
      recommendations.push('Break down complex tasks into smaller subtasks');
    }

    // Undefined tasks
    if (decomposition.tasksUndefined > 0) {
      recommendations.push('Improve task descriptions — some tasks lack clear objectives');
    }

    return recommendations;
  }
}

/**
 * @typedef {object} RetrospectiveReport
 * @property {object} agentPerformance - { successful, failed, avgDuration, avgTurns, avgCost }
 * @property {string[]} successPatterns - What worked well
 * @property {string[]} failurePatterns - What went wrong
 * @property {string[]} recommendations - Actionable improvements for next run
 * @property {object} costAnalysis - { total, perAgent, wasteful, efficient }
 * @property {object} decompositionQuality - { tasksCompleted, tasksOverscoped, tasksUndefined }
 * @property {number} overallScore - 0-1 quality score for the run
 */

/**
 * Council RPC: Distributed council voting via IPC
 *
 * Implements REQ-025: Council pattern over IPC for distributed multi-judge validation.
 * Orchestrator sends vote requests to judge agents, collects verdicts, and evaluates consensus.
 *
 * @module council-rpc
 */

import Council from "../council.mjs";

// ── Constants ────────────────────────────────────────────────────

/** Default timeout for each judge vote request (ms) */
const DEFAULT_VOTE_TIMEOUT = 30000;

/** Default number of judges to consult */
const DEFAULT_JUDGE_COUNT = 3;

/** Default consensus threshold (minimum approvals) */
const DEFAULT_CONSENSUS_THRESHOLD = 2;

// ── CouncilRPC class ─────────────────────────────────────────────

/**
 * Distributed council voting via RPC over IPC.
 * Orchestrates multi-judge validation across separate agent processes.
 *
 * @example
 * const orchestratorControl = new OrchestratorControl();
 * await orchestratorControl.connect();
 *
 * const councilRPC = new CouncilRPC(orchestratorControl, {
 *   judgeCount: 3,
 *   consensusThreshold: 2,
 *   voteTimeout: 30000
 * });
 *
 * const judgeAgentIds = ['judge-01', 'judge-02', 'judge-03'];
 * const result = await councilRPC.conductReview(task, result, judgeAgentIds);
 * console.log('Consensus:', result.consensus, 'Confidence:', result.confidence);
 */
export default class CouncilRPC {
  /**
   * @param {import("./orchestrator-control.mjs").OrchestratorControl} orchestratorControl - OrchestratorControl instance for RPC
   * @param {object} [options] - Configuration options
   * @param {number} [options.voteTimeout=30000] - Timeout for each judge vote request (ms)
   * @param {number} [options.judgeCount=3] - Number of judges to consult
   * @param {number} [options.consensusThreshold=2] - Minimum approvals for consensus
   */
  constructor(orchestratorControl, options = {}) {
    if (!orchestratorControl) {
      throw new Error("orchestratorControl is required");
    }

    this.orchestratorControl = orchestratorControl;
    this.options = {
      voteTimeout: options.voteTimeout || DEFAULT_VOTE_TIMEOUT,
      judgeCount: options.judgeCount || DEFAULT_JUDGE_COUNT,
      consensusThreshold: options.consensusThreshold || DEFAULT_CONSENSUS_THRESHOLD,
    };

    // Create internal Council instance for decision logic
    this.council = new Council({
      judgeCount: this.options.judgeCount,
      consensusThreshold: this.options.consensusThreshold,
    });
  }

  /**
   * Determine if a task warrants council review.
   * Delegates to the internal Council instance.
   *
   * @param {object} task - Task with type, description, targetFiles
   * @param {object} result - Agent result with output, filesChanged
   * @returns {boolean} True if council review is warranted
   */
  shouldReview(task, result) {
    return this.council.shouldReview(task, result);
  }

  /**
   * Conduct distributed council review via RPC.
   * Sends vote requests to judge agents, collects verdicts, and evaluates consensus.
   *
   * @param {object} task - Task specification with description, type
   * @param {object} result - Agent result with output, filesChanged
   * @param {string[]} judgeAgentIds - Array of judge agent IDs
   * @returns {Promise<{
   *   consensus: string,
   *   confidence: number,
   *   concerns: string[],
   *   recommendation: string,
   *   votes: Array<{ role: string, verdict: string, confidence: number, concerns: string[] }>,
   *   meta: { judgeCount: number, responded: number, timedOut: number, duration: number }
   * }>}
   * @throws {Error} If judgeAgentIds.length < judgeCount
   */
  async conductReview(task, result, judgeAgentIds) {
    const startTime = Date.now();

    // Validate judge agent count
    if (judgeAgentIds.length < this.options.judgeCount) {
      throw new Error(
        `Not enough judge agents: need ${this.options.judgeCount}, got ${judgeAgentIds.length}`
      );
    }

    // Generate judge prompts using Council
    const prompts = this.council.generateJudgePrompts(task, result);

    // Send vote requests to judges in parallel
    const votePromises = [];
    for (let i = 0; i < this.options.judgeCount; i++) {
      const judgeId = judgeAgentIds[i];
      const { role, prompt } = prompts[i];

      const votePromise = this._requestVote(judgeId, role, prompt, task);
      votePromises.push(votePromise);
    }

    // Wait for all votes with graceful timeout handling
    const results = await Promise.allSettled(votePromises);

    // Collect verdicts from fulfilled promises
    const verdicts = [];
    let respondedCount = 0;
    let timedOutCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const { role } = prompts[i];

      if (result.status === "fulfilled") {
        verdicts.push(result.value);
        respondedCount++;
      } else {
        // Treat timeout/rejection as abstention
        verdicts.push({
          role,
          verdict: "REJECT",
          confidence: 0.0,
          concerns: [`Judge timed out or failed: ${result.reason?.message || "unknown error"}`],
        });
        timedOutCount++;
      }
    }

    // Evaluate consensus using Council
    const evaluation = this.council.evaluateVerdicts(verdicts);

    const duration = Date.now() - startTime;

    return {
      consensus: evaluation.consensus,
      confidence: evaluation.confidence,
      concerns: evaluation.concerns,
      recommendation: evaluation.recommendation,
      votes: verdicts,
      meta: {
        judgeCount: this.options.judgeCount,
        responded: respondedCount,
        timedOut: timedOutCount,
        duration,
      },
    };
  }

  /**
   * Send a vote request to a judge agent via RPC
   *
   * @private
   * @param {string} judgeId - Judge agent ID
   * @param {string} role - Judge role (correctness, regression, quality)
   * @param {string} prompt - Judge prompt
   * @param {object} task - Task specification
   * @returns {Promise<{ role: string, verdict: string, confidence: number, concerns: string[] }>}
   */
  async _requestVote(judgeId, role, prompt, task) {
    const message = {
      type: "council_vote_request",
      role,
      prompt,
      task: {
        description: task.description,
        type: task.type,
      },
      timestamp: Date.now(),
    };

    const response = await this.orchestratorControl.request(
      judgeId,
      message,
      this.options.voteTimeout
    );

    // Validate response structure
    if (!response || !response.verdict) {
      throw new Error(`Invalid vote response from ${judgeId}: missing verdict`);
    }

    return {
      role,
      verdict: response.verdict,
      confidence: response.confidence ?? 0.5,
      concerns: response.concerns || [],
    };
  }

  /**
   * Create a vote handler for judge agents.
   * Returns a message handler that processes council vote requests.
   *
   * @static
   * @param {function(string, string): Promise<{ verdict: string, concerns: string[], confidence: number }>} reviewFn
   *   - Async function that performs the review
   *   - Parameters: (role: string, prompt: string)
   *   - Returns: { verdict: 'APPROVE'|'REJECT'|'NEEDS_WORK', concerns: string[], confidence: number }
   * @returns {function(object): Promise<object|null>} Message handler for AgentChannel.onMessage()
   *
   * @example
   * // In judge agent code:
   * const handler = CouncilRPC.createVoteHandler(async (role, prompt) => {
   *   // Perform review based on role and prompt
   *   return {
   *     verdict: 'APPROVE',
   *     concerns: [],
   *     confidence: 0.9
   *   };
   * });
   *
   * agentChannel.onMessage(async (msg) => {
   *   const response = await handler(msg);
   *   if (response) {
   *     // Response is automatically sent via request-response pattern
   *     return response;
   *   }
   * });
   */
  static createVoteHandler(reviewFn) {
    return async (message) => {
      // Check if this is a council vote request
      if (message.type !== "council_vote_request") {
        return null;
      }

      const { role, prompt } = message;

      if (!role || !prompt) {
        return {
          verdict: "REJECT",
          concerns: ["Invalid vote request: missing role or prompt"],
          confidence: 0.0,
        };
      }

      try {
        // Perform review
        const result = await reviewFn(role, prompt);

        // Validate result structure
        if (!result || !result.verdict) {
          return {
            verdict: "REJECT",
            concerns: ["Review function returned invalid result"],
            confidence: 0.0,
          };
        }

        return {
          verdict: result.verdict,
          concerns: result.concerns || [],
          confidence: result.confidence ?? 0.5,
        };
      } catch (err) {
        return {
          verdict: "REJECT",
          concerns: [`Review error: ${err.message}`],
          confidence: 0.0,
        };
      }
    };
  }
}

// ── Factory function ─────────────────────────────────────────────

/**
 * Create a CouncilRPC instance
 *
 * @param {import("./orchestrator-control.mjs").OrchestratorControl} orchestratorControl - OrchestratorControl instance
 * @param {object} [options] - Configuration options
 * @returns {CouncilRPC}
 */
export function createCouncilRPC(orchestratorControl, options = {}) {
  return new CouncilRPC(orchestratorControl, options);
}

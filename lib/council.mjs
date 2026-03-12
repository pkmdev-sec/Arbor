/**
 * Council pattern for critical task validation
 *
 * Multi-judge validation for high-stakes changes.
 * Inspired by Fernis REQ-025: use multiple perspectives to catch
 * correctness issues, regressions, and over-engineering.
 */

// ── Constants ────────────────────────────────────────────────────

/** Default number of judges */
const DEFAULT_JUDGE_COUNT = 3;

/** Default consensus threshold (minimum approvals) */
const DEFAULT_CONSENSUS_THRESHOLD = 2;

/** File count threshold for automatic council review */
const LARGE_CHANGE_THRESHOLD = 10;

/** Critical task types that always warrant council review */
const CRITICAL_TASK_TYPES = new Set(['security', 'architecture']);

/** Critical keywords in task descriptions */
const CRITICAL_KEYWORDS = [
  'critical',
  'breaking',
  'migration',
  'auth',
  'security',
];

// ── Council class ────────────────────────────────────────────────

/**
 * Multi-judge validation for critical tasks.
 * Evaluates task results from multiple perspectives to ensure quality.
 *
 * @example
 * const council = new Council({ judgeCount: 3, consensusThreshold: 2 });
 * if (council.shouldReview(task, result)) {
 *   const prompts = council.generateJudgePrompts(task, result);
 *   const verdicts = await evaluateWithJudges(prompts);
 *   const decision = council.evaluateVerdicts(verdicts);
 * }
 */
export default class Council {
  constructor(options = {}) {
    this.judgeCount = options.judgeCount || DEFAULT_JUDGE_COUNT;
    this.consensusThreshold = options.consensusThreshold || DEFAULT_CONSENSUS_THRESHOLD;
  }

  /**
   * Determine if a task warrants council review.
   * Triggers for security/architecture tasks, large changes, or critical keywords.
   *
   * @param {object} task - Task with type, description, targetFiles
   * @param {object} result - Agent result with output, filesChanged
   * @returns {boolean} True if council review is warranted
   */
  shouldReview(task, result) {
    // Check if task type is critical
    if (task.type && CRITICAL_TASK_TYPES.has(task.type)) {
      return true;
    }

    // Check if change is large
    const filesChanged = result.filesChanged || [];
    if (filesChanged.length > LARGE_CHANGE_THRESHOLD) {
      return true;
    }

    // Check for critical keywords in task description
    const description = (task.description || '').toLowerCase();
    for (const keyword of CRITICAL_KEYWORDS) {
      if (description.includes(keyword)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate judge prompts for a task result.
   * Creates prompts for three judges: Correctness, Regression, Quality.
   *
   * @param {object} task - Task specification
   * @param {object} result - Agent result with output, filesChanged
   * @returns {Array<{ role: string, prompt: string }>} Judge prompts
   */
  generateJudgePrompts(task, result) {
    const taskDescription = task.description || 'No description provided';
    const output = result.output || 'No output';
    const filesChanged = result.filesChanged || [];

    return [
      {
        role: 'correctness',
        prompt: `You are the Correctness Judge. Review this implementation:

Task: ${taskDescription}

Implementation output: ${output}

Files changed: ${filesChanged.join(', ')}

Your job: Does this implementation actually work? Check for:
- Logic errors and edge cases
- Correct algorithm/approach
- Proper error handling
- Data validation

Respond with:
- verdict: APPROVE | REJECT | NEEDS_WORK
- confidence: 0.0-1.0
- concerns: array of specific issues found (empty if none)`,
      },
      {
        role: 'regression',
        prompt: `You are the Regression Judge. Review this implementation:

Task: ${taskDescription}

Implementation output: ${output}

Files changed: ${filesChanged.join(', ')}

Your job: Does this break existing functionality? Check for:
- Removed features or APIs
- Changed behavior of existing code
- Test coverage for changes
- Backward compatibility

Respond with:
- verdict: APPROVE | REJECT | NEEDS_WORK
- confidence: 0.0-1.0
- concerns: array of specific issues found (empty if none)`,
      },
      {
        role: 'quality',
        prompt: `You are the Quality Judge. Review this implementation:

Task: ${taskDescription}

Implementation output: ${output}

Files changed: ${filesChanged.join(', ')}

Your job: Is this the simplest correct solution? Check for:
- Over-engineering and unnecessary complexity
- Code quality and readability
- Proper abstraction level
- Following project conventions

Respond with:
- verdict: APPROVE | REJECT | NEEDS_WORK
- confidence: 0.0-1.0
- concerns: array of specific issues found (empty if none)`,
      },
    ];
  }

  /**
   * Evaluate judge verdicts and produce consensus.
   * Aggregates verdicts using threshold-based consensus.
   *
   * @param {Array<{ role: string, verdict: string, confidence: number, concerns: string[] }>} verdicts
   * @returns {{ consensus: string, confidence: number, concerns: string[], recommendation: string }}
   */
  evaluateVerdicts(verdicts) {
    // Handle empty verdicts array
    if (verdicts.length === 0) {
      return {
        consensus: 'rejected',
        confidence: 0.5,
        concerns: [],
        recommendation: 'No judge verdicts provided. Cannot evaluate.',
      };
    }

    // Count verdicts by type
    const counts = {
      APPROVE: 0,
      REJECT: 0,
      NEEDS_WORK: 0,
    };

    const allConcerns = [];
    let totalConfidence = 0;

    for (const verdict of verdicts) {
      const v = verdict.verdict || 'REJECT';
      counts[v] = (counts[v] || 0) + 1;
      totalConfidence += verdict.confidence || 0.5;
      if (verdict.concerns && verdict.concerns.length > 0) {
        allConcerns.push(...verdict.concerns);
      }
    }

    const judgeCount = verdicts.length;
    const avgConfidence = judgeCount > 0 ? totalConfidence / judgeCount : 0.5;

    // Determine consensus based on approval count
    let consensus;
    let confidence;
    let recommendation;

    if (counts.APPROVE === judgeCount) {
      // Unanimous approval
      consensus = 'approved';
      confidence = 0.95;
      recommendation = 'Implementation approved by all judges. Proceed with confidence.';
    } else if (counts.APPROVE >= this.consensusThreshold) {
      // Threshold met
      consensus = 'approved';
      // Average confidence of approving judges
      const approvingConfidence = verdicts
        .filter(v => v.verdict === 'APPROVE')
        .reduce((sum, v) => sum + (v.confidence || 0.5), 0);
      confidence = approvingConfidence / counts.APPROVE;
      recommendation = `Implementation approved with ${counts.APPROVE}/${judgeCount} judges. Review concerns before proceeding.`;
    } else if (counts.APPROVE >= 1) {
      // Some approval but below threshold
      consensus = 'needs_review';
      confidence = avgConfidence;
      recommendation = `Implementation has mixed reviews (${counts.APPROVE}/${judgeCount} approve). Address concerns and re-evaluate.`;
    } else {
      // No approvals
      consensus = 'rejected';
      // Average confidence of rejecting judges
      const rejectingConfidence = verdicts
        .filter(v => v.verdict === 'REJECT' || v.verdict === 'NEEDS_WORK')
        .reduce((sum, v) => sum + (v.confidence || 0.5), 0);
      confidence = rejectingConfidence / (counts.REJECT + counts.NEEDS_WORK);
      recommendation = 'Implementation rejected by all judges. Significant rework required.';
    }

    return {
      consensus,
      confidence: Math.min(1.0, Math.max(0.0, confidence)),
      concerns: allConcerns,
      recommendation,
    };
  }
}

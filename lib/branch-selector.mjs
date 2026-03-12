/**
 * F12: Branch Selector for Fork-Merge Mode
 *
 * Compares competing approach results and selects a winner based on:
 * 1. Exit code (success vs failure)
 * 2. Diff size (smaller is better for equal quality)
 * 3. Test pass rate
 * 4. AI quality verdict (optional)
 *
 * Used by swarm.mjs --mode fork-merge after parallel approach execution.
 */

import { execFileSync } from "node:child_process";
import { aiJsonDecision, isAiClientAvailable } from "./ai-client.mjs";
import { colors, log } from "./output.mjs";
import { logIpc } from "./ipc-logger.mjs";

/**
 * Score a single approach result.
 *
 * @param {object} result - Agent execution result
 * @param {string} result.output - Agent stdout
 * @param {number} result.exitCode - Process exit code
 * @param {number} result.durationMs - Execution time
 * @param {string} worktreePath - Path to approach worktree
 * @returns {object} Scored result with metrics
 */
function scoreApproach(result, worktreePath) {
  const score = {
    exitCode: result.exitCode,
    succeeded: result.exitCode === 0,
    durationMs: result.durationMs,
    diffStats: { files: 0, insertions: 0, deletions: 0, total: 0 },
    testsPassed: null,
    qualityScore: 0,
  };

  // Measure diff size from worktree
  if (worktreePath) {
    try {
      const stat = execFileSync("git", ["diff", "--stat", "HEAD"], {
        encoding: "utf-8", timeout: 10000, cwd: worktreePath,
      });
      const lines = stat.trim().split("\n");
      // Parse summary line: " N files changed, X insertions(+), Y deletions(-)"
      const summary = lines[lines.length - 1] || "";
      const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
      const insMatch = summary.match(/(\d+)\s+insertions?/);
      const delMatch = summary.match(/(\d+)\s+deletions?/);
      score.diffStats.files = filesMatch ? parseInt(filesMatch[1]) : 0;
      score.diffStats.insertions = insMatch ? parseInt(insMatch[1]) : 0;
      score.diffStats.deletions = delMatch ? parseInt(delMatch[1]) : 0;
      score.diffStats.total = score.diffStats.insertions + score.diffStats.deletions;
    } catch {
      // git diff failed — non-fatal
    }
  }

  // Extract test results from output (heuristic)
  if (result.output) {
    const passMatch = result.output.match(/(\d+)\s+(?:tests?\s+)?pass/i);
    const failMatch = result.output.match(/(\d+)\s+(?:tests?\s+)?fail/i);
    if (passMatch || failMatch) {
      const passed = passMatch ? parseInt(passMatch[1]) : 0;
      const failed = failMatch ? parseInt(failMatch[1]) : 0;
      score.testsPassed = { passed, failed, total: passed + failed };
    }
  }

  // Compute quality score (0-100)
  // Success: 40 points
  // Diff economy: 0-30 points (smaller = better, capped at reasonable threshold)
  // Tests: 0-30 points
  score.qualityScore = 0;
  if (score.succeeded) score.qualityScore += 40;
  // Diff economy: penalize large diffs (>500 lines). Max 30pts at 0 lines, linear decay.
  const diffPenalty = Math.min(score.diffStats.total / 500, 1);
  score.qualityScore += Math.round(30 * (1 - diffPenalty));
  // Test bonus
  if (score.testsPassed) {
    const total = score.testsPassed.total || 1;
    score.qualityScore += Math.round(30 * (score.testsPassed.passed / total));
  } else if (score.succeeded) {
    // No test evidence but succeeded — give partial credit
    score.qualityScore += 15;
  }

  return score;
}

/**
 * Compare approach results and select a winner.
 *
 * @param {Array<{id, approach, result, worktreePath}>} candidates
 * @param {string} task - Original task description
 * @param {object} options
 * @param {boolean} [options.useAiJudge=true] - Use AI for tie-breaking
 * @returns {Promise<{winner, scores, reasoning}>}
 */
export async function selectWinner(candidates, task, { useAiJudge = true } = {}) {
  log(`${colors.bold}${colors.cyan}[FORK-MERGE]${colors.reset} Comparing ${candidates.length} approaches...`);
  logIpc("orchestrator", "selector", "task_assign", `Compare ${candidates.length} approaches`);

  // Score each candidate
  const scored = candidates.map(c => ({
    ...c,
    score: scoreApproach(c.result, c.worktreePath),
  }));

  // Log scores
  for (const s of scored) {
    const icon = s.score.succeeded ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    const tests = s.score.testsPassed
      ? `tests: ${s.score.testsPassed.passed}/${s.score.testsPassed.total}`
      : "tests: N/A";
    log(`  ${icon} ${s.approach.title}: quality=${s.score.qualityScore} diff=${s.score.diffStats.total}L ${tests}`);
  }

  // Sort by quality score (descending)
  const ranked = [...scored].sort((a, b) => b.score.qualityScore - a.score.qualityScore);

  // Check if we have a clear winner (>10 point lead)
  const top = ranked[0];
  const runnerUp = ranked[1];
  const margin = top.score.qualityScore - (runnerUp?.score.qualityScore || 0);

  let reasoning = `Selected "${top.approach.title}" with quality score ${top.score.qualityScore}`;
  let aiVerdict = null;

  // AI judge for close races (margin <= 10) or when both succeeded
  if (useAiJudge && margin <= 10 && runnerUp && isAiClientAvailable()) {
    try {
      const judgeResult = await aiJsonDecision({
        model: "claude-sonnet-4-6",
        system: [
          "You are a code quality judge comparing two implementation approaches.",
          "Evaluate based on: correctness, maintainability, simplicity, test coverage, and risk.",
          'Respond with ONLY JSON: {"winner": "A"|"B", "reasoning": "1-2 sentence justification",',
          '"confidence": 0.0-1.0}',
        ].join("\n"),
        prompt: [
          `TASK: ${task}`,
          "",
          `APPROACH A: ${top.approach.title}`,
          `Strategy: ${top.approach.strategy}`,
          `Output preview: ${(top.result.output || "").slice(0, 2000)}`,
          `Diff: ${top.score.diffStats.total} lines (${top.score.diffStats.files} files)`,
          `Exit: ${top.score.exitCode} | Duration: ${(top.score.durationMs / 1000).toFixed(1)}s`,
          "",
          `APPROACH B: ${runnerUp.approach.title}`,
          `Strategy: ${runnerUp.approach.strategy}`,
          `Output preview: ${(runnerUp.result.output || "").slice(0, 2000)}`,
          `Diff: ${runnerUp.score.diffStats.total} lines (${runnerUp.score.diffStats.files} files)`,
          `Exit: ${runnerUp.score.exitCode} | Duration: ${(runnerUp.score.durationMs / 1000).toFixed(1)}s`,
          "",
          "Which approach is better? Consider correctness first, then simplicity.",
        ].join("\n"),
        maxTokens: 256,
      });

      if (judgeResult.parsed) {
        aiVerdict = judgeResult.parsed;
        if (judgeResult.parsed.winner === "B") {
          // AI picked the runner-up — swap
          ranked[0] = runnerUp;
          ranked[1] = top;
          reasoning = `AI judge selected "${runnerUp.approach.title}": ${judgeResult.parsed.reasoning} (confidence: ${judgeResult.parsed.confidence})`;
        } else {
          reasoning = `AI judge confirmed "${top.approach.title}": ${judgeResult.parsed.reasoning} (confidence: ${judgeResult.parsed.confidence})`;
        }
        log(`  ${colors.dim}AI judge: ${reasoning}${colors.reset}`);
      }
    } catch (err) {
      log(`${colors.yellow}  ⚠ AI judge failed: ${err.message} — using score-based ranking${colors.reset}`);
    }
  }

  const winner = ranked[0];
  log(`\n  ${colors.bold}${colors.green}Winner: ${winner.approach.title}${colors.reset} (quality: ${winner.score.qualityScore}, margin: ${margin}pts)`);
  logIpc("selector", "orchestrator", "result",
    `Winner: ${winner.approach.title} (quality=${winner.score.qualityScore})`,
    { winnerId: winner.id, margin, aiVerdict });

  return {
    winner,
    ranked,
    scores: scored.map(s => ({
      id: s.id,
      title: s.approach.title,
      qualityScore: s.score.qualityScore,
      diffLines: s.score.diffStats.total,
      succeeded: s.score.succeeded,
    })),
    reasoning,
    aiVerdict,
  };
}

export { scoreApproach };

/**
 * lib/merge-pipeline.mjs — Worktree merge logic extracted from swarm.mjs
 *
 * Functions:
 *   collectWorktreeChanges(isolation, mainCwd) — validate + apply changes from one worktree
 *   runMergePipeline({ worktrees, mainDir })   — orchestrate merge for multiple worktrees
 */

import { execFileSync } from "node:child_process";
import { validateAndApply, cleanupIsolation } from "./isolation.mjs";

/**
 * Collect and apply changes from a single worktree.
 *
 * Calls validateAndApply on the isolation result and returns a structured outcome.
 *
 * @param {Object} isolation — isolation result from prepareWorktree
 * @param {boolean} isolation.success — whether worktree was created
 * @param {string} isolation.worktreePath — path to the worktree
 * @param {Object} isolation.snapshot — pre-change snapshot
 * @param {string} isolation.backupDir — backup directory path
 * @param {string[]} isolation.copiedUntracked — untracked files copied
 * @param {string} isolation.baseCommit — base commit hash
 * @param {string} mainCwd — main repository working directory
 * @returns {Promise<{ applied: boolean, files: string[], errors: string[], rolledBack: string[], escaped: string[] }>}
 */
export async function collectWorktreeChanges(isolation, mainCwd) {
  if (!isolation || !isolation.success) {
    return { applied: false, files: [], errors: ["isolation not available"], rolledBack: [], escaped: [] };
  }

  const apply = await validateAndApply(
    isolation.worktreePath,
    mainCwd,
    isolation.snapshot,
    isolation.backupDir,
    isolation.copiedUntracked,
    new Set(),  // excludePatterns
    [],         // extraValidations
    new Map(),  // fileOwnership
    new Set(),  // lockedFiles
    isolation.baseCommit,
  );

  return {
    applied: apply.valid,
    files: apply.applied || [],
    errors: apply.errors || [],
    rolledBack: apply.rolled_back || [],
    escaped: apply.escaped || [],
  };
}

/**
 * Run the merge pipeline for multiple worktrees.
 *
 * Applies changes from each worktree in sequence, collects results,
 * and cleans up all worktrees.
 *
 * @param {Object} opts
 * @param {Array<{id: string, isolation: Object, result?: Object}>} opts.worktrees
 *   — worktree entries (each with isolation result and optional agent result)
 * @param {string} opts.mainDir — main repository working directory
 * @param {boolean} [opts.cleanup=true] — whether to clean up worktrees after merge
 * @returns {Promise<{results: Array<{id: string, applied: boolean, files: string[], errors: string[]}>, totalApplied: number, totalFailed: number}>}
 */
export async function runMergePipeline({ worktrees, mainDir, cleanup = true }) {
  const results = [];
  let totalApplied = 0;
  let totalFailed = 0;

  for (const entry of worktrees) {
    const mergeResult = await collectWorktreeChanges(entry.isolation, mainDir);

    results.push({
      id: entry.id,
      ...mergeResult,
    });

    if (mergeResult.applied) {
      totalApplied++;
    } else {
      totalFailed++;
    }

    // Clean up worktree after processing
    if (cleanup && entry.isolation && entry.isolation.success) {
      cleanupIsolation(entry.isolation.worktreePath, entry.isolation.backupDir);
    }
  }

  return { results, totalApplied, totalFailed };
}

/**
 * Gather list of changed files from a worktree (git diff).
 *
 * @param {string} worktreePath — path to the worktree
 * @param {string} baseCommit — base commit to diff against
 * @returns {string[]} list of changed file paths (relative to worktree)
 */
export function getWorktreeChangedFiles(worktreePath, baseCommit) {
  try {
    const output = execFileSync("git", ["diff", "--name-only", baseCommit || "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
      cwd: worktreePath,
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

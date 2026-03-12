# Core Concepts

## Fork-join concurrency

<img src="../assets/modes.svg" width="800" alt="Fork-join in execution modes">

Arbor's parallel execution follows the fork-join model first described by Conway (1963). A single task forks into independent subtasks that run concurrently, then joins back together when all subtasks complete.

The decomposer agent splits work by **file scope** — each subtask gets a set of files it's allowed to modify, and no two subtasks share a file. This eliminates data races at the design level rather than relying on locks or coordination during execution.

When agents finish, the orchestrator joins their results: merging file changes, collecting output, and resolving any conflicts that arise from overlapping reads (agents can read shared files, they just can't write to the same ones).

## Worktree isolation

<img src="../assets/isolation.svg" width="800" alt="Isolation model">

Git worktrees are the foundation of Arbor's isolation model. Each agent gets its own worktree via `git worktree add`, which creates a full checkout of the repository at a separate path. The agent operates on this copy — it can read, write, run builds, execute tests — without affecting the main working directory or other agents.

This is different from branching. A worktree is a physical directory with its own checked-out files, not just a pointer in the reflog. Two worktrees can exist simultaneously, each with different file states, and git manages the bookkeeping.

After the agent finishes, Arbor copies changed files back to the main directory (if they pass validation) and removes the worktree.

## Snapshot-validate-apply

The merge process has three phases:

### 1. Snapshot (before execution)

Before an agent starts, Arbor hashes every file in the agent's scope using SHA-256 with an mtime pre-filter. If a file's modification time hasn't changed since the last snapshot, its hash is reused. This makes re-snapshotting cheap even for large repos.

The snapshot also records a backup — physical copies of the original files, stored in a temporary directory.

### 2. Validate (after execution)

When the agent finishes, Arbor re-hashes the worktree files and compares them against the pre-snapshot. Files whose hashes differ are candidates for merge. Each candidate goes through syntax validation:

- JavaScript/TypeScript: `node --check`
- Python: `py_compile`
- JSON: `JSON.parse()`
- YAML: basic structure check

Files that fail syntax validation are rejected. The agent's changes to those files are discarded.

### 3. Apply or rollback

Files that pass validation enter the three-way merge. Arbor uses `git merge-file` with the pre-snapshot version as the common ancestor, the agent's version as "theirs," and the current main directory version as "ours." This handles the case where the main directory changed while the agent was running (unlikely in practice, but possible if the user edits files during a swarm run).

If the merge produces conflicts, Arbor records them in the conflict report and falls back to the backup for those files. Clean merges are applied directly. If *everything* fails, the entire operation rolls back to the pre-execution backup.

## Agent roles

The orchestrator uses three specialized agent roles, each with a distinct system prompt:

### Worker

The default role for agents executing subtasks. Workers follow an explicit protocol: read before writing, verify after editing, stay within scope, and produce a completion checklist at the end. The checklist uses `[PASS]`, `[FAIL]`, and `[SKIP]` markers with file:line citations.

### Decomposer

A planning-only role. The decomposer receives the full task and project structure, then outputs a JSON array of subtasks — each with a title, detailed instructions, file scope, turn estimate, and model preference. The key constraint: no two subtasks may have overlapping file scopes.

### Verifier

An adversarial role that cross-checks worker outputs. The verifier extracts factual claims from each worker's output, compares them against the actual git diff, checks for silent omissions, audits edge cases, and produces a verdict: PASS, FAIL, or NEEDS_REWORK. Issues are classified as CRITICAL, MAJOR, or MINOR with file:line evidence.

## Depth presets

Depth controls how much compute each agent gets:

| Preset | Turns | Budget | Verify model | Use case |
|--------|-------|--------|-------------|----------|
| `shallow` | 10 | $5 | Sonnet | Quick exploration, simple fixes |
| `normal` | 25 | $15 | Sonnet | Most implementation tasks |
| `thorough` | 50 | $25 | Opus | Complex refactors, critical changes |

Turns limit the number of tool-use rounds per agent. Budget caps the total API spend. The verify model determines which model runs the verification pass — Opus catches more subtle issues but costs more.

## Error classification and retry

When an agent fails, Arbor doesn't just retry blindly. It sends the error output to a classification prompt that categorizes the failure:

- **Transient** — Network timeout, rate limit, temporary API error. Safe to retry immediately.
- **Deterministic** — Syntax error in the task, missing file, invalid configuration. Retrying won't help without changing the input.
- **Resource** — Context window exhaustion, budget exceeded. May succeed with different parameters (fewer turns, smaller scope).

The retry loop (opt-in via `--max-retries`) only retries transient failures. Deterministic failures surface immediately. Resource failures may trigger scope reduction in future versions.

## Escape detection

Even with worktree isolation, agents could theoretically affect shared state — environment variables, global npm packages, system files. Arbor's escape detection catches some of these cases by comparing pre- and post-snapshot hashes of files outside the agent's declared scope.

If a hash mismatch is detected outside the agent's scope, the entire agent run is flagged as "escaped" and its changes are rejected. This is a safety net, not a complete sandbox — it catches accidental scope violations, not adversarial attacks.

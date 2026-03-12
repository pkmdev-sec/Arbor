# Core Concepts

## Fork-join concurrency

<img src="../assets/modes.svg" width="800" alt="Fork-join in execution modes">

The decomposer splits work by **file scope**: each subtask gets files it may modify, and no two subtasks share a file. No shared files means no data races.

When agents finish, the orchestrator joins: merging file changes, collecting output, resolving conflicts from overlapping reads.

## Worktree isolation

<img src="../assets/isolation.svg" width="800" alt="Isolation model">

Each agent gets its own worktree via `git worktree add`. That's a full checkout at a separate path where the agent can read, write, build, and test without touching the main directory or other agents.

After the agent finishes, Arbor copies changed files back (if they pass validation) and removes the worktree.

## Snapshot-validate-apply

Three phases:

| Phase | What happens |
|-------|-------------|
| **Snapshot** | SHA-256 hash every file in scope (mtime pre-filter for speed). Store backup copies. |
| **Validate** | Re-hash worktree files after execution. Candidates go through syntax validation: `node --check` (JS/TS), `py_compile` (Python), `JSON.parse()` (JSON). |
| **Apply** | `git merge-file` three-way merge. Pre-snapshot as common ancestor, agent's version as "theirs," main directory as "ours." Conflicts fall back to backup. |

Full failure → entire operation rolls back to pre-execution backup.

## Agent roles

| Role | Purpose | Key behavior |
|------|---------|-------------|
| **Worker** | Executes subtasks | Read before write, verify after edit, stay in scope, produce `[PASS]`/`[FAIL]` checklist |
| **Decomposer** | Plans subtask split | Outputs JSON array of subtasks with title, instructions, file scope, turn estimate. No two subtasks overlap. |
| **Verifier** | Adversarial cross-check | Extracts claims from worker output, compares against actual diff, checks for omissions. Verdict: PASS / FAIL / NEEDS_REWORK |

## Depth presets

| Preset | Turns | Budget | Verify model | Use case |
|--------|-------|--------|-------------|----------|
| `shallow` | 10 | $5 | Sonnet | Quick exploration, simple fixes |
| `normal` | 25 | $15 | Sonnet | Most implementation tasks |
| `thorough` | 50 | $25 | Opus | Complex refactors, critical changes |

## Error classification

When an agent fails, Arbor classifies the error before deciding on retry:

| Class | Examples | Retry? |
|-------|----------|--------|
| **Transient** | Network timeout, rate limit, API error | Yes, safe to retry |
| **Deterministic** | Syntax error in task, missing file, bad config | No, retrying won't help |
| **Resource** | Context exhaustion, budget exceeded | No, reduce scope instead |

Retry is opt-in via `--max-retries`. Only transient failures are retried.

## Escape detection

Arbor compares pre/post-snapshot hashes of files **outside** the agent's declared scope. Hash mismatches flag an isolation escape and reject all changes from that agent run. This is a safety net for accidental scope violations, not a complete sandbox.

# Execution Modes

<img src="../assets/modes.svg" width="800" alt="All execution modes">

Arbor has five execution modes. The orchestrator picks one automatically based on task analysis, or you can force a specific mode with `--mode`.

## Auto-detection

When `--mode auto` (the default), the orchestrator runs `autoMode()` which examines:

- **Task text** — Keywords like "explore," "analyze," "review" suggest single or review mode. Words like "implement," "refactor," "add" suggest parallel or swarm.
- **Task scope** — If the task mentions many files or directories, parallel modes are preferred. Narrow scope suggests single mode.
- **Project structure** — The scout pass identifies language, test framework, and directory layout to inform decomposition.

The auto-detection is conservative. It picks `single` mode for ambiguous tasks and escalates to `parallel` or `swarm` only when there's clear evidence the task can be split.

## Single

```
Task → Agent → Result
```

One agent, one task, direct execution. This is the simplest mode and the fallback for tasks that can't be meaningfully decomposed.

**When to use:**
- Exploration and analysis ("explain how the auth flow works")
- Focused changes to a single file or small area
- Tasks where context continuity matters more than parallelism

**Behavior:**
- Spawns one `agent-entry.mjs` process
- No decomposition, no verification (unless explicitly requested)
- Default model: Sonnet. Use `-m opus` for complex reasoning.

```bash
arbor "explore the payment module"
swarm --mode single "fix the null check in src/utils/parser.ts"
```

## Parallel

```
Task → Decompose → [Agent, Agent, Agent] → Merge → Result
```

Fork-join execution. The decomposer splits the task into 2-5 independent subtasks, each agent runs concurrently in its own worktree, and results merge back together.

**When to use:**
- Multiple independent changes across different files
- Codebase-wide modifications (add logging, update imports, fix lint errors)
- Tasks where speed matters and subtasks don't depend on each other

**Behavior:**
- Decomposer agent creates subtasks with non-overlapping file scopes
- Up to `--agents N` run concurrently (default: 3, max: 5)
- Three-way merge resolves any conflicts at the join point
- No verification pass (use `swarm` mode if you want verification)

```bash
swarm --mode parallel --agents 4 "add input validation to all route handlers"
swarm --mode parallel "update error messages across the API"
```

## Pipeline

```
Task → Research → Implement → Test → Review → Result
```

Sequential stages, where each agent's output becomes context for the next. The task flows through a fixed pipeline: research the problem, implement the solution, run tests, and review the result.

**When to use:**
- Tasks that need research before implementation
- Changes where you want automated test verification
- Work that benefits from a built-in review step

**Behavior:**
- Stages run sequentially (not in parallel)
- Each stage gets the previous stage's output as context
- Default stages: research, implement, test, review
- The pipeline can short-circuit if an early stage determines the task is simpler than expected

```bash
swarm --mode pipeline "refactor the database connection pooling"
swarm --mode pipeline --depth thorough "migrate from REST to GraphQL"
```

## Swarm

```
Task → Decompose → [Agent, Agent, Agent] → Verify → Merge → Result
```

Like parallel mode, but with a verification pass after execution. The verifier agent adversarially cross-checks all worker outputs, comparing claims against actual diffs and checking for silent omissions.

**When to use:**
- High-stakes changes where correctness is critical
- Large refactors that touch many files
- Any task where you want an independent check on the agents' work

**Behavior:**
- Same decomposition and parallel execution as `parallel` mode
- After agents finish, a verifier agent inspects all results
- Verifier produces a verdict (PASS / FAIL / NEEDS_REWORK) with evidence
- The verdict is included in the swarm contract output
- Verification uses Sonnet by default, Opus with `--depth thorough`

```bash
swarm --mode swarm --verify "implement the billing integration"
swarm --mode swarm --depth thorough "rewrite the authentication system"
```

## Review

```
Task → Opus Agent → Verify → Result
```

Code review mode. A single Opus agent analyzes the input (typically a diff piped via stdin), then a verification pass double-checks the review for completeness.

**When to use:**
- Pre-merge code review
- Diff analysis
- Security audits of specific changes

**Behavior:**
- Single agent using Opus (regardless of `-m` flag)
- Verification pass always runs
- Input typically comes from stdin (piped diff)
- Output focuses on issues, risks, and suggestions rather than code changes

```bash
git diff main..feature | swarm --stdin --mode review
git diff HEAD~3 | swarm --stdin --mode review --verify
gh pr diff 42 | swarm --stdin --mode review
```

## Mode comparison

| | Single | Parallel | Pipeline | Swarm | Review |
|-|--------|----------|----------|-------|--------|
| Agents | 1 | 2-5 | 2-5 seq | 2-5 | 1 |
| Decomposition | No | Yes | Fixed stages | Yes | No |
| Parallel execution | No | Yes | No | Yes | No |
| Verification | No | No | Built-in | Yes | Yes |
| Default model | Sonnet | Sonnet | Sonnet | Sonnet | Opus |
| Worktree isolation | Yes | Yes | Yes | Yes | Yes |

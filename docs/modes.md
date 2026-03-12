# Execution Modes

<img src="../assets/modes.svg" width="800" alt="All execution modes">

Five modes. `autoMode()` picks one based on your task, or force a specific one with `--mode`.

## Auto-detection

`autoMode()` examines task text, scope, and project structure:
- Keywords like "explore," "analyze" → `single` or `review`
- Keywords like "implement," "refactor" + broad scope → `parallel` or `swarm`
- Conservative: defaults to `single` when ambiguous

## Single

One agent, direct execution. Fallback for tasks that can't be decomposed.

```bash
arbor "explore the payment module"
```

## Parallel

Fork-join. Decomposer splits into 2-5 independent subtasks, agents run concurrently in separate worktrees, results merge.

```bash
arbor-swarm --mode parallel --agents 4 "add input validation to all route handlers"
```

## Pipeline

Sequential stages: research → implement → test → review. Each agent's output becomes context for the next.

```bash
arbor-swarm --mode pipeline "refactor the database connection pooling"
```

## Swarm

Like parallel, plus a verification pass. Verifier adversarially cross-checks all worker outputs against actual diffs.

```bash
arbor-swarm --mode swarm --verify "implement the billing integration"
```

## Review

Single Opus agent analyzes input (typically a piped diff), then verification double-checks completeness.

```bash
git diff main..feature | arbor-swarm --stdin --mode review --verify
```

## Comparison

| | Single | Parallel | Pipeline | Swarm | Review |
|-|--------|----------|----------|-------|--------|
| Agents | 1 | 2-5 | 2-5 seq | 2-5 | 1 |
| Decomposition | No | Yes | Fixed stages | Yes | No |
| Parallel | No | Yes | No | Yes | No |
| Verification | No | No | Built-in | Yes | Yes |
| Default model | Sonnet | Sonnet | Sonnet | Sonnet | Opus |

# Advanced Orchestration

Guide to swarm modes, mode selection, and hierarchical decomposition patterns.

## Mode Selection

### auto (default)
AI-powered mode detection analyzes the task description:
- Review/audit keywords → `review`
- Multi-step "implement and test" → `pipeline`
- Large scope with file listing → `parallel`/`swarm`
- Small focused tasks → `single`

Override with `--mode` when auto-detection is wrong.

### single
One worker agent. Best for:
- Focused tasks in a single module
- Quick fixes under 50 lines
- Tasks where parallel overhead isn't worth it

### parallel
Decompose → N parallel workers → merge results. Best for:
- Multi-module changes with clear boundaries
- Tasks that split naturally into independent subtasks
- When you want speed but don't need cross-verification

### swarm
Like parallel, but adds scout + verification pass. Best for:
- Production-quality changes
- Tasks where correctness matters more than speed
- Cross-cutting concerns that need validation

### pipeline
Sequential stages: research → implement → test → review. Best for:
- Tasks where each stage depends on the previous
- Feature development with test requirements
- When you want thoroughness over speed

### review
Single Opus reviewer + verifier cross-check. Best for:
- Code review and security audits
- Architecture assessment
- When you want the highest quality analysis

### fork-merge
Generate N competing approaches → execute in parallel → compare → apply winner. Best for:
- Tasks with multiple valid implementation strategies
- When you want the "best" approach, not just the first
- Refactoring where different approaches have different tradeoffs

```bash
# Generate 3 approaches and pick the best
swarm --mode fork-merge --forks 3 "refactor auth module for testability"
```

**Scoring**: Exit code (40pts) + diff economy (30pts) + test results (30pts). AI judge breaks ties within 10 points.

### hierarchical
Multi-level tree decomposition for large-scale tasks. Best for:
- Monorepo-wide changes
- Tasks spanning 10+ files across multiple modules
- When flat decomposition produces too many subtasks

```bash
# Deep hierarchical decomposition
swarm --mode hierarchical --hierarchy-depth 3 --max-children 4 --agent-budget 20 "migrate to TypeScript"

# Preview plan without executing
swarm --mode hierarchical --estimate-only "refactor entire API layer"
```

## Hierarchical Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--hierarchy-depth` | 3 | Max tree depth (1-5) |
| `--max-children` | 4 | Max children per coordinator (2-8) |
| `--agent-budget` | 20 | Max total agents across all levels |
| `--min-task-files` | 3 | Minimum files to warrant sub-decomposition |
| `--decompose-by` | module-boundary | Strategy: module-boundary, directory, dependency-cluster |

## Depth Presets

| Preset | Turns | Budget | Use Case |
|--------|-------|--------|----------|
| shallow | 10 | $2 | Quick scans, simple fixes |
| normal | 20 | $5 | Standard development tasks |
| thorough | 40 | $10 | Complex features, audits |

## Verification

Verification is on by default for: swarm, pipeline, review, hierarchical, fork-merge.

The verifier:
1. Receives worker outputs + git diff + test results
2. Runs in read-only mode (no Write/Edit tools)
3. Produces a verdict: PASS, FAIL, or NEEDS_REWORK

Disable with `--no-verify` for speed.

## Semantic Merge

When multiple agents modify overlapping files, semantic merge resolves conflicts using LLM analysis instead of git's line-based merge.

- **On by default** for: swarm mode
- **Off by default** for: parallel mode
- Override with `--semantic-merge` / `--no-semantic-merge`

## Worktree Isolation

Every agent operates in its own git worktree:
1. `prepareWorktree()` creates a worktree from current HEAD
2. Agent makes changes in isolation
3. `validateAndApply()` validates changes and merges back
4. `cleanupIsolation()` removes the worktree

This prevents agents from interfering with each other or corrupting the main working tree.

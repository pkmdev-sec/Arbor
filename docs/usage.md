# Usage

## Prerequisites

- **Node.js 18+** — Arbor runs as ES modules
- **Claude Code** — The underlying AI runtime (`curl -fsSL https://claude.ai/install.sh | bash`)
- **Git** — Worktree isolation requires git 2.15+

## Installation

```bash
git clone <repo-url> && cd arbor
./install.sh
```

The installer does six things:

1. Checks prerequisites (Node.js version, Claude Code presence)
2. Runs `npm install` for dependencies
3. Symlinks `arbor` and `swarm` to `~/.local/bin/`
4. Copies hooks to `~/.claude/hooks/`
5. Registers hooks in `~/.claude/settings.json`
6. Creates the state directory for hook coordination

Make sure `~/.local/bin` is on your PATH. If not:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Single-agent usage

The `arbor` command runs one Claude Code agent in isolation:

```bash
# Explore a codebase area
arbor "explore the auth module and document the login flow"

# Use Opus for complex reasoning
arbor -m opus "refactor the error handling across all API routes"

# Set a higher budget for large tasks
arbor -b 25 -t 900 "migrate the database layer from Prisma to Drizzle"

# Read task from a file
echo "fix the race condition in the connection pool" | arbor --stdin

# Write structured output to a file
arbor --result-file output.json "list all API endpoints with their methods"
```

### Result files

When you use `--result-file`, Arbor writes a JSON object:

```json
{
  "exitCode": 0,
  "output": "The agent's text response...",
  "duration": 45.2,
  "toolCalls": 23,
  "model": "sonnet[1m]"
}
```

### Context files

Pass structured context into an agent with `--context-file`:

```json
{
  "project": "e-commerce API",
  "language": "TypeScript",
  "framework": "Express",
  "focus": ["src/routes/", "src/middleware/"],
  "constraints": ["Do not modify database schemas", "Keep backward compatibility"]
}
```

The context bridge converts this into a system prompt section that the agent sees at the start of its session.

## Multi-agent usage

The `swarm` command coordinates multiple agents:

```bash
# Auto-detect the best mode
swarm "implement user authentication with JWT tokens"

# Force parallel mode with 4 agents
swarm --mode parallel --agents 4 "add input validation to all API endpoints"

# Pipeline: research → implement → test → review
swarm --mode pipeline "refactor the payment processing module"

# Swarm with verification
swarm --mode swarm --verify "implement the notification system"

# Thorough mode for critical changes
swarm --mode swarm --depth thorough "rewrite the caching layer"

# Code review
git diff main..feature-branch | swarm --stdin --mode review --verify
```

### How decomposition works

When you run a swarm, the orchestrator first sends your task to a decomposer agent. The decomposer analyzes the task and project structure, then splits the work into 2-5 independent subtasks. Each subtask gets:

- A title and detailed instructions
- A file scope (which files the agent may modify)
- A turn estimate
- A model preference (Sonnet for implementation, Opus for complex reasoning)

The critical constraint: **no two subtasks share a file scope**. This eliminates merge conflicts by design. If two pieces of work need the same file, they go into the same subtask.

### Verification

In `swarm` and `review` modes, a verifier agent runs after the workers finish. The verifier:

1. Extracts every factual claim from worker outputs
2. Compares claims against the actual git diff
3. Checks for silent omissions (assigned work that wasn't mentioned)
4. Audits edge cases in the code changes
5. Produces a verdict: PASS, FAIL, or NEEDS_REWORK

The verification result is included in the swarm contract output.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_TTL_HOURS` | `24` | Hours before old run directories are cleaned up |
| `DEBUG` | - | Enable verbose debug output |
| `ANTHROPIC_API_KEY` | - | API key (usually inherited from Claude Code) |

## Troubleshooting

### "arbor not found"

Add `~/.local/bin` to your PATH, or run the installer again:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Agent fails with "context window exhausted"

Reduce the scope or use fewer turns:

```bash
arbor -n 15 "smaller, more focused task"
swarm --depth shallow "quick analysis"
```

### Merge conflicts after swarm run

This usually means the decomposer assigned overlapping file scopes. The conflict report in the swarm output identifies which files conflicted. Re-run with a more explicit task description that clarifies file boundaries, or use `--agents 2` to reduce parallelism.

### Hooks not firing

Check that the hooks are registered in `~/.claude/settings.json`:

```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep -A2 "auto_orchestrator"
```

If missing, re-run `./install.sh` to re-register them.

### Stale worktrees

If a run crashes mid-execution, worktrees may be left behind:

```bash
git worktree list    # see all worktrees
git worktree prune   # clean up stale entries
```

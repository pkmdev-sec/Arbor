# Usage

## Prerequisites

- **Node.js 18+**
- **Claude Code** (`curl -fsSL https://claude.ai/install.sh | bash`)
- **Git 2.15+** (needed for `git worktree`)

## Installation

```bash
git clone <repo-url> && cd arbor
./install.sh
```

The installer: checks prerequisites, runs `npm install`, symlinks `arbor` and `arbor-swarm` to `~/.local/bin/`, copies hooks to `~/.claude/hooks/`, registers hooks in `~/.claude/settings.json`, creates the state directory.

Ensure `~/.local/bin` is on your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

## Single-agent

```bash
arbor "explore the auth module and document the login flow"
arbor -m opus "refactor error handling across all API routes"
arbor -b 25 -t 900 "migrate the database layer from Prisma to Drizzle"
echo "fix the race condition in the pool" | arbor --stdin
arbor --result-file output.json "list all API endpoints"
```

### Result file format

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

Pass structured context with `--context-file`:

```json
{
  "project": "e-commerce API",
  "language": "TypeScript",
  "focus": ["src/routes/", "src/middleware/"],
  "constraints": ["Do not modify database schemas"]
}
```

## Multi-agent

```bash
arbor-swarm "implement user authentication with JWT tokens"
arbor-swarm --mode parallel --agents 4 "add input validation to all endpoints"
arbor-swarm --mode pipeline "refactor the payment processing module"
arbor-swarm --mode swarm --verify "implement the notification system"
arbor-swarm --mode swarm --depth thorough "rewrite the caching layer"
git diff main..feature | arbor-swarm --stdin --mode review --verify
```

### Decomposition

The decomposer splits tasks into 2-5 independent subtasks, each with:
- Title and detailed instructions
- File scope (no two subtasks share files)
- Turn estimate and model preference

### Verification

In `swarm` and `review` modes, a verifier extracts claims from worker outputs, compares against actual diffs, checks for omissions, and produces a verdict: PASS / FAIL / NEEDS_REWORK.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_TTL_HOURS` | `24` | Hours before old run directories are cleaned |
| `DEBUG` | - | Enable verbose output |
| `ANTHROPIC_API_KEY` | - | API key (usually inherited from Claude Code) |

## Troubleshooting

**"arbor not found"**: add `~/.local/bin` to PATH. `export PATH="$HOME/.local/bin:$PATH"`

**"context window exhausted"**: reduce scope. `arbor -n 15 "smaller task"` or `arbor-swarm --depth shallow`

**Merge conflicts**: the decomposer assigned overlapping scopes. Re-run with `--agents 2` or explicit file boundaries.

**Hooks not firing**: check `cat ~/.claude/settings.json | python3 -m json.tool | grep auto_orchestrator`. Re-run `./install.sh` if missing.

**Stale worktrees**: `git worktree list && git worktree prune`

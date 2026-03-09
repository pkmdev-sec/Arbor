# remote-agent

Autonomous Claude Code executor with parallel swarm orchestration. Spawns isolated Claude Code subprocesses with fresh 1M context windows — solving the context pollution problem that degrades quality in long sessions.

## What it does

When you're in a Claude Code session and ask it to explore a codebase, implement a feature, or debug an issue, **remote-agent** handles the work in isolated subprocesses instead of polluting your main session's context window.

```
Main Claude Session (stays lean at 20-30% context)
  │
  ├─ You: "explore the codebase and map all component connectivity"
  │
  ├─ Orchestrator classifies task → RESEARCH, parallel mode, 4 agents
  │
  ├─ swarm decomposes into 4 subtasks by directory
  │   ├─ agent-01: src/models/     ─┐
  │   ├─ agent-02: src/services/   ─┤ run in parallel
  │   ├─ agent-03: src/components/ ─┤ fresh 1M context each
  │   └─ agent-04: src/utils/      ─┘
  │
  ├─ Results merged into structured JSON
  │
  └─ Main session reads summary (2KB, not 200KB of raw files)
```

## Prerequisites

- **Node.js 18+**
- **Claude Code** — `curl -fsSL https://claude.ai/install.sh | bash`
- **`ANTHROPIC_API_KEY`** environment variable set (for the AI task classifier)
- **Python 3** (for hook scripts)

## Install

```bash
git clone https://github.com/yourusername/remote-agent.git
cd remote-agent
./install.sh
```

The installer:
1. Installs `@anthropic-ai/claude-code` npm dependency
2. Symlinks `remote-agent` and `swarm` to `~/.local/bin/`
3. Copies hook scripts to `~/.claude/hooks/`
4. Registers hooks in `~/.claude/settings.json`
5. Creates isolated subprocess config (no hooks, no MCP)

## Usage

### Single agent

```bash
# Simple task
remote-agent "explore src/auth/ and map the authentication flow"

# With result file
remote-agent -m sonnet --result-file /tmp/result.json "analyze the data models"

# Pipe input
git diff HEAD~1 | remote-agent --stdin -m opus "review this diff for bugs"

# With context from prior work
remote-agent --context-file ctx.json --result-file result.json "implement the feature"
```

### Swarm (parallel agents)

```bash
# Auto-detect mode
swarm "explore the entire codebase architecture"

# Explicit parallel with 4 agents
swarm --mode parallel --agents 4 --result-file /tmp/swarm.json "map all modules"

# Full swarm with verification
swarm --mode swarm --agents 3 --depth thorough --verify "implement OAuth with tests"

# Pipeline (sequential stages)
swarm --mode pipeline --verify "refactor the database layer"

# Code review
git diff | swarm --stdin --mode review --verify "security audit"
```

### Swarm modes

| Mode | Pattern | When |
|------|---------|------|
| `parallel` | Decompose → N agents → merge | Research, exploration |
| `swarm` | Decompose → N agents → verify | Large implementations |
| `pipeline` | Research → Implement → Test → Review | Refactoring, features |
| `single` | 1 agent + optional verifier | Debugging, focused fixes |
| `review` | Opus reviewer + verifier | Code review, audits |

### Depth presets

| Depth | Turns | Budget | Verify model |
|-------|-------|--------|-------------|
| `shallow` | 10 | $5 | sonnet |
| `normal` | 25 | $15 | sonnet |
| `thorough` | 50 | $25 | opus |

## How it works

### Architecture

```
remote-agent (agent-entry.mjs)
  │ Supervisor process — spawns cli.js as child process
  │
  ├─ Parses CLI flags
  ├─ Reads --context-file → injects as --append-system-prompt
  ├─ Spawns: node cli.js -p --model sonnet[1m] --team-name ... "task"
  ├─ Streams stderr live (tool activity, file reads, etc.)
  ├─ Captures stdout → result
  ├─ Writes --result-file on exit
  └─ Cleans up team directory

swarm (swarm.mjs)
  │ Multi-agent orchestrator — spawns N remote-agents
  │
  ├─ Phase 1: DECOMPOSE — scans project structure, splits into subtasks
  ├─ Phase 2: EXECUTE — spawns agents in parallel (Promise.all)
  ├─ Phase 3: VERIFY — opus agent cross-checks claims vs git diff
  └─ Phase 4: REPORT — writes completion contract JSON
```

### Nesting bypass

Claude Code blocks spawning itself inside itself (`CLAUDECODE=1` guard). We bypass via:
1. **Team triple**: `--team-name` + `--agent-id` + `--agent-name` (legitimate mechanism)
2. **`CLAUDECODE=""`**: Empty string passes the `=== "1"` check

### Isolation

Each subprocess gets:
- **Fresh 1M context** via `sonnet[1m]` / `opus[1m]`
- **No hooks** — `CLAUDE_CONFIG_DIR` points to minimal config with `disableAllHooks: true`
- **No MCP servers** — clean config has no MCP registrations
- **Full tool access** — Read, Write, Edit, Bash, Grep, Glob
- **No session persistence** — `--no-session-persistence` for clean disposal

### Hook enforcement

The orchestrator uses Claude Code hooks to enforce remote-agent usage:

1. **`auto_orchestrator.py`** (UserPromptSubmit) — AI-powered task classifier using Haiku. Determines task type, mode, agents, depth. Writes `DELEGATE` state file + pre-computed swarm command.

2. **`block_agent_tool.py`** (PreToolUse: Agent, Read, Glob, Grep) — When `DELEGATE` active, blocks Claude from using Agent/Read/Glob/Grep directly. Forces Bash with swarm command.

3. **`fulfill_delegate.py`** (PostToolUse: Bash) — When Bash runs remote-agent/swarm, transitions state from `DELEGATE` → `FULFILLED`, unblocking all tools for follow-up work.

4. **`block_task_tools.py`** (PreToolUse: TaskCreate, etc.) — Blocks Claude's internal task system, redirects to `bd` CLI for persistent task tracking.

### State lifecycle

```
User prompt → orchestrator writes DELEGATE + swarm command
  │
  ├─ Claude tries Agent → BLOCKED "Use Bash: swarm ..."
  ├─ Claude tries Read  → BLOCKED "Use Bash: swarm ..."
  ├─ Claude tries Glob  → BLOCKED "Use Bash: swarm ..."
  │
  └─ Claude uses Bash with swarm → ALLOWED
       └─ PostToolUse transitions DELEGATE → FULFILLED
           └─ All tools unblocked for follow-up
```

## Configuration

### Models

Only `sonnet` and `opus` are allowed — both resolve to 1M context variants (`sonnet[1m]`, `opus[1m]`). Haiku is not supported.

### Agent roles

Agents receive role-specific system prompts:

- **worker**: Must produce a completion checklist (PASS/FAIL/SKIP per item)
- **verifier**: Adversarial cross-checking — compares claims against git diff
- **decomposer**: Outputs JSON array of non-overlapping subtasks

### Context file schema

Pass prior knowledge from the main session:

```json
{
  "task": {
    "scope": ["src/models/"],
    "constraints": ["Read-only", "Focus on exports"]
  },
  "prior_knowledge": {
    "decisions": ["Using Prisma ORM"],
    "file_summaries": { "src/auth.ts": "JWT middleware" }
  }
}
```

### Result file schema (completion contract)

```json
{
  "version": 2,
  "task": "explore codebase",
  "mode": "parallel",
  "agents": [
    {
      "id": "agent-01",
      "subtask": "Explore src/models/",
      "status": "completed",
      "output": "full agent output text...",
      "duration_ms": 25000
    }
  ],
  "merged_output": "all agent outputs combined with headers",
  "verification": { "output": "VERDICT: PASS", "model": "opus" },
  "summary": { "total_agents": 4, "completed": 4, "failed": 0 }
}
```

## File structure

```
remote-agent/
├── agent-entry.mjs      # Single agent supervisor (spawns cli.js subprocess)
├── swarm.mjs            # Multi-agent orchestrator (decompose → parallel → verify)
├── config/
│   └── settings.json    # Isolated config for subprocesses (no hooks, full permissions)
├── hooks/
│   ├── auto_orchestrator.py   # AI task classifier + swarm command generator
│   ├── block_agent_tool.py    # PreToolUse enforcer (blocks Agent/Read/Glob/Grep during DELEGATE)
│   ├── fulfill_delegate.py    # PostToolUse transition (DELEGATE → FULFILLED after Bash)
│   └── block_task_tools.py    # Blocks internal task tools → redirects to bd CLI
├── package.json
├── install.sh           # One-command installer
└── README.md
```

## Troubleshooting

**"Error: Claude Code cannot be launched inside another Claude Code session"**
The nesting guard is blocking subprocess spawning. Ensure `CLAUDECODE` is not set to `"1"` in your environment.

**Agent/Read/Glob blocked unexpectedly**
The delegation state is stale. Clear it: `echo '{"mode":"DIRECT"}' > ~/.claude/hooks/.acontext_state/delegate_mode.json`

**"This model does not support the effort parameter"**
Remove `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` from your `~/.claude/settings.json` — it breaks sonnet/haiku.

**Hooks not firing in a project**
Hooks load at session start. If you modified settings.json, start a **new** session (don't `--resume`).

**Blocking yourself when editing the orchestrator**
The blocker has an escape hatch: if the working directory contains `/.claude`, it never blocks.

## License

MIT

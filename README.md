<div align="center">
  <img src="assets/banner.svg" width="800" alt="Arbor">
</div>

---

Arbor spawns isolated Claude Code agents in separate git worktrees, each with a fresh 1M token context, and merges their work back when they're done.

## Architecture

<img src="assets/architecture.svg" width="800" alt="Architecture">

## Quick start

```bash
git clone <repo-url> && cd arbor
./install.sh

# Single agent
arbor "explore the auth module"
arbor -m opus "refactor error handling in lib/"

# Multi-agent
arbor-swarm --mode parallel --agents 3 "analyze the codebase"
arbor-swarm --mode swarm --verify "implement feature X"

# Code review
git diff | arbor-swarm --stdin --mode review --verify
```

## Execution modes

<img src="assets/modes.svg" width="800" alt="Execution Modes">

| Mode | Agents | Pattern | Best for |
|------|--------|---------|----------|
| `single` | 1 | Direct execution | Focused tasks, exploration |
| `parallel` | 2-5 | Fork, execute, merge | Independent changes across files |
| `pipeline` | 2-5 | Sequential stages | Research → implement → test → review |
| `swarm` | 2-5 | Fork, execute, **verify**, merge | High-stakes changes needing validation |
| `review` | 1 | Opus + verify | Code review with adversarial checking |

## Isolation model

<img src="assets/isolation.svg" width="800" alt="Isolation">

Three layers of protection per agent:

1. **Worktree isolation**: `git worktree add` gives each agent a full repo copy
2. **Snapshot validation**: SHA-256 hashing before and after execution. Mismatches outside the declared scope flag an escape.
3. **Syntax-gated merge**: changes only land if they parse cleanly. Failures trigger rollback.

## Data flow

<img src="assets/data-flow.svg" width="600" alt="Data Flow">

## Modules

<img src="assets/module-graph.svg" width="800" alt="Module Dependencies">

```
arbor/
├── agent-entry.mjs        CLI supervisor (arbor)
├── swarm.mjs              Orchestrator (arbor-swarm)
└── lib/
    ├── orchestration.mjs   Decompose, execute, verify, merge
    ├── isolation.mjs       Snapshot, validate, apply, rollback
    ├── agent-spawn.mjs     Subprocess management
    ├── config.mjs          Models, roles, depth presets
    ├── cli.mjs             Argument parsing, help text
    ├── context-bridge.mjs  Context file ↔ system prompt
    ├── lifecycle.mjs       Task tracking, cleanup
    ├── telemetry.mjs       Tool call and memory tracking
    └── output.mjs          TTY-aware colors, logging
```

## CLI reference

### `arbor`

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --model` | `sonnet` | `sonnet` or `opus` |
| `-b, --budget` | `15` | Max budget (USD) |
| `-t, --timeout` | `600` | Timeout (seconds) |
| `-n, --turns` | `50` | Max tool-use turns |
| `--result-file` | - | Write JSON result to file |
| `--context-file` | - | Read structured context from file |
| `--stdin` | - | Read task from stdin |
| `-q, --quiet` | - | Suppress status output |

### `arbor-swarm`

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `auto` | `single` / `parallel` / `pipeline` / `swarm` / `review` |
| `--agents` | `3` | Max parallel agents (1-5) |
| `--depth` | `normal` | `shallow` / `normal` / `thorough` |
| `--verify` / `--no-verify` | auto | Force or skip verification |
| `--timeout` | `600` | Per-agent timeout (seconds) |

### Depth presets

| Preset | Turns | Budget | Verify model |
|--------|-------|--------|-------------|
| `shallow` | 10 | $5 | Sonnet |
| `normal` | 25 | $15 | Sonnet |
| `thorough` | 50 | $25 | Opus |

## Hooks

Four Claude Code hooks handle routing:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `auto_orchestrator.py` | `UserPromptSubmit` | Classifies prompts, routes to Arbor |
| `block_agent_tool.py` | `PreToolUse` | Prevents raw agent spawning |
| `fulfill_delegate.py` | `PostToolUse` | Detects delegated command completion |
| `block_task_tools.py` | `PreToolUse` | Redirects task tools to `bd` CLI |

## Documentation

| Doc | Covers |
|-----|--------|
| [Architecture](docs/architecture.md) | System design, data flow, module responsibilities |
| [Concepts](docs/concepts.md) | Worktree isolation, snapshot validation, merge |
| [Usage](docs/usage.md) | Installation, configuration, examples |
| [Modes](docs/modes.md) | Execution mode details and flow diagrams |
| [Hooks](docs/hooks.md) | Hook system, state machine, customization |

## Contributors

<a href="https://github.com/pkmdev-sec">
  <img src="https://github.com/pkmdev-sec.png" width="60" style="border-radius:50%" alt="pkmdev-sec">
</a>

**[pkmdev-sec](https://github.com/pkmdev-sec)**

## License

MIT

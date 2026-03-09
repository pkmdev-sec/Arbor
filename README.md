<div align="center">
  <img src="assets/logo.svg" width="120" alt="remote-agent">
  <h1>remote-agent</h1>
  <p><b>Multi-agent orchestration for Claude Code with worktree isolation</b></p>
</div>

## What it does

Spawn isolated Claude Code agents with fresh 200K context windows.
Decompose tasks, run agents in parallel, verify results, apply changes safely.

## Quick start

```bash
remote-agent "explore the auth module"
swarm --mode parallel --agents 3 "analyze the codebase"
swarm --mode swarm --verify "implement feature X"
swarm --mode pipeline "refactor the API layer"
git diff | swarm --stdin --mode review --verify
```

## Architecture

<img src="assets/architecture.svg" width="800" alt="Architecture">

## Execution modes

<img src="assets/modes.svg" width="800" alt="Execution Modes">

## Isolation model

<img src="assets/isolation.svg" width="800" alt="3-Layer Isolation">

## Modules

```
remote-agent/
├── agent-entry.mjs      ← CLI supervisor (484 lines)
├── swarm.mjs            ← orchestrator (219 lines)
└── lib/
    ├── output.mjs       ← colors, logging
    ├── config.mjs       ← models, roles, presets
    ├── cli.mjs          ← arg parsing, help text
    ├── telemetry.mjs    ← tool call tracking
    ├── context-bridge.mjs ← context ↔ system prompt
    ├── agent-spawn.mjs  ← subprocess spawning
    ├── lifecycle.mjs    ← bd tasks, cleanup
    ├── isolation.mjs    ← snapshot, worktree, rollback
    └── orchestration.mjs ← decompose, parallel, verify
```

<img src="assets/module-graph.svg" width="800" alt="Module Dependencies">

## CLI reference

### `remote-agent`

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --model` | `sonnet` | Model: sonnet or opus (both 1M) |
| `-b, --budget` | `15` | Max budget in USD |
| `-t, --timeout` | `600` | Timeout in seconds |
| `-n, --turns` | `50` | Max tool-use turns |
| `--result-file` | — | Write JSON result |
| `--context-file` | — | Read structured context |
| `--stdin` | — | Read task from stdin |
| `--max-retries` | `0` | Retry on failure (opt-in) |
| `-q, --quiet` | — | Suppress status |

### `swarm`

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `auto` | single/parallel/pipeline/swarm/review |
| `--agents` | `3` | Max parallel agents (1-5) |
| `--depth` | `normal` | shallow/normal/thorough |
| `--verify/--no-verify` | auto | Verification pass |
| `--result-file` | — | Write JSON contract |
| `--timeout` | `600` | Per-agent timeout |
| `--bd-task` | — | Beads task tracking |

## License

MIT

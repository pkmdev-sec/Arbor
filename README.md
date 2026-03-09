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

```
┌─────────────────────────┐
│   Main Claude Session   │
│  (Opus 4.6 · 1M · hooks)│
└────────────┬────────────┘
             │ DELEGATE
    ┌────────▼────────┐
    │    swarm.mjs    │
    │   orchestrator  │
    └──┬─────┬─────┬──┘
       │     │     │
  ┌────▼┐ ┌─▼──┐ ┌▼────┐
  │ A-1 │ │A-2 │ │ A-3 │  ← agent-entry.mjs
  │200K │ │200K│ │200K │  ← fresh context each
  └──┬──┘ └─┬──┘ └──┬──┘
     │      │       │
  ┌──▼──┐┌──▼──┐┌───▼──┐
  │ wt-1││wt-2 ││ wt-3 │  ← git worktrees
  └─────┘└─────┘└──────┘
```

> [Interactive diagram](assets/diagrams/architecture.html)

## Execution modes

```
Mode       Flow                                    Use Case
─────────  ──────────────────────────────────────  ─────────────────
single     task → agent → result                   Bug fixes
parallel   task → decompose → agents → merge       Research
pipeline   task → research → impl → test → review  Features
swarm      task → decompose → agents → verify      Large impl
review     task → opus → verify → result            Code review
```

> [Interactive diagram](assets/diagrams/modes.html)

## Isolation model

```
BEFORE              DURING                AFTER
─────────────────   ────────────────────  ─────────────────────
snapshot files      agent runs in         ┌─ validate ✓ → apply
(SHA-256 hashes)    isolated worktree     │
backup sources      ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌   └─ validate ✗ → rollback
                    escape detection:          ↑ restore from backup
                    absolute-path writes
                    caught by hash diff
```

> [Interactive diagram](assets/diagrams/isolation.html)

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

> [Interactive graph](assets/diagrams/module-graph.html)

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

# Architecture

<img src="../assets/architecture.svg" width="800" alt="Architecture">

## Overview

Arbor is structured as a two-layer system: a **supervisor** that manages a single agent, and an **orchestrator** that coordinates multiple supervisors running in parallel.

The supervisor (`agent-entry.mjs`) handles the lifecycle of one Claude Code subprocess — argument resolution, process spawning, output capture, retry logic, and result extraction. The orchestrator (`swarm.mjs`) sits above the supervisor and manages decomposition, parallel execution, verification, and merge.

Neither layer knows about the internals of the other. The supervisor exposes a simple contract: give it a task string and configuration, it returns a JSON result. The orchestrator consumes that contract to run multiple supervisors concurrently.

## Data flow

```
User prompt
  │
  ▼
┌──────────────────┐
│  Claude Code      │  Main session with hooks active
│  (Opus 4.6, 1M)  │
└────────┬─────────┘
         │  hooks intercept
         ▼
┌──────────────────┐
│  auto_orchestrator│  Classifies: DIRECT / DELEGATE / ORCHESTRATE
│  (PreToolUse)     │
└────────┬─────────┘
         │  if ORCHESTRATE
         ▼
┌──────────────────┐
│  swarm.mjs        │  Orchestrator
│  - autoMode()     │  Picks execution mode
│  - decompose()    │  Splits into subtasks
│  - execute*()     │  Runs agents in parallel
│  - verify()       │  Cross-checks results
│  - buildContract()│  Packages final output
└────────┬─────────┘
         │  spawns N agents
         ▼
┌──────────────────┐
│  agent-entry.mjs  │  × N (one per subtask)
│  - isolated env   │
│  - fresh 1M ctx   │
│  - no hooks       │
│  - own worktree   │
└────────┬─────────┘
         │  writes to worktree
         ▼
┌──────────────────┐
│  isolation.mjs    │  Snapshot → Validate → Apply/Rollback
└──────────────────┘
```

## Module responsibilities

### Entry points

**agent-entry.mjs** — The single-agent supervisor. Resolves the Claude Code CLI path, parses arguments, builds the subprocess environment, manages the retry loop with AI-assisted error classification, and writes the result file. This is the binary that `arbor` symlinks to.

**swarm.mjs** — The multi-agent orchestrator. Parses swarm-specific arguments, selects an execution mode, and coordinates the full decompose-execute-verify-merge pipeline. This is the binary that `swarm` symlinks to.

### Core modules

**orchestration.mjs** — The brain of the orchestrator. Contains:
- `autoMode()` — Analyzes task text and project structure to pick an execution mode
- `scoutProject()` — Quick project reconnaissance (language, test framework, structure)
- `decompose()` — Sends the task to a decomposer agent that returns independent subtasks with file scopes
- `executeParallel()` — Runs agents concurrently with worktree isolation
- `executePipeline()` — Runs agents sequentially, passing context forward
- `verify()` — Sends all results to a verifier agent for adversarial cross-checking
- `buildContract()` — Packages everything into a structured JSON output

**isolation.mjs** — The safety net. Handles:
- `snapshotFiles()` — SHA-256 hashing of files with mtime pre-filter for performance
- `backupFiles()` — Copies originals before agent execution
- `validateAndApply()` — Syntax checking, three-way merge via `git merge-file`, conflict detection, and atomic rollback
- `rollbackFromBackup()` — Restores originals when validation fails

### Supporting modules

**config.mjs** — Constants and configuration: allowed models, role-specific system prompts (worker, verifier, decomposer), depth presets, file extension filters.

**cli.mjs** — Argument parsing with two-row Levenshtein distance for flag typo correction. Generates help text for both `arbor` and `swarm` commands.

**agent-spawn.mjs** — Thin wrapper around `child_process.spawn`. Sets up the subprocess environment with `Object.create(null)` for a clean env, enforces the 50MB stdout cap, and manages process lifecycle.

**context-bridge.mjs** — Bidirectional conversion between structured context files (JSON) and system prompt text. Used to pass project context from the orchestrator into agent subprocesses.

**lifecycle.mjs** — Process cleanup handlers for all exit paths (SIGINT, SIGTERM, uncaught exceptions), beads task tracking (claim/close), and stale run directory cleanup.

**telemetry.mjs** — Tracks tool call counts and memory high-water marks per agent. Uses module-scope state to avoid cross-agent pollution.

**output.mjs** — TTY-aware ANSI color constants and a `log()` function that writes to stderr.

## Process isolation

Every agent subprocess runs with:

- **Fresh 1M context window** — No bleed-through from the parent session or other agents
- **No hooks** — `disableAllHooks: true` prevents recursive orchestration
- **Clean environment** — `Object.create(null)` base env prevents variable leakage
- **Own worktree** — `git worktree add` provides a full repo copy
- **Scoped file access** — Each agent's task specifies which files it may modify
- **Budget and timeout caps** — Hard limits prevent runaway execution

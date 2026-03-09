# remote-agent

Isolated Claude Code supervisor for spawning fresh AI agent subprocesses. Each agent gets its own context window, config directory, and optional git worktree — no hook recursion, no context pollution, no nesting guards.

**Two entry points:**
- **`remote-agent`** (agent-entry.mjs) — Spawns a single Claude Code subprocess with isolated config. Supervisor pattern: parses flags, builds child args, streams output, writes structured results.
- **`swarm`** (swarm.mjs) — Multi-agent orchestrator. Decomposes tasks, runs agents in parallel or pipeline, verifies results, produces completion contracts.

## Directory Structure

```
remote-agent/
├── agent-entry.mjs          # Single-agent supervisor (CLI entry point)
├── swarm.mjs                # Multi-agent orchestrator (CLI entry point)
├── package.json             # Dependencies: @anthropic-ai/claude-code
├── config/
│   ├── settings.json        # Isolated permissions (all hooks disabled, dontAsk mode)
│   └── policy-limits.json   # Feature restrictions (no remote sessions/control)
└── lib/
    ├── output.mjs           # TTY-aware colors and quiet-suppressible log()
    ├── config.mjs           # Constants: models, depth presets, role prompts, buffer limits
    ├── cli.mjs              # CLI argument parsing and help text for both entry points
    ├── context-bridge.mjs   # Context file → system prompt conversion, result I/O
    ├── telemetry.mjs        # Parse stderr/stdout for tool call counts and quality signals
    ├── lifecycle.mjs        # Beads (bd) task tracking and directory cleanup
    ├── agent-spawn.mjs      # Agent subprocess spawning (used by swarm)
    ├── isolation.mjs        # Git worktree isolation: snapshot, backup, validate, apply/rollback
    └── orchestration.mjs    # Swarm workflow phases: decompose, execute, verify, report
```

## Dependency Graph

```
output.mjs ─────────────────────────────────────── (no internal deps)
config.mjs ─────────────────────────────────────── (no internal deps)

telemetry.mjs ──────── config.mjs
cli.mjs ────────────── output.mjs
context-bridge.mjs ─── output.mjs
lifecycle.mjs ──────── output.mjs
agent-spawn.mjs ────── output.mjs
isolation.mjs ──────── output.mjs, config.mjs

orchestration.mjs ──── output.mjs, config.mjs, agent-spawn.mjs,
                       context-bridge.mjs, isolation.mjs

agent-entry.mjs ────── output.mjs, config.mjs, cli.mjs,
                       context-bridge.mjs, telemetry.mjs, lifecycle.mjs

swarm.mjs ──────────── output.mjs, config.mjs, cli.mjs,
                       agent-spawn.mjs, orchestration.mjs,
                       isolation.mjs, lifecycle.mjs
```

## How It Works

### agent-entry.mjs — Single Agent Supervisor

1. **Resolves CLI_JS** — Finds `@anthropic-ai/claude-code/cli.js` via local `node_modules/` first, then falls back to `import.meta.resolve`.
2. **Parses flags** — Model, budget, timeout, turns, context file, result file, stdin, retries (via `lib/cli.mjs`).
3. **Builds child args** — Constructs the full `node cli.js -p [flags] "task"` command with `--permission-mode dontAsk`, `--dangerously-skip-permissions`, `--no-session-persistence`.
4. **Injects system prompt** — Combines role-specific prompts (`ROLE_PROMPTS`), context file content (`contextToSystemPrompt`), and custom system prompts via `--append-system-prompt`.
5. **Bypasses nesting guard** — Provides the full team triple (`--team-name`, `--agent-id`, `--agent-name`) and clears `CLAUDECODE` env var.
6. **Isolates config** — Sets `CLAUDE_CONFIG_DIR` to `config/` directory (hooks disabled, all permissions granted). Deletes feature-flag env vars (`CLAUDE_CODE_ENABLE_TASKS`, etc.).
7. **Spawns subprocess** — Runs with a ring buffer (50MB cap) for stdout/stderr, 30-second progress interval, and progressive timeout (SIGINT → SIGTERM → SIGKILL).
8. **Retry loop** — Retries on non-zero, non-timeout exits with exponential backoff (1s, 2s, 4s). Skips retry if budget < $2.
9. **Writes result** — Structured JSON with status, output (500KB cap), duration, telemetry (tool counts, checklist parsing, quality signals).
10. **Lifecycle** — Claims bd task on start, closes on success (leaves open on failure). Cleans up team directory (`~/.claude/teams/<name>/`).

### swarm.mjs — Multi-Agent Orchestrator

Five modes, selectable via `--mode` or auto-detected from task keywords:

| Mode | Behavior |
|------|----------|
| **single** | 1 worker agent (+ optional verifier) |
| **parallel** | Decompose task → scout project structure in parallel → N workers → merge |
| **pipeline** | Sequential stages: RESEARCH → IMPLEMENT → TEST → REVIEW |
| **swarm** | Decompose → parallel workers → verify → report (same as parallel + verify) |
| **review** | 1 Opus reviewer (+ optional verifier) |
| **auto** | Score-based keyword matching to select mode |

**Auto-mode scoring** (`autoMode()` in orchestration.mjs):
- "review/audit/check/inspect" → review (weight 3)
- "fix/bug/debug/crash/error/broken" → single (weight 2)
- "explore/analyze/understand/map/research/investigate" → parallel (weight 2)
- "refactor/restructure/clean/reorganize" → pipeline (weight 2)
- "implement/build/create" + scope words → swarm (weight 3); without scope → pipeline (weight 2)
- Tie-breaking order: single > pipeline > parallel > swarm > review

**Parallel mode flow:**
1. Decomposer agent splits task into N subtasks (scoped to directories/modules)
2. Scout agent scans project structure simultaneously (parallel with decomposition)
3. N worker agents run in parallel, each in its own git worktree
4. Scout summary injected as informational context to workers
5. Results validated and applied per-agent with cumulative `knownApplied` tracking
6. Optional verifier cross-checks all outputs against actual git diff

**Pipeline mode stages:**
1. RESEARCH (sonnet, 15 turns) — Map codebase, list files and architecture
2. IMPLEMENT (sonnet, depth-preset turns) — Execute the task
3. TEST (sonnet, 20 turns) — Run tests, fix failures
4. REVIEW (opus, 15 turns) — Adversarial review, find and fix bugs

### Worktree Isolation

Each agent in swarm mode gets an isolated git worktree. The cycle:

1. **Prepare** (`prepareWorktree`):
   - `git worktree add <path> --detach` creates a detached HEAD worktree
   - Untracked files copied from mainCwd (preserving directory structure)
   - `node_modules/` symlinked (not copied — too large)
   - Pre-snapshot: SHA-256 hash of every file in mainCwd (for escape detection)
   - Backup: source files matching code extensions copied for potential rollback

2. **Agent runs** in the worktree directory

3. **Validate and Apply** (`validateAndApply`):
   - Detect worktree changes via `git diff --name-only` (modified, added, deleted)
   - Detect new untracked files created by the agent
   - Detect modifications to copied untracked files (hash comparison)
   - **Escape detection**: post-snapshot of mainCwd compared to pre-snapshot — catches agents that wrote to absolute paths outside the worktree
   - Syntax validation gate: `node --check` for `.mjs/.js/.cjs`, `py_compile` for `.py`
   - If all valid → copy worktree changes to mainCwd, escaped files stay in place
   - If any validation fails → rollback escaped files from backup, discard worktree changes

4. **Cleanup** (`cleanupIsolation`):
   - `git worktree remove --force`
   - `rmSync` backup directory

### Nesting Guard Bypass

Claude Code prevents recursive spawning via two mechanisms. remote-agent bypasses both:

1. **Team triple** — Passes `--team-name remote-<uuid>`, `--agent-id <uuid>`, `--agent-name remote-agent` to the child process. This tells Claude Code it's part of a legitimate agent team, not an accidental recursion.
2. **CLAUDECODE env var** — Set to empty string (`env.CLAUDECODE = ""`). This clears the environment variable that Claude Code uses to detect nesting.

### CLAUDE_CONFIG_DIR Isolation

Setting `CLAUDE_CONFIG_DIR` to the local `config/` directory ensures:
- **No hooks execute** — `config/settings.json` has `"disableAllHooks": true`
- **No permission prompts** — `permissions.allow: ["*"]` with `defaultMode: "dontAsk"`
- **No MCP servers loaded** — Clean config with no MCP configuration
- **No feature flags** — Env vars like `CLAUDE_CODE_ENABLE_TASKS` are explicitly deleted

This prevents hook recursion (parent hooks triggering on child process tool calls) and ensures the subprocess runs with minimal overhead.

## Usage

### remote-agent CLI

```
remote-agent [OPTIONS] "task description"
echo "task" | remote-agent --stdin [OPTIONS]
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --model MODEL` | sonnet | Model: `sonnet` or `opus` (both use 1M context) |
| `-b, --budget USD` | 15 | Max budget in USD (range: >0 to 100) |
| `-t, --timeout SECS` | 600 | Timeout in seconds (range: 10 to 3600) |
| `-n, --turns NUM` | 50 | Max tool-use turns (range: 1 to 200) |
| `-s, --system PROMPT` | — | Append system prompt |
| `-d, --dir PATH` | cwd | Working directory |
| `--context-file PATH` | — | Read structured context from JSON file |
| `--result-file PATH` | — | Write structured results to JSON file |
| `--json` | — | Output as JSON instead of text |
| `--stdin` | — | Read task from stdin |
| `--stdin-timeout SECS` | 30 | Stdin read timeout |
| `--max-retries NUM` | 0 | Retry on non-timeout failures |
| `--role ROLE` | — | Role prompt: `worker`, `verifier`, or `decomposer` |
| `--bd-task ID` | — | Beads task ID (claimed on start, closed on completion) |
| `-q, --quiet` | — | Suppress status messages |

### swarm CLI

```
swarm [OPTIONS] "task description"
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--mode MODE` | auto | `single`, `parallel`, `pipeline`, `swarm`, `review`, or `auto` |
| `--agents N` | 3 | Max parallel agents (range: 1-5) |
| `--depth LEVEL` | normal | `shallow`, `normal`, or `thorough` |
| `--timeout SECS` | 600 | Per-agent timeout |
| `--result-file PATH` | — | Write structured result JSON (includes all agent outputs) |
| `--context-file PATH` | — | Pass context to all agents |
| `--bd-task ID` | — | Beads task ID |
| `--verify` | auto | Force verification pass |
| `--no-verify` | — | Skip verification |
| `-q, --quiet` | — | Suppress status messages |

Verification defaults to **on** for `swarm`, `pipeline`, and `review` modes; **off** for `single` and `parallel`.

### Common Patterns

```bash
# Research — single agent explores codebase
remote-agent "explore the auth module and map all endpoints"

# Deep research with Opus
remote-agent -m opus --turns 80 "security audit of src/api/"

# Piped review — stdin diff analyzed by agent
git diff HEAD~3 | remote-agent --stdin -s "review for bugs"

# Structured I/O — context in, result out
remote-agent --context-file ctx.json --result-file out.json "analyze models"

# Parallel exploration — 3 agents decompose and explore
swarm --mode parallel --agents 3 --result-file /tmp/swarm.json "explore codebase"

# Full implementation with verification
swarm --mode swarm --verify --result-file /tmp/swarm.json "implement feature X"

# Sequential pipeline — research → implement → test → review
swarm --mode pipeline --verify --result-file /tmp/swarm.json "refactor auth module"

# Code review with Opus + verification
git diff | swarm --mode review --verify --result-file /tmp/review.json "review changes"
```

Note: `swarm` does not accept `--stdin` directly. Pipe input by including it in the task string, or use `remote-agent --stdin` for single-agent piped workflows.

## Module Reference

### lib/output.mjs

TTY-aware terminal output with color codes and a quiet-suppressible log function.

```javascript
export const colors: { bold, dim, cyan, green, yellow, red, magenta, reset }
export function setQuiet(q: boolean): void
export function log(msg: string): void
```

**Dependencies:** none

### lib/config.mjs

Configuration constants, model resolution, role prompts, and depth presets.

```javascript
export const MAX_BUFFER_SIZE: number            // 50MB (52428800 bytes)
export const TOOL_CALL_RE: RegExp               // Matches Read|Grep|Bash|Edit|Write|Glob|WebSearch|WebFetch
export const ALLOWED_MODELS: { sonnet, opus }
export function resolveModel(input: string): string | null  // Returns "sonnet[1m]" or "opus[1m]"
export const ROLE_PROMPTS: { worker, verifier, decomposer }
export const DEPTH: { shallow, normal, thorough }
export const DEFAULT_EXCLUDES: string[]         // ["node_modules", ".git", ".beads", ...]
export const BACKUP_EXTENSIONS: RegExp          // .mjs|.js|.cjs|.ts|.tsx|.jsx|.py|.json|.yaml|...
```

**Dependencies:** none

### lib/cli.mjs

CLI argument parsing and help text for both entry points.

```javascript
export function parseAgentArgs(argv: string[]): AgentArgs
export function showAgentHelp(): void
export function parseSwarmArgs(argv: string[]): SwarmArgs
export function showSwarmHelp(): void
```

**Dependencies:** output.mjs

### lib/context-bridge.mjs

Converts structured context JSON files into system prompts and handles result file I/O.

```javascript
export function contextToSystemPrompt(contextPath: string): { prompt: string|null, error: boolean }
export function writeResult(resultPath: string, data: object): void
export function readAgentResult(resultFile: string): object
```

Context files can contain: `task.constraints`, `task.scope`, `prior_knowledge.decisions`, `prior_knowledge.file_summaries`, `project.recent_files`.

**Dependencies:** output.mjs

### lib/telemetry.mjs

Parses agent stderr/stdout for tool call counts and completion checklist signals.

```javascript
export function parseTelemetry(stderrText: string, stdoutText: string): {
  tool_calls: { Read, Grep, Bash, Edit, Write, Glob, total },
  completion_checklist: { pass, fail, skip },
  quality_signals: { has_checklist: boolean }
}
```

**Dependencies:** config.mjs

### lib/lifecycle.mjs

Beads (`bd`) task lifecycle management and directory cleanup.

```javascript
export async function claimBdTask(bdTaskId: string|null): Promise<void>
export async function closeBdTask(bdTaskId: string|null, exitCode: number, output: string, durationSec: string): Promise<void>
export function cleanupTeamDir(teamName: string): void
export function cleanOldRuns(swarmBase: string): void
```

`cleanOldRuns` removes swarm run directories older than `SWARM_TTL_HOURS` (default: 24). Caps cleanup to first 50 directories.

**Dependencies:** output.mjs

### lib/agent-spawn.mjs

Spawns remote-agent subprocesses (used by swarm to launch worker/verifier/decomposer agents).

```javascript
export const RA_BIN: string    // Path to agent-entry.mjs
export function spawnAgent(opts: {
  task, role?, model?, turns?, budget?, timeout?,
  resultFile?, contextFile?, systemPrompt?, bdTask?,
  agentId?, cwd?, quiet?
}): Promise<{ output: string, exitCode: number, durationMs: number }>
```

**Dependencies:** output.mjs

### lib/isolation.mjs

Git worktree isolation with snapshot-based escape detection and syntax validation.

```javascript
export function snapshotFiles(dir: string, excludePatterns?: string[]): Record<string, { hash: string, size: number }>
export function backupFiles(mainCwd: string, backupDir: string, snapshot: object): number
export function prepareWorktree(workDir: string, agentId: string, mainCwd: string): {
  worktreePath: string|null, snapshot: object|null, backupDir: string|null,
  copiedUntracked: string[], success: boolean
}
export function validateAndApply(worktreePath: string, mainCwd: string, preSnapshot: object,
  backupDir: string, copiedUntracked?: string[], knownApplied?: Set<string>): {
  valid: boolean, applied: string[], escaped: string[], rolled_back: string[], errors: string[]
}
export function cleanupIsolation(worktreePath: string|null, backupDir: string|null): void
```

**Dependencies:** output.mjs, config.mjs

### lib/orchestration.mjs

Top-level swarm workflow phases: task decomposition, parallel/pipeline execution, verification, and contract building.

```javascript
export async function decompose(task: string, maxAgents: number, depth: string,
  contextFile: string|null, workDir: string): Promise<Subtask[]>
export async function executeParallel(subtasks: Subtask[], depth: string,
  contextFile: string|null, workDir: string, scoutSummary: string|null): Promise<WorkerResult[]>
export async function executePipeline(task: string, depth: string,
  contextFile: string|null, workDir: string): Promise<WorkerResult[]>
export async function verify(task: string, workerResults: WorkerResult[], depth: string,
  workDir: string): Promise<VerifyResult>
export function buildContract(task: string, mode: string, workerResults: WorkerResult[],
  verifyResult: VerifyResult|null, totalMs: number, workDir: string): Contract
export function autoMode(task: string): string
```

**Dependencies:** output.mjs, config.mjs, agent-spawn.mjs, context-bridge.mjs, isolation.mjs

## Security Model

### Process-per-task Isolation

Each agent runs as a separate Node.js subprocess with a fresh Claude Code context window. No state leaks between agents — no shared memory, no shared conversation history.

### Config Isolation

`CLAUDE_CONFIG_DIR` points to `config/` which provides:
- `settings.json`: `disableAllHooks: true`, `permissions.allow: ["*"]`, `defaultMode: "dontAsk"`, `includeCoAuthoredBy: false`
- `policy-limits.json`: Disables `allow_product_feedback`, `allow_remote_sessions`, `allow_remote_control`

This prevents the subprocess from triggering parent session hooks or prompting for permissions.

### Worktree Isolation (3-layer protection)

1. **Git worktree** — Agent operates in a detached-HEAD worktree, not the main working tree. Changes are contained until explicitly applied.
2. **Pre/post snapshot** — SHA-256 hash manifest of mainCwd taken before and after agent runs. Detects modifications to files outside the worktree (escape detection).
3. **Backup and rollback** — Source files backed up before agent runs. If validation fails, escaped files are restored from backup and worktree changes are discarded entirely.

### Escape Detection

If an agent writes to absolute paths in mainCwd (bypassing the worktree), the post-snapshot comparison catches it:
- Modified files detected by hash mismatch
- Deleted files detected by missing entries
- New files detected by entries not in the pre-snapshot
- Parallel agents use cumulative `knownApplied` tracking to avoid false positives

### Syntax Validation Gate

All changed files (both worktree changes and escaped files) are validated before application:
- `.mjs`, `.js`, `.cjs` → `node --check <file>` (syntax parse)
- `.py` → `python3 -c "import py_compile; py_compile.compile('<file>', doraise=True)"`

If any file fails validation, the entire agent's changes are rejected and rolled back.

## Configuration

### config/settings.json

```json
{
  "permissions": { "allow": ["*"], "deny": [], "defaultMode": "dontAsk" },
  "disableAllHooks": true,
  "includeCoAuthoredBy": false
}
```

Grants the subprocess full tool permissions without prompting. All hooks disabled to prevent recursion when the parent session has hooks configured.

### config/policy-limits.json

```json
{
  "restrictions": {
    "allow_product_feedback": { "allowed": false },
    "allow_remote_sessions": { "allowed": false },
    "allow_remote_control": { "allowed": false }
  }
}
```

Disables features unnecessary for automated agent subprocesses.

### DEPTH Presets

| Preset | Turns | Budget | Verify Model |
|--------|-------|--------|-------------|
| `shallow` | 10 | $5 | sonnet |
| `normal` | 25 | $15 | sonnet |
| `thorough` | 50 | $25 | opus |

Used by swarm to configure per-agent resource limits based on the `--depth` flag.

### Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `SWARM_TTL_HOURS` | lifecycle.mjs | TTL for old swarm run directories in `/tmp/swarm/` (default: 24 hours) |
| `CLAUDE_CODE_VERSION` | agent-entry.mjs | Detected main session version for mismatch warnings |
| `SWARM_AGENT_ID` | agent-spawn.mjs | Agent identifier passed to child process for log prefixing |

### Role Prompts

Three built-in roles configured in `config.mjs`:

- **worker** — Executes subtasks. Required to produce a completion checklist (`[PASS]`/`[FAIL]`/`[SKIP]` items).
- **verifier** — Adversarial cross-checker. Compares worker claims against actual `git diff`. Produces a `VERDICT: PASS|FAIL|NEEDS_REWORK`.
- **decomposer** — Splits tasks into independent subtasks as a JSON array. Scoped to files/directories, 2-5 subtasks max, no overlapping writes.

## Result File Format

### remote-agent result (version 1)

```json
{
  "version": 1,
  "status": "completed|timeout|failed",
  "output": "agent output (500KB cap)",
  "duration_ms": 12345,
  "exit_code": 0,
  "model": "sonnet[1m]",
  "task": "original task string",
  "truncated": false,
  "telemetry": {
    "tool_calls": { "Read": 5, "Grep": 3, "Bash": 2, "Edit": 1, "Write": 0, "Glob": 2, "total": 13 },
    "completion_checklist": { "pass": 3, "fail": 0, "skip": 1 },
    "quality_signals": { "has_checklist": true, "high_token_low_tools": false }
  }
}
```

### swarm contract (version 2)

```json
{
  "version": 2,
  "task": "original task",
  "mode": "parallel",
  "work_dir": "/tmp/swarm/<run-id>",
  "timestamp": "2026-03-10T...",
  "agents": [{ "id", "role", "subtask", "scope", "model", "status", "duration_ms", "exit_code", "result_file", "output" }],
  "merged_output": "all agent outputs combined",
  "verification": { "model", "duration_ms", "output", "result_file" },
  "summary": { "total_agents", "completed", "failed", "total_duration_ms", "per_agent_files" }
}
```

# Arbor Optimization Guide

Performance and cost optimization features across all phases.

## Phase 1: Core Optimizations (F1-F7)

### F1: Structured Output Schema
Decomposer uses `DECOMPOSER_OUTPUT_SCHEMA` (lib/config.mjs) for deterministic JSON responses. Eliminates regex parsing failures and retry loops.

### F2: Role-Based Thinking Budgets
Token allocation by role in `ROLE_THINKING_TOKENS`:
- **worker**: 10,000 tokens — focused execution
- **verifier**: 16,000 tokens — deeper analysis
- **decomposer**: 12,000 tokens — moderate planning

### F3: Tool Restrictions
`ROLE_DISALLOWED_TOOLS` prevents wasteful tool usage:
- Workers cannot use `WebSearch`, `WebFetch`
- Verifiers skip `Write`, `Edit` (read-only role)

### F4: Bash Command Limits
`ROLE_BASH_LIMIT` caps shell commands per role to prevent runaway loops.

### F5: Direct API Calls
`lib/ai-client.mjs` bypasses Claude Code subprocess for decisions, saving 20-30s per call. Used by scout, decomposer, verifier preamble, and fork-merge components.

### F6: Debug Mode
`--debug` flag propagates `CLAUDE_CODE_DEBUG_LOGS_DIR` per agent. Logs written to `{workDir}/debug/{agentId}/`.

### F7: IPC Logger
`lib/ipc-logger.mjs` writes NDJSON event log to `{workDir}/ipc.ndjson`. Events: lifecycle, task_assign, result, error, decision.

## Phase 2: Hooks & State (F8-F10)

### F8: JSON Schema Validation
`lib/schema-validator.mjs` validates decomposer output against `DECOMPOSER_OUTPUT_SCHEMA`. Catches malformed subtask lists before execution.

### F9: PostToolUse Progress Hook
Agents emit structured progress via PostToolUse hook when `ARBOR_TUI=1`. Reports: files read/written, tool calls made, current phase.

### F10: PreCompact State Persistence
Before context compaction, agents write critical state to `CLAUDE.md` via PreCompact hook. Survives the compaction boundary.

## Phase 3: Context & Branching (F11-F13)

### F11: Semantic Context Filtering
Per-role filtering of system prompts to reduce token waste:

| Section | Worker | Verifier | Decomposer |
|---------|--------|----------|------------|
| Scout Report | keep | strip | keep |
| Decisions | keep | strip | keep |
| File Context | keep | strip | keep |
| Git Diff | strip | keep | strip |
| Test Results | strip | keep | strip |
| Worker Outputs | strip | keep | strip |

Target: ≥30% context reduction for verifier/worker roles.

Integration: `agent-entry.mjs` filters before `--append-system-prompt`. `orchestration.mjs` filters parallel worker context.

### F12: Fork-Merge Mode
Competitive approach execution:

```
swarm --mode fork-merge --forks 3 "implement caching layer"
```

Flow: Generate N approaches → execute in parallel worktrees → score (exit code 40pts + diff economy 30pts + test results 30pts) → AI judge for close races → apply winner.

Key files:
- `lib/approach-generator.mjs` — AI-powered approach generation with fallback
- `lib/branch-selector.mjs` — scoring and selection with AI tiebreaker

### F13: Documentation & Benchmarks
This guide, plus:
- `docs/ADVANCED-ORCHESTRATION.md` — mode selection and hierarchical patterns
- `docs/OBSERVABILITY.md` — monitoring, IPC events, TUI dashboard
- `benchmarks/startup-latency.mjs` — measures agent spawn overhead
- `benchmarks/token-usage.mjs` — measures context filtering reduction

## Quick Reference: CLI Flags

### arbor (single agent)
```
--effort LEVEL       low|medium|high|max
--fallback-model M   auto-fallback on overload
--persist-context    write context to CLAUDE.md
--scope PATHS        comma-separated scope enforcement
--prefill TEXT       pre-fill assistant response
--debug              per-agent debug logs
```

### swarm (orchestrator)
```
--mode MODE          single|parallel|pipeline|swarm|fork-merge|hierarchical|review|auto
--forks N            competing approaches for fork-merge (2-5, default: 2)
--agents N           max parallel agents (1-5, default: 3)
--depth LEVEL        shallow|normal|thorough
--verify/--no-verify
--semantic-merge/--no-semantic-merge
--tui/--no-tui
--hierarchy-depth N  max decomposition depth (1-5)
--max-children N     max children per coordinator (2-8)
--agent-budget N     max total agents (default: 20)
--estimate-only      show plan without executing
```

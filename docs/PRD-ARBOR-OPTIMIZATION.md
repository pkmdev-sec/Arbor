# Arbor Optimization & Innovation PRD

**Document:** PRD-ARBOR-OPT-001
**Version:** 1.1
**Date:** 2026-03-12
**Author:** pkmdev-sec
**Status:** VALIDATED -- Challenge agent findings incorporated

---

## 1. Product Overview

### 1.1 What is Arbor?

Arbor is a production-grade CLI orchestration system that supervises isolated Claude Code agents. It enables parallel multi-agent workflows with worktree isolation, hierarchical decomposition, verification passes, and real-time TUI monitoring.

### 1.2 Current State

Arbor v1.0.0 is fully operational with:
- **6 orchestration modes**: single, parallel, pipeline, swarm, review, hierarchical
- **Worktree isolation**: each agent gets its own git worktree with safe merge + rollback
- **IPC coordination**: Unix socket message bus with heartbeats, progress, agent registry
- **Quality gates**: AI-powered verification with PASS/FAIL/NEEDS_REWORK verdicts
- **Go TUI + Node fallback**: real-time monitoring of agent progress
- **65 unit tests**: 100% pass rate, 113ms execution

### 1.3 Purpose of This PRD

Define the implementation scope for Arbor's optimization phase: closing performance gaps, adding role intelligence, and building two high-value innovations (semantic context filtering and branch-merge orchestration).

---

## 2. Goals & Non-Goals

### 2.1 Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G1 | Reduce agent startup latency | p50 < 2s (currently ~3s) |
| G2 | Cut token waste via role-based tuning | 30% thinking token reduction for workers |
| G3 | Eliminate non-essential network traffic | 0 telemetry/update HTTP requests per agent |
| G4 | Enable structured decomposer output | 0 JSON parsing retry loops |
| G5 | Provide real-time structured progress | Tool-level events in TUI (not regex-scraped) |
| G6 | Preserve agent state across compaction | State survives compaction for agents >50 turns |
| G7 | Role-aware context delivery | Agents receive only role-relevant prior results |
| G8 | Multi-approach exploration | Fork N approaches, auto-select winner |

### 2.2 Non-Goals

- **No architectural rewrites** -- core orchestration is production-grade
- **No new swarm modes** -- fork-and-merge enhances existing parallel mode
- **No context tiering (I6) or memory graph (I7)** -- deferred to Q2
- **No TUI redesign** -- TUI gets new data sources, not new layouts
- **No multi-machine distribution** -- single-machine only

---

## 3. User Personas

### 3.1 Solo Developer (Primary)
- Runs `arbor -m sonnet "implement feature X"` for isolated tasks
- Uses `arbor-swarm --mode parallel "refactor auth module"` for multi-file work
- Cares about: speed, cost, correctness

### 3.2 Power User / Orchestrator (Secondary)
- Chains arbor into Claude Code hooks (auto_orchestrator.py -> arbor-swarm)
- Builds multi-stage pipelines: decompose -> implement -> verify
- Cares about: control, observability, context quality

---

## 4. Feature Specifications

### Phase 1: Performance Baseline (Week 1-2)

#### F1: Non-Essential Traffic Suppression
**Priority:** P0 | **Effort:** 30 min | **Impact:** 500ms-1s faster startup

Set 9 env vars in agent-entry.mjs: DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, DISABLE_AUTOUPDATER, DISABLE_COST_WARNINGS, DISABLE_INSTALLATION_CHECKS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, CLAUDE_CODE_DISABLE_AUTO_MEMORY, CLAUDE_CODE_DISABLE_TERMINAL_TITLE, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY. Mirror in config/settings.json.

**Acceptance:** Zero telemetry HTTP, startup p50 improves >= 400ms, no regression.

#### F2: Adaptive Compaction Threshold
**Priority:** P0 | **Effort:** 30 min | **Impact:** Context preservation

Set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95 for short tasks (<=25 turns), 85 for long tasks (>25 turns).

**Acceptance:** 10-turn decomposer: 0 compaction. 50-turn worker: deferred compaction.

#### F3: Small Model for Internal Calls
**Priority:** P0 | **Effort:** 15 min | **Impact:** $0.01-0.03/agent savings

Set ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001.

#### F4: Role-Specific Resource Tuning
**Priority:** P0 | **Effort:** 2.5h | **Impact:** 30% token waste reduction

Config constants in lib/config.mjs:
- ROLE_THINKING_TOKENS: worker=8000, verifier=32000, decomposer=16000
- ROLE_OUTPUT_TOKENS: worker=64000, verifier=16000, decomposer=8000
- ROLE_BASH_LIMIT: worker=200000, verifier=200000, decomposer=50000

Applied via MAX_THINKING_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS, BASH_MAX_OUTPUT_LENGTH.

#### F5: Context Persistence + Scope Trigger
**Priority:** P1 | **Effort:** 15 min

Expand: args.persistContext || args.maxTurns > 50 || args.scope

#### F6: Debug Passthrough
**Priority:** P1 | **Effort:** 30 min

SWARM_DEBUG/DEBUG -> --debug flag + per-agent CLAUDE_CODE_DEBUG_LOGS_DIR.

#### F7: Settings Sources Isolation
**Priority:** P1 | **Effort:** 15 min

Add --setting-sources user to child args.

---

### Phase 2: Structured Output & Observability (Week 3)

#### F8: Decomposer JSON Schema Enforcement
**Priority:** P0 | **Effort:** 2h | **Risk:** HIGH

Add --json-schema for decomposer role. Schema: array of {title, task, scope, turns, model}.
**Risk:** --json-schema flag unverified. Fallback: structured prompting + retry.

#### F9: PostToolUse Progress Hook
**Priority:** P1 | **Effort:** 4h

New hooks/progress-reporter.py: tool events -> IPC -> TUI. Only when --tui set.

#### F10: PreCompact State Preservation
**Priority:** P1 | **Effort:** 6h

New hooks/agent-precompact.py: saves modified files, progress, errors to persistContextDir.

---

### Phase 3: Context Intelligence (Week 4-5)

#### F11: Semantic Context Filtering
**Priority:** P1 | **Effort:** 2 weeks

New lib/context-filter.mjs with per-role rules:
- Worker: decisions + file summaries (no exploration)
- Verifier: diff + test results (no file summaries)
- Decomposer: project structure (no test results)

Target: >= 30% context size reduction per agent.

---

### Phase 4: Advanced Orchestration (Week 6-7)

#### F12: Conversation Branch & Merge
**Priority:** P2 | **Effort:** 2 weeks

New --mode fork-merge: generate N approaches, fork agents, compare (diff size, tests, AI verdict), merge winner. New files: lib/approach-generator.mjs, lib/branch-selector.mjs.

---

### Phase 5: Polish (Week 8)

#### F13: Documentation & Benchmarks
**Priority:** P1 | **Effort:** 16h

Docs: OPTIMIZATION-GUIDE.md, ADVANCED-ORCHESTRATION.md, OBSERVABILITY.md
Benchmarks: startup-latency.mjs, token-usage.mjs

---

## 5. Technical Architecture

### 5.1 Files Changed

```
~/arbor/
  agent-entry.mjs            -- F1-F7, F8 (root, not lib/)
  lib/config.mjs            -- F4
  lib/context-filter.mjs    -- F11 (NEW)
  lib/approach-generator.mjs -- F12 (NEW)
  lib/branch-selector.mjs   -- F12 (NEW)
  hooks/progress-reporter.py -- F9 (NEW)
  hooks/agent-precompact.py  -- F10 (NEW)
  config/settings.json       -- F1
  swarm.mjs                  -- F11, F12
  benchmarks/*.mjs           -- F13 (NEW)
  docs/*.md                  -- F13 (NEW)
```

### 5.2 SDK Dependencies & Risks

| Feature | Dependency | Risk | Status | Fallback |
|---------|-----------|------|--------|----------|
| F1 | 9 env vars | LOW | VERIFIED (all 9 found in SDK) | N/A |
| F2 | CLAUDE_AUTOCOMPACT_PCT_OVERRIDE | LOW | VERIFIED (1 match) | N/A |
| F3 | ANTHROPIC_SMALL_FAST_MODEL | LOW | VERIFIED (4 matches) | Default model |
| F4 | MAX_THINKING_TOKENS | LOW | VERIFIED (3 matches). Note: NOT CLAUDE_CODE_MAX_THINKING_TOKENS (0 matches) | N/A |
| F7 | --setting-sources flag | LOW | VERIFIED (exists + settingSources SDK param) | N/A |
| F8 | --json-schema flag | LOW | VERIFIED (--json-schema exists in CLI) | Prompting + retry |

---

## 6. Rollout Plan

| Week | Features | Hours | Gate |
|------|----------|-------|------|
| 1 | F1-F7 | 5h | p50 startup < 2s |
| 2 | Benchmarks | 8h | Metrics captured |
| 3 | F8, F9, F10 | 12h | 0 retries, TUI events |
| 4-5 | F11 | 40h | Role-filtered context |
| 6-7 | F12 | 40h | Fork-merge winner |
| 8 | F13 | 16h | Regression-free release |

**Total: ~121 hours** (revised from roadmap 200h)

---

## 7. Risk Register

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | SDK update breaks env vars | HIGH | Pin exact version (^2.1.71 -> exact) |
| R2 | ~~--json-schema missing~~ | ~~HIGH~~ LOW | VERIFIED in SDK. Flag exists. |
| R3 | ~~MAX_THINKING_TOKENS not real~~ | ~~MEDIUM~~ LOW | VERIFIED (3 matches). Use MAX_THINKING_TOKENS, not CLAUDE_CODE_MAX_THINKING_TOKENS. |
| R4 | Hook latency (scope-guard.py per tool call) | MEDIUM | --tui only; scope guard spawns Python per Write/Edit/Bash |
| R5 | Over-filtering context | MEDIUM | Conservative rules + override |
| R6 | Fork-merge cost | LOW | Default 2 forks |
| R7 | Wrong tuning values | LOW | Benchmark, iterate |
| R8 | Concurrent file writes in parallel mode | MEDIUM | writeFileSync is atomic per-call, but appendFile in ipc-logger.mjs can race. Add write queue or per-agent log files. |
| R9 | No file locking in shared paths | MEDIUM | No flock/lockfile patterns found. IPC log and context-bridge writes could corrupt under >5 parallel agents. |
| R10 | Stale "remote-" branding in runtime | LOW | agent-entry.mjs:258 still uses `remote-${agentId}` for teamName. Rename to `arbor-${agentId}`. |

---

## 8. Roadmap Challenges & Corrections (Validated)

### 8.1 Line Reference Corrections (Agent 1)
- Roadmap claims "agent-entry.mjs:265" for env var insertion -- WRONG. Line 265 is `const sessionUUID = randomUUID()`. Correct env section: lines 243-295 (delta env construction).
- 5 references CONFIRMED accurate, 3 SHIFTED by small offsets, 1 WRONG (above).

### 8.2 Effort Revisions (Agent 3)
- Roadmap 200h -> PRD 121h (I2/I3 overcounted at 80h each)
- QW1 (traffic suppression): 30 min realistic
- QW2 (adaptive compaction): roadmap says 30 min, realistic is 4-8h (needs turn-counting logic + testing across task lengths)
- I1 (JSON schema enforcement): roadmap says 2h, realistic is 8-12h (schema design + fallback retry + edge cases)
- I5 (PreCompact state): roadmap's Agent 3 incorrectly claimed PreCompact doesn't exist -- it DOES. We have working PreCompact hooks in ~/.claude/settings.json. Effort 6h is realistic.

### 8.3 SDK Verification (Agent 2)
All 15 env vars and 2 CLI flags VERIFIED in @anthropic-ai/claude-code SDK:
- 9 traffic suppression vars: all found (1-12 matches each)
- CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: found (1 match)
- ANTHROPIC_SMALL_FAST_MODEL: found (4 matches)
- MAX_THINKING_TOKENS: found (3 matches) -- **CRITICAL**: CLAUDE_CODE_MAX_THINKING_TOKENS has 0 matches, use MAX_THINKING_TOKENS
- CLAUDE_CODE_MAX_OUTPUT_TOKENS: found (3 matches)
- BASH_MAX_OUTPUT_LENGTH: found (3 matches)
- --json-schema: found in CLI
- --setting-sources: found in CLI + settingSources in SDK params

### 8.4 Stale References
- All roadmap paths say ~/.claude/remote-agent/ -- should be ~/arbor/
- agent-entry.mjs:258 still uses `remote-${agentId}` for teamName -- rename to `arbor-`
- References ROLE_DISALLOWED_TOOLS -- needs verification

### 8.5 Blind Spots (Agent 4)
- **Dependency pinning**: ^2.1.71 allows breaking updates. Pin exact version.
- **Concurrent writes**: ipc-logger.mjs uses async appendFile without locks. Safe for <=3 agents, risks corruption at >5.
- **No file locking**: No flock/lockfile patterns in any shared write path.
- **Scope guard latency**: scope-guard.py spawns Python per Write/Edit/Bash call. Cold Python start ~50-100ms per tool invocation.
- **Error recovery**: swarm.mjs has 41 error-handling patterns (good coverage), but worktree cleanup on SIGKILL is untested.
- **IPC scalability**: Unix socket message bus untested beyond 5 concurrent agents.
- **Crash recovery**: No automatic worktree cleanup after unclean exit (orphaned worktrees accumulate).
- **Branding cleanup**: docs still reference "remote-agent" in several places.

### 8.6 Questionable Claims
- "500ms-1s faster" from env vars alone -- needs benchmarking before/after
- "30% thinking token waste" -- not measured, based on assumption
- "2-3 years ahead" -- no external validation
- ICE scores self-assigned without calibration

---

## 9. Success Criteria

**Phase 1 (Week 2):** Startup p50 < 2s, 0 telemetry, role tokens correct
**Phase 2 (Week 3):** 0 retries, TUI events, state survives compaction
**Phase 3 (Week 5):** Role-filtered context, >= 30% size reduction
**Phase 4 (Week 7):** Fork-merge valid winner, worktrees cleaned
**Release (Week 8):** All docs, 65+ tests, no regressions, tagged v1.1.0

---

## 10. Deferred to Q2

| Feature | Why | Dependency |
|---------|-----|------------|
| I6: Context Tiering | High complexity | F10 |
| I7: Memory Graph | NLP needed, high R&D risk | F11 |

---

**Next Steps:**
1. Pin @anthropic-ai/claude-code to exact version (remove ^ from ^2.1.71)
2. Rename `remote-${agentId}` to `arbor-${agentId}` in agent-entry.mjs:258
3. Begin Phase 1 implementation (F1-F7) using verified env var names
4. Build startup-latency benchmark BEFORE making changes (baseline measurement)
5. Address R8/R9 (concurrent write safety) before scaling beyond 5 parallel agents

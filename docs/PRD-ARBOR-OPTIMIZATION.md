# Arbor Optimization & Innovation PRD

**Document:** PRD-ARBOR-OPT-001
**Version:** 1.2
**Date:** 2026-03-12
**Author:** pkmdev-sec
**Status:** PHASE 3 COMPLETE -- F1-F13 + pre-fixes R10/R12/R13, 101/101 tests

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

### Phase 1: Performance Baseline (Week 1-2) — COMPLETE ✓

#### F1: Non-Essential Traffic Suppression
**Priority:** P0 | **Effort:** 30 min | **Impact:** 500ms-1s faster startup

Set 8 env vars in agent-entry.mjs: DISABLE_ERROR_REPORTING, DISABLE_AUTOUPDATER, DISABLE_COST_WARNINGS, DISABLE_INSTALLATION_CHECKS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, CLAUDE_CODE_DISABLE_AUTO_MEMORY, CLAUDE_CODE_DISABLE_TERMINAL_TITLE, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY. Mirror in config/settings.json. *(DISABLE_TELEMETRY excluded — not found in SDK.)*
**Status:** IMPLEMENTED (e944c97)

**Acceptance:** Zero telemetry HTTP, startup p50 improves >= 400ms, no regression.

#### F2: Adaptive Compaction Threshold
**Priority:** P0 | **Effort:** 30 min | **Impact:** Context preservation

Set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95 for short tasks (<=25 turns), 85 for long tasks (>25 turns).

**Acceptance:** 10-turn decomposer: 0 compaction. 50-turn worker: deferred compaction.
**Status:** IMPLEMENTED (e944c97)

#### F3: Small Model for Internal Calls
**Priority:** P0 | **Effort:** 15 min | **Impact:** $0.01-0.03/agent savings

Set ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001.
**Status:** IMPLEMENTED (e944c97)

#### F4: Role-Specific Resource Tuning
**Priority:** P0 | **Effort:** 2.5h | **Impact:** 30% token waste reduction

Config constants in lib/config.mjs:
- ROLE_THINKING_TOKENS: worker=8000, verifier=32000, decomposer=16000
- ROLE_OUTPUT_TOKENS: worker=64000, verifier=16000, decomposer=8000
- ROLE_BASH_LIMIT: worker=200000, verifier=200000, decomposer=50000

Applied via MAX_THINKING_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS, BASH_MAX_OUTPUT_LENGTH.
**Status:** IMPLEMENTED (e944c97)

#### F5: Context Persistence + Scope Trigger
**Priority:** P1 | **Effort:** 15 min

Expand: args.persistContext || args.maxTurns > 50 || args.scope
**Status:** IMPLEMENTED (e944c97)

#### F6: Debug Passthrough
**Priority:** P1 | **Effort:** 30 min

SWARM_DEBUG/DEBUG -> --debug flag + per-agent CLAUDE_CODE_DEBUG_LOGS_DIR.
**Status:** IMPLEMENTED (e944c97)

#### F7: Settings Sources Isolation
**Priority:** P1 | **Effort:** 15 min

Add --setting-sources user to child args.
**Status:** IMPLEMENTED (e944c97)

---

### Phase 2: Structured Output & Observability (Week 3)

#### F8: Decomposer JSON Schema Enforcement
**Priority:** P0 | **Effort:** 8-12h (revised from 2h) | **Risk:** LOW (verified)

Add --json-schema for decomposer role. Schema: `{subtasks: [{title, task, scope, turns, model, effort?, depends_on?}]}`.
**Status:** ✅ IMPLEMENTED (a5d5150) — DECOMPOSER_OUTPUT_SCHEMA in config.mjs, --json-schema wired in agent-entry.mjs, orchestration.mjs parsing handles both wrapper and bare array.

#### F9: PostToolUse Progress Hook
**Priority:** P1 | **Effort:** 4h

New hooks/progress-reporter.py: tool events -> IPC -> TUI. Only when --tui set.
**Status:** ✅ IMPLEMENTED (a5d5150) — hooks/progress-reporter.py created, ARBOR_TUI env propagated from swarm.mjs, PostToolUse wired via needsHooks block.

#### F10: PreCompact State Preservation
**Priority:** P1 | **Effort:** 6h

New hooks/agent-precompact.py: saves modified files, progress, errors to persistContextDir.
**Status:** ✅ IMPLEMENTED (a5d5150) — hooks/agent-precompact.py created, ARBOR_PERSIST_DIR set after persistContextDir, PreCompact wired for long-running/scoped/persistent agents.

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
| F1 | 8 env vars | LOW | VERIFIED + IMPLEMENTED (DISABLE_TELEMETRY excluded — not in SDK) | N/A |
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
| 3 | F8, F9, F10 | 22h | 0 retries, TUI events |
| 4-5 | F11 | 40h | Role-filtered context |
| 6-7 | F12 | 40h | Fork-merge winner |
| 8 | F13 | 16h | Regression-free release |

**Total: ~131 hours** (revised from roadmap 200h, F8 effort corrected 2h->10h)

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
| R11 | Orphaned worktrees on hard crash | CRITICAL | No cleanup on SIGKILL/power loss. Need `arbor cleanup` command. |
| R12 | No unhandledRejection handler | HIGH | agent-entry.mjs:970 and swarm.mjs:906 miss fire-and-forget promises. Add global handler. |
| R13 | Non-atomic result file writes | HIGH | context-bridge.mjs:78 can corrupt on mid-write crash. Use temp+rename pattern. |
| R14 | Escape detection race condition | HIGH | isolation.mjs:476 snapshots after exit. Parallel agents can cause false positives. Lock mainCwd during snapshot. |
| R15 | OOM at max agent count | MEDIUM | 20 agents x 256MB = 5.1GB > 4GB governor limit. Reduce maxTotalAgents or increase limit. |

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
- 8 traffic suppression vars: all found (1-12 matches each). DISABLE_TELEMETRY excluded (0 matches — false positive from substring grep).
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

### 8.5 Codebase Audit (Agent 4) -- 25 findings, 9 categories

#### CRITICAL
- **Orphaned worktree accumulation**: lifecycle.mjs handles exit/SIGINT/SIGTERM/uncaughtException, but SIGKILL or hard crash leaves orphaned worktrees in /tmp/swarm/*/worktrees/ and ~/.claude/teams/<uuid>. No auto-cleanup exists. **Recommendation**: Add `arbor cleanup` command (scan stale worktrees >24h, git worktree prune, rm /tmp/swarm/*).
- **Floating dependency version**: ^2.1.71 allows breaking updates. Pin exact version "2.1.71".

#### HIGH -- Error Handling
- **No unhandledRejection handler**: agent-entry.mjs:970 and swarm.mjs:906 both catch main() errors, but have no global `unhandledRejection` handler. Fire-and-forget promises crash without cleanup.
- **Non-atomic result file writes**: context-bridge.mjs:78 uses `writeFileSync` directly. If process crashes mid-write, parent reads corrupt JSON. **Fix**: write to temp file, then `fs.renameSync` (atomic on POSIX).
- **Result files not crash-safe**: agent-entry.mjs:937 writes result, then unlinks progress file (line 941). Crash between = stale progress file. Parent thinks agent is still running.

#### HIGH -- Security
- **Worktree escape detection race**: isolation.mjs:476 takes snapshot AFTER agent exits. In parallel mode, Agent B could modify shared files between Agent A's exit and snapshot, causing false positives/negatives.

#### HIGH -- Testing Gaps
- No integration tests for swarm modes (parallel/pipeline/hierarchical)
- No tests for worktree isolation (prepareWorktree, validateAndApply, escape detection)
- No tests for error recovery (agent crashes, timeout, retry)
- No IPC bus server tests (only protocol tested in ipc.test.mjs)
- No hierarchical mode tests (ResourceGovernor, SubCoordinator, budget allocation)
- integration-test.mjs exists but is NOT in the test runner (package.json runs test/*.test.mjs only)

#### MEDIUM
- **Memory limit exceeded at max agents**: governor.mjs defaults maxTotalAgents=20, maxMemoryMB=4096. Each agent ~256MB overhead -> 20 x 256 = 5.1GB > 4GB limit. OOM at scale.
- **No global AI API rate limiting**: ai-client.mjs has per-agent retry, but no cross-agent rate limiter. 10 parallel agents = 10x rate limit consumption.
- **Parallel file writes uncoordinated**: orchestration.mjs applies changes sequentially after all agents finish, but no file-level locking between validateAndApply calls.
- **No IPC connection limit**: message-bus.mjs allows unlimited connections. 100+ agents could overflow socket buffers.
- **Silent snapshot failures**: isolation.mjs:90 uses empty `catch {}` for file read failures. Incomplete snapshots could miss escape detection.
- **No dependency vulnerability scanning**: No npm audit, Snyk, or Dependabot in repo.

#### LOW
- Sequential worktree cleanup: isolation.mjs:630 removes worktrees one-by-one (10s timeout each). 15 worktrees = 150s worst case. Parallelize.
- Stale "remote-agent" in comments: isolation.mjs:414, orchestration.mjs:286
- No telemetry aggregation: each agent writes to own result file. No `arbor report` command to aggregate.
- Potential credential leakage in IPC logs: no credential scrubbing in message payloads.

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

**Next Steps (Priority Order):**

**COMPLETED — Pre-fixes + Phase 1 (commit e944c97):**
- ~~Pin @anthropic-ai/claude-code to exact version "2.1.71"~~ DONE
- ~~Add global `unhandledRejection` handler to agent-entry.mjs and swarm.mjs (R12)~~ DONE
- ~~Make result file writes atomic: temp file + fs.renameSync in context-bridge.mjs (R13)~~ DONE
- ~~Rename `remote-${agentId}` to `arbor-${agentId}` in agent-entry.mjs (R10)~~ DONE
- ~~F1-F7 implemented and validated (8 env vars, adaptive compaction, role tuning, etc.)~~ DONE

**COMPLETED — Phase 2 (commit a5d5150):**
- ~~F8: Decomposer JSON Schema Enforcement (--json-schema, DECOMPOSER_OUTPUT_SCHEMA)~~ DONE
- ~~F9: PostToolUse Progress Hook (hooks/progress-reporter.py, ARBOR_TUI propagation)~~ DONE
- ~~F10: PreCompact State Preservation (hooks/agent-precompact.py, ARBOR_PERSIST_DIR)~~ DONE

**Phase 3 — Next:**
1. F11: Semantic Context Filtering (lib/context-filter.mjs, per-role rules)
2. F12: Branch & Merge Strategy (git-based isolation improvements)
3. F13: Documentation & Benchmarks

**Before scaling beyond 5 agents:**
4. Implement `arbor cleanup` command for orphaned worktree recovery (R11)
5. Fix escape detection race condition with mainCwd locking (R14)
6. Address R8/R9 (concurrent write safety) and R15 (OOM at max agents)

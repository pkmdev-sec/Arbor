# Remote-Agent Architecture Analysis — Executive Summary

**Date:** 2026-03-10 | **Agents:** 3 (Opus) | **Files Analyzed:** 35+ | **LOC:** ~8,000+

## Scope

Full architectural and code-quality analysis of `arbor` — single-agent runner, parallel swarm orchestrator, IPC message bus, hierarchy subsystem, AI client, TUI dashboard, and supporting libraries.

## Key Stats

| Category | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Weaknesses | 5 | 2 | 3 | 1 | **11** |
| Bottlenecks | 1 | 9 | 5 | 1 | **16** |
| Gaps | 1 | 3 | 3 | 0 | **7** |
| Optimizations | 0 | 1 | 5 | 2 | **8** |
| Innovations | — | — | — | — | **9** |
| **Total** | **7** | **15** | **16** | **4** | **51** |

## Critical Findings (Fix First)

1. **Wildcard topic matching missing** — hierarchical IPC silently broken (`message-bus.mjs`, `scoped-bus.mjs`)
2. **Python bridge protocol mismatch** — Python clients silently fail to register (`bus_client.py`, `protocol.mjs`)
3. **Duplicate AI client implementations** — crash risk on import, inconsistent retry/output (`ai-client.mjs`, `ai-decisions.mjs`)
4. **`depends_on` declared but never enforced** — parallel tasks ignore dependency ordering (`orchestration.mjs:236-278`)
5. **Unbounded memory in `agent-spawn.mjs`** — swarm workers can OOM parent (`agent-spawn.mjs:85-86`)
6. **`buildContract` verification model hardcoded** — always resolves to "opus" regardless of depth (`orchestration.mjs:656`)
7. **`policy-limits.json` schema vs reality mismatch** — required fields don't exist in actual file (`config.mjs:183-224`)

## Subsystem Health

| Subsystem | Status | Key Issue |
|---|---|---|
| Core orchestration | Functional, bugs | Dependency ordering ignored, pipeline context not chained |
| Agent spawning | OOM risk | No buffer limits on worker stdout |
| IPC message bus | Partially broken | Wildcard matching missing, rate limiting unimplemented |
| Hierarchy module | Built, unwired | Not integrated into swarm execution pipeline |
| AI client layer | Duplicated | Two implementations with different APIs and retry logic |
| TUI dashboard | Performance issues | 80ms spinner re-renders, sync FS in render loop |
| Telemetry | Functional, slow | Full-buffer O(n) parsing, heuristic-only cost tracking |
| Testing | Absent | Zero test files in entire codebase |

## Highest-ROI Fixes

1. Consolidate AI clients → eliminates crash risk + inconsistent behavior
2. Implement wildcard topic matching → unblocks hierarchy feature
3. Add buffer limits to `agent-spawn.mjs` → prevents OOM crashes
4. Fix pipeline context chaining (`results[i-1]` instead of `results[0]`) → 1-line fix
5. Add exponential backoff to AI retry → prevents cascade failures under load

# Gaps, Optimizations & Innovations

*Extracted from ARCHITECTURE_ANALYSIS.md — 3-agent swarm analysis (2026-03-10)*

---

## GAPS — Missing Functionality vs Stated Goals

### G1. `depends_on` Declared but Never Enforced in Parallel Execution
**Priority:** Critical

**Problem:** Decomposer prompt (`config.mjs:162`) tells AI to produce `depends_on` arrays, but `executeParallel()` at `orchestration.mjs:236-278` launches ALL subtasks with `Promise.all`, ignoring dependencies entirely.

**Evidence:** `orchestration.mjs:236` — `const results = await Promise.all(promises);` runs everything concurrently regardless of declared deps.

**Solution:** Implement topological sort scheduler — build DAG from `depends_on`, run independent tasks in parallel, release dependents on completion, fall back to full parallelism on cycles.

**Steps:**
1. Add `buildExecutionDAG(subtasks)` to `orchestration.mjs`
2. Replace `Promise.all` with wave-based execution: `executeWaves(dag, spawnFn)`
3. Maintain same result format

**Trade-offs:** Reduces parallelism if deps are over-specified. Mitigated by decomposer preferring independence.

---

### G2. `policy-limits.json` Schema vs Reality Mismatch
**Priority:** Critical

**Problem:** `config.mjs:183-224` defines schema requiring `maxTurns`, `maxCost`, `timeout`, `maxAgents` (all `required: true`), but `config/policy-limits.json` only contains `restrictions`. Calling `loadPolicyLimits()` would throw.

**Evidence:** Schema expects 4 required numeric fields; JSON file has only `restrictions` object with boolean feature flags.

**Solution:** Either (a) add the numeric limits to JSON and wire into spawn logic, or (b) mark all fields `required: false` to match reality.

**Steps:** Option A: Add `maxTurns: 200, maxCost: 100, timeout: 3600000, maxAgents: 5` to JSON; wire as hard caps in `agent-entry.mjs` and `swarm.mjs`. Option B: Fix schema to match.

**Trade-offs:** Option A adds governance; Option B admits schema is aspirational.

---

### G3. Pipeline Mode Doesn't Chain Context Between Stages
**Priority:** High

**Problem:** `orchestration.mjs:458` passes `results[0]?.resultFile` (RESEARCH stage) as context for ALL subsequent stages. TEST doesn't see IMPLEMENT output; REVIEW only sees RESEARCH.

**Evidence:** `contextFile: i > 0 ? results[0]?.resultFile : contextFile` — always index 0, not previous stage.

**Solution:** Chain each stage to previous: `contextFile: i > 0 ? results[i - 1]?.resultFile : contextFile`, or build cumulative context per stage.

**Trade-offs:** Simple chaining may miss earlier context; cumulative approach adds ~20 LOC.

---

### G4. Wildcard Topic Matching Missing — Hierarchical IPC Non-Functional
**Priority:** Critical

**Problem:** `ScopedBus.subscribeDown()` creates wildcard patterns (e.g., `swarm.L2.auth.*.status`) but `MessageBus._routeToSubscribers()` uses exact `Map.get()`. Wildcards **never match**, breaking all parent-child hierarchical communication.

**Evidence:** `scoped-bus.mjs:247-252` creates wildcard topics; `message-bus.mjs:616-620` does `this.subscriptions.get(topic)` — exact match only. Design doc explicitly calls this out as needed.

**Solution:** Trie-based topic matcher supporting `*` (single-segment) and `**` (multi-segment) wildcards. Cache matched wildcards per-topic.

**Steps:**
1. Add `wildcardSubscriptions` trie to `MessageBus`
2. On subscribe with `*`: parse segments, store in trie
3. On publish: check exact first, then walk trie for wildcards
4. Cache with invalidation on subscribe/unsubscribe

**Trade-offs:** ~50-100ms overhead on first publish to new topic; O(1) cached afterward. ~2KB memory per wildcard sub.

---

### G5. Python Bridge Protocol Mismatch — Silent Message Drop
**Priority:** Critical

**Problem:** Python `BusClient` sends REGISTER/UNREGISTER without required `id` field. Node.js `MessageParser.feed()` validates via `validateMessage()` and silently skips messages without valid `id`. **Python clients silently fail to register.**

**Evidence:** `bus_client.py:126-135` — no `id`, `to`, `topic`, `correlationId`, `priority` fields. `protocol.mjs:152-155` — rejects messages without string `id`. `protocol.mjs:312-314` — `continue` on invalid (silent drop).

**Solution:** Add `"id": str(uuid.uuid4())` and missing fields with `None`/null defaults to all Python messages. Create `_create_message()` helper mirroring JS `createMessage()`.

**Trade-offs:** Minimal (~1μs per message for UUID). Breaking change for downstream Python consumers (likely none since old format doesn't work).

---

### G6. Rate Limiting Declared But Never Enforced
**Priority:** High

**Problem:** `MessageBus` stores `rateLimits`/`rateLimitWindows` Maps and accepts `set_rate_limit` commands, but routing paths (`_handleMessage`, `_sendToClient`, `_routeToSubscribers`) never check limits.

**Evidence:** `message-bus.mjs:83-87` declares Maps; `message-bus.mjs:773-783` has set command; `_handleMessage` at line 357 has no rate check.

**Solution:** Add `_checkRateLimit(agentId)` called at top of `_handleMessage` using sliding window counter.

**Trade-offs:** ~2μs per message. Negligible for typical 100 msg/sec limits.

---

### G7. Pause/Resume Has No Effect on Message Flow
**Priority:** High

**Problem:** `pauseAgent()` adds to `pausedAgents` Set but no code checks it during routing. JSDoc promises messages are queued until resumed — this is fiction.

**Evidence:** `message-bus.mjs:756-761` — pause command exists; `message-bus.mjs:637-643` — `_sendToClient` has no pause check.

**Solution:** Message queue per paused agent. On send, check pause → enqueue. On resume, drain queue with max depth (1000) and oldest-drop overflow.

**Trade-offs:** ~1MB per 1000 queued messages per agent. Drain burst on resume — throttle with `setImmediate()` batches.

---

### G8. Hierarchical Mode Not Integrated
**Priority:** Medium

**Problem:** `hierarchy/README.md:186-190` lists "Next Steps" including `mode: "hierarchical"` in `swarm.mjs` and `executeHierarchical()` in `orchestration.mjs`. Neither exists. Hierarchy module is built but unwired.

**Solution:** Complete Phase 5 — wire `decomposeHierarchically()` + `SubCoordinator` + `ResourceGovernor` into main pipeline.

**Steps:**
1. Add `case "hierarchical":` in `swarm.mjs` mode switch
2. Create `executeHierarchical()` in `orchestration.mjs`
3. Add `--mode hierarchical --hierarchy-depth N` CLI flags
4. Update `autoMode()` for hierarchical detection (>50 files, >3 modules)

**Trade-offs:** ~100 LOC wiring. Gated behind explicit `--mode hierarchical` flag.

---

### G9. No Test Suite
**Priority:** Medium

**Problem:** Zero test files exist in `arbor/`. No test script in `package.json`. Any change risks undetected regressions.

**Solution:** Add unit tests for pure-function modules first: `config.mjs` (`resolveModel`, `validateConfig`), `cli.mjs` (`parseAgentArgs`, `suggestFlag`), `context-bridge.mjs`, `telemetry.mjs`, `orchestration.mjs` (`autoModeRegex`, `buildContract`).

**Trade-offs:** Test maintenance burden. Mitigated by focusing on deterministic pure functions.

---

### G10. OrchestratorControl Filter Can Block RESPONSE Messages
**Priority:** Medium

**Problem:** `orchestrator-control.mjs:403-418` applies filters before `super._handleMessage()`. If a filter matches a RESPONSE, the parent's pending request resolution is blocked, causing timeout instead of response delivery.

**Solution:** Process RESPONSE messages before applying filters — exempt them from filtering.

**Trade-offs:** Filters can't block responses. Correct semantics: filters block unsolicited messages, not request responses.

---

### G11. Duplicate AI Client Implementations
**Priority:** Critical

**Problem:** `ai-client.mjs` (lazy init, retry on 529, object params) and `ai-decisions.mjs` (eager init — crashes without API key, no retry, positional params) overlap. Different text joining (`""` vs `"\n"`) produces subtly different outputs.

**Solution:** Delete `ai-decisions.mjs`. Redirect all callers to `ai-client.mjs`.

**Trade-offs:** Callers must update from positional to object-arg style (1-2 call sites).

---

### G12. Cost Tracker Has No Feedback Loop
**Priority:** Medium

**Problem:** `cost-tracker.mjs:28-30` uses fixed heuristics (800 input tokens/tool call). `ai-client.mjs:80-84` returns real `usage` data but it's never aggregated into cost estimates.

**Solution:** Add `recordActualUsage(model, inputTokens, outputTokens)` accumulator. Display blended cost: actual where available, heuristic where not.

**Trade-offs:** Adds coupling between cost tracker and orchestration layer.

---

### G13. Context Bridge Lacks Schema Validation
**Priority:** Medium

**Problem:** `context-bridge.mjs:21-56` reads JSON and accesses nested props with optional chaining but no schema validation. Malformed files silently produce empty prompts.

**Solution:** Lightweight validation: check `ctx` is object, warn on unexpected root keys, log sections extracted vs skipped.

**Trade-offs:** Could be overly strict if schema evolves — use warnings not errors.

---

### G14. Output Module is Anemic
**Priority:** Medium

**Problem:** `output.mjs` is 26 lines of raw ANSI codes and a `log()` function. All callers do ad-hoc formatting. No log levels, no timestamps, binary quiet flag.

**Solution:** Add `log.info(tag, msg)`, `log.warn()`, `log.error()`, `log.debug()` with level filtering. Keep `log()` as-is for compat.

**Trade-offs:** Adds API surface. Backward compatible.

---

## OPTIMIZATIONS — Concrete Code-Level Improvements

### O1. `autoMode` AI Call Adds 2-5s Latency
**Priority:** Medium | `orchestration.mjs:678`

**Problem:** API call to classify task mode runs before any work begins. Regex fallback (lines 734-767) produces reasonable results in microseconds.

**Solution:** Default to regex heuristic; add `--smart-route` flag for AI classification. Or run AI classification in parallel with decomposition.

**Trade-offs:** Regex less accurate for ambiguous tasks.

---

### O2. AI Client Retry Logic — Single Retry on 529 Only
**Priority:** Critical | `ai-client.mjs:60-70`

**Problem:** Only retries once on HTTP 529 after fixed 2s. Ignores 429, 500, 503, network errors. Second attempt can also crash.

**Solution:** Exponential backoff with jitter for retryable codes (429, 500, 503, 529). Max 3 retries. Or use SDK's built-in `maxRetries: 3`.

**Trade-offs:** Increased latency on failure. Fallback paths exist as safety net.

---

### O3. Three-Way Merge Temp Files Not Cleaned
**Priority:** Medium | `orchestration.mjs:360-377`

**Problem:** Creates `merge-current-*`, `merge-base-*`, `merge-other-*` temp files but never deletes them.

**Solution:** Add `finally` block with `unlinkSync` for all three temp files. Use `os.tmpdir()` instead of `workDir`.

---

### O4. MessageParser Buffer.concat O(n²) on Hot Path
**Priority:** High | `protocol.mjs:267`

**Problem:** `Buffer.concat([this.buffer, chunk])` copies all existing data on every incoming data event. O(n²) in data volume for bus handling 15 agents.

**Solution:** Buffer list pattern — accumulate chunks in array, only concat when frame extraction needed. Reduces CPU ~90%.

**Trade-offs:** Slightly more complex state management. Equivalent memory usage.

---

### O5. `git ls-files` Called Twice Per Decomposition
**Priority:** High | `decomposer.mjs:402,876`

**Problem:** `analyzeTaskScope()` runs `git ls-files`, then `decomposeHierarchically()` runs it again identically. Redundant subprocess + 10MB buffer allocation.

**Solution:** Have `analyzeTaskScope` return raw file list alongside scope analysis. Pass into `buildDependencyGraph` directly.

**Trade-offs:** Slightly larger return type. No downsides.

---

### O6. Decomposer `buildDependencyGraph` Blocks Event Loop
**Priority:** High | `decomposer.mjs:612-614`

**Problem:** `readFileSync()` on every file. 300 files → seconds of event loop blocking → missed heartbeats → false crash detection.

**Solution:** Use `asyncPool` pattern (already in `isolation.mjs`) with concurrency limit of 50.

**Trade-offs:** I/O-bound improvement on SSD (~2x), significant on NFS (~10x).

---

### O7. Synchronous Full-Tree Snapshot Blocks Event Loop
**Priority:** High | `isolation.mjs:56-85`

**Problem:** `snapshotFiles` sync-walks entire directory, reads every file, computes SHA-256. Blocks for seconds on large repos. Async variant exists but isn't used everywhere.

**Solution:** Deprecate sync `snapshotFiles`. Complete migration to `cacheSnapshotAsync` with mtime pre-filter.

**Trade-offs:** All callers become async (most already are).

---

### O8. Fake Circular Buffer Uses O(n) Array Operations
**Priority:** Medium | `telemetry-channel.mjs:60,351,273`

**Problem:** Declared as "circular buffer" but uses `shift()` (O(n)) and `unshift(...batch)` (O(n×batch)).

**Solution:** True ring buffer with head/tail indices and fixed-size array (~20 LOC).

**Trade-offs:** Saves ~50μs per drop event at 1000-item capacity.

---

### O9. Registry Discovery O(n) Linear Scans Per-Message
**Priority:** Medium | `registry.mjs:182-305`

**Problem:** `findByRole()`, `findByCapability()`, `findByHealth()` create array copies via `listAll()` then filter. Called on message routing hooks.

**Solution:** Secondary indexes: `roleIndex: Map<string, Set<string>>`, etc. Update on register/deregister.

**Trade-offs:** ~200 bytes per agent per index. Reduces O(n) to O(k) where k = matching agents.

---

### O10. Double Exponential Backoff Bug
**Priority:** Medium | `agent-channel.mjs:461-468`

**Problem:** `reconnectDelay` doubled both inside timeout callback (on failure) AND unconditionally after scheduling. 4× rate instead of 2× — reaches 30s max after 2 failures instead of ~5.

**Solution:** Delete line 468 (unconditional doubling). Catch block at 463 handles backoff correctly.

**Trade-offs:** None. Pure bug fix.

---

### O11. Bridge Split Header/Body Writes
**Priority:** Medium | `bridge.mjs:347-349`

**Problem:** Two separate `socket.write()` calls (4-byte header + body) causes TCP fragmentation. `protocol.mjs:218-227` already shows the correct single-buffer pattern.

**Solution:** Combine into single `Buffer.allocUnsafe(4 + replyBuf.length)` write.

**Trade-offs:** One extra allocation per response (negligible, bridge is low-frequency).

---

### O12. Pending Requests Grow Unbounded
**Priority:** Medium | `message-bus.mjs:72,540`

**Problem:** `pendingRequests` Map entries added on REQUEST, removed on RESPONSE. Crashed/unresponsive agents leave orphan entries forever.

**Solution:** Periodic sweep (60s interval) removing entries older than 30s. Or clean on agent disconnect.

**Trade-offs:** 60s sweep is coarse but sufficient.

---

### O13. Heartbeat Echo Creates 2× Message Overhead
**Priority:** Low | `message-bus.mjs:574`

**Problem:** Bus echoes every heartbeat back. `AgentChannel` never processes the echo. 15 agents × 30s = 30 wasted messages/minute.

**Solution:** Remove echo. Update `lastSeen` timestamp in registry on receipt instead.

**Trade-offs:** Removes server-confirmed ack. Use on-demand ping/pong if confirmation needed later.

---

### O14. Sync File I/O on IPC Logger Critical Path
**Priority:** High | `lib/ipc-logger.mjs:40-50`

**Problem:** `appendFileSync` + `writeFileSync` on every IPC log call. Comment says "Non-blocking" but `writeFileSync` is definitionally blocking. During 3-5 parallel agents, creates I/O contention.

**Solution:** Switch to `appendFile` (async) with debounced `writeFile` for latest-buffer (1s interval).

**Trade-offs:** Slight risk of message loss on crash (acceptable for observability logs).

---

### O15. Telemetry Parsing Scans Entire Output
**Priority:** High | `lib/telemetry.mjs:62-78`

**Problem:** `parseTelemetry` splits entire stderr/stdout by newline and iterates every line. For 50MB buffers, processes millions of lines. Also emits per-match IPC messages inside the loop.

**Solution:** Parse incrementally during execution as lines arrive. Batch IPC emission (`toolCalls({ Read: 5, Bash: 3 })`).

**Trade-offs:** Incremental parsing adds state to spawn loop.

---

### O16. Semantic Merge Token Budget Underestimate
**Priority:** High | `lib/semantic-merge.mjs:448`

**Problem:** `Math.min(16384, Math.ceil(baseContent.length / 3) + 2048)` — 16384 cap insufficient for 100KB files. ~3 chars/token assumption wrong for code (~3.5-4). Truncation causes fallback to git merge.

**Solution:** Use ~4 chars/token, raise cap to 65536, include diff additions in estimate.

**Trade-offs:** Higher cost per merge. Add size validation to re-request on truncation.

---

### O17. TUI Spinner 80ms Timer Creates Excessive Re-renders
**Priority:** High | `dashboard.mjs:87-89`, `monitor.mjs:320`

**Problem:** 80ms spinner interval = 12.5 full React reconciliation + re-renders/sec across entire component tree.

**Solution:** Use Ink's built-in `<Spinner>` component. Wrap `AgentListItem`/`AgentDetail` in `React.memo`.

**Trade-offs:** Imperceptible animation difference in terminal.

---

### O18. IPC Stream Reads Entire JSONL File Every Poll
**Priority:** High | `lib/tui/ipc-stream.mjs:44-63`

**Problem:** Reads entire `ipc.jsonl` every 500ms despite tracking `lastSize`. Splits ALL lines, then slices new ones.

**Solution:** Byte-offset-based reads using `fs.read` with position parameter. Read only `lastSize` to `stat.size`.

**Trade-offs:** Handle partial lines at buffer boundary with remainder buffer.

---

### O19. Monitor Sync FS Scans in Render Loop
**Priority:** Medium | `lib/tui/monitor.mjs:316-324`

**Problem:** `scanAllRuns()` called every 2s inside `setInterval`. Performs `readdirSync`/`statSync` on all runs — ~50+ sync stat calls for 10 runs with 5 agents each. Blocks React/Ink render loop.

**Solution:** Move to async `fs.promises` APIs with `useRef` mounted flag for cleanup.

**Trade-offs:** Async state updates need careful cleanup (stale closures).

---

### O20. ChatPanel Sawtooth Message Buffer
**Priority:** Medium | `lib/tui/chat-panel.mjs:78-81`

**Problem:** Grows to 500, trims to 300. Array spread `[...prev, msg]` copies up to 500 elements on every message at 10/s.

**Solution:** Ring buffer with fixed 300 capacity. Only re-render visible window.

**Trade-offs:** Minor complexity increase. Eliminates sawtooth and per-message copy.

---

### O21. `excludePatterns` Overly Broad String Matching
**Priority:** Low | `isolation.mjs:67`

**Problem:** `relPath.includes(p)` means `".git"` matches `.gitignore`, `.github/`, etc.

**Solution:** Path-segment matching: `relPath.split("/")` then `segments.includes(p)`.

**Trade-offs:** Slightly more computation per file. Correctness significantly improved.

---

### O22. Semantic Merge Naive Dropped-Change Detection
**Priority:** Medium | `lib/semantic-merge.mjs:686-694`

**Problem:** Compares trimmed lines as exact strings. Whitespace changes, reindentation, reordering flagged as "dropped" — cry-wolf effect.

**Solution:** Normalize lines more aggressively (collapse whitespace, strip comments). Consider Jaccard similarity threshold on tokens.

**Trade-offs:** Aggressive normalization could mask genuine drops.

---

### O23. Regex Tool Call Detection Undercounts
**Priority:** Medium | `agent-entry.mjs:438-445`

**Problem:** 6 tools tracked in progress patterns vs 8 in `TOOL_CALL_RE` (`config.mjs:22`). Missing WebSearch, WebFetch.

**Solution:** Derive progress patterns from `TOOL_CALL_RE` instead of maintaining separate list.

**Trade-offs:** None — strictly better.

---

## INNOVATIONS — Significant Enhancement Opportunities

### I1. Adaptive Agent Budget Based on Task Complexity
**Priority:** Medium | `config.mjs:167-171`

Depth presets are static. Decomposer knows complexity but can't adjust per-subtask budgets. Let decomposer output per-subtask `budget` recommendations; wire into `spawnAgent` calls.

---

### I2. Incremental Snapshot via FSEvents
**Priority:** Medium | `isolation.mjs`

Snapshot re-walks entire tree. Use `fs.watch`/`chokidar` to maintain live file index during swarm. Escape detection drops from O(files) to O(changed).

---

### I3. Streaming Verification During Agent Execution
**Priority:** Medium | `orchestration.mjs:484-614`

Verification runs AFTER all workers complete. Implement streaming verification via IPC — verifier reads progress events, flags issues mid-execution. Workers receiving "scope conflict" signals abort early, saving budget.

---

### I4. Result Deduplication Across Retry Attempts
**Priority:** Low | `agent-entry.mjs:347-688`

Retry loop re-runs entire agent from scratch. On retry, pass previous agent's output as context via `--context-file`, allowing resume from failure point.

---

### I5. Swarm-Level Cost Tracking and Budget Enforcement
**Priority:** Medium

No aggregate budget enforcement — 5 agents at max budget = 5× per-agent limit unchecked. Add `--total-budget` flag. `ResourceGovernor` could enforce aggregate via IPC-reported cumulative spend.

---

### I6. Dynamic Budget Rebalancing
**Priority:** Low | `decomposer.mjs:1099-1101`, `sub-coordinator.mjs:756-775`

Budget divided at decomposition time, never adjusted. Unused budget from early completers is wasted. Implement budget reservation pool in `ResourceGovernor` — sub-coordinators request on-demand. API partially exists in `governor.mjs:310-429` but isn't wired.

**Trade-offs:** ~1 IPC round-trip per spawn. Improves utilization from ~60% to ~85% for unbalanced trees.

---

### I7. Adaptive Decomposition with Dependency-Aware Routing
**Priority:** Low | `decomposer.mjs:698-707`

Directory-based grouping ignores cross-directory coupling. Dependency graph is built but only used for cohesion scoring. Use graph partitioning (min-cut / Kernighan-Lin) for natural module boundaries that minimize cross-boundary imports.

**Trade-offs:** ~100 LOC. KL algorithm O(n² log n) — acceptable for ≤300 files.

---

### I8. Adaptive AI Decision Model Selection
**Priority:** Low | `ai-client.mjs:45`, `semantic-merge.mjs:452`

All AI decisions use Sonnet regardless of complexity. Implement decision complexity classifier: large diffs → Opus for merge, complex decomposition → Opus, simple routing → Sonnet, failure → escalate to Opus on retry.

**Trade-offs:** Higher Opus cost offset by fewer failures and better decompositions.

---

### I9. Context Bridge Bidirectional Knowledge Flow
**Priority:** Low | `context-bridge.mjs`

Currently unidirectional (parent → child). No mechanism for agents to feed discoveries back during execution. Extend IPC with `knowledge.discovery` topic — agents publish, orchestrator aggregates and broadcasts via `knowledge.update`.

**Trade-offs:** Increases IPC volume. Must prevent feedback loops.

---

## Summary

| Category | Count | Critical | High | Medium | Low |
|----------|-------|----------|------|--------|-----|
| **Gaps** | 14 | 5 | 3 | 6 | 0 |
| **Optimizations** | 23 | 1 | 8 | 10 | 4 |
| **Innovations** | 9 | 0 | 0 | 4 | 5 |
| **Total** | **46** | **6** | **11** | **20** | **9** |

# Remote-Agent Architecture Analysis

*Generated from swarm analysis results*

**Analysis Date:** 2026-03-10T06:23:33.080Z
**Mode:** swarm
**Working Directory:** /tmp/swarm/a106c75a

---

## Task

Perform a rigorous architectural and code-quality analysis of the ~/.claude/arbor codebase. Phase 1: Read README.md, package.json, and map directory structure (lib/, config/, docs/). Phase 2: Deep-read all core source files — agent-entry.mjs, swarm.mjs, and every file under lib/ — thoroughly. Read tests if they exist. Phase 3: For every finding, assess impact on Performance, Output Quality, and Maintainability. Produce a prioritized PRD plan covering: (1) Weaknesses — structural/design issues limiting the project ceiling, (2) Bottlenecks — performance/scalability issues on the critical path, (3) Gaps — missing functionality vs stated goals, (4) Optimizations — concrete code-level improvements with measurable impact, (5) Innovations — significant enhancement opportunities based on observed code patterns. Each recommendation must reference specific files and line ranges. Format each as: Title, Priority (Critical/High/Medium/Low), Problem with file refs, Evidence with code snippets, Proposed Solution, Implementation Outline with steps/files, Trade-offs. Order by priority then impact.

---

## Agents Deployed

### Agent: Unknown

- **Role:** worker
- **Model:** opus
- **Status:** completed
- **Turns:** 0

---

### Agent: Unknown

- **Role:** worker
- **Model:** opus
- **Status:** completed
- **Turns:** 0

---

### Agent: Unknown

- **Role:** worker
- **Model:** opus
- **Status:** completed
- **Turns:** 0

---

## Merged Analysis Output

═══ AGENT-01 | Analyze Core Entry Points and Orchestration | completed (283.6s) ═══
Now I have comprehensive understanding of the entire codebase. Let me produce the analysis.

---

# Architectural & Code-Quality Analysis: arbor

## Priority: CRITICAL

---

### 1. Unbounded Memory in `agent-spawn.mjs` — Swarm Worker OOM Risk

**Priority:** Critical
**Impact:** Performance (crash), Output Quality (data loss), Maintainability (silent failure)

**Problem:** `agent-spawn.mjs:85-86` accumulates stdout chunks without any buffer limit, unlike `agent-entry.mjs` which implements a 50MB ring buffer with overflow-to-disk. Every swarm worker agent has its stdout buffered entirely in the parent process memory. With 3-5 agents running in parallel (each potentially producing megabytes of output), the orchestrator process can OOM.

**Evidence:**
```javascript
// agent-spawn.mjs:85-86 — NO LIMIT
const chunks = [];
proc.stdout.on("data", (c) => chunks.push(c));
```

Compare to `agent-entry.mjs:386-417` which has ring buffer + overflow + backpressure:
```javascript
// agent-entry.mjs:396-406 — PROTECTED
while (stdoutBytes > MAX_BUFFER_SIZE && stdoutChunks.length > 0) {
  const dropped = stdoutChunks.shift();
  stdoutBytes -= dropped.length;
  if (!stdoutOverflowStream) {
    stdoutOverflowPath = join(tempDir, "stdout-overflow.log");
    stdoutOverflowStream = createWriteStream(stdoutOverflowPath, { flags: "a" });
  }
  stdoutOverflowStream.write(dropped);
}
```

**Proposed Solution:** Extract the ring-buffer logic from `agent-entry.mjs` into a shared `BufferedStream` class in `lib/buffer.mjs`. Apply it in `spawnAgent()`. Cap per-agent at 10MB (agents write to result files anyway; the in-memory buffer is just for the contract's `merged_output`).

**Implementation Outline:**
1. Create `lib/buffer.mjs` with `RingBuffer` class (cap, overflow callback)
2. Use it in both `agent-spawn.mjs:85` and `agent-entry.mjs:386`
3. Respect `MAX_BUFFER_SIZE / agentCount` for swarm mode

**Trade-offs:** Adds ~40 LOC of shared code. Slight complexity increase, but eliminates a crash vector.

---

### 2. `buildContract` Verification Model Hardcoded to "thorough"

**Priority:** Critical
**Impact:** Output Quality (wrong model reported), Maintainability (confusing bug)

**Problem:** `orchestration.mjs:656` computes the verification model incorrectly. `DEPTH.thorough` is an object `{turns: 50, budget: 25, verifyModel: "opus"}` which is always truthy, so the ternary ALWAYS resolves to `"thorough"` regardless of the actual depth used.

**Evidence:**
```javascript
// orchestration.mjs:656
verification: verifyResult ? {
  model: DEPTH[DEPTH.thorough ? "thorough" : "normal"]?.verifyModel || "sonnet",
  // ↑ DEPTH.thorough is {turns:50, budget:25, verifyModel:"opus"} — always truthy
  // This ALWAYS returns "opus", even when depth="shallow" was used
```

**Proposed Solution:** Pass the `depth` string through to `buildContract` and use it directly:
```javascript
model: DEPTH[depth]?.verifyModel || "sonnet",
```

**Implementation Outline:**
1. Add `depth` parameter to `buildContract` signature
2. Update call site in `swarm.mjs:542`
3. Use `DEPTH[depth]?.verifyModel` instead of the broken ternary

**Trade-offs:** Signature change to `buildContract` — callers need updating (1 call site in `swarm.mjs`).

---

### 3. `depends_on` Declared but Never Enforced in Parallel Execution

**Priority:** Critical
**Impact:** Output Quality (incorrect results from violated dependencies), Maintainability (misleading API)

**Problem:** The decomposer prompt (`config.mjs:162`) tells the AI to produce `"depends_on": []` for each subtask. However, `executeParallel()` at `orchestration.mjs:236-278` launches ALL subtasks simultaneously with `Promise.all`. Dependencies are completely ignored. If the decomposer correctly identifies that subtask B depends on subtask A, B will still run concurrently with A, potentially reading stale state.

**Evidence:**
```javascript
// config.mjs:162 — decomposer is told to declare dependencies
'- depends_on: array of titles this subtask must wait for (empty if independent)',

// orchestration.mjs:236-278 — dependencies are never read
const promises = agentSetups.map((setup, i) => {
  // ...
  return spawnAgent({...}).then((result) => {...});
});
const results = await Promise.all(promises); // ALL run in parallel, no dependency check
```

**Proposed Solution:** Implement a topological sort scheduler:
1. Build a DAG from `depends_on` fields
2. Run independent tasks in parallel
3. When a task completes, release its dependents
4. Fall back to full parallelism if the DAG has cycles (with a warning)

**Implementation Outline:**
1. Add `buildExecutionDAG(subtasks)` to `orchestration.mjs`
2. Replace `Promise.all` with wave-based execution: `executeWaves(dag, spawnFn)`
3. Maintain the same result format

**Trade-offs:** Increases complexity of parallel execution. Could reduce parallelism if dependencies are over-specified. Mitigated by having the decomposer prefer independence (already in prompt).

---

### 4. `policy-limits.json` Schema vs Reality Mismatch

**Priority:** Critical
**Impact:** Maintainability (dead code / latent crash), Output Quality (false confidence in validation)

**Problem:** `config.mjs:183-224` defines `POLICY_LIMITS_SCHEMA` with fields `maxTurns`, `maxCost`, `timeout`, `maxAgents` (all marked `required: true`), but the actual `config/policy-limits.json` only contains `restrictions`. If `loadPolicyLimits()` were ever called, it would throw a validation error because the required fields don't exist.

**Evidence:**
```javascript
// config.mjs:186-213
export const POLICY_LIMITS_SCHEMA = {
  properties: {
    maxTurns: { type: "number", required: true, ... },    // NOT in actual file
    maxCost: { type: "number", required: true, ... },     // NOT in actual file
    timeout: { type: "number", required: true, ... },     // NOT in actual file
    maxAgents: { type: "number", required: true, ... },   // NOT in actual file
    restrictions: { type: "object", required: false, ... } // Only this exists
  }
};
```

```json
// config/policy-limits.json — actual contents
{
  "restrictions": {
    "allow_product_feedback": { "allowed": false },
    "allow_remote_sessions": { "allowed": false },
    "allow_remote_control": { "allowed": false }
  }
}
```

**Proposed Solution:** Either (a) update `policy-limits.json` to include the required fields and wire them into the actual agent spawn logic, or (b) fix the schema to match reality. Option (a) would centralize limits currently scattered across CLI defaults.

**Implementation Outline:**
1. Add `maxTurns: 200, maxCost: 100, timeout: 3600000, maxAgents: 5` to `policy-limits.json`
2. Have `agent-entry.mjs` and `swarm.mjs` load and respect these as hard caps
3. Or: Mark all as `required: false` in the schema to match current usage

**Trade-offs:** Option (a) adds centralized governance but requires wiring. Option (b) is simpler but admits the schema is aspirational.

---

## Priority: HIGH

---

### 5. Pipeline Mode Doesn't Chain Context Between Stages

**Priority:** High
**Impact:** Output Quality (stages operate blind to prior stages' work)

**Problem:** `orchestration.mjs:458` passes `results[0]?.resultFile` (RESEARCH stage) as the context file for ALL subsequent stages. The IMPLEMENT stage result is never passed to TEST, meaning the TEST stage doesn't know what was just implemented. The REVIEW stage only sees RESEARCH context, not IMPLEMENT or TEST results.

**Evidence:**
```javascript
// orchestration.mjs:458
contextFile: i > 0 ? results[0]?.resultFile : contextFile,
// Stage 0 (RESEARCH): uses original contextFile ✓
// Stage 1 (IMPLEMENT): uses RESEARCH result ✓
// Stage 2 (TEST): uses RESEARCH result ✗ (should use IMPLEMENT)
// Stage 3 (REVIEW): uses RESEARCH result ✗ (should use cumulative context)
```

**Proposed Solution:** Chain context: each stage receives the previous stage's result file, or a cumulative context file that aggregates all prior stage outputs.

**Implementation Outline:**
```javascript
contextFile: i > 0 ? results[i - 1]?.resultFile : contextFile,
```
Or build a cumulative context file per stage.

**Trade-offs:** Simple chaining may miss earlier context. Cumulative approach requires building a composite context file, adding ~20 LOC.

---

### 6. Duplicate Signal Handler Registration

**Priority:** High
**Impact:** Maintainability (double cleanup, race conditions), Performance (redundant work)

**Problem:** `agent-entry.mjs:88-110` registers its own `exit`, `SIGTERM`, `SIGINT`, and `uncaughtException` handlers. `lifecycle.mjs:131-197` also registers handlers for all the same signals via `ensureCleanupHooks()`. When `agent-entry.mjs` imports lifecycle functions that register cleanup handlers, both sets of handlers fire on signals, causing double cleanup attempts and potential race conditions.

**Evidence:**
```javascript
// agent-entry.mjs:88-91
process.on("exit", () => {
  killAllChildren();
  cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME);
});

// lifecycle.mjs:135-145
process.on("exit", () => {
  const handlers = Array.from(cleanupHandlers);
  for (const handler of handlers) {
    try { handler(); } catch (err) { ... }
  }
});
```

**Proposed Solution:** Consolidate into lifecycle.mjs's `registerCleanupHandler` pattern. Have `agent-entry.mjs` register `killAllChildren` and `cleanupTeamDir` as cleanup handlers instead of duplicating the process event registration.

**Implementation Outline:**
1. Remove manual `process.on(...)` calls from `agent-entry.mjs:88-110`
2. Import `registerCleanupHandler` from lifecycle.mjs
3. Register `killAllChildren` and `cleanupTeamDir` as handlers in `main()`

**Trade-offs:** Cleanup execution order becomes less explicit. Mitigated by lifecycle.mjs running handlers in registration order.

---

### 7. Synchronous Full-Tree Snapshot Blocks Event Loop

**Priority:** High
**Impact:** Performance (multi-second blocking on large repos)

**Problem:** `isolation.mjs:56-85` (`snapshotFiles`) synchronously walks the entire directory tree, reads every file, and computes SHA-256 hashes. For a repo with thousands of files, this blocks the Node.js event loop for seconds. The async variant (`snapshotFilesAsync`, line 174) exists but `snapshotFiles` is still called from synchronous code paths like `cacheSnapshot` (line 32) and `snapshotFilesFiltered` (line 92).

**Evidence:**
```javascript
// isolation.mjs:72-77 — sync read + hash of EVERY file
const content = readFileSync(fullPath);
const hash = createHash("sha256").update(content).digest("hex");
const st = statSync(fullPath);
manifest[relPath] = { hash, size: content.length, mtimeMs: st.mtimeMs };
```

**Proposed Solution:** Deprecate the synchronous `snapshotFiles` entirely. The `snapshotFilesFiltered` (used for escape detection) should use the async pattern with the mtime optimization. Already partially done with `cacheSnapshotAsync` — complete the migration.

**Implementation Outline:**
1. Replace `cacheSnapshot` calls with `cacheSnapshotAsync`
2. Make `snapshotFilesFiltered` async with the concurrency pool
3. Keep the sync version only as a last-resort fallback

**Trade-offs:** All callers become async, requiring await propagation. Most callers are already async.

---

### 8. Array Property Mutation for Conflict Report

**Priority:** High
**Impact:** Maintainability (fragile pattern, data loss on serialization)

**Problem:** `orchestration.mjs:422` attaches a custom property to an Array object. Arrays are objects in JS, so this works, but the property is lost when the array is spread, destructured, `JSON.stringify`'d without custom handling, or passed through `Array.from()`.

**Evidence:**
```javascript
// orchestration.mjs:422
results._conflictReport = conflictReport;

// swarm.mjs:541 — reads it back
const conflictReport = workerResults._conflictReport || null;
```

**Proposed Solution:** Return a proper result object from `executeParallel`:
```javascript
return { results, conflictReport };
```

**Implementation Outline:**
1. Change `executeParallel` return type to `{ results: WorkerResult[], conflictReport: ConflictEntry[] }`
2. Update `swarm.mjs` to destructure: `const { results: workerResults, conflictReport } = await executeParallel(...)`
3. Same for `executePipeline` for consistency

**Trade-offs:** Breaking change to `executeParallel` return type. Only 2 call sites (swarm.mjs, hierarchy fallback).

---

### 9. Backpressure Implementation is Effectively a No-Op

**Priority:** High
**Impact:** Performance (false protection against memory pressure)

**Problem:** `agent-entry.mjs:409-416` pauses stdout when buffer exceeds 80% threshold, then immediately resumes on `setImmediate`. Since `setImmediate` fires on the next event loop iteration and the `data` event is already dequeued, this pause/resume cycle has negligible effect — the stream is paused for essentially zero time.

**Evidence:**
```javascript
// agent-entry.mjs:409-416
if (stdoutBytes > BACKPRESSURE_THRESHOLD && !proc.stdout.isPaused()) {
  proc.stdout.pause();
  setImmediate(() => {
    if (proc.stdout.isPaused()) {
      proc.stdout.resume();
    }
  });
}
```

**Proposed Solution:** Remove the pseudo-backpressure or implement real backpressure by piping through a Transform stream with `highWaterMark`. The ring buffer already handles overflow; the backpressure mechanism is redundant and misleading.

**Implementation Outline:**
1. Remove the pause/resume blocks (lines 409-416 and 543-550)
2. The ring buffer + overflow-to-disk already handles the actual problem
3. Optionally: use a proper Transform stream for backpressure if needed

**Trade-offs:** Removing dead code simplifies the file with zero behavioral change.

---

## Priority: MEDIUM

---

### 10. No Test Suite

**Priority:** Medium
**Impact:** Maintainability (regressions undetected), Output Quality (can't verify fixes)

**Problem:** Zero test files exist in the entire `arbor/` directory. For a system that manipulates git worktrees, spawns processes, manages files, and performs complex orchestration, any change risks introducing subtle regressions that won't be caught.

**Evidence:**
```bash
# No test files, no test scripts
$ find arbor/ -name "*.test.*" -o -name "*.spec.*"
# (empty)
```

```json
// package.json — no test script
{
  "scripts": {
    "start": "node agent-entry.mjs",
    "update-claude": "npm install @anthropic-ai/claude-code@latest"
  }
}
```

**Proposed Solution:** Add unit tests for the pure-function modules first (highest ROI):
1. `config.mjs`: `resolveModel`, `validateConfig`
2. `cli.mjs`: `parseAgentArgs`, `parseSwarmArgs`, `suggestFlag`
3. `context-bridge.mjs`: `contextToSystemPrompt`
4. `telemetry.mjs`: `parseTelemetry`
5. `orchestration.mjs`: `autoModeRegex`, `buildContract`

**Implementation Outline:**
1. Add `vitest` or Node's built-in `node:test` as devDependency
2. Create `test/` directory with per-module test files
3. Add `"test": "vitest"` to package.json scripts

**Trade-offs:** Maintenance burden of test suite. Mitigated by focusing on deterministic pure functions first.

---

### 11. `autoMode` AI Call Adds 2-5s Latency to Every Swarm Invocation

**Priority:** Medium
**Impact:** Performance (latency on critical path)

**Problem:** `orchestration.mjs:678` calls the Anthropic API to classify the task mode. This adds 2-5 seconds to every `swarm` invocation before any actual work begins. The regex fallback (lines 734-767) produces reasonable results and runs in microseconds.

**Evidence:**
```javascript
// orchestration.mjs:678-732 — full API call just to pick a mode
export async function autoMode(task) {
  if (isAiClientAvailable()) {
    try {
      const result = await aiJsonDecision({ model: "claude-sonnet-4-6", ... });
      // 2-5 seconds later...
```

**Proposed Solution:** Use the regex heuristic as default, with an opt-in `--smart-route` flag for AI-powered mode selection. Or cache mode decisions for similar task patterns.

**Implementation Outline:**
1. Default to `autoModeRegex` (rename to `autoMode`)
2. Add `--smart-route` flag that enables the AI classification
3. Or: run AI classification in parallel with decomposition (don't block on it)

**Trade-offs:** Regex is less accurate for ambiguous tasks. The 2-5s cost may be acceptable if the AI picks a better mode that saves time overall.

---

### 12. `ai-client.mjs` Retry Logic is Insufficient

**Priority:** Medium
**Impact:** Performance (failed orchestration calls), Output Quality (degraded mode fallbacks)

**Problem:** `ai-client.mjs:60-70` only retries on HTTP 529 (overloaded), once, after 2s. It doesn't handle 429 (rate limit), 500, 503, network timeouts, or `ECONNRESET`. Since AI calls are used for critical orchestration decisions (decompose, verify, autoMode), transient failures silently degrade to subprocess fallback or regex fallback.

**Evidence:**
```javascript
// ai-client.mjs:62-69
try {
  response = await client.messages.create(params);
} catch (err) {
  if (err.status === 529) {
    await new Promise((r) => setTimeout(r, 2000));
    response = await client.messages.create(params);
  } else {
    throw err;  // 429, 500, 503 all throw immediately
  }
}
```

**Proposed Solution:** Add exponential backoff with jitter for transient errors (429, 500, 503, 529, network errors). Max 3 retries, 1-4s delays.

**Implementation Outline:**
```javascript
const RETRYABLE = new Set([429, 500, 503, 529]);
for (let attempt = 0; attempt <= 2; attempt++) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    if (!RETRYABLE.has(err.status) && err.code !== 'ECONNRESET') throw err;
    await new Promise(r => setTimeout(r, (1 << attempt) * 1000 + Math.random() * 500));
  }
}
```

**Trade-offs:** Adds latency on failure. Mitigated by low retry count and the fact that fallback paths exist.

---

### 13. Three-Way Merge Temp Files Not Cleaned Up

**Priority:** Medium
**Impact:** Maintainability (disk leak), Performance (leftover files)

**Problem:** `orchestration.mjs:360-377` creates temp files for `git merge-file` but never cleans them up. If the merge succeeds or fails, the temp files (`merge-current-*`, `merge-base-*`, `merge-other-*`) remain in the workDir indefinitely.

**Evidence:**
```javascript
// orchestration.mjs:360-362 — created but never deleted
const tmpCurrent = join(workDir, `merge-current-${file.replace(/\//g, "_")}`);
const tmpBase = join(workDir, `merge-base-${file.replace(/\//g, "_")}`);
const tmpOther = join(workDir, `merge-other-${file.replace(/\//g, "_")}`);
// ... no cleanup after try/catch
```

**Proposed Solution:** Add `finally` block to clean up temp files. Use `os.tmpdir()` instead of `workDir` for merge temps.

**Implementation Outline:**
```javascript
try {
  writeFileSync(tmpCurrent, currentMerged, "utf-8");
  // ... merge ...
} catch (err) {
  // ... handle ...
} finally {
  for (const f of [tmpCurrent, tmpBase, tmpOther]) {
    try { unlinkSync(f); } catch {}
  }
}
```

**Trade-offs:** Minimal — pure cleanup improvement.

---

### 14. Regex Tool Call Detection Undercounts

**Priority:** Medium
**Impact:** Output Quality (inaccurate telemetry), Maintainability (misleading metrics)

**Problem:** `agent-entry.mjs:438-445` uses patterns like `/\bRead\(/i` to detect tool calls from stderr. This regex requires the exact pattern "Read(" which may not match Claude Code's actual stderr format. Additionally, tools like `WebSearch` and `WebFetch` (listed in `config.mjs:22` `TOOL_CALL_RE`) are missing from the progress tracker patterns.

**Evidence:**
```javascript
// agent-entry.mjs:438-445 — 6 tools tracked
const toolPatterns = [
  { pattern: /\bRead\(/i, name: "Read" },
  { pattern: /\bGrep\(/i, name: "Grep" },
  // ...missing WebSearch, WebFetch
];

// config.mjs:22 — 8 tools in the regex
export const TOOL_CALL_RE = /\b(Read|Grep|Bash|Edit|Write|Glob|WebSearch|WebFetch)\(/;
```

**Proposed Solution:** Derive the progress patterns from `TOOL_CALL_RE` rather than maintaining a separate list. Or at minimum, add the missing tools.

**Implementation Outline:**
1. Import `TOOL_CALL_RE` (already imported) and use it for progress tracking
2. Parse group name from the match: `const m = text.match(TOOL_CALL_RE); if (m) { progress.last_tool = m[1]; progress.tool_calls_count++; }`

**Trade-offs:** None — strictly better than the current approach.

---

## Priority: LOW

---

### 15. `cleanupTeamDir` Warning Spam on Early Crashes

**Priority:** Low
**Impact:** Maintainability (noisy logs)

**Problem:** `agent-entry.mjs:90` calls `cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME)` in the `exit` handler, but the env var is set at line 304 inside `main()`. If the process exits before reaching line 304 (e.g., CLI parse failure at line 170), `REMOTE_AGENT_TEAM_NAME` is undefined, causing `cleanupTeamDir` to emit a warning: "Cannot cleanup team directory - no team name provided" (lifecycle.mjs:262).

**Evidence:**
```javascript
// agent-entry.mjs:88-91
process.on("exit", () => {
  killAllChildren();
  cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME); // undefined before line 304
});

// lifecycle.mjs:261-265
if (!teamName) {
  process.stderr.write(`Warning: Cannot cleanup team directory...`);
  return;
}
```

**Proposed Solution:** Guard the call: `if (process.env.REMOTE_AGENT_TEAM_NAME) cleanupTeamDir(...)`. Or set the env var earlier.

**Trade-offs:** Trivial fix.

---

### 16. `excludePatterns` Uses `String.includes()` — Overly Broad Matching

**Priority:** Low
**Impact:** Output Quality (files incorrectly excluded from snapshots)

**Problem:** `isolation.mjs:67` uses `relPath.includes(p)` for exclude matching. This means a pattern like `"__pycache__"` would also match a file named `something__pycache__related.py` or a directory `my__pycache__dir/`. The `".git"` pattern would match files like `.gitignore` or `.github/`.

**Evidence:**
```javascript
// isolation.mjs:67
if (excludePatterns.some(p => relPath.includes(p))) continue;

// config.mjs:174
export const DEFAULT_EXCLUDES = ["node_modules", ".git", ".beads", "__pycache__", ".DS_Store"];
// ".git" matches ".gitignore", ".github/", etc.
```

**Proposed Solution:** Use path-segment matching: split on `/` and check if any segment exactly matches the pattern, or use a proper glob library.

**Implementation Outline:**
```javascript
const segments = relPath.split("/");
if (excludePatterns.some(p => segments.includes(p))) continue;
```

**Trade-offs:** Slightly more computation per file. Correctness improvement is significant — `.github/` workflows would no longer be excluded.

---

## Innovation Opportunities

---

### I1. Adaptive Agent Budget Based on Task Complexity

**Observation:** Depth presets (`config.mjs:167-171`) are static. The decomposer knows the task complexity but can't adjust budgets per subtask — all workers get the same `preset.budget`.

**Opportunity:** Let the decomposer output per-subtask budget recommendations (it already outputs `turns`). Wire `budget` from decomposer output into `spawnAgent` calls. Complex subtasks get more budget; simple file-copy subtasks get less.

---

### I2. Incremental Snapshot via inotify/FSEvents

**Observation:** The snapshot system (`isolation.mjs`) re-walks the entire directory tree. The mtime pre-filter helps, but the walk itself scales with repo size.

**Opportunity:** Use Node.js `fs.watch` / `chokidar` to maintain a live file index during the swarm run. When `validateAndApply` needs a post-snapshot, only re-hash files that changed according to the watcher. This would reduce escape detection from O(files) to O(changed).

---

### I3. Streaming Verification During Agent Execution

**Observation:** Verification (`orchestration.mjs:484-614`) runs AFTER all workers complete. If a worker produces an obvious error early, other workers continue wasting budget.

**Opportunity:** Implement streaming verification via the IPC bus — the verifier agent reads progress events and can flag issues mid-execution. Workers that receive a "scope conflict" or "critical error in dependency" signal can abort early, saving budget.

---

### I4. Result Deduplication Across Retry Attempts

**Observation:** `agent-entry.mjs:347-688` retry loop re-runs the entire agent subprocess. If the agent succeeded partially before failing, the retry starts from scratch with no memory of prior progress.

**Opportunity:** On retry, pass the previous agent's output as context (via `--context-file`), allowing the new agent to resume from where the previous one failed rather than starting over. The result file from the failed run contains enough information to seed this.

---

### I5. Cost Tracking and Budget Enforcement Across Swarm

**Observation:** Each agent has its own budget (`DEPTH[depth].budget`), but there's no swarm-level cost tracking. If all 5 agents hit their budget ceiling, the total spend is 5x the per-agent limit with no aggregate enforcement.

**Opportunity:** Add a `--total-budget` flag to `swarm`. The `ResourceGovernor` (already partially implemented in the hierarchy module) could enforce an aggregate budget by reducing per-agent allocations dynamically based on cumulative spend reported through the IPC bus.

---

```checklist
- [PASS] Read and analyzed README.md: arbor/README.md (499 lines)
- [PASS] Read and analyzed package.json: arbor/package.json (20 lines)
- [PASS] Read and analyzed agent-entry.mjs: arbor/agent-entry.mjs (808 lines)
- [PASS] Read and analyzed swarm.mjs: arbor/swarm.mjs (612 lines)
- [PASS] Read and analyzed lib/orchestration.mjs: arbor/lib/orchestration.mjs (768 lines)
- [PASS] Read and analyzed lib/agent-spawn.mjs: arbor/lib/agent-spawn.mjs (115 lines)
- [PASS] Read and analyzed lib/lifecycle.mjs: arbor/lib/lifecycle.mjs (379 lines)
- [PASS] Read and analyzed lib/isolation.mjs: arbor/lib/isolation.mjs (547 lines)
- [PASS] Read and analyzed lib/config.mjs: arbor/lib/config.mjs (496 lines)
- [PASS] Read and analyzed lib/cli.mjs: arbor/lib/cli.mjs (282 lines)
- [PASS] Read and analyzed config/policy-limits.json (13 lines)
- [PASS] Read and analyzed config/settings.json (10 lines)
- [PASS] Additionally analyzed: lib/ai-client.mjs, lib/telemetry.mjs, lib/context-bridge.mjs, lib/output.mjs
- [PASS] Produced 16 findings across 4 priority levels (Critical: 4, High: 5, Medium: 4, Low: 2) plus 5 innovation opportunities
- [PASS] All findings reference specific files and line ranges with code snippets as evidence
```

═══ AGENT-02 | Analyze IPC Layer and Hierarchy System | completed (431.9s) ═══
I've now read all 20+ files across both subsystems and all design documents. Here is the comprehensive architectural analysis.

---

# Architectural & Code Quality Analysis: IPC + Hierarchy Subsystems

## Prioritized PRD: Findings & Recommendations

---

### 1. Wildcard Topic Matching Missing — Hierarchical IPC Is Non-Functional

**Priority: CRITICAL**

**Problem:** The `ScopedBus.subscribeDown()` creates wildcard topic patterns (e.g., `swarm.L2.auth.*.status`) but the `MessageBus._routeToSubscribers()` uses exact `Map.get()` lookups. Wildcard patterns **never match any published messages**, meaning all parent-child hierarchical communication silently fails.

**Impact:** Performance: N/A | Output Quality: CRITICAL (hierarchy coordination is broken) | Maintainability: HIGH

**Evidence:**

`scoped-bus.mjs:247-252`:
```javascript
subscribeDown(eventType, handler) {
    const childLevel = this.level + 1;
    const wildcardTopic = `swarm.L${childLevel}.${this.scope}.*.${eventType}`;
    // Note: This relies on the message bus supporting wildcard subscriptions
    // If not supported, this will only match exact topic names
    this.channel.subscribe(wildcardTopic, handler);
}
```

`message-bus.mjs:616-620`:
```javascript
_routeToSubscribers(topic, msg) {
    const subscribers = this.subscriptions.get(topic); // EXACT match only
    if (!subscribers || subscribers.size === 0) { return 0; }
    // ...
```

The design doc (`HIERARCHICAL_DECOMPOSITION_DESIGN.md:658`) explicitly identifies this as needed: *"Add wildcard topic matching (e.g., `swarm.L1.*.lifecycle`)"*.

**Proposed Solution:** Implement a trie-based topic matcher in `MessageBus` that supports `*` (single-segment) and `**` (multi-segment) wildcards. On subscribe, store both exact and wildcard subscriptions. On publish, check exact matches first, then walk wildcard patterns.

**Implementation Outline:**
1. Add `wildcardSubscriptions: Map<string, Set<string>>` to `MessageBus`
2. On `SUBSCRIBE` with `*` in topic: parse into segments, store in trie
3. On `PUBLISH`: first check exact `this.subscriptions.get(topic)`, then walk trie for wildcard matches
4. Cache matched wildcards per-topic with invalidation on subscribe/unsubscribe

**Trade-offs:** Adds ~50-100ms overhead on first publish to a new topic (trie walk). Cached lookups are O(1) afterward. Increases memory by ~2KB per wildcard subscription.

---

### 2. Python Bridge Protocol Mismatch — Silent Message Drop

**Priority: CRITICAL**

**Problem:** The Python `BusClient` sends REGISTER and UNREGISTER messages without the required `id` field. The Node.js `MessageParser.feed()` validates every message via `validateMessage()` and silently skips messages without a valid `id`. This means **Python clients silently fail to register** with the bus.

**Impact:** Performance: N/A | Output Quality: CRITICAL (Python hooks cannot communicate) | Maintainability: HIGH

**Evidence:**

`bus_client.py:126-135`:
```python
self._send_frame({
    "type": "REGISTER",
    "from": self.agent_id,
    "payload": {"agentId": self.agent_id, "pid": os.getpid()},
    "timestamp": int(time.time() * 1000)
    # MISSING: "id", "to", "topic", "correlationId", "priority"
})
```

`protocol.mjs:152-155`:
```javascript
if (!msg.id || typeof msg.id !== "string") {
    return { valid: false, error: "Message must have a string 'id'" };
}
```

`protocol.mjs:312-314` (inside `MessageParser.feed`):
```javascript
const validation = validateMessage(message);
if (!validation.valid) {
    continue; // Silently skip — Python REGISTER is dropped here
}
```

**Proposed Solution:** Add `"id": str(uuid.uuid4())` to all messages in `bus_client.py`. Also add missing fields (`to`, `topic`, `correlationId`, `priority`) with `None`/null defaults to match the JS protocol schema.

**Implementation Outline:**
1. Create a `_create_message(type, payload, **kwargs)` helper in `BusClient` that mirrors `createMessage()` from `protocol.mjs`
2. Replace all raw dict construction in `connect()`, `close()`, `_send_unsubscribe()` with the helper
3. Add a protocol conformance test that validates Python messages against JS `validateMessage()`

**Trade-offs:** Minimal. UUID generation adds ~1μs per message. Breaking change for any downstream Python consumers expecting the old format (likely none, since the old format doesn't work).

---

### 3. Rate Limiting Declared But Never Enforced

**Priority: HIGH**

**Problem:** `MessageBus` stores rate limit configuration (`rateLimits` Map, `rateLimitWindows` Map) and accepts `set_rate_limit`/`get_rate_limit` commands, but the actual message routing path (`_handleMessage`, `_sendToClient`, `_routeToSubscribers`) never checks rate limits. A misbehaving agent can flood the bus without throttling.

**Impact:** Performance: HIGH (bus saturation under load) | Output Quality: MEDIUM | Maintainability: LOW

**Evidence:**

`message-bus.mjs:83-87` (declared):
```javascript
this.rateLimits = new Map();
this.rateLimitWindows = new Map();
```

`message-bus.mjs:773-783` (set command exists):
```javascript
case "set_rate_limit": {
    const targetId = msg.payload?.targetAgentId;
    const limit = msg.payload?.msgsPerSec;
    if (targetId && typeof limit === "number") {
        this.rateLimits.set(targetId, limit);
    }
    break;
}
```

But `_handleMessage()` at line 357 calls the switch statement directly — **no rate check anywhere in the path**.

**Proposed Solution:** Add a `_checkRateLimit(agentId)` method called at the top of `_handleMessage()` before routing. Use a sliding window counter (array of timestamps, trimmed to 1-second window).

**Implementation Outline:**
1. Add `_checkRateLimit(agentId)` → returns `boolean` (allowed/blocked)
2. Call it at `_handleMessage:359`, after identity validation but before routing
3. On block: increment `metrics.messagesBlocked`, log, optionally send ERROR back to sender
4. Use `rateLimitWindows` Map with trimmed timestamp arrays (already declared, just unused)

**Trade-offs:** Adds ~2μs per message (timestamp comparison). Array trimming on each check is O(window_size), capped at `msgsPerSec` entries. Negligible for typical 100 msg/sec limits.

---

### 4. Pause/Resume Has No Effect on Message Flow

**Priority: HIGH**

**Problem:** `pauseAgent()` adds to `pausedAgents` Set, but no code path checks this set during message routing. The JSDoc at `orchestrator-control.mjs:197-198` promises *"Messages from the paused agent will be queued by the bus but not delivered until resumed"* — this is documentation-code divergence.

**Impact:** Performance: N/A | Output Quality: HIGH (orchestrator control is illusory) | Maintainability: HIGH (misleading API)

**Evidence:**

`message-bus.mjs:756-761` (pause command):
```javascript
case "pause_agent": {
    const targetId = msg.payload?.targetAgentId;
    if (targetId) { this.pausedAgents.add(targetId); }
    break;
}
```

`message-bus.mjs:637-643` (`_sendToClient` — no pause check):
```javascript
_sendToClient(agentId, msg) {
    const socket = this.clients.get(agentId);
    if (!socket) { return false; }
    return this._sendToSocket(socket, msg); // No pause check
}
```

**Proposed Solution:** Add a message queue per paused agent. On `_sendToClient`, if agent is paused, enqueue message. On `resume_agent`, drain the queue. Set a max queue depth per agent (e.g., 1000 messages) with oldest-drop overflow.

**Implementation Outline:**
1. Add `pauseQueues: Map<string, Message[]>` to `MessageBus`
2. In `_sendToClient`: check `pausedAgents.has(agentId)` → enqueue to `pauseQueues`
3. In `resume_agent` handler: drain `pauseQueues.get(targetId)` via `_sendToSocket` for each message
4. Enforce max queue depth (1000 default), drop oldest on overflow

**Trade-offs:** Memory overhead of ~1MB per 1000 queued messages per paused agent. Queue drain on resume creates a burst — consider throttled drain with `setImmediate()` batches.

---

### 5. MessageParser Buffer.concat Is O(n²) on Hot Path

**Priority: HIGH**

**Problem:** `MessageParser.feed()` calls `Buffer.concat([this.buffer, chunk])` on every incoming data event. This creates a new buffer and copies all existing data on every call, making total processing O(n²) in data volume. For a bus handling 15 agents with heartbeats + telemetry, this is the primary serialization bottleneck.

**Impact:** Performance: HIGH (quadratic CPU on message throughput) | Output Quality: N/A | Maintainability: LOW

**Evidence:**

`protocol.mjs:267`:
```javascript
feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Every call copies this.buffer + chunk into a new allocation
```

**Proposed Solution:** Replace with a buffer list pattern. Accumulate chunks in an array, only concat when needed for frame extraction. After extraction, keep only the remainder.

**Implementation Outline:**
```javascript
// Replace:
this.buffer = Buffer.concat([this.buffer, chunk]);
// With:
this._chunks.push(chunk);
this._totalLength += chunk.length;
// Only concat when we need to read a frame:
if (this._totalLength >= neededBytes) {
    this.buffer = Buffer.concat(this._chunks);
    this._chunks = [];
    this._totalLength = this.buffer.length;
}
```

**Trade-offs:** Slightly more complex state management. Memory usage is equivalent (same data, different layout). Reduces CPU by ~90% for large message volumes.

---

### 6. Decomposer Calls `git ls-files` Twice Per Decomposition

**Priority: HIGH**

**Problem:** `decomposeHierarchically()` calls `analyzeTaskScope()` which runs `git ls-files` (line 402), then immediately runs `git ls-files` again in its own body (line 876). The file listing is identical both times.

**Impact:** Performance: HIGH (redundant subprocess + 10MB buffer allocation) | Output Quality: N/A | Maintainability: MEDIUM

**Evidence:**

`decomposer.mjs:400-408` (first call in `analyzeTaskScope`):
```javascript
const output = execFileSync("git", ["ls-files"], {
    cwd: workDir, encoding: "utf-8", timeout: 10000,
    maxBuffer: 10 * 1024 * 1024
});
files = output.split("\n").filter(Boolean);
```

`decomposer.mjs:874-882` (second call in `decomposeHierarchically`):
```javascript
const output = execFileSync("git", ["ls-files"], {
    cwd: workDir, encoding: "utf-8", timeout: 10000,
    maxBuffer: 10 * 1024 * 1024
});
files = output.split("\n").filter(Boolean).filter(isCodeFile);
```

**Proposed Solution:** Have `analyzeTaskScope` return the raw file list alongside scope analysis. Pass it into `buildDependencyGraph` directly.

**Implementation Outline:**
1. Modify `analyzeTaskScope` to return `{ ...scope, allFiles: files, codeFiles }`
2. In `decomposeHierarchically`, use `scope.codeFiles` instead of re-scanning
3. This was already identified in `PERF_STATUS.md` as optimization S3 for `swarm.mjs` but not applied to the decomposer

**Trade-offs:** Slightly larger return type from `analyzeTaskScope`. No meaningful downsides.

---

### 7. Decomposer `buildDependencyGraph` Blocks Event Loop with Sync Reads

**Priority: HIGH**

**Problem:** `buildDependencyGraph()` reads every file synchronously via `readFileSync()` (line 613). For a project with 300 code files, this blocks the Node.js event loop for potentially seconds, preventing heartbeats, IPC messages, and other async operations.

**Impact:** Performance: HIGH (event loop stall) | Output Quality: MEDIUM (missed heartbeats → false crash detection) | Maintainability: LOW

**Evidence:**

`decomposer.mjs:612-614`:
```javascript
for (const [absPath, node] of nodes.entries()) {
    // ...
    const content = readFileSync(absPath, "utf-8"); // SYNC — blocks event loop
    const importSpecs = extractImports(content, absPath);
```

**Proposed Solution:** Use the existing `asyncPool` pattern from `isolation.mjs` (R5 optimization) to read files concurrently with a pool limit.

**Implementation Outline:**
1. Import `asyncPool` from `isolation.mjs` (or replicate the 5-line pattern)
2. Replace sync loop with: `await asyncPool(50, fileEntries, async ([absPath, node]) => { const content = await readFile(absPath, "utf-8"); ... })`
3. `buildDependencyGraph` is already declared async — no signature change needed

**Trade-offs:** Import extraction regex is CPU-bound (not I/O), so the parallelism benefit is primarily from overlapping disk reads. On SSD, improvement is modest (~2x). On NFS/slow disk, improvement is significant (~10x).

---

### 8. TelemetryChannel Fake "Circular Buffer" Uses O(n) Array Operations

**Priority: MEDIUM**

**Problem:** The buffer is declared as "circular buffer for efficiency" but implemented as a plain array with `shift()` (O(n)) and `unshift(...batch)` (O(n×batch)) operations. Under high telemetry load, this creates unnecessary GC pressure and CPU waste.

**Impact:** Performance: MEDIUM (O(n) per telemetry event at capacity) | Output Quality: N/A | Maintainability: LOW (misleading comment)

**Evidence:**

`telemetry-channel.mjs:60-61`:
```javascript
// Telemetry buffer (circular buffer for efficiency)
this.buffer = [];
```

`telemetry-channel.mjs:351`:
```javascript
this.buffer.shift(); // O(n) — reindexes entire array
```

`telemetry-channel.mjs:273`:
```javascript
this.buffer.unshift(...batch); // O(n × batch_size) — reindexes + copies
```

**Proposed Solution:** Replace with a true ring buffer using head/tail indices and a fixed-size array. Or, simpler: just use `splice(0, batch.length)` for flush (already done at line 246) and accept that `shift()` in the drop path is rare (only when buffer is constantly full).

**Implementation Outline:**
1. Replace `this.buffer = []` with `{ items: new Array(bufferSize), head: 0, tail: 0, count: 0 }`
2. `push`: `items[tail] = item; tail = (tail + 1) % size; count++`
3. `shift` (drop oldest): `head = (head + 1) % size; count--`
4. `drain`: extract `head..tail` range

**Trade-offs:** Ring buffer is ~20 lines more code. Saves ~50μs per drop event at 1000-item capacity. Not high impact in isolation, but compounds under sustained telemetry load.

---

### 9. Registry Discovery Methods Are O(n) Linear Scans Called Per-Message

**Priority: MEDIUM**

**Problem:** `AgentRegistry` hooks into `onMessageRouted` to update stats. On each routed message, it calls `incrementSent(msg.from)` and for PUBLISH messages, iterates `getSubscribers()` calling `incrementReceived()` for each. The `findByRole()`, `findByCapability()`, `findByHealth()` methods all create array copies via `listAll()` then filter.

**Impact:** Performance: MEDIUM (O(n) per message × O(subscribers) for publish) | Output Quality: N/A | Maintainability: MEDIUM

**Evidence:**

`registry.mjs:289-305` (hook called on every routed message):
```javascript
messageBus.registerHook("onMessageRouted", (msg, targetSocket) => {
    if (msg.from) { this.incrementSent(msg.from); }
    if (msg.to) { this.incrementReceived(msg.to); }
    else if (msg.topic) {
        const subscribers = messageBus.getSubscribers(msg.topic);
        for (const subscriberId of subscribers) {
            this.incrementReceived(subscriberId); // O(n) per topic subscriber
        }
    }
});
```

`registry.mjs:182-184`:
```javascript
findByRole(role) {
    return this.listAll().filter(agent => agent.role === role);
    // listAll() = Array.from(this.agents.values()) — new array every call
}
```

**Proposed Solution:** Add secondary indexes: `roleIndex: Map<string, Set<string>>`, `capabilityIndex: Map<string, Set<string>>`, `healthIndex: Map<string, Set<string>>`. Update indexes on register/deregister/health change.

**Implementation Outline:**
1. Add index Maps in constructor
2. Update `register()`: add to role/capability indexes
3. Update `deregister()`: remove from all indexes
4. `findByRole()`: return `Array.from(roleIndex.get(role) || []).map(id => this.agents.get(id))`
5. For per-message stat updates: the `incrementSent/Received` are already O(1) Map lookups — the issue is only in the discovery methods and the `getSubscribers()` loop

**Trade-offs:** ~200 bytes additional memory per agent per index. Negligible overhead. Reduces discovery from O(n) to O(k) where k = matching agents.

---

### 10. Double Exponential Backoff in AgentChannel Reconnect

**Priority: MEDIUM**

**Problem:** `_handleDisconnect()` doubles `reconnectDelay` both inside the timeout callback (line 463, on failure) AND after scheduling the timeout (line 468, unconditionally). This means the delay grows at 4× rate instead of the intended 2× rate, reaching `MAX_RECONNECT_DELAY_MS` (30s) after just 2 failures instead of ~5.

**Impact:** Performance: MEDIUM (unnecessary reconnection delays) | Output Quality: MEDIUM (agents stay disconnected longer) | Maintainability: LOW (subtle bug)

**Evidence:**

`agent-channel.mjs:461-468`:
```javascript
this.reconnectTimer = setTimeout(() => {
    this.connect().catch((err) => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS); // Double on failure
        // ...
    });
}, this.reconnectDelay);

this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS); // Also doubled unconditionally
```

**Proposed Solution:** Remove the unconditional doubling at line 468. The delay should only increase on reconnection failure (inside the catch).

**Implementation Outline:** Delete line 468 (`this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);`). The catch block at line 463 already handles backoff correctly.

**Trade-offs:** None. Pure bug fix.

---

### 11. Bridge Server Sends Header and Body as Separate Writes

**Priority: MEDIUM**

**Problem:** `startBridgeServer` in `bridge.mjs` sends response frames as two separate `socket.write()` calls — one for the 4-byte header, one for the body. This can cause TCP/socket fragmentation, where the receiver gets the header in one `data` event and the body in another. While the parser handles this, it introduces unnecessary latency and partial-frame processing overhead.

**Impact:** Performance: MEDIUM (extra syscalls + parser iterations) | Output Quality: N/A | Maintainability: LOW

**Evidence:**

`bridge.mjs:347-349`:
```javascript
const respond = (response) => {
    // ...
    socket.write(replyHeader);  // Write 1: 4 bytes
    socket.write(replyBuf);     // Write 2: N bytes
};
```

Compare with `protocol.mjs:218-227` which correctly uses a single buffer:
```javascript
const buffer = Buffer.allocUnsafe(4 + length);
buffer.writeUInt32BE(length, 0);
jsonBuffer.copy(buffer, 4);
return buffer; // Single atomic write
```

**Proposed Solution:** Use `serializeMessage()` from `protocol.mjs` in the bridge server, or at minimum combine header + body into one buffer before writing.

**Implementation Outline:** Replace the two writes with:
```javascript
const combined = Buffer.allocUnsafe(4 + replyBuf.length);
combined.writeUInt32BE(replyBuf.length, 0);
replyBuf.copy(combined, 4);
socket.write(combined);
```

**Trade-offs:** One extra buffer allocation per response. Negligible given the bridge is for Python hook communication (low frequency).

---

### 12. OrchestratorControl Filter Can Block Response Messages

**Priority: MEDIUM**

**Problem:** `OrchestratorControl._handleMessage()` applies all filter predicates before calling `super._handleMessage()`. If a filter matches a RESPONSE message, the parent's pending request resolution logic is never reached, causing the corresponding `request()` call to timeout instead of receiving its response.

**Impact:** Performance: N/A | Output Quality: MEDIUM (spurious timeouts on filtered responses) | Maintainability: HIGH (non-obvious interaction)

**Evidence:**

`orchestrator-control.mjs:403-418`:
```javascript
_handleMessage(message) {
    // Apply filters
    for (const { predicate } of this.filterPredicates) {
        if (predicate(message)) {
            this.emit("message_filtered", message);
            return; // RESPONSE messages can be blocked here
        }
    }
    super._handleMessage(message); // Never reached if filtered
}
```

`agent-channel.mjs:389-401` (parent handles RESPONSE):
```javascript
_handleMessage(message) {
    if (type === MessageType.RESPONSE && message.correlationId) {
        const pending = this.pendingRequests.get(message.correlationId);
        if (pending) { pending.resolve(message.payload); return; }
    }
    // ...
```

**Proposed Solution:** Always process RESPONSE messages before applying filters. Move response resolution before the filter loop, or exempt RESPONSE type from filtering.

**Implementation Outline:**
```javascript
_handleMessage(message) {
    // Always process responses (they match pending requests, not filterable)
    if (message.type === MessageType.RESPONSE) {
        super._handleMessage(message);
        return;
    }
    // Apply filters to non-response messages
    for (const { predicate } of this.filterPredicates) { ... }
    super._handleMessage(message);
}
```

**Trade-offs:** Filters cannot block response messages. This is the correct semantic — filters should block unsolicited messages, not responses to explicit requests.

---

### 13. Pending Requests in MessageBus Grow Unbounded

**Priority: MEDIUM**

**Problem:** `MessageBus.pendingRequests` Map (line 72) stores entries when REQUEST messages are forwarded, and removes them when RESPONSE arrives. If the target agent crashes or never responds, entries remain forever, constituting a memory leak proportional to unresolved requests.

**Impact:** Performance: LOW (memory leak, slow for long-running buses) | Output Quality: N/A | Maintainability: MEDIUM

**Evidence:**

`message-bus.mjs:540-543` (added on request):
```javascript
this.pendingRequests.set(msg.id, {
    from: msg.from,
    timestamp: msg.timestamp,
});
```

`message-bus.mjs:558-560` (removed on response):
```javascript
const request = this.pendingRequests.get(msg.correlationId);
if (request) { this.pendingRequests.delete(msg.correlationId); }
```

No TTL, no periodic cleanup, no size limit.

**Proposed Solution:** Add a periodic sweep (every 60s) that removes entries older than `REQUEST_TIMEOUT_MS` (5000ms from agent-channel). Or use the agent disconnect handler to reject all pending requests from/to the disconnecting agent.

**Implementation Outline:**
1. In `start()`: `this._pendingCleanupTimer = setInterval(() => this._cleanPendingRequests(), 60000)`
2. `_cleanPendingRequests()`: iterate `pendingRequests`, delete entries with `timestamp < Date.now() - 30000`
3. In `stop()`: `clearInterval(this._pendingCleanupTimer)`

**Trade-offs:** 60-second sweep is coarse but sufficient. Alternative: hook into `_handleDisconnect` to clean up per-agent pending requests immediately.

---

### 14. Design Doc Specifies `hierarchical` Mode But Integration Is Incomplete

**Priority: MEDIUM**

**Problem:** The design doc (`HIERARCHICAL_DECOMPOSITION_DESIGN.md`) specifies a 6-phase implementation plan, and the hierarchy README lists "Next Steps" including adding `mode: "hierarchical"` to `swarm.mjs` and `executeHierarchical()` to `orchestration.mjs`. These integration points do not exist in the codebase. The hierarchy module is self-contained but not wired into the main execution pipeline.

**Impact:** Performance: N/A | Output Quality: HIGH (feature is built but unusable) | Maintainability: HIGH (dead code risk)

**Evidence:**

`hierarchy/README.md:186-190`:
```
## Next Steps
1. Add `mode: "hierarchical"` to `swarm.mjs`
2. Update `orchestration.mjs` with `executeHierarchical()`
3. Extend `config.mjs` with hierarchy defaults
4. Add CLI flags for hierarchy depth and max children
```

No `executeHierarchical` function exists anywhere in the codebase. The `hierarchy/` module exports work but are never imported by `swarm.mjs` or `orchestration.mjs`.

**Proposed Solution:** Complete Phase 5 from the design doc — wire `decomposeHierarchically()` + `SubCoordinator` + `ResourceGovernor` into the main swarm execution pipeline.

**Implementation Outline:**
1. Add `case "hierarchical":` in `swarm.mjs` main mode switch
2. Create `executeHierarchical(tree, depth, contextFile, workDir)` in `orchestration.mjs`
3. Add `--mode hierarchical --hierarchy-depth N --hierarchy-max-children N` CLI flags
4. Update `autoMode()` to detect hierarchical-appropriate tasks (>50 files, >3 modules)

**Trade-offs:** Adds ~100 LOC wiring code. Risk of introducing bugs in the main execution path — gated behind explicit `--mode hierarchical` flag.

---

### 15. Heartbeat Echo Creates 2× Message Overhead

**Priority: LOW**

**Problem:** The bus echoes every heartbeat back to the sender (`message-bus.mjs:576`). With 15 agents sending heartbeats every 30 seconds, this is 30 messages/minute of pure overhead. The echo is unused by `AgentChannel` — it doesn't listen for heartbeat responses.

**Impact:** Performance: LOW (negligible per-message cost, but wastes bandwidth at scale) | Output Quality: N/A | Maintainability: LOW

**Evidence:**

`message-bus.mjs:574-577`:
```javascript
_handleHeartbeat(msg, socket) {
    // Echo heartbeat back
    const response = createMessage(MessageType.HEARTBEAT, "message-bus", { echo: true }, { to: msg.from });
    this._sendToSocket(socket, response);
}
```

`agent-channel.mjs:480-488` (sends heartbeat but never processes echo):
```javascript
_startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
        const msg = createMessage(MessageType.HEARTBEAT, this.agentId, { agentId: this.agentId });
        this._sendFrame(msg);
    }, this.heartbeatInterval);
}
// No handling of incoming HEARTBEAT in _handleMessage
```

**Proposed Solution:** Remove the echo. Instead, update `lastSeen` timestamp in the registry on heartbeat receipt. The bus already tracks `socketToAgent` — just update an `agentLastSeen` Map.

**Implementation Outline:**
1. Replace `_handleHeartbeat` with: `this._updateLastSeen(msg.from)`
2. Add `agentLastSeen: Map<string, number>` to `MessageBus`
3. Expose `getAgentLastSeen(agentId)` for stale detection

**Trade-offs:** Removes server-confirmed heartbeat acknowledgment. If confirmation is needed in the future, switch to on-demand ping/pong instead of echoing every heartbeat.

---

### 16. Single `onMessage` Handler Slot Prevents Composition

**Priority: LOW**

**Problem:** `AgentChannel.onMessage(handler)` replaces the previous handler (line 294: `this.messageHandler = handler`). Any module that calls `onMessage` overwrites the previous registration. This is especially problematic for `ScopedBus`, `TelemetryChannel`, and any monitoring code that all need to observe messages.

**Impact:** Performance: N/A | Output Quality: LOW (fragile composition) | Maintainability: MEDIUM

**Evidence:**

`agent-channel.mjs:293-295`:
```javascript
onMessage(handler) {
    this.messageHandler = handler; // Only one handler allowed
}
```

**Proposed Solution:** Switch to an array of handlers (or use the existing `EventEmitter` base class by emitting a `message` event).

**Implementation Outline:**
```javascript
onMessage(handler) {
    this.on("message", handler); // Use EventEmitter.on
}
// In _handleMessage:
this.emit("message", message); // Replace this.messageHandler(message)
```

**Trade-offs:** Slightly different semantics (listeners aren't removed by adding new ones). Migration: ensure no code relies on the replacement behavior.

---

### 17. Decomposition Produces Static Budget Allocation — No Runtime Rebalancing

**Priority: LOW (Innovation Opportunity)**

**Problem:** Budget allocation in `decomposer.mjs:1099-1101` and `sub-coordinator.mjs:756-775` divides the budget at decomposition time and never adjusts. If a subtask completes early, its unused budget is wasted. The design doc acknowledges this: *"unused slots are NOT redistributed (simplicity over optimality)"*.

**Impact:** Performance: MEDIUM (agent utilization) | Output Quality: LOW | Maintainability: LOW

**Evidence:**

`decomposer.mjs:1099-1101`:
```javascript
const childCount = Math.min(splittable.length + leaves.length, maxChildren);
const budgetPerChild = Math.floor(remainingBudget / childCount);
// Static allocation — never rebalanced
```

Design doc `HIERARCHICAL_DECOMPOSITION_DESIGN.md:261`:
> If a sub-coordinator determines it doesn't need all its budget, unused slots are NOT redistributed (simplicity over optimality).

**Proposed Solution (Innovation):** Implement a **budget reservation pool** in the `ResourceGovernor`. Sub-coordinators request budget on-demand rather than receiving static allocations. The governor tracks a global pool and grants slots based on real-time availability.

**Implementation Outline:**
1. Replace static `budget` field in decomposition tree with `maxBudget` (upper bound)
2. Sub-coordinators call `governor.requestBudget(id, needed, level)` before spawning each child
3. Governor grants from global pool, respecting concurrent limits
4. On child completion, `governor.releaseBudget(id, 1)` returns slot to pool
5. This is already partially implemented in `governor.mjs:310-429` — the `requestBudget`/`releaseBudget` API exists but isn't wired into the decomposition flow

**Trade-offs:** Introduces runtime coordination overhead (~1 IPC round-trip per spawn). Increases complexity but improves agent utilization from ~60% to ~85% for unbalanced trees.

---

### 18. Innovation: Adaptive Decomposition with Dependency-Aware Routing

**Priority: LOW (Innovation Opportunity)**

**Problem:** The current decomposer uses directory-based module boundaries (`decomposer.mjs:698-707`). Files in the same directory are always grouped together, even when import analysis reveals tight coupling across directories. The dependency graph is built but only used for cohesion scoring — not for intelligent partitioning.

**Evidence:**

`decomposer.mjs:698-706`:
```javascript
// Group files by module (top-level directory)
for (const node of graph.nodes.values()) {
    if (!moduleGroups.has(node.module)) {
        moduleGroups.set(node.module, []);
    }
    moduleGroups.get(node.module).push(node); // Only by top-level dir
}
```

The `crossDependencies` data (line 728) is computed but only used for `isLeaf` determination and coupling density thresholds — never for intelligent re-grouping.

**Proposed Solution:** Use the dependency graph for **graph partitioning** instead of directory grouping. Apply a min-cut algorithm (Kernighan-Lin or spectral clustering on the adjacency matrix) to find natural module boundaries that minimize cross-boundary imports.

**Implementation Outline:**
1. Build adjacency matrix from `graph.edges`
2. Apply connected-component analysis first (disjoint subgraphs → independent modules)
3. For connected components larger than `maxFanOut`, apply Kernighan-Lin bisection
4. Use `crossDependencies` count as edge weight — minimize weighted cut
5. Fall back to directory-based grouping if graph is too sparse (< 10% of files have imports)

**Trade-offs:** Adds ~100 LOC for graph partitioning. KL algorithm is O(n² log n) — acceptable for ≤300 files. Produces better decompositions for non-trivially-structured codebases.

---

## Summary Table

| # | Finding | Priority | Perf | Quality | Maint | File(s) |
|---|---------|----------|------|---------|-------|---------|
| 1 | Wildcard topic matching missing | CRITICAL | - | CRITICAL | HIGH | `message-bus.mjs`, `scoped-bus.mjs` |
| 2 | Python bridge protocol mismatch | CRITICAL | - | CRITICAL | HIGH | `bus_client.py`, `protocol.mjs` |
| 3 | Rate limiting declared, never enforced | HIGH | HIGH | MED | LOW | `message-bus.mjs:83,773` |
| 4 | Pause/resume has no effect | HIGH | - | HIGH | HIGH | `message-bus.mjs:756,637` |
| 5 | Buffer.concat O(n²) in parser | HIGH | HIGH | - | LOW | `protocol.mjs:267` |
| 6 | git ls-files called twice | HIGH | HIGH | - | MED | `decomposer.mjs:402,876` |
| 7 | Sync file reads block event loop | HIGH | HIGH | MED | LOW | `decomposer.mjs:613` |
| 8 | Fake circular buffer uses O(n) ops | MED | MED | - | LOW | `telemetry-channel.mjs:60,351` |
| 9 | Registry O(n) scans per message | MED | MED | - | MED | `registry.mjs:182-305` |
| 10 | Double exponential backoff bug | MED | MED | MED | LOW | `agent-channel.mjs:461-468` |
| 11 | Bridge split header/body writes | MED | MED | - | LOW | `bridge.mjs:347-349` |
| 12 | Filter can block RESPONSE messages | MED | - | MED | HIGH | `orchestrator-control.mjs:403` |
| 13 | Pending requests grow unbounded | MED | LOW | - | MED | `message-bus.mjs:72,540` |
| 14 | Hierarchical mode not integrated | MED | - | HIGH | HIGH | `hierarchy/README.md:186` |
| 15 | Heartbeat echo wastes bandwidth | LOW | LOW | - | LOW | `message-bus.mjs:574` |
| 16 | Single onMessage handler slot | LOW | - | LOW | MED | `agent-channel.mjs:293` |
| 17 | Static budget — no rebalancing | LOW | MED | LOW | LOW | `decomposer.mjs:1099` |
| 18 | Directory-only decomposition | LOW | - | MED | LOW | `decomposer.mjs:698` |

```checklist
- [PASS] Read all IPC files: agent-channel.mjs, bridge.mjs, index.mjs, message-bus.mjs, orchestrator-control.mjs, protocol.mjs, registry.mjs, telemetry-channel.mjs, bus_client.py
- [PASS] Read all hierarchy files: aggregator.mjs, decomposer.mjs, governor.mjs, index.mjs, scoped-bus.mjs, sub-coordinator.mjs, README.md
- [PASS] Read design docs: IPC_INTEGRATION_STATUS.md, PERF_STATUS.md, HIERARCHICAL_DECOMPOSITION_DESIGN.md, ARCHITECTURE.html (partial — HTML styling only, content in other docs)
- [PASS] Assessed each finding against Performance, Output Quality, Maintainability
- [PASS] Produced prioritized findings (2 Critical, 5 High, 7 Medium, 4 Low) with file:line references, code snippets, solutions, trade-offs
- [PASS] Identified design-doc-to-implementation gaps (#1 wildcard matching, #4 pause queuing, #14 hierarchical mode integration)
- [PASS] Identified concrete code optimizations (#5 Buffer.concat, #6 dedup git ls-files, #7 async reads, #8 ring buffer, #9 indexed registry)
- [PASS] Identified innovation opportunities (#17 dynamic budget rebalancing, #18 graph-partitioned decomposition)
```

═══ AGENT-03 | Analyze AI Client, Output, Telemetry, and TUI | completed (317.8s) ═══
Now I have a comprehensive understanding of all 22 files. Let me synthesize the full architectural analysis.

---

# Architectural & Code-Quality Analysis: Remote-Agent Codebase

## Prioritized PRD — Findings by Priority

---

### 1. Duplicate AI Client Implementations

**Priority:** Critical

**Problem:** Two separate files implement overlapping AI client functionality with different APIs, no retry parity, and a module-scope client instantiation that crashes on import when `ANTHROPIC_API_KEY` is unset.

**Evidence:**

`lib/ai-client.mjs:20-25` — Lazy-initialized singleton with guard:
```js
let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _client;
}
```

`lib/ai-decisions.mjs:10-12` — Eager module-scope instantiation (crashes on missing key):
```js
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

`lib/ai-client.mjs:44` — Takes `{ model, system, prompt, maxTokens }` (object param).
`lib/ai-decisions.mjs:30` — Takes `(systemPrompt, userPrompt, model, maxTokens)` (positional params).

`lib/ai-client.mjs:62-69` — Retries once on 529 overload.
`lib/ai-decisions.mjs:53-55` — No retry logic at all, wraps original error losing stack.

`lib/ai-client.mjs:72-75` — Joins text blocks with `""` (no separator).
`lib/ai-decisions.mjs:47-49` — Joins text blocks with `"\n"`.

**Impact:**
- **Performance:** Double SDK initialization; no retry in `ai-decisions.mjs` causes unnecessary failures under load.
- **Output Quality:** Different text joining strategies (`""` vs `"\n"`) produce subtly different outputs for multi-block responses.
- **Maintainability:** Two files doing the same thing with different APIs is a maintenance trap.

**Proposed Solution:** Delete `ai-decisions.mjs` entirely. Redirect all callers to `ai-client.mjs` which has the superior design (lazy init, retry, IPC logging).

**Implementation Outline:**
1. Search all importers of `ai-decisions.mjs` (likely `orchestration.mjs`).
2. Rewrite calls from positional-arg style `aiDecision(system, user, model, tokens)` to object-arg style `aiDecision({ system, prompt, model, maxTokens })`.
3. Delete `ai-decisions.mjs`.

**Trade-offs:** API callers must update — breaking change for any external consumers of the positional API (low risk since it's internal).

---

### 2. AI Client Retry Logic is Fragile and Narrow

**Priority:** Critical

**Problem:** `ai-client.mjs` retries only on HTTP 529 (overloaded) with a single retry after a fixed 2s delay. It ignores 429 (rate limit), 500 (server error), 503 (service unavailable), and network transient errors. The retry doesn't retry — the second attempt can also throw 529 and crash.

**Evidence:**

`lib/ai-client.mjs:60-70`:
```js
try {
  response = await client.messages.create(params);
} catch (err) {
  // Retry once on 529 (overloaded) after 2s delay
  if (err.status === 529) {
    await new Promise((r) => setTimeout(r, 2000));
    response = await client.messages.create(params);  // ← no catch; crashes on 2nd failure
  } else {
    throw err;
  }
}
```

**Impact:**
- **Performance:** Under Anthropic API load spikes (common with parallel swarm agents), a single 2s retry is insufficient. Rate-limited requests (429) crash immediately.
- **Output Quality:** Semantic merge (`semantic-merge.mjs:450-460`) wraps `aiDecision` in a `Promise.race` with a 60s timeout but gets no retry benefit from the client for recoverable errors.
- **Maintainability:** Each caller would need to add their own retry wrapper.

**Proposed Solution:** Implement exponential backoff with jitter for retryable status codes (429, 500, 503, 529) up to 3 attempts. Alternatively, leverage the Anthropic SDK's built-in retry mechanism (`maxRetries` option).

**Implementation Outline:**
```js
const client = new Anthropic({ maxRetries: 3 }); // SDK-native retries
```
Or custom:
```js
const RETRYABLE = new Set([429, 500, 503, 529]);
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    if (!RETRYABLE.has(err.status) || attempt === MAX_RETRIES) throw err;
    const delay = Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }
}
```

**Trade-offs:** Increased latency on retries (mitigated by backoff caps). The SDK's built-in retry is the simplest path.

---

### 3. Synchronous File I/O on Critical Telemetry Path

**Priority:** High

**Problem:** `ipc-logger.mjs` uses `appendFileSync` and `writeFileSync` on every single IPC log call, which blocks the event loop. This is called from `ai-client.mjs:78` (every AI decision) and extensively from `orchestration.mjs`. During heavy swarm runs with 3-5 parallel agents, this creates I/O contention.

**Evidence:**

`lib/ipc-logger.mjs:40-50`:
```js
try {
  appendFileSync(join(_workDir, 'ipc.jsonl'), JSON.stringify(msg) + '\n');
} catch {} // Non-blocking, never fail

_messageBuffer.push(msg);
if (_messageBuffer.length > 200) _messageBuffer = _messageBuffer.slice(-100);

try {
  writeFileSync(join(_workDir, 'ipc-latest.json'), JSON.stringify(_messageBuffer.slice(-50)), 'utf-8');
} catch {} // Non-blocking
```

The comment says "Non-blocking" but `writeFileSync` is definitionally blocking.

**Impact:**
- **Performance:** Each `logIpc` call blocks for two synchronous disk writes. During a semantic merge with 5+ agents, this stalls the orchestration loop.
- **Maintainability:** The `_messageBuffer` uses `slice(-100)` (creates a new array) when length exceeds 200, causing GC pressure at high message rates.

**Proposed Solution:** Switch to `appendFile` (async) or batch writes with a flush interval. For the latest-buffer, debounce writes to once per second.

**Implementation Outline:**
```js
import { appendFile, writeFile } from 'node:fs/promises';

let _flushTimer = null;
export function logIpc(from, to, type, content, metadata = {}) {
  const msg = { /* ... */ };
  _messageBuffer.push(msg);
  appendFile(join(_workDir, 'ipc.jsonl'), JSON.stringify(msg) + '\n').catch(() => {});
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => {
      writeFile(join(_workDir, 'ipc-latest.json'), JSON.stringify(_messageBuffer.slice(-50))).catch(() => {});
      _flushTimer = null;
    }, 1000);
  }
}
```

**Trade-offs:** Slight risk of message loss on crash (acceptable given these are observability logs, not transaction records). Buffer trimming should use a ring buffer instead of `slice`.

---

### 4. Telemetry Parsing Scans Entire Output on Every Call

**Priority:** High

**Problem:** `parseTelemetry` in `telemetry.mjs:58-162` splits the entire stderr and stdout strings by newline and iterates every line to count tool calls and checklist items. For agents with 50MB buffer limits (`MAX_BUFFER_SIZE`), this can process millions of lines.

**Evidence:**

`lib/telemetry.mjs:62-78`:
```js
for (const line of stderrText.split("\n")) {
  const m = line.match(TOOL_CALL_RE);
  if (m) {
    const tool = m[1];
    if (tool in toolCounts) toolCounts[tool]++;
    toolCounts.total++;
    // IPC: emit tool call event (non-blocking) ← per-line IPC emit!
    if (telemetryChannel) {
      try {
        telemetryChannel.toolCall(tool);
      } catch (err) {}
    }
  }
}
```

Additionally, `telemetryChannel.toolCall(tool)` is called per match inside the loop, meaning for agents with 100+ tool calls, this generates 100+ IPC messages during a single parse.

**Impact:**
- **Performance:** O(n) line scan on potentially multi-megabyte strings. The `split("\n")` alone allocates an array of all lines.
- **Output Quality:** No impact.
- **Maintainability:** The mixed concerns (parsing + IPC emission) make the function hard to test.

**Proposed Solution:** Parse incrementally during agent execution (as lines arrive) rather than post-hoc. Separate IPC emission from parsing.

**Implementation Outline:**
1. Track tool counts incrementally in `agent-spawn.mjs` as stderr chunks arrive.
2. Use a streaming regex matcher instead of `split + loop`.
3. Emit IPC telemetry batched (e.g., `telemetryChannel.toolCalls({ Read: 5, Bash: 3 })`) instead of per-tool.

**Trade-offs:** Incremental parsing requires state in the spawn loop, adding complexity to `agent-spawn.mjs`.

---

### 5. Semantic Merge LLM Token Budget Estimation is Unreliable

**Priority:** High

**Problem:** The `llmMerge` function estimates output tokens as `Math.ceil(baseContent.length / 3) + 2048`, capped at 16384. For a 100KB file (the max), this gives `ceil(100000/3) + 2048 = 35382`, which is capped at 16384. The merged output for a 100KB file is likely to exceed 16384 tokens, causing truncation.

**Evidence:**

`lib/semantic-merge.mjs:448`:
```js
const estimatedOutputTokens = Math.min(16384, Math.ceil(baseContent.length / 3) + 2048);
```

The assumption of ~3 chars per token is also incorrect for code (typically ~3.5-4 chars/token for code, meaning the estimate is too high for small files and too aggressively capped for large files).

**Impact:**
- **Output Quality:** Truncated merges silently drop trailing content. The `parseMergeResponse` function (line 387) then fails to find `===MERGED_FILE_END===`, returning `mergedContent: null` and falling back to git merge.
- **Performance:** Unnecessary git fallbacks waste time.

**Proposed Solution:** Use a more accurate token estimation (~4 chars/token for code) and raise the cap to 32768 or use the model's full output capacity. Better yet, validate that the response contains the full file by comparing merged line count against expected.

**Implementation Outline:**
```js
const estimatedOutputTokens = Math.min(65536,
  Math.ceil(baseContent.length / 4) + // base file reproduction
  agentVersions.reduce((sum, v) => sum + (v.diff?.length || 0) / 4, 0) + // diff additions
  4096 // conflict report + overhead
);
```

**Trade-offs:** Higher token budget increases cost per merge. Could add a size validation that re-requests with higher budget on truncation.

---

### 6. TUI Dashboard Spinner Timer at 80ms Creates Excessive Re-renders

**Priority:** High

**Problem:** The dashboard and monitor components both run a spinner animation timer at 80ms intervals, causing 12.5 renders/second. Combined with the 1s progress polling and any agent updates, this creates high render churn for a file-polling TUI.

**Evidence:**

`lib/tui/dashboard.mjs:87-89`:
```js
const spinnerTimer = setInterval(() => {
  setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
}, 80);
```

`lib/tui/monitor.mjs:320`:
```js
const spinner = setInterval(() => setSpinnerFrame(f => (f + 1) % SPINNER.length), 80);
```

Each `setSpinnerFrame` call triggers a React reconciliation and re-render of the entire component tree including all agent cards, bar charts, and log viewers.

**Impact:**
- **Performance:** ~12.5 unnecessary full re-renders/second. On large swarms with 5+ agents, each render traverses the entire component tree.
- **Maintainability:** The spinner is a cosmetic feature driving the majority of CPU usage.

**Proposed Solution:** Use Ink's built-in `<Spinner>` component (already imported and used for individual agents) which handles its own animation lifecycle. Alternatively, increase the interval to 120ms (matching typical terminal refresh rates) and isolate the spinner in a `React.memo`-wrapped component.

**Implementation Outline:**
1. Remove the manual `SPINNER_FRAMES` + `setInterval` pattern.
2. Use `<Spinner type="dots">` for the header spinner (already imported from `ink-spinner`).
3. Wrap `AgentListItem` and `AgentDetail` in `React.memo` to prevent cascading re-renders from spinner state changes.

**Trade-offs:** Slightly less smooth spinner animation at lower rates (imperceptible in a terminal).

---

### 7. IPC Stream JSONL File Polling Reads Entire File on Every Poll

**Priority:** High

**Problem:** `createIpcStream` in `ipc-stream.mjs` reads the entire `ipc.jsonl` file every 500ms, even though it tracks `lastSize`. The file is read in full, then only new lines are processed by slicing `lines.slice(messages.length)`.

**Evidence:**

`lib/tui/ipc-stream.mjs:44-63`:
```js
function readNewMessages() {
  try {
    if (!existsSync(ipcFile)) return;
    const stat = statSync(ipcFile);
    if (stat.size <= lastSize) return;

    const content = readFileSync(ipcFile, 'utf-8');     // ← reads ENTIRE file
    const lines = content.split('\n').filter(Boolean);  // ← splits ALL lines

    const newLines = lines.slice(messages.length);      // ← only processes new ones
    // ...
    lastSize = stat.size;
  } catch {} // Non-fatal
}
```

**Impact:**
- **Performance:** For a 1000-message JSONL file (~100KB), this reads and parses the full file 2x/second. Grows linearly with session duration.
- **Maintainability:** The `messages.length` counter for slicing is fragile — if any line fails to parse, the counter diverges from file position.

**Proposed Solution:** Use byte-offset-based reads. Read only from `lastSize` to `stat.size` using `fs.read` with position parameter, or open the file with a persistent read stream.

**Implementation Outline:**
```js
import { openSync, readSync, closeSync } from 'node:fs';
function readNewMessages() {
  const stat = statSync(ipcFile);
  if (stat.size <= lastSize) return;
  const buf = Buffer.alloc(stat.size - lastSize);
  const fd = openSync(ipcFile, 'r');
  readSync(fd, buf, 0, buf.length, lastSize);
  closeSync(fd);
  const newContent = buf.toString('utf-8');
  // ... parse only new lines
  lastSize = stat.size;
}
```

**Trade-offs:** Byte-offset reads can split a line at a buffer boundary; handle by keeping a partial-line buffer.

---

### 8. Cost Tracker Relies Entirely on Heuristics With No Feedback Loop

**Priority:** Medium

**Problem:** `cost-tracker.mjs` estimates costs based on fixed heuristics (800 input tokens/tool call, 400 output tokens/tool call) with no calibration against actual API usage data. The `ai-client.mjs` returns `usage` objects with real token counts, but these are never fed back into cost estimates.

**Evidence:**

`lib/tui/cost-tracker.mjs:28-30`:
```js
const INPUT_TOKENS_PER_TOOL_CALL  = 800;
const OUTPUT_TOKENS_PER_TOOL_CALL = 400;
const BASE_INPUT_TOKENS           = 2000;
```

Meanwhile, `ai-client.mjs:80-84` returns actual usage data:
```js
return {
  content,
  usage: response.usage,  // ← { input_tokens, output_tokens }
  model: response.model,
  latencyMs,
};
```

This actual usage is logged in IPC (`ai-client.mjs:78`) but never aggregated.

**Impact:**
- **Output Quality:** Displayed cost estimates can be wildly inaccurate. A Sonnet agent doing 20 Read calls with large files could use 50k+ input tokens, not the estimated `2000 + 20*800 = 18000`.
- **Maintainability:** If pricing changes, the heuristics give no indication of drift.

**Proposed Solution:** Add an `actualUsage` accumulator that captures real token counts from AI decisions and agent result files (which include telemetry). Use heuristics as fallback only when actual data isn't available.

**Implementation Outline:**
1. In `cost-tracker.mjs`, add `recordActualUsage(model, inputTokens, outputTokens)`.
2. In `orchestration.mjs`, call `recordActualUsage` after each `aiDecision/aiJsonDecision` call.
3. Display blended cost: actual where available, heuristic where not, with a confidence indicator.

**Trade-offs:** Requires plumbing usage data through orchestration, adding coupling between cost tracker and orchestration layer.

---

### 9. Output Module is Anemic — No Structured Logging

**Priority:** Medium

**Problem:** `output.mjs` provides only raw ANSI escape codes and a bare `log()` function (26 lines total). All callers format their own output strings with inline color codes, leading to inconsistent formatting across `orchestration.mjs`, `semantic-merge.mjs`, and other modules.

**Evidence:**

`lib/output.mjs:10-26`:
```js
const isTTY = process.stderr.isTTY;
export const colors = {
  bold:    isTTY ? "\x1b[1m"  : "",
  // ...
};
let _quiet = false;
export function setQuiet(q) { _quiet = q; }
export function log(msg) { if (!_quiet) process.stderr.write(msg + "\n"); }
```

Callers do ad-hoc formatting like:
```js
log(`${colors.bold}${colors.cyan}[SEMANTIC MERGE]${colors.reset} Analyzing ${overlaps.size}...`);
log(`  ${colors.dim}${file}${colors.reset} → ${agents.join(", ")}`);
```

**Impact:**
- **Output Quality:** Inconsistent prefix formatting, no timestamp, no log levels. The quiet flag is binary — no way to get errors without info.
- **Maintainability:** Every new log statement must manually construct ANSI strings.

**Proposed Solution:** Add structured log helpers: `log.info(tag, msg)`, `log.warn(tag, msg)`, `log.error(tag, msg)`, `log.debug(tag, msg)` with level filtering. Keep the current simple API as the default.

**Implementation Outline:**
```js
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let _level = LEVELS.info;
export function setLogLevel(level) { _level = LEVELS[level] || 0; }
export function logInfo(tag, msg) { if (_level <= LEVELS.info) process.stderr.write(`${colors.cyan}[${tag}]${colors.reset} ${msg}\n`); }
// ...
```

**Trade-offs:** Adds API surface. Keep backward compat by keeping `log()` as-is.

---

### 10. Context Bridge Lacks Schema Validation

**Priority:** Medium

**Problem:** `context-bridge.mjs:21-56` reads a JSON context file and accesses deeply nested properties (`ctx.task?.constraints?.length`, `ctx.prior_knowledge?.decisions`) with optional chaining but no schema validation. Malformed context files silently produce empty prompts.

**Evidence:**

`lib/context-bridge.mjs:23-24`:
```js
const raw = readFileSync(contextPath, "utf-8");
const ctx = JSON.parse(raw);
```

Then accesses nested paths without validating the top-level structure:
```js
if (ctx.task?.constraints?.length) { /* ... */ }
if (ctx.prior_knowledge?.file_summaries) { /* ... */ }
```

If `ctx` has unexpected shape (e.g., `{ version: 2, data: { ... } }`), all context is silently dropped.

**Impact:**
- **Output Quality:** Agents receive empty/partial system prompts when context files have unexpected shapes, degrading task comprehension.
- **Maintainability:** No error feedback on schema mismatches.

**Proposed Solution:** Add lightweight validation: check that `ctx` is an object, warn on unexpected root keys, and log what sections were extracted vs. skipped.

**Trade-offs:** Adds a few lines of validation code. Could be overly strict if the schema evolves — use warning, not error, for unknown keys.

---

### 11. Semantic Merge Dropped-Change Detection Uses Naive Line Matching

**Priority:** Medium

**Problem:** `verifyNoDroppedChanges` at `semantic-merge.mjs:684-712` checks for dropped changes by comparing trimmed lines as exact string matches. This means whitespace-only changes, reindentation, or line reordering are flagged as "dropped" even when semantically preserved.

**Evidence:**

`lib/semantic-merge.mjs:686-694`:
```js
const baseLines = new Set(baseContent.split("\n").map(l => l.trim()).filter(l => l.length > 0));
const mergedLines = new Set(mergedContent.split("\n").map(l => l.trim()).filter(l => l.length > 0));
// ...
const addedLines = agentLines.filter(l => !baseLines.has(l));
const preserved = addedLines.filter(l => mergedLines.has(l));
const coverage = preserved.length / addedLines.length;
```

Common false positives:
- Agent adds `const x = 1;` — if LLM reformats to `const x  = 1;` (double space), it's "dropped".
- Agent reorders imports — all reordered lines appear as "new" in agent but "missing" in merged.

**Impact:**
- **Output Quality:** Spurious "possible dropped changes" warnings reduce trust in the merge output (cry-wolf effect).
- **Maintainability:** Low.

**Proposed Solution:** Normalize lines more aggressively (collapse whitespace, strip comments) before comparison. Consider using a similarity threshold (Jaccard index of tokens) instead of exact match.

**Trade-offs:** More aggressive normalization could mask genuine drops. A threshold-based approach adds complexity.

---

### 12. Monitor Component Performs Synchronous Filesystem Scans in Render Loop

**Priority:** Medium

**Problem:** `monitor.mjs:316-324` calls `scanAllRuns()` every 2 seconds inside a `setInterval`. `scanAllRuns()` synchronously reads multiple directories, stats files, and parses JSON — all with `readFileSync`, `readdirSync`, and `statSync`. This blocks the React render loop.

**Evidence:**

`lib/tui/monitor.mjs:316-324`:
```js
useEffect(() => {
  const refresh = () => setData(scanAllRuns());  // ← synchronous FS scan
  refresh();
  const timer = setInterval(refresh, 2000);
  // ...
});
```

`scanAllRuns` → `scanRun` → `newestMtime` does:
```js
function newestMtime(dirPath) {
  const files = readdirSync(dirPath);
  for (const f of files) {
    const mt = statSync(join(dirPath, f)).mtimeMs;
    // ...
  }
}
```

For 10 runs with 5 agents each, this performs ~50+ synchronous stat calls every 2 seconds.

**Impact:**
- **Performance:** Blocks the React/Ink render loop for potentially 50-100ms every 2s, causing visible UI jank.
- **Maintainability:** Mixing sync I/O with React state updates is an anti-pattern.

**Proposed Solution:** Move filesystem scanning to an async worker function. Use `fs.promises` APIs and update state from the async callback.

**Trade-offs:** Async state updates in React require careful cleanup (stale closures, unmounted component writes). `useRef` for a "mounted" flag handles this.

---

### 13. ChatPanel Message Buffer Has Unbounded-then-Abrupt Trimming

**Priority:** Medium

**Problem:** `chat-panel.mjs:78-81` grows messages to 500, then trims to 300 on overflow. This creates a sawtooth pattern where the UI shows 500 messages, then jumps back to 300 (losing 200 messages including scroll context).

**Evidence:**

`lib/tui/chat-panel.mjs:78-81`:
```js
monitor.on('message', (msg) => {
  setMessages(prev => {
    const next = [...prev, msg];
    return next.length > 500 ? next.slice(-300) : next;
  });
});
```

**Impact:**
- **Performance:** Array spread `[...prev, msg]` copies up to 500 elements on every message. With messages arriving at 10/s, this is 5000 copies/second.
- **Maintainability:** The 500/300 thresholds are magic numbers.

**Proposed Solution:** Use a ring buffer with a fixed capacity (e.g., 300). Only re-render the visible window.

**Trade-offs:** Ring buffer adds minor complexity but eliminates both the sawtooth behavior and per-message copy overhead.

---

### 14. LogViewer Strips ANSI But Doesn't Leverage It

**Priority:** Low

**Problem:** `log-viewer.mjs:23` strips ANSI escape codes from output for "clean display", but the resulting plain text loses all color context (error highlights, file paths, warnings) that makes agent output scannable.

**Evidence:**

`lib/tui/log-viewer.mjs:23`:
```js
const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
```

**Impact:**
- **Output Quality:** Agent output in the TUI is monochrome, making it harder to spot errors and warnings at a glance.
- **Maintainability:** Low.

**Proposed Solution:** Instead of stripping ANSI, pass raw text through to Ink's `<Text>` component which can render ANSI. Alternatively, parse ANSI into Ink color props.

**Trade-offs:** Ink may or may not handle raw ANSI correctly depending on version. Testing needed.

---

### 15. Innovation — Adaptive AI Decision Model Selection

**Priority:** Low (Innovation)

**Problem:** `ai-client.mjs` defaults to `claude-sonnet-4-6` for all decisions. Some decisions (decomposition, verification) benefit from Opus-level reasoning, while simple routing decisions waste money on Sonnet.

**Evidence:**

`lib/ai-client.mjs:45`:
```js
model = "claude-sonnet-4-6",
```

The `semantic-merge.mjs:452` hardcodes Sonnet:
```js
model: "claude-sonnet-4-6",
```

Meanwhile `config.mjs:170` defines depth presets with model differentiation:
```js
thorough: { turns: 50, budget: 25, verifyModel: "opus" },
```

But this model selection doesn't propagate to decomposition or semantic merge.

**Proposed Solution:** Implement a decision complexity classifier that selects model based on:
- Input size (large diffs → Opus for semantic merge)
- Decision type (decompose → Opus for complex tasks, route → Sonnet for simple ones)
- Error history (previous failure → escalate to Opus on retry)

**Trade-offs:** Higher cost for Opus calls. ROI comes from fewer failed merges and better decompositions.

---

### 16. Innovation — Context Bridge Bidirectional Knowledge Flow

**Priority:** Low (Innovation)

**Problem:** `context-bridge.mjs` is unidirectional: parent → child context only. There's no mechanism for agents to feed discoveries back to the orchestrator during execution (e.g., "I found that module X is deprecated, other agents should know").

**Proposed Solution:** Extend the IPC bus with a `knowledge.discovery` topic. Agents publish discoveries; the orchestrator aggregates and broadcasts to other running agents via `knowledge.update` messages. The context bridge becomes bidirectional.

**Trade-offs:** Adds IPC message volume and complexity. Must be careful not to create feedback loops.

---

## Summary Matrix

| # | Finding | Priority | Perf | Quality | Maint |
|---|---------|----------|------|---------|-------|
| 1 | Duplicate AI clients | Critical | Med | High | High |
| 2 | Fragile retry logic | Critical | High | Med | Med |
| 3 | Sync I/O in IPC logger | High | High | Low | Med |
| 4 | Full-buffer telemetry parse | High | High | Low | Med |
| 5 | LLM token budget underestimate | High | Med | High | Low |
| 6 | 80ms spinner re-renders | High | High | Low | Med |
| 7 | Full-file JSONL reads | High | High | Low | Med |
| 8 | Heuristic-only cost tracking | Medium | Low | High | Med |
| 9 | Anemic output module | Medium | Low | Med | High |
| 10 | No context schema validation | Medium | Low | Med | Med |
| 11 | Naive dropped-change detection | Medium | Low | Med | Low |
| 12 | Sync FS in monitor render | Medium | Med | Low | Med |
| 13 | Sawtooth message buffer | Medium | Med | Low | Low |
| 14 | ANSI stripping in logs | Low | Low | Med | Low |
| 15 | Static model selection | Low | Low | Med | Low |
| 16 | Unidirectional context bridge | Low | Low | Med | Med |

```checklist
- [PASS] Read and analyzed lib/ai-client.mjs (135 lines) — identified duplicate implementation and retry deficiencies
- [PASS] Read and analyzed lib/ai-decisions.mjs (103 lines) — identified redundancy with ai-client.mjs, missing retry, eager init crash risk
- [PASS] Read and analyzed lib/output.mjs (26 lines) — identified anemic design lacking structured logging
- [PASS] Read and analyzed lib/telemetry.mjs (246 lines) — identified O(n) full-buffer parsing, per-line IPC emission
- [PASS] Read and analyzed lib/semantic-merge.mjs (1144 lines) — identified token budget underestimate, naive drop detection
- [PASS] Read and analyzed lib/context-bridge.mjs (88 lines) — identified missing schema validation, unidirectional limitation
- [PASS] Read and analyzed all 15 TUI files (agent-card, bar-chart, chat-panel, cost-tracker, dashboard, help-overlay, ipc-logger, ipc-monitor-client, ipc-stream, layout, log-viewer, monitor, progress-reader, sparkline, theme) — identified spinner churn, sync FS in render, full-file reads, message buffer sawtooth, ANSI stripping
- [PASS] Read lib/config.mjs for constants/schema context
- [PASS] Read lib/orchestration.mjs header for integration context
- [PASS] Produced 16 prioritized findings with file:line references, code evidence, solutions, and trade-offs
```

---

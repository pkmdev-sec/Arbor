# Weaknesses & Bottlenecks — Remote-Agent Architecture

*Extracted from ARCHITECTURE_ANALYSIS.md — 3-agent swarm analysis (2026-03-10)*

---

## Priority: CRITICAL

---

### W-01: Unbounded Memory in `agent-spawn.mjs` — Swarm Worker OOM Risk

**Priority:** Critical

**Problem:** `agent-spawn.mjs:85-86` accumulates stdout chunks without any buffer limit. Every swarm worker agent has its stdout buffered entirely in the parent process memory. With 3-5 agents running in parallel (each potentially producing megabytes of output), the orchestrator process can OOM. Unlike `agent-entry.mjs` which implements a 50MB ring buffer with overflow-to-disk, `agent-spawn.mjs` has zero protection.

**Evidence:**
```javascript
// agent-spawn.mjs:85-86 — NO LIMIT
const chunks = [];
proc.stdout.on("data", (c) => chunks.push(c));
```

Compare to `agent-entry.mjs:396-406` which has ring buffer + overflow + backpressure:
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

**Solution:** Extract the ring-buffer logic from `agent-entry.mjs` into a shared `BufferedStream` class in `lib/buffer.mjs`. Apply it in `spawnAgent()`. Cap per-agent at 10MB (agents write to result files anyway; the in-memory buffer is just for the contract's `merged_output`).

**Implementation:**
1. Create `lib/buffer.mjs` with `RingBuffer` class (cap, overflow callback)
2. Use it in both `agent-spawn.mjs:85` and `agent-entry.mjs:386`
3. Respect `MAX_BUFFER_SIZE / agentCount` for swarm mode

**Trade-offs:** Adds ~40 LOC of shared code. Slight complexity increase, but eliminates a crash vector.

---

### W-02: `buildContract` Verification Model Hardcoded to "thorough"

**Priority:** Critical

**Problem:** `orchestration.mjs:656` computes the verification model incorrectly. `DEPTH.thorough` is an object `{turns: 50, budget: 25, verifyModel: "opus"}` which is always truthy, so the ternary ALWAYS resolves to `"thorough"` regardless of the actual depth used.

**Evidence:**
```javascript
// orchestration.mjs:656
verification: verifyResult ? {
  model: DEPTH[DEPTH.thorough ? "thorough" : "normal"]?.verifyModel || "sonnet",
  // ↑ DEPTH.thorough is {turns:50, budget:25, verifyModel:"opus"} — always truthy
  // This ALWAYS returns "opus", even when depth="shallow" was used
```

**Solution:** Pass the `depth` string through to `buildContract` and use it directly:
```javascript
model: DEPTH[depth]?.verifyModel || "sonnet",
```

**Implementation:**
1. Add `depth` parameter to `buildContract` signature
2. Update call site in `swarm.mjs:542`
3. Use `DEPTH[depth]?.verifyModel` instead of the broken ternary

**Trade-offs:** Signature change to `buildContract` — callers need updating (1 call site in `swarm.mjs`).

---

### W-03: `depends_on` Declared but Never Enforced in Parallel Execution

**Priority:** Critical

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

**Solution:** Implement a topological sort scheduler:
1. Build a DAG from `depends_on` fields
2. Run independent tasks in parallel
3. When a task completes, release its dependents
4. Fall back to full parallelism if the DAG has cycles (with a warning)

**Implementation:**
1. Add `buildExecutionDAG(subtasks)` to `orchestration.mjs`
2. Replace `Promise.all` with wave-based execution: `executeWaves(dag, spawnFn)`
3. Maintain the same result format

**Trade-offs:** Increases complexity of parallel execution. Could reduce parallelism if dependencies are over-specified. Mitigated by having the decomposer prefer independence (already in prompt).

---

### W-04: `policy-limits.json` Schema vs Reality Mismatch

**Priority:** Critical

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

**Solution:** Either (a) update `policy-limits.json` to include the required fields and wire them into the actual agent spawn logic, or (b) fix the schema to match reality. Option (a) centralizes limits currently scattered across CLI defaults.

**Implementation:**
1. Add `maxTurns: 200, maxCost: 100, timeout: 3600000, maxAgents: 5` to `policy-limits.json`
2. Have `agent-entry.mjs` and `swarm.mjs` load and respect these as hard caps
3. Or: Mark all as `required: false` in the schema to match current usage

**Trade-offs:** Option (a) adds centralized governance but requires wiring. Option (b) is simpler but admits the schema is aspirational.

---

### W-05: Wildcard Topic Matching Missing — Hierarchical IPC Is Non-Functional

**Priority:** Critical

**Problem:** The `ScopedBus.subscribeDown()` creates wildcard topic patterns (e.g., `swarm.L2.auth.*.status`) but the `MessageBus._routeToSubscribers()` uses exact `Map.get()` lookups. Wildcard patterns **never match any published messages**, meaning all parent-child hierarchical communication silently fails.

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

**Solution:** Implement a trie-based topic matcher in `MessageBus` that supports `*` (single-segment) and `**` (multi-segment) wildcards. On subscribe, store both exact and wildcard subscriptions. On publish, check exact matches first, then walk wildcard patterns.

**Implementation:**
1. Add `wildcardSubscriptions: Map<string, Set<string>>` to `MessageBus`
2. On `SUBSCRIBE` with `*` in topic: parse into segments, store in trie
3. On `PUBLISH`: first check exact `this.subscriptions.get(topic)`, then walk trie for wildcard matches
4. Cache matched wildcards per-topic with invalidation on subscribe/unsubscribe

**Trade-offs:** Adds ~50-100ms overhead on first publish to a new topic (trie walk). Cached lookups are O(1) afterward. Increases memory by ~2KB per wildcard subscription.

---

### W-06: Python Bridge Protocol Mismatch — Silent Message Drop

**Priority:** Critical

**Problem:** The Python `BusClient` sends REGISTER and UNREGISTER messages without the required `id` field. The Node.js `MessageParser.feed()` validates every message via `validateMessage()` and silently skips messages without a valid `id`. This means **Python clients silently fail to register** with the bus.

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

**Solution:** Add `"id": str(uuid.uuid4())` to all messages in `bus_client.py`. Also add missing fields (`to`, `topic`, `correlationId`, `priority`) with `None`/null defaults to match the JS protocol schema.

**Implementation:**
1. Create a `_create_message(type, payload, **kwargs)` helper in `BusClient` that mirrors `createMessage()` from `protocol.mjs`
2. Replace all raw dict construction in `connect()`, `close()`, `_send_unsubscribe()` with the helper
3. Add a protocol conformance test that validates Python messages against JS `validateMessage()`

**Trade-offs:** Minimal. UUID generation adds ~1us per message. Breaking change for any downstream Python consumers expecting the old format (likely none, since the old format doesn't work).

---

### W-07: Duplicate AI Client Implementations

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

**Solution:** Delete `ai-decisions.mjs` entirely. Redirect all callers to `ai-client.mjs` which has the superior design (lazy init, retry, IPC logging).

**Implementation:**
1. Search all importers of `ai-decisions.mjs` (likely `orchestration.mjs`)
2. Rewrite calls from positional-arg style `aiDecision(system, user, model, tokens)` to object-arg style `aiDecision({ system, prompt, model, maxTokens })`
3. Delete `ai-decisions.mjs`

**Trade-offs:** API callers must update — breaking change for any external consumers of the positional API (low risk since it's internal).

---

### W-08: AI Client Retry Logic is Fragile and Narrow

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

**Solution:** Implement exponential backoff with jitter for retryable status codes (429, 500, 503, 529) up to 3 attempts. Alternatively, leverage the Anthropic SDK's built-in retry mechanism (`maxRetries` option).

**Implementation:**
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

## Priority: HIGH

---

### W-09: Pipeline Mode Doesn't Chain Context Between Stages

**Priority:** High

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

**Solution:** Chain context: each stage receives the previous stage's result file, or a cumulative context file that aggregates all prior stage outputs.

**Implementation:**
```javascript
contextFile: i > 0 ? results[i - 1]?.resultFile : contextFile,
```
Or build a cumulative context file per stage.

**Trade-offs:** Simple chaining may miss earlier context. Cumulative approach requires building a composite context file, adding ~20 LOC.

---

### W-10: Duplicate Signal Handler Registration

**Priority:** High

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

**Solution:** Consolidate into lifecycle.mjs's `registerCleanupHandler` pattern. Have `agent-entry.mjs` register `killAllChildren` and `cleanupTeamDir` as cleanup handlers instead of duplicating the process event registration.

**Implementation:**
1. Remove manual `process.on(...)` calls from `agent-entry.mjs:88-110`
2. Import `registerCleanupHandler` from lifecycle.mjs
3. Register `killAllChildren` and `cleanupTeamDir` as handlers in `main()`

**Trade-offs:** Cleanup execution order becomes less explicit. Mitigated by lifecycle.mjs running handlers in registration order.

---

### B-01: Synchronous Full-Tree Snapshot Blocks Event Loop

**Priority:** High

**Problem:** `isolation.mjs:56-85` (`snapshotFiles`) synchronously walks the entire directory tree, reads every file, and computes SHA-256 hashes. For a repo with thousands of files, this blocks the Node.js event loop for seconds. The async variant (`snapshotFilesAsync`, line 174) exists but `snapshotFiles` is still called from synchronous code paths like `cacheSnapshot` (line 32) and `snapshotFilesFiltered` (line 92).

**Evidence:**
```javascript
// isolation.mjs:72-77 — sync read + hash of EVERY file
const content = readFileSync(fullPath);
const hash = createHash("sha256").update(content).digest("hex");
const st = statSync(fullPath);
manifest[relPath] = { hash, size: content.length, mtimeMs: st.mtimeMs };
```

**Solution:** Deprecate the synchronous `snapshotFiles` entirely. The `snapshotFilesFiltered` (used for escape detection) should use the async pattern with the mtime optimization. Already partially done with `cacheSnapshotAsync` — complete the migration.

**Implementation:**
1. Replace `cacheSnapshot` calls with `cacheSnapshotAsync`
2. Make `snapshotFilesFiltered` async with the concurrency pool
3. Keep the sync version only as a last-resort fallback

**Trade-offs:** All callers become async, requiring await propagation. Most callers are already async.

---

### W-11: Array Property Mutation for Conflict Report

**Priority:** High

**Problem:** `orchestration.mjs:422` attaches a custom property to an Array object. Arrays are objects in JS, so this works, but the property is lost when the array is spread, destructured, `JSON.stringify`'d without custom handling, or passed through `Array.from()`.

**Evidence:**
```javascript
// orchestration.mjs:422
results._conflictReport = conflictReport;

// swarm.mjs:541 — reads it back
const conflictReport = workerResults._conflictReport || null;
```

**Solution:** Return a proper result object from `executeParallel`:
```javascript
return { results, conflictReport };
```

**Implementation:**
1. Change `executeParallel` return type to `{ results: WorkerResult[], conflictReport: ConflictEntry[] }`
2. Update `swarm.mjs` to destructure: `const { results: workerResults, conflictReport } = await executeParallel(...)`
3. Same for `executePipeline` for consistency

**Trade-offs:** Breaking change to `executeParallel` return type. Only 2 call sites (swarm.mjs, hierarchy fallback).

---

### B-02: Backpressure Implementation is Effectively a No-Op

**Priority:** High

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

**Solution:** Remove the pseudo-backpressure or implement real backpressure by piping through a Transform stream with `highWaterMark`. The ring buffer already handles overflow; the backpressure mechanism is redundant and misleading.

**Implementation:**
1. Remove the pause/resume blocks (lines 409-416 and 543-550)
2. The ring buffer + overflow-to-disk already handles the actual problem
3. Optionally: use a proper Transform stream for backpressure if needed

**Trade-offs:** Removing dead code simplifies the file with zero behavioral change.

---

### W-12: Rate Limiting Declared But Never Enforced

**Priority:** High

**Problem:** `MessageBus` stores rate limit configuration (`rateLimits` Map, `rateLimitWindows` Map) and accepts `set_rate_limit`/`get_rate_limit` commands, but the actual message routing path (`_handleMessage`, `_sendToClient`, `_routeToSubscribers`) never checks rate limits. A misbehaving agent can flood the bus without throttling.

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

But `_handleMessage()` at line 357 — **no rate check anywhere in the path**.

**Solution:** Add a `_checkRateLimit(agentId)` method called at the top of `_handleMessage()` before routing. Use a sliding window counter.

**Implementation:**
1. Add `_checkRateLimit(agentId)` returning boolean (allowed/blocked)
2. Call it at `_handleMessage:359`, after identity validation but before routing
3. On block: increment `metrics.messagesBlocked`, log, optionally send ERROR back to sender
4. Use `rateLimitWindows` Map with trimmed timestamp arrays (already declared, just unused)

**Trade-offs:** Adds ~2us per message (timestamp comparison). Negligible for typical 100 msg/sec limits.

---

### W-13: Pause/Resume Has No Effect on Message Flow

**Priority:** High

**Problem:** `pauseAgent()` adds to `pausedAgents` Set, but no code path checks this set during message routing. The JSDoc at `orchestrator-control.mjs:197-198` promises "Messages from the paused agent will be queued by the bus but not delivered until resumed" — this is documentation-code divergence.

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

**Solution:** Add a message queue per paused agent. On `_sendToClient`, if agent is paused, enqueue message. On `resume_agent`, drain the queue.

**Implementation:**
1. Add `pauseQueues: Map<string, Message[]>` to `MessageBus`
2. In `_sendToClient`: check `pausedAgents.has(agentId)` → enqueue to `pauseQueues`
3. In `resume_agent` handler: drain `pauseQueues.get(targetId)` via `_sendToSocket` for each message
4. Enforce max queue depth (1000 default), drop oldest on overflow

**Trade-offs:** Memory overhead of ~1MB per 1000 queued messages per paused agent. Queue drain on resume creates a burst — consider throttled drain with `setImmediate()` batches.

---

### B-03: MessageParser Buffer.concat Is O(n^2) on Hot Path

**Priority:** High

**Problem:** `MessageParser.feed()` calls `Buffer.concat([this.buffer, chunk])` on every incoming data event. This creates a new buffer and copies all existing data on every call, making total processing O(n^2) in data volume. For a bus handling 15 agents with heartbeats + telemetry, this is the primary serialization bottleneck.

**Evidence:**

`protocol.mjs:267`:
```javascript
feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Every call copies this.buffer + chunk into a new allocation
```

**Solution:** Replace with a buffer list pattern. Accumulate chunks in an array, only concat when needed for frame extraction.

**Implementation:**
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

**Trade-offs:** Slightly more complex state management. Reduces CPU by ~90% for large message volumes.

---

### B-04: Decomposer Calls `git ls-files` Twice Per Decomposition

**Priority:** High

**Problem:** `decomposeHierarchically()` calls `analyzeTaskScope()` which runs `git ls-files` (line 402), then immediately runs `git ls-files` again in its own body (line 876). The file listing is identical both times.

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

**Solution:** Have `analyzeTaskScope` return the raw file list alongside scope analysis. Pass it into `buildDependencyGraph` directly.

**Implementation:**
1. Modify `analyzeTaskScope` to return `{ ...scope, allFiles: files, codeFiles }`
2. In `decomposeHierarchically`, use `scope.codeFiles` instead of re-scanning
3. This was already identified in `PERF_STATUS.md` as optimization S3 for `swarm.mjs` but not applied to the decomposer

**Trade-offs:** Slightly larger return type from `analyzeTaskScope`. No meaningful downsides.

---

### B-05: Decomposer `buildDependencyGraph` Blocks Event Loop with Sync Reads

**Priority:** High

**Problem:** `buildDependencyGraph()` reads every file synchronously via `readFileSync()` (line 613). For a project with 300 code files, this blocks the Node.js event loop for potentially seconds, preventing heartbeats, IPC messages, and other async operations.

**Evidence:**

`decomposer.mjs:612-614`:
```javascript
for (const [absPath, node] of nodes.entries()) {
    // ...
    const content = readFileSync(absPath, "utf-8"); // SYNC — blocks event loop
    const importSpecs = extractImports(content, absPath);
```

**Solution:** Use the existing `asyncPool` pattern from `isolation.mjs` to read files concurrently with a pool limit.

**Implementation:**
1. Import `asyncPool` from `isolation.mjs` (or replicate the 5-line pattern)
2. Replace sync loop with: `await asyncPool(50, fileEntries, async ([absPath, node]) => { const content = await readFile(absPath, "utf-8"); ... })`
3. `buildDependencyGraph` is already declared async — no signature change needed

**Trade-offs:** Import extraction regex is CPU-bound (not I/O), so the parallelism benefit is primarily from overlapping disk reads. On SSD, improvement is modest (~2x). On NFS/slow disk, improvement is significant (~10x).

---

### B-06: Synchronous File I/O on Critical Telemetry Path

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

**Solution:** Switch to `appendFile` (async) or batch writes with a flush interval. For the latest-buffer, debounce writes to once per second.

**Implementation:**
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

**Trade-offs:** Slight risk of message loss on crash (acceptable given these are observability logs, not transaction records).

---

### B-07: Telemetry Parsing Scans Entire Output on Every Call

**Priority:** High

**Problem:** `parseTelemetry` in `telemetry.mjs:58-162` splits the entire stderr and stdout strings by newline and iterates every line to count tool calls and checklist items. For agents with 50MB buffer limits (`MAX_BUFFER_SIZE`), this can process millions of lines. Additionally, `telemetryChannel.toolCall(tool)` is called per match inside the loop, meaning for agents with 100+ tool calls, this generates 100+ IPC messages during a single parse.

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

**Solution:** Parse incrementally during agent execution (as lines arrive) rather than post-hoc. Separate IPC emission from parsing.

**Implementation:**
1. Track tool counts incrementally in `agent-spawn.mjs` as stderr chunks arrive
2. Use a streaming regex matcher instead of `split + loop`
3. Emit IPC telemetry batched (e.g., `telemetryChannel.toolCalls({ Read: 5, Bash: 3 })`) instead of per-tool

**Trade-offs:** Incremental parsing requires state in the spawn loop, adding complexity to `agent-spawn.mjs`.

---

### W-14: Semantic Merge LLM Token Budget Estimation is Unreliable

**Priority:** High

**Problem:** The `llmMerge` function estimates output tokens as `Math.ceil(baseContent.length / 3) + 2048`, capped at 16384. For a 100KB file (the max), this gives `ceil(100000/3) + 2048 = 35382`, which is capped at 16384. The merged output for a 100KB file is likely to exceed 16384 tokens, causing truncation.

**Evidence:**

`lib/semantic-merge.mjs:448`:
```js
const estimatedOutputTokens = Math.min(16384, Math.ceil(baseContent.length / 3) + 2048);
```

The assumption of ~3 chars per token is also incorrect for code (typically ~3.5-4 chars/token).

**Solution:** Use a more accurate token estimation (~4 chars/token for code) and raise the cap to 32768 or use the model's full output capacity. Validate that the response contains the full file.

**Implementation:**
```js
const estimatedOutputTokens = Math.min(65536,
  Math.ceil(baseContent.length / 4) + // base file reproduction
  agentVersions.reduce((sum, v) => sum + (v.diff?.length || 0) / 4, 0) + // diff additions
  4096 // conflict report + overhead
);
```

**Trade-offs:** Higher token budget increases cost per merge. Could add a size validation that re-requests with higher budget on truncation.

---

### B-08: TUI Dashboard Spinner Timer at 80ms Creates Excessive Re-renders

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

Each `setSpinnerFrame` call triggers a React reconciliation and re-render of the entire component tree.

**Solution:** Use Ink's built-in `<Spinner>` component which handles its own animation lifecycle. Alternatively, increase the interval to 120ms and isolate the spinner in a `React.memo`-wrapped component.

**Implementation:**
1. Remove the manual `SPINNER_FRAMES` + `setInterval` pattern
2. Use `<Spinner type="dots">` for the header spinner (already imported from `ink-spinner`)
3. Wrap `AgentListItem` and `AgentDetail` in `React.memo` to prevent cascading re-renders

**Trade-offs:** Slightly less smooth spinner animation at lower rates (imperceptible in a terminal).

---

### B-09: IPC Stream JSONL File Polling Reads Entire File on Every Poll

**Priority:** High

**Problem:** `createIpcStream` in `ipc-stream.mjs` reads the entire `ipc.jsonl` file every 500ms, even though it tracks `lastSize`. The file is read in full, then only new lines are processed by slicing.

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

**Solution:** Use byte-offset-based reads. Read only from `lastSize` to `stat.size` using `fs.read` with position parameter.

**Implementation:**
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

## Priority: MEDIUM

---

### B-10: `autoMode` AI Call Adds 2-5s Latency to Every Swarm Invocation

**Priority:** Medium

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

**Solution:** Use the regex heuristic as default, with an opt-in `--smart-route` flag for AI-powered mode selection. Or cache mode decisions for similar task patterns.

**Implementation:**
1. Default to `autoModeRegex` (rename to `autoMode`)
2. Add `--smart-route` flag that enables the AI classification
3. Or: run AI classification in parallel with decomposition (don't block on it)

**Trade-offs:** Regex is less accurate for ambiguous tasks. The 2-5s cost may be acceptable if the AI picks a better mode that saves time overall.

---

### W-15: `ai-client.mjs` Retry Logic is Insufficient (Detailed)

**Priority:** Medium

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

**Solution:** Add exponential backoff with jitter for transient errors (429, 500, 503, 529, network errors). Max 3 retries, 1-4s delays.

**Implementation:**
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

### B-11: Three-Way Merge Temp Files Not Cleaned Up

**Priority:** Medium

**Problem:** `orchestration.mjs:360-377` creates temp files for `git merge-file` but never cleans them up. If the merge succeeds or fails, the temp files (`merge-current-*`, `merge-base-*`, `merge-other-*`) remain in the workDir indefinitely.

**Evidence:**
```javascript
// orchestration.mjs:360-362 — created but never deleted
const tmpCurrent = join(workDir, `merge-current-${file.replace(/\//g, "_")}`);
const tmpBase = join(workDir, `merge-base-${file.replace(/\//g, "_")}`);
const tmpOther = join(workDir, `merge-other-${file.replace(/\//g, "_")}`);
// ... no cleanup after try/catch
```

**Solution:** Add `finally` block to clean up temp files. Use `os.tmpdir()` instead of `workDir` for merge temps.

**Implementation:**
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

### W-16: Regex Tool Call Detection Undercounts

**Priority:** Medium

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

**Solution:** Derive the progress patterns from `TOOL_CALL_RE` rather than maintaining a separate list.

**Implementation:**
1. Import `TOOL_CALL_RE` (already imported) and use it for progress tracking
2. Parse group name from the match: `const m = text.match(TOOL_CALL_RE); if (m) { progress.last_tool = m[1]; progress.tool_calls_count++; }`

**Trade-offs:** None — strictly better than the current approach.

---

### B-12: TelemetryChannel Fake "Circular Buffer" Uses O(n) Array Operations

**Priority:** Medium

**Problem:** The buffer is declared as "circular buffer for efficiency" but implemented as a plain array with `shift()` (O(n)) and `unshift(...batch)` (O(n * batch)) operations. Under high telemetry load, this creates unnecessary GC pressure and CPU waste.

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

**Solution:** Replace with a true ring buffer using head/tail indices and a fixed-size array.

**Implementation:**
1. Replace `this.buffer = []` with `{ items: new Array(bufferSize), head: 0, tail: 0, count: 0 }`
2. `push`: `items[tail] = item; tail = (tail + 1) % size; count++`
3. `shift` (drop oldest): `head = (head + 1) % size; count--`
4. `drain`: extract `head..tail` range

**Trade-offs:** Ring buffer is ~20 lines more code. Saves ~50us per drop event at 1000-item capacity.

---

### B-13: Registry Discovery Methods Are O(n) Linear Scans Called Per-Message

**Priority:** Medium

**Problem:** `AgentRegistry` hooks into `onMessageRouted` to update stats. On each routed message, it calls `incrementSent(msg.from)` and for PUBLISH messages, iterates `getSubscribers()` calling `incrementReceived()` for each. The `findByRole()`, `findByCapability()`, `findByHealth()` methods all create array copies via `listAll()` then filter.

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

**Solution:** Add secondary indexes: `roleIndex: Map<string, Set<string>>`, `capabilityIndex: Map<string, Set<string>>`. Update indexes on register/deregister.

**Implementation:**
1. Add index Maps in constructor
2. Update `register()`: add to role/capability indexes
3. Update `deregister()`: remove from all indexes
4. `findByRole()`: return `Array.from(roleIndex.get(role) || []).map(id => this.agents.get(id))`

**Trade-offs:** ~200 bytes additional memory per agent per index. Reduces discovery from O(n) to O(k) where k = matching agents.

---

### W-17: Double Exponential Backoff in AgentChannel Reconnect

**Priority:** Medium

**Problem:** `_handleDisconnect()` doubles `reconnectDelay` both inside the timeout callback (line 463, on failure) AND after scheduling the timeout (line 468, unconditionally). This means the delay grows at 4x rate instead of the intended 2x rate, reaching `MAX_RECONNECT_DELAY_MS` (30s) after just 2 failures instead of ~5.

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

**Solution:** Remove the unconditional doubling at line 468. The delay should only increase on reconnection failure (inside the catch).

**Implementation:** Delete line 468. The catch block at line 463 already handles backoff correctly.

**Trade-offs:** None. Pure bug fix.

---

### B-14: Bridge Server Sends Header and Body as Separate Writes

**Priority:** Medium

**Problem:** `startBridgeServer` in `bridge.mjs` sends response frames as two separate `socket.write()` calls — one for the 4-byte header, one for the body. This can cause TCP/socket fragmentation, where the receiver gets the header in one `data` event and the body in another.

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

**Solution:** Use `serializeMessage()` from `protocol.mjs` in the bridge server, or combine header + body into one buffer before writing.

**Implementation:**
```javascript
const combined = Buffer.allocUnsafe(4 + replyBuf.length);
combined.writeUInt32BE(replyBuf.length, 0);
replyBuf.copy(combined, 4);
socket.write(combined);
```

**Trade-offs:** One extra buffer allocation per response. Negligible given the bridge is for Python hook communication (low frequency).

---

### W-18: OrchestratorControl Filter Can Block Response Messages

**Priority:** Medium

**Problem:** `OrchestratorControl._handleMessage()` applies all filter predicates before calling `super._handleMessage()`. If a filter matches a RESPONSE message, the parent's pending request resolution logic is never reached, causing the corresponding `request()` call to timeout instead of receiving its response.

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

**Solution:** Always process RESPONSE messages before applying filters.

**Implementation:**
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

### W-19: Pending Requests in MessageBus Grow Unbounded

**Priority:** Medium

**Problem:** `MessageBus.pendingRequests` Map (line 72) stores entries when REQUEST messages are forwarded, and removes them when RESPONSE arrives. If the target agent crashes or never responds, entries remain forever, constituting a memory leak proportional to unresolved requests.

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

**Solution:** Add a periodic sweep (every 60s) that removes entries older than `REQUEST_TIMEOUT_MS`. Or use the agent disconnect handler to reject all pending requests from/to the disconnecting agent.

**Implementation:**
1. In `start()`: `this._pendingCleanupTimer = setInterval(() => this._cleanPendingRequests(), 60000)`
2. `_cleanPendingRequests()`: iterate `pendingRequests`, delete entries with `timestamp < Date.now() - 30000`
3. In `stop()`: `clearInterval(this._pendingCleanupTimer)`

**Trade-offs:** 60-second sweep is coarse but sufficient. Alternative: hook into `_handleDisconnect` to clean up per-agent pending requests immediately.

---

### W-20: No Test Suite

**Priority:** Medium

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

**Solution:** Add unit tests for the pure-function modules first (highest ROI):
1. `config.mjs`: `resolveModel`, `validateConfig`
2. `cli.mjs`: `parseAgentArgs`, `parseSwarmArgs`, `suggestFlag`
3. `context-bridge.mjs`: `contextToSystemPrompt`
4. `telemetry.mjs`: `parseTelemetry`
5. `orchestration.mjs`: `autoModeRegex`, `buildContract`

**Implementation:**
1. Add `vitest` or Node's built-in `node:test` as devDependency
2. Create `test/` directory with per-module test files
3. Add `"test": "vitest"` to package.json scripts

**Trade-offs:** Maintenance burden of test suite. Mitigated by focusing on deterministic pure functions first.

---

### W-21: Cost Tracker Relies Entirely on Heuristics With No Feedback Loop

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

This actual usage is logged in IPC but never aggregated.

**Solution:** Add an `actualUsage` accumulator that captures real token counts from AI decisions and agent result files. Use heuristics as fallback only when actual data isn't available.

**Implementation:**
1. In `cost-tracker.mjs`, add `recordActualUsage(model, inputTokens, outputTokens)`
2. In `orchestration.mjs`, call `recordActualUsage` after each `aiDecision/aiJsonDecision` call
3. Display blended cost: actual where available, heuristic where not, with a confidence indicator

**Trade-offs:** Requires plumbing usage data through orchestration, adding coupling between cost tracker and orchestration layer.

---

### W-22: Context Bridge Lacks Schema Validation

**Priority:** Medium

**Problem:** `context-bridge.mjs:21-56` reads a JSON context file and accesses deeply nested properties with optional chaining but no schema validation. Malformed context files silently produce empty prompts.

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

If `ctx` has unexpected shape, all context is silently dropped.

**Solution:** Add lightweight validation: check that `ctx` is an object, warn on unexpected root keys, and log what sections were extracted vs. skipped.

**Trade-offs:** Adds a few lines of validation code. Could be overly strict if the schema evolves — use warning, not error, for unknown keys.

---

### W-23: Semantic Merge Dropped-Change Detection Uses Naive Line Matching

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
- Agent adds `const x = 1;` — if LLM reformats to `const x  = 1;` (double space), it's "dropped"
- Agent reorders imports — all reordered lines appear as "new" in agent but "missing" in merged

**Solution:** Normalize lines more aggressively (collapse whitespace, strip comments) before comparison. Consider using a similarity threshold (Jaccard index of tokens) instead of exact match.

**Trade-offs:** More aggressive normalization could mask genuine drops. A threshold-based approach adds complexity.

---

### B-15: Monitor Component Performs Synchronous Filesystem Scans in Render Loop

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

For 10 runs with 5 agents each, this performs ~50+ synchronous stat calls every 2 seconds.

**Solution:** Move filesystem scanning to an async worker function. Use `fs.promises` APIs and update state from the async callback.

**Trade-offs:** Async state updates in React require careful cleanup (stale closures, unmounted component writes). `useRef` for a "mounted" flag handles this.

---

### B-16: ChatPanel Message Buffer Has Unbounded-then-Abrupt Trimming

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

**Solution:** Use a ring buffer with a fixed capacity (e.g., 300). Only re-render the visible window.

**Trade-offs:** Ring buffer adds minor complexity but eliminates both the sawtooth behavior and per-message copy overhead.

---

### W-24: Design Doc Specifies `hierarchical` Mode But Integration Is Incomplete

**Priority:** Medium

**Problem:** The design doc specifies a 6-phase implementation plan with `mode: "hierarchical"` in `swarm.mjs` and `executeHierarchical()` in `orchestration.mjs`. These integration points do not exist. The hierarchy module is self-contained but not wired into the main execution pipeline.

**Evidence:**

`hierarchy/README.md:186-190`:
```
## Next Steps
1. Add `mode: "hierarchical"` to `swarm.mjs`
2. Update `orchestration.mjs` with `executeHierarchical()`
3. Extend `config.mjs` with hierarchy defaults
4. Add CLI flags for hierarchy depth and max children
```

No `executeHierarchical` function exists anywhere in the codebase.

**Solution:** Complete Phase 5 from the design doc — wire `decomposeHierarchically()` + `SubCoordinator` + `ResourceGovernor` into the main swarm execution pipeline.

**Implementation:**
1. Add `case "hierarchical":` in `swarm.mjs` main mode switch
2. Create `executeHierarchical(tree, depth, contextFile, workDir)` in `orchestration.mjs`
3. Add `--mode hierarchical --hierarchy-depth N --hierarchy-max-children N` CLI flags
4. Update `autoMode()` to detect hierarchical-appropriate tasks (>50 files, >3 modules)

**Trade-offs:** Adds ~100 LOC wiring code. Risk of introducing bugs in the main execution path — gated behind explicit `--mode hierarchical` flag.

---

## Priority: LOW

---

### W-25: `cleanupTeamDir` Warning Spam on Early Crashes

**Priority:** Low

**Problem:** `agent-entry.mjs:90` calls `cleanupTeamDir(process.env.REMOTE_AGENT_TEAM_NAME)` in the `exit` handler, but the env var is set at line 304 inside `main()`. If the process exits before reaching line 304 (e.g., CLI parse failure), `REMOTE_AGENT_TEAM_NAME` is undefined, causing a warning.

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

**Solution:** Guard the call: `if (process.env.REMOTE_AGENT_TEAM_NAME) cleanupTeamDir(...)`. Or set the env var earlier.

**Trade-offs:** Trivial fix.

---

### W-26: `excludePatterns` Uses `String.includes()` — Overly Broad Matching

**Priority:** Low

**Problem:** `isolation.mjs:67` uses `relPath.includes(p)` for exclude matching. This means a pattern like `".git"` would match files like `.gitignore` or `.github/`.

**Evidence:**
```javascript
// isolation.mjs:67
if (excludePatterns.some(p => relPath.includes(p))) continue;

// config.mjs:174
export const DEFAULT_EXCLUDES = ["node_modules", ".git", ".beads", "__pycache__", ".DS_Store"];
// ".git" matches ".gitignore", ".github/", etc.
```

**Solution:** Use path-segment matching: split on `/` and check if any segment exactly matches the pattern.

**Implementation:**
```javascript
const segments = relPath.split("/");
if (excludePatterns.some(p => segments.includes(p))) continue;
```

**Trade-offs:** Slightly more computation per file. Correctness improvement is significant — `.github/` workflows would no longer be excluded.

---

### B-17: Heartbeat Echo Creates 2x Message Overhead

**Priority:** Low

**Problem:** The bus echoes every heartbeat back to the sender (`message-bus.mjs:576`). With 15 agents sending heartbeats every 30 seconds, this is 30 messages/minute of pure overhead. The echo is unused by `AgentChannel` — it doesn't listen for heartbeat responses.

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

**Solution:** Remove the echo. Instead, update `lastSeen` timestamp in the registry on heartbeat receipt.

**Implementation:**
1. Replace `_handleHeartbeat` with: `this._updateLastSeen(msg.from)`
2. Add `agentLastSeen: Map<string, number>` to `MessageBus`
3. Expose `getAgentLastSeen(agentId)` for stale detection

**Trade-offs:** Removes server-confirmed heartbeat acknowledgment. If confirmation is needed in the future, switch to on-demand ping/pong.

---

### W-27: Single `onMessage` Handler Slot Prevents Composition

**Priority:** Low

**Problem:** `AgentChannel.onMessage(handler)` replaces the previous handler (line 294: `this.messageHandler = handler`). Any module that calls `onMessage` overwrites the previous registration. This is problematic for `ScopedBus`, `TelemetryChannel`, and any monitoring code that all need to observe messages.

**Evidence:**

`agent-channel.mjs:293-295`:
```javascript
onMessage(handler) {
    this.messageHandler = handler; // Only one handler allowed
}
```

**Solution:** Switch to an array of handlers (or use the existing `EventEmitter` base class).

**Implementation:**
```javascript
onMessage(handler) {
    this.on("message", handler); // Use EventEmitter.on
}
// In _handleMessage:
this.emit("message", message); // Replace this.messageHandler(message)
```

**Trade-offs:** Slightly different semantics (listeners aren't removed by adding new ones). Ensure no code relies on the replacement behavior.

---

## Summary Table

| ID | Finding | Priority | Type | Performance | Quality | Maintainability | Primary File(s) |
|----|---------|----------|------|-------------|---------|-----------------|------------------|
| W-01 | Unbounded memory in agent-spawn | Critical | Weakness | Crash | Data loss | Silent failure | `agent-spawn.mjs:85` |
| W-02 | buildContract model hardcoded | Critical | Weakness | - | Wrong model | Confusing bug | `orchestration.mjs:656` |
| W-03 | depends_on never enforced | Critical | Weakness | - | Incorrect results | Misleading API | `orchestration.mjs:236`, `config.mjs:162` |
| W-04 | Policy schema vs reality | Critical | Weakness | - | False validation | Dead code | `config.mjs:183`, `policy-limits.json` |
| W-05 | Wildcard topic matching missing | Critical | Weakness | - | IPC broken | HIGH | `message-bus.mjs:616`, `scoped-bus.mjs:247` |
| W-06 | Python bridge protocol mismatch | Critical | Weakness | - | Silent drops | HIGH | `bus_client.py:126`, `protocol.mjs:152` |
| W-07 | Duplicate AI clients | Critical | Weakness | Double init | Different outputs | Maintenance trap | `ai-client.mjs`, `ai-decisions.mjs` |
| W-08 | Fragile retry logic | Critical | Weakness | Failures | Degraded fallback | - | `ai-client.mjs:60` |
| W-09 | Pipeline no context chaining | High | Weakness | - | Blind stages | - | `orchestration.mjs:458` |
| W-10 | Duplicate signal handlers | High | Weakness | Redundant work | - | Race conditions | `agent-entry.mjs:88`, `lifecycle.mjs:131` |
| B-01 | Sync full-tree snapshot | High | Bottleneck | Multi-second block | - | - | `isolation.mjs:56` |
| W-11 | Array property mutation | High | Weakness | - | Data loss | Fragile pattern | `orchestration.mjs:422` |
| B-02 | Backpressure is no-op | High | Bottleneck | False protection | - | - | `agent-entry.mjs:409` |
| W-12 | Rate limiting never enforced | High | Weakness | Bus saturation | - | - | `message-bus.mjs:83,773` |
| W-13 | Pause/resume no effect | High | Weakness | - | Illusory control | Misleading API | `message-bus.mjs:756,637` |
| B-03 | Buffer.concat O(n^2) | High | Bottleneck | Quadratic CPU | - | - | `protocol.mjs:267` |
| B-04 | git ls-files called twice | High | Bottleneck | Redundant subprocess | - | - | `decomposer.mjs:402,876` |
| B-05 | Sync reads block event loop | High | Bottleneck | Event loop stall | Missed heartbeats | - | `decomposer.mjs:613` |
| B-06 | Sync I/O in IPC logger | High | Bottleneck | I/O contention | - | - | `ipc-logger.mjs:40` |
| B-07 | Full-buffer telemetry parse | High | Bottleneck | O(n) line scan | - | - | `telemetry.mjs:62` |
| W-14 | Token budget underestimate | High | Weakness | - | Truncated merges | - | `semantic-merge.mjs:448` |
| B-08 | 80ms spinner re-renders | High | Bottleneck | 12.5 renders/sec | - | - | `dashboard.mjs:87`, `monitor.mjs:320` |
| B-09 | Full-file JSONL reads | High | Bottleneck | Linear growth | - | - | `ipc-stream.mjs:44` |
| B-10 | autoMode 2-5s AI latency | Medium | Bottleneck | Critical path delay | - | - | `orchestration.mjs:678` |
| W-15 | Retry logic insufficient | Medium | Weakness | Failed calls | Degraded fallbacks | - | `ai-client.mjs:62` |
| B-11 | Merge temp files not cleaned | Medium | Bottleneck | Disk leak | - | - | `orchestration.mjs:360` |
| W-16 | Tool call detection undercounts | Medium | Weakness | - | Inaccurate telemetry | - | `agent-entry.mjs:438` |
| B-12 | Fake circular buffer O(n) | Medium | Bottleneck | GC pressure | - | - | `telemetry-channel.mjs:60,351` |
| B-13 | Registry O(n) scans | Medium | Bottleneck | Per-message overhead | - | - | `registry.mjs:182-305` |
| W-17 | Double exponential backoff | Medium | Weakness | Excessive delays | Agents disconnected | - | `agent-channel.mjs:461` |
| B-14 | Split header/body writes | Medium | Bottleneck | Extra syscalls | - | - | `bridge.mjs:347` |
| W-18 | Filter blocks RESPONSE | Medium | Weakness | - | Spurious timeouts | Non-obvious | `orchestrator-control.mjs:403` |
| W-19 | Pending requests unbounded | Medium | Weakness | Memory leak | - | - | `message-bus.mjs:72,540` |
| W-20 | No test suite | Medium | Weakness | - | Undetected regressions | - | `package.json` |
| W-21 | Heuristic-only cost tracking | Medium | Weakness | - | Inaccurate estimates | - | `cost-tracker.mjs:28` |
| W-22 | No context schema validation | Medium | Weakness | - | Empty prompts | - | `context-bridge.mjs:21` |
| W-23 | Naive dropped-change detection | Medium | Weakness | - | False positives | - | `semantic-merge.mjs:684` |
| B-15 | Sync FS in monitor render | Medium | Bottleneck | UI jank | - | - | `monitor.mjs:316` |
| B-16 | Sawtooth message buffer | Medium | Bottleneck | Per-message copy | - | - | `chat-panel.mjs:78` |
| W-24 | Hierarchical mode not integrated | Medium | Weakness | - | Feature unusable | Dead code risk | `hierarchy/README.md:186` |
| W-25 | cleanupTeamDir warning spam | Low | Weakness | - | - | Noisy logs | `agent-entry.mjs:90` |
| W-26 | Overly broad exclude matching | Low | Weakness | - | Files incorrectly excluded | - | `isolation.mjs:67` |
| B-17 | Heartbeat echo overhead | Low | Bottleneck | Wasted bandwidth | - | - | `message-bus.mjs:574` |
| W-27 | Single onMessage handler slot | Low | Weakness | - | Fragile composition | - | `agent-channel.mjs:293` |

---

**Totals:** 27 Weaknesses (W) + 17 Bottlenecks (B) = 44 findings
- Critical: 8
- High: 15
- Medium: 17
- Low: 4

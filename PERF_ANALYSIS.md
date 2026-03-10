# Performance Bottleneck Analysis: 3-Agent Swarm Run

## Critical Path Trace

A `swarm --mode swarm --agents 3 --verify` run follows this execution timeline:

```
Phase                           Location                    Type         Duration (est.)
──────────────────────────────────────────────────────────────────────────────────────────
1. Parse args + autoMode        swarm.mjs:122               AI API call  2-3s
2. mkdirSync + cleanOldRuns     swarm.mjs:129-130           sync I/O     100-500ms
3. claimBdTask                  lifecycle.mjs:139            execFileSync 200-500ms
4. decompose ║ scout            swarm.mjs:170-173           parallel API 3-5s
5. prepareWorktree × 3 (SEQ!)   orchestration.mjs:134       sync I/O     15-30s ← BIGGEST
6. spawnAgent × 3 (parallel)    orchestration.mjs:136-148   async spawn  60-300s (actual work)
7. validateAndApply × 3 (SEQ!)  orchestration.mjs:168-181   sync I/O     15-30s ← SECOND BIGGEST
8. verify                       orchestration.mjs:205        AI API call  5-10s
9. buildContract + write result swarm.mjs:211-216           sync I/O     100ms
10. bd close + cleanup          swarm.mjs:243-272           sync I/O     500ms
```

**Total overhead (excluding actual agent work): 40-80s**
**Agent execution time: 60-300s**
**Overhead as % of total: 15-55% depending on task complexity**

---

## Bottleneck 1: Redundant `snapshotFiles` — SHA-256 Hashing Entire Project (×6)

**Location**: `isolation.mjs:26-54` (called from `prepareWorktree` at `:125` and `validateAndApply` at `:229`)

**Current cost**: ~3-5s per call × 6 calls = **18-30s total**

**Root cause**: `snapshotFiles()` walks the entire directory tree, reads every file into memory with `readFileSync`, and computes SHA-256 for each. It is called:
- 3× in `prepareWorktree()` (once per agent) — but mainCwd hasn't changed between calls
- 3× in `validateAndApply()` (once per agent post-execution) — to detect "escape" writes

For a typical project with 500 files totaling 50MB, each call does:
- 500 `readdirSync` + `readFileSync` calls (synchronous, blocks event loop)
- 500 SHA-256 computations (~10μs each, but the I/O dominates)
- Full file content loaded into memory each time

```javascript
// isolation.mjs:42-44 — the hot inner loop
const content = readFileSync(fullPath);           // sync read entire file
const hash = createHash("sha256").update(content).digest("hex"); // compute hash
manifest[relPath] = { hash, size: content.length };
```

**Fix**:
1. Cache the pre-snapshot across agents: compute once before the `.map()` loop, share the result
2. In `validateAndApply`, use `git status`/`stat()` mtime checks instead of re-hashing the entire tree
3. Replace SHA-256 with xxHash (native Node.js via `crypto.hash()` in Node 21+, or the `xxhash-wasm` package) — 10-20× faster for integrity checks
4. Use async `fs.readFile` with concurrency pooling instead of blocking `readFileSync`

**Improvement**: **~80% reduction** — from 18-30s to 3-5s (1 cached snapshot + mtime-based escape detection)

**Effort**: Medium (2-4 hours)

---

## Bottleneck 2: Sequential `prepareWorktree` in `.map()` Loop

**Location**: `orchestration.mjs:129-157` (inside `executeParallel`)

**Current cost**: ~5-10s per agent × 3 agents = **15-30s total** (sequential)

**Root cause**: `prepareWorktree()` is called synchronously inside `.map()`, which iterates synchronously despite returning Promises. Each call blocks on:
- `execFileSync("git", ["worktree", "add", ...])` — 500ms-2s
- `execFileSync("git", ["ls-files", "--others", ...])` — 200-500ms
- Sequential `copyFileSync` for untracked files — 200-1000ms
- `snapshotFiles(mainCwd)` — 3-5s (see Bottleneck 1)
- `backupFiles()` — 1-3s (see Bottleneck 5)

```javascript
// orchestration.mjs:129-157 — setup is sync, only spawnAgent is async
const promises = subtasks.map((st, i) => {
    const isolation = prepareWorktree(workDir, id, mainCwd);  // ← BLOCKS HERE
    return spawnAgent({...}).then((result) => ({...}));         // ← async starts after
});
```

**Fix**:
1. Compute snapshot once, share across all agents (eliminates 2/3 of snapshot cost)
2. Convert `prepareWorktree` to async, use `execFile` (non-blocking) instead of `execFileSync`
3. Pipeline the setup: start agent-01 spawn while setting up agent-02's worktree
4. Note: `git worktree add` holds a lock, so worktree creation itself must be sequential — but snapshot/backup can run in parallel with the next worktree creation

**Improvement**: **~65% reduction** — from 15-30s to 5-10s (1 snapshot + pipelined setup)

**Effort**: Medium-High (3-5 hours — requires async refactor of isolation.mjs)

---

## Bottleneck 3: `execFileSync` Blocking Calls Throughout

**Location**: Multiple files — every `execFileSync` call blocks the Node.js event loop

**Current cost per call**: 100ms-2s depending on command

| Call | Location | Cost |
|------|----------|------|
| `git worktree add` | isolation.mjs:88 | 500ms-2s |
| `git ls-files --others` | isolation.mjs:94 | 200-500ms |
| `git worktree remove` | isolation.mjs:352 | 300-800ms |
| `git diff --name-only` (×3 variants) | isolation.mjs:170-188 | 100-300ms each |
| `git ls-files --others` (escape detect) | isolation.mjs:192 | 200-500ms |
| `git ls-files` (decompose) | orchestration.mjs:35 | 200-500ms |
| `git ls-files` (scout) | swarm.mjs:36 | 200-500ms |
| `git diff` (verify) | orchestration.mjs:264 | 200-1000ms |
| `node --check` (per file) | isolation.mjs:264 | 200-500ms each |
| `python3 -c compile` (per file) | isolation.mjs:266 | 200-500ms each |
| `bd update --claim` | lifecycle.mjs:139 | 100-500ms |
| `bd close` | lifecycle.mjs:171, swarm.mjs:246 | 100-500ms |

**Total in a 3-agent run**: ~20-40 calls × avg 300ms = **6-12s of blocked event loop**

**Root cause**: `execFileSync` blocks the entire Node.js event loop. While one git command runs, no other I/O can proceed. In a system designed for parallelism, this serializes everything.

**Fix**: Replace all `execFileSync` with `execFile` wrapped in `util.promisify` (or use `child_process.execFile` with callback/promise). This allows overlapping I/O operations.

```javascript
// Before:
const diffOut = execFileSync("git", ["diff", "--name-only"], { cwd, encoding: "utf-8" });

// After:
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const { stdout: diffOut } = await execFileAsync("git", ["diff", "--name-only"], { cwd });
```

**Improvement**: **~50% reduction in wall-clock** for phases with multiple git calls (validateAndApply especially, where 4 sequential git calls become concurrent)

**Effort**: Medium (2-3 hours — mechanical refactor but requires testing)

---

## Bottleneck 4: Sequential `validateAndApply` Post-Loop

**Location**: `orchestration.mjs:168-181`

**Current cost**: ~5-10s per agent × 3 agents = **15-30s total** (sequential)

**Root cause**: After all 3 agents complete, their results are validated and applied in a sequential `for` loop. Each iteration does:
1. 4 `execFileSync` git commands (300ms each = 1.2s)
2. `snapshotFiles(mainCwd)` — full SHA-256 re-hash (3-5s)
3. Per-file hash comparison for escape detection
4. Per-file syntax validation via `execFileSync("node", ["--check", ...])` (200-500ms each)
5. Sequential `copyFileSync` to apply changes

```javascript
// orchestration.mjs:168-181 — sequential post-processing
for (const r of results) {
    if (!r.isolation?.success) continue;
    const apply = validateAndApply(r.isolation.worktreePath, mainCwd, ...);
    // ... logging
    cleanupIsolation(r.isolation.worktreePath, r.isolation.backupDir);
}
```

The `knownApplied` set tracking means agents can't be fully parallelized here (later agents need to know what earlier agents already applied to avoid false "escape" detection). However, the git commands and syntax validation within each agent's validation CAN be parallelized.

**Fix**:
1. Replace `snapshotFiles()` in escape detection with `stat()` mtime comparison (instant vs 3-5s)
2. Batch all git diff commands into a single `git diff --name-only` call (1 command vs 4)
3. Run syntax validation (`node --check`) in parallel using `Promise.all` with concurrency limit
4. Since `knownApplied` creates a dependency chain, the agents must still be processed sequentially — but each agent's internal validation can be much faster

**Improvement**: **~75% reduction** — from 15-30s to 4-8s

**Effort**: Medium (3-4 hours)

---

## Bottleneck 5: `backupFiles` Sequential Copying

**Location**: `isolation.mjs:61-75` (called from `prepareWorktree` at `:128`)

**Current cost**: ~1-3s per agent × 3 agents = **3-9s total**

**Root cause**: For each file in the snapshot matching `BACKUP_EXTENSIONS`, the function does sequential `mkdirSync` + `copyFileSync`. For a project with 200 source files, that's 200 synchronous copy operations.

```javascript
// isolation.mjs:64-73 — sequential copy loop
for (const relPath of Object.keys(snapshot)) {
    if (!BACKUP_EXTENSIONS.test(relPath)) continue;
    const src = join(mainCwd, relPath);
    const dst = join(backupDir, relPath);
    mkdirSync(dirname(dst), { recursive: true });  // sync dir create
    copyFileSync(src, dst);                          // sync file copy
    count++;
}
```

**Fix**:
1. Share backup across agents: if mainCwd hasn't changed, one backup suffices for all 3 agents
2. Use async `fs.copyFile` with a concurrency pool (e.g., 10 concurrent copies)
3. Consider using hard links (`fs.linkSync`) instead of copies — same data, zero copy cost, works if on same filesystem
4. Lazy backup: only backup files that agents actually modify (detected post-execution), not all files preemptively

**Improvement**: **~85% reduction** — from 3-9s to 0.5-1.5s (shared backup + hard links)

**Effort**: Low-Medium (1-2 hours)

---

## Bottleneck 6: `Buffer.concat` Repeated on Same Data

**Location**: `agent-entry.mjs:554, 581, 635, 647`

**Current cost**: ~50-500ms per concat depending on buffer size (up to 50MB)

**Root cause**: `stderrChunks` is concatenated to a string multiple times in different code paths:

```javascript
// Line 554: After process exit
output = Buffer.concat(stdoutChunks).toString("utf-8").trim();

// Line 581: For AI error classification
const stderrTail = Buffer.concat(stderrChunks).toString("utf-8").slice(-2000);

// Line 635: For failure diagnostics
const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

// Line 647: For telemetry
const stderrText = Buffer.concat(stderrChunks).toString("utf-8");
```

Each `Buffer.concat` allocates a new buffer of `stderrBytes` size, copies all chunks into it, then `.toString("utf-8")` creates another allocation. With a 50MB buffer cap, this can be 4× 50MB = 200MB of transient allocations.

**Fix**: Concat once into a variable and reuse:

```javascript
const outputBuf = Buffer.concat(stdoutChunks);
const stderrBuf = Buffer.concat(stderrChunks);
const output = outputBuf.toString("utf-8").trim();
const stderrText = stderrBuf.toString("utf-8");
```

**Improvement**: **~75% reduction in memory allocations**, 100-400ms saved on large outputs

**Effort**: Low (30 minutes — trivial refactor)

---

## Bottleneck 7: `process.env` Object Spreading

**Location**: `agent-entry.mjs:288` and `agent-spawn.mjs:42`

**Current cost**: ~1-5ms per spread × 6 total (3 agents × 2 levels) = **6-30ms**

**Root cause**: Each agent spawn creates a full copy of `process.env`:

```javascript
// agent-entry.mjs:288
const env = { ...process.env };

// agent-spawn.mjs:42
const childEnv = { ...process.env };
```

`process.env` is a special proxy object in Node.js. Spreading it creates a plain object copy with string coercion of all values. With typical 50-100 env vars, each spread is ~1-5ms.

**Fix**:
1. In `agent-spawn.mjs`, pass only the delta env vars (SWARM_AGENT_ID) via `spawn` options instead of spreading the full env
2. In `agent-entry.mjs`, create the env object once and mutate it directly rather than spreading

Note: This is a **low-impact** bottleneck. The 6-30ms cost is negligible compared to others.

**Improvement**: **~80% reduction** — from 6-30ms to 1-5ms, but only ~25ms saved total

**Effort**: Low (15 minutes)

---

## Bottleneck 8: Duplicate `git ls-files` in Decompose and Scout

**Location**: `orchestration.mjs:35-36` (decompose) and `swarm.mjs:36` (scoutProject)

**Current cost**: ~200-500ms each × 2 = **400ms-1s**

**Root cause**: Both `decompose()` and `scoutProject()` independently call `execFileSync("git", ["ls-files"])` to get the project file listing. They run in parallel via `Promise.all`, but both are `execFileSync` (blocking), so they actually serialize.

```javascript
// Both functions contain this identical block:
tree = execFileSync("git", ["ls-files"], {
    encoding: "utf-8", timeout: 5000, cwd: process.cwd(),
}).split("\n").filter(Boolean).slice(0, 300).join("\n");
```

**Fix**: Compute the file tree once before `Promise.all`, pass as parameter to both functions.

**Improvement**: **~50% reduction** — from 400ms-1s to 200-500ms

**Effort**: Low (30 minutes)

---

## Bottleneck 9: `readFileSync`/`writeFileSync` in Hot Paths

**Location**: Multiple locations

| Operation | Location | Frequency | Cost |
|-----------|----------|-----------|------|
| `readFileSync` per file in snapshot | isolation.mjs:43 | 500× per snapshot call | ~10μs + I/O per file |
| `writeFileSync` progress file | agent-entry.mjs:450 | Every 30s per agent | ~1-5ms |
| `readFileSync` result file | context-bridge.mjs:81 | Per agent in buildContract | ~1-5ms |
| `writeFileSync` result file | context-bridge.mjs:66 | Per agent completion | ~1-5ms |
| `copyFileSync` in backupFiles | isolation.mjs:70 | 200× per agent | ~0.5-2ms each |
| `copyFileSync` in apply | isolation.mjs:316-317 | Per changed file | ~0.5-2ms each |

**Root cause**: All filesystem operations are synchronous, blocking the event loop. The `snapshotFiles` inner loop is the worst offender — 500 synchronous reads in tight succession.

**Fix**:
1. Convert `snapshotFiles` to use async `fs.readFile` with a concurrency pool (`Promise.all` with chunks of 50)
2. Use `fs.writeFile` (async) for progress files — they're best-effort anyway
3. For `copyFileSync` in backupFiles/apply, use `fs.copyFile` (async) with concurrency limit

**Improvement**: **~60% reduction in event loop blocking** for I/O-heavy phases

**Effort**: Medium (2-3 hours — requires async refactor of isolation.mjs)

---

## Bottleneck 10: Sequential Syntax Validation in `validateAndApply`

**Location**: `isolation.mjs:261-272`

**Current cost**: ~200-500ms per file × N changed files = **1-5s per agent**

**Root cause**: Each changed file is validated one at a time with `execFileSync`:

```javascript
// isolation.mjs:261-272 — sequential validation
for (const { file, cwd } of allChangedFiles) {
    if (/\.(mjs|js|cjs)$/.test(file)) {
        execFileSync("node", ["--check", join(cwd, file)], { timeout: 10000 });
    } else if (/\.py$/.test(file)) {
        execFileSync("python3", ["-c", `import py_compile; py_compile.compile('${fullPath}', doraise=True)`], { timeout: 10000 });
    }
}
```

Node.js startup alone costs ~100ms. For 10 changed JS files, that's 10 × (100ms startup + 100ms parse) = **2s of sequential blocking**.

**Fix**:
1. Batch JS validation: write a temp script that requires all files, run once
2. Use `acorn.parse()` or `@babel/parser` in-process for JS syntax checking (~1ms per file vs 200ms)
3. For Python, batch into a single `python3 -c` call that compiles all files
4. Run all validations in parallel with `Promise.all` + async `execFile`

**Improvement**: **~90% reduction** — from 2-5s to 200-500ms per agent

**Effort**: Medium (2-3 hours)

---

## Bottleneck 11: `cleanOldRuns` Synchronous Directory Scan

**Location**: `lifecycle.mjs:240-313`

**Current cost**: ~100-500ms (depends on number of old runs)

**Root cause**: Scans up to 50 directories with `readdirSync` + `statSync` + `rmSync`. Runs synchronously at startup, blocking the critical path.

```javascript
// lifecycle.mjs:265-280
const dirs = readdirSync(swarmBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .slice(0, 50);

for (const dir of dirs) {
    const stats = statSync(dirPath);
    if (now - stats.mtimeMs > ttlMs) {
        rmSync(dirPath, { recursive: true, force: true });  // blocking recursive delete
    }
}
```

**Fix**: Run cleanup asynchronously after swarm start (fire-and-forget), or defer to a background setImmediate/setTimeout.

**Improvement**: **~100% off critical path** — 100-500ms saved from startup latency

**Effort**: Low (30 minutes)

---

## Bottleneck 12: `git worktree add` Sequential Creation

**Location**: `isolation.mjs:88`

**Current cost**: ~500ms-2s per agent × 3 agents = **1.5-6s total** (must be sequential due to git lock)

**Root cause**: Git's worktree operations use a lock file (`.git/worktrees/`). Only one `git worktree add` can run at a time. Even with async refactoring, this remains sequential.

However, the subsequent setup steps (copy untracked, snapshot, backup) are independent and could be overlapped with the next worktree creation.

**Fix**: Pipeline the setup — while agent-02's worktree is being created, agent-01's untracked copy + snapshot + backup can proceed in parallel.

**Improvement**: **~40% reduction** — from 1.5-6s to 1-4s (worktree creation itself unchanged, but overlapped with other work)

**Effort**: Medium (2-3 hours — requires pipelining the async flow)

---

## Summary Table

| # | Bottleneck | Location | Current Cost | Fix | Time Saved | % Improvement | Effort |
|---|-----------|----------|-------------|-----|-----------|---------------|--------|
| 1 | Redundant snapshotFiles SHA-256 (×6) | isolation.mjs:26-54 | 18-30s | Cache snapshot + mtime-based escape detection | 15-25s | 80% | Medium |
| 2 | Sequential prepareWorktree in .map() | orchestration.mjs:129-157 | 15-30s | Async + shared snapshot + pipeline | 10-20s | 65% | Med-High |
| 3 | execFileSync blocking throughout | Multiple | 6-12s | Replace with async execFile | 3-6s | 50% | Medium |
| 4 | Sequential validateAndApply post-loop | orchestration.mjs:168-181 | 15-30s | mtime escape detection + parallel validation | 11-22s | 75% | Medium |
| 5 | backupFiles sequential copying | isolation.mjs:61-75 | 3-9s | Shared backup + hard links | 2.5-7.5s | 85% | Low-Med |
| 6 | Buffer.concat repeated on same data | agent-entry.mjs:554,581,635,647 | 100-400ms | Concat once, reuse | 75-300ms | 75% | Low |
| 7 | process.env spreading | agent-entry.mjs:288, agent-spawn.mjs:42 | 6-30ms | Delta env only | 5-25ms | 80% | Low |
| 8 | Duplicate git ls-files | orchestration.mjs:35, swarm.mjs:36 | 400ms-1s | Compute once, pass as param | 200-500ms | 50% | Low |
| 9 | readFileSync/writeFileSync hot paths | isolation.mjs, agent-entry.mjs | 5-15s (across all snapshot ops) | Async with concurrency pool | 3-9s | 60% | Medium |
| 10 | Sequential syntax validation | isolation.mjs:261-272 | 3-15s (across 3 agents) | In-process parse + batch | 2.7-13.5s | 90% | Medium |
| 11 | cleanOldRuns at startup | lifecycle.mjs:240-313 | 100-500ms | Defer to background | 100-500ms | 100% | Low |
| 12 | git worktree add sequential | isolation.mjs:88 | 1.5-6s | Pipeline with async setup | 0.6-2.4s | 40% | Medium |

## Total Estimated Improvement

**Current total overhead** (excluding agent execution): **40-80s**

| Priority | Fixes | Saves | Cumulative |
|----------|-------|-------|-----------|
| P0 (Quick wins) | #6 Buffer.concat + #7 env + #8 dup ls-files + #11 cleanOldRuns | 0.5-1.5s | 0.5-1.5s |
| P1 (High impact, medium effort) | #1 Cache snapshot + #5 shared backup | 17-33s | 18-34s |
| P2 (Async refactor) | #2 async prepareWorktree + #3 async execFile + #4 async validateAndApply | 24-48s | 42-82s |
| P3 (In-process validation) | #9 async fs + #10 in-process parse | 6-22s | 48-104s |

**Realistic improvement with P0+P1+P2**: **60-75% reduction** in overhead, from 40-80s down to **10-20s**.

**With all fixes applied**: Overhead drops to **5-12s**, making agent execution time (60-300s) completely dominant — which is the ideal state where all time is spent on actual productive work.

## Priority Recommendation

**Start with #1 (cache snapshot) + #6 (Buffer.concat dedup)**: These two fixes alone save 15-25s with minimal risk.

**Then #5 (shared backup) + #8 (dedup ls-files) + #11 (defer cleanup)**: Another 3-8s with trivial code changes.

**Then the async refactor (#2, #3, #4, #9, #10)**: This is the comprehensive fix that requires converting isolation.mjs to async, but it eliminates essentially all event-loop blocking.

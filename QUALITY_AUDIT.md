# Quality Audit: Performance Optimization Verdicts

**Auditor**: Quality Assurance Architect (Claude Opus 4.6)
**Date**: 2026-03-10
**Scope**: 12 proposed bottleneck fixes for remote-agent/swarm infrastructure
**Source files reviewed**: agent-entry.mjs, swarm.mjs, lib/orchestration.mjs, lib/isolation.mjs, lib/config.mjs, lib/agent-spawn.mjs, lib/context-bridge.mjs, lib/telemetry.mjs, lib/ai-client.mjs, lib/lifecycle.mjs

## Hard Constraints (Non-Negotiable)

| # | Constraint | Relevant Code |
|---|-----------|---------------|
| 1 | No reduced verification thoroughness | `validateAndApply()` syntax checks, `verify()` cross-referencing |
| 2 | No skipped validation steps | `node --check`, `python3 -c`, SHA-256 integrity, escape detection |
| 3 | No introduced race conditions | Parallel worktree operations, concurrent file writes |
| 4 | No stale data usage | `snapshotFiles()` pre/post comparison, mtime reliability |
| 5 | No weakened isolation boundaries | Worktree separation, backup independence, env isolation |
| 6 | No reduced error visibility | Error logging in catch blocks, validation error surfacing |
| 7 | No compromised determinism | File apply order, merge conflict detection |
| 8 | No lowered code quality bar | Syntax validation, linting gates |

## Summary Table

| BN | Title | Verdict | Risk Level |
|----|-------|---------|------------|
| .16 | SHA-256 → mtime + xxHash | **RISKY** | Medium-High |
| .17 | Parallelize prepareWorktree setup | **SAFE** | Low |
| .18 | execFileSync → async execFile | **SAFE** | Low |
| .19 | Optimize validateAndApply | **RISKY** | Medium |
| .20 | Shared backup + hard links | **BLOCKED** | Critical |
| .21 | Eliminate repeated Buffer.concat | **SAFE** | None |
| .22 | Delta-only env vars | **SAFE** | None |
| .23 | Deduplicate git ls-files | **SAFE** | None |
| .24 | Sync fs → async with concurrency pool | **RISKY** | Low-Medium |
| .25 | In-process acorn.parse for syntax | **RISKY** | Medium-High |
| .26 | Defer cleanOldRuns to background | **SAFE** | None |
| .27 | Pipeline git worktree add | **RISKY** | Medium |

---

## Detailed Verdicts

---

### BN-.16: Replace SHA-256 hashing with mtime checks + xxHash

**File**: `lib/isolation.mjs` — `snapshotFiles()` (lines 26-54), untracked file diff (lines 205-221)

**VERDICT: RISKY**

#### Current behavior
`snapshotFiles()` reads every file's content and computes `createHash("sha256").update(content).digest("hex")`. This hash is used for:
1. **Escape detection**: comparing pre-snapshot vs post-snapshot of mainCwd to detect if an agent modified files outside its worktree (lines 228-249)
2. **Untracked file modification detection**: comparing worktree copy against original (lines 205-221)

#### What could go wrong

**mtime is unreliable for change detection:**
- `cp -p` preserves mtime — a file can be replaced with different content while keeping the same mtime
- Some editors (vim with `backupcopy=auto`) restore mtime after writes
- NFS and networked filesystems have clock skew issues
- macOS APFS has 1ns mtime resolution, but some tools truncate to 1s
- An agent that writes a file, then writes it back to the original content within the same second would show "no mtime change" while actually having modified it

**Impact on escape detection**: If mtime check gives a false negative (says "unchanged" when content changed), an agent's worktree escape goes undetected. The escaped modification persists in mainCwd without validation. This violates **Constraint #4 (stale data)** and **Constraint #1 (reduced verification)**.

**xxHash alone is fine**: xxHash-64 has a collision probability of ~1/2^64 for random data. For integrity checking (not security), this is more than sufficient. The concern is purely with the mtime fast-path.

#### Required mitigations (ALL mandatory)

1. **xxHash is acceptable as a SHA-256 replacement** — swap the hash algorithm freely. xxHash-64 or xxHash-128 provides adequate integrity assurance for file change detection.

2. **mtime can ONLY be used as a negative filter for UNCHANGED files** — if `mtime === pre.mtime AND size === pre.size`, skip hashing (file definitely unchanged). But if EITHER differs, MUST hash. This is the "mtime as bloom filter" pattern.

3. **NEVER use mtime-only comparison for escape detection** — the escape detection path (lines 228-249) is the security boundary. Files with changed mtime MUST be hashed. Files with unchanged mtime AND unchanged size can be assumed unchanged.

4. **Add a test case**: Create a file, snapshot, replace content with same-size different content while preserving mtime (using `utimes()`), verify that the change is still detected via hash.

#### If mitigations are not implementable
Upgrade to **BLOCKED**. Mtime-only escape detection would allow agents to silently corrupt mainCwd.

---

### BN-.17: Parallelize prepareWorktree setup

**File**: `lib/isolation.mjs` — `prepareWorktree()` (lines 82-136)

**VERDICT: SAFE**

#### Current behavior (sequential)
1. `git worktree add` (creates worktree from HEAD)
2. `git ls-files --others` + `copyFileSync` (copies untracked files to worktree)
3. `symlinkSync` (symlinks node_modules)
4. `snapshotFiles(mainCwd)` (hashes all files for escape detection baseline)
5. `backupFiles(mainCwd, backupDir, snapshot)` (copies source files for rollback)

#### Why this is safe

Steps 1 and 4 are **fully independent**:
- `git worktree add` creates a new directory under `workDir/worktrees/` and modifies `.git/worktrees/`. It does NOT modify any tracked files in mainCwd.
- `snapshotFiles(mainCwd)` is a read-only walk of mainCwd. It doesn't touch `.git/worktrees/`.

These can safely run in parallel:
```
Promise.all([
  asyncGitWorktreeAdd(wtPath, mainCwd),  // step 1
  asyncSnapshotFiles(mainCwd),            // step 4
])
```

Steps 2-3 depend on step 1 (worktree must exist). Step 5 depends on step 4 (needs snapshot manifest). So the dependency graph is:

```
[1: worktree add] ──→ [2: copy untracked] ──→ [3: symlink node_modules]
[4: snapshot]     ──→ [5: backup files]
```

Both branches can run in parallel. Total wall-clock time drops from `T1+T2+T3+T4+T5` to `max(T1+T2+T3, T4+T5)`.

#### Safeguards to implement

- `snapshotFiles` must complete BEFORE returning from `prepareWorktree`. The snapshot is the escape detection baseline — it must be captured before the agent starts.
- Step 5 (backup) must await step 4 (snapshot) — it iterates `Object.keys(snapshot)`.
- Steps 2-3 must await step 1 — they write into the worktree directory.

---

### BN-.18: Replace execFileSync with async execFile

**Files**: `lib/isolation.mjs`, `lib/orchestration.mjs`, `lib/lifecycle.mjs`

**VERDICT: SAFE**

#### Current behavior
Multiple uses of `execFileSync` throughout:
- `git worktree add` (isolation.mjs:88)
- `git ls-files --others` (isolation.mjs:94)
- `git diff --name-only` (isolation.mjs:170-186, orchestration.mjs:264)
- `git ls-files` (orchestration.mjs:35-42, swarm.mjs:36-42)
- `node --check` (isolation.mjs:264)
- `python3 -c` (isolation.mjs:267)
- `bd update/close` (lifecycle.mjs:139, 171)

All of these block the event loop. Converting to `util.promisify(execFile)` with `await` is a drop-in replacement.

#### Why this is safe

- **Ordering preserved by `await`** — each `await execFile(...)` produces the same sequential execution as `execFileSync(...)`.
- **No functional change** — same commands, same arguments, same timeouts.
- **Enables future parallelism** — once async, independent operations can be `Promise.all`'d.
- **Error handling identical** — both throw on non-zero exit, both support timeout.

#### Safeguards to implement

- **Every `execFileSync` → `await execFile` conversion MUST have `await`**. A missing `await` would fire-and-forget the operation, causing race conditions. Use a linter rule (`no-floating-promises` or TypeScript strict mode) to catch missing awaits.
- **The `encoding: "utf-8"` option must be preserved** — without it, the async version returns a `{stdout, stderr}` object instead of a string. Destructure accordingly: `const { stdout } = await execFile(...)`.
- **Timeout behavior is identical** — `child_process.execFile` supports `timeout` option in both sync and async forms.

---

### BN-.19: Optimize validateAndApply (mtime checks, batch git diffs)

**File**: `lib/isolation.mjs` — `validateAndApply()` (lines 157-344)

**VERDICT: RISKY**

#### Current behavior
1. Runs 3 separate `git diff --name-only` commands:
   - All changed files (line 170)
   - Deleted files with `--diff-filter=D` (line 177)
   - Added files with `--diff-filter=A` (line 184)
2. Runs `git ls-files --others --exclude-standard` (line 192)
3. Hashes each modified untracked file with SHA-256 (lines 205-221)
4. Runs `snapshotFiles(mainCwd)` for escape detection (line 229)
5. Runs `node --check` / `python3 -c` per changed file (lines 263-271)

#### Component-by-component analysis

**Batch git diffs — SAFE:**
Replace 3 `git diff` calls with a single `git diff --name-status` that returns both the status letter (A/D/M) and filename. Parse the output to populate all three lists. Functionally identical, 3x fewer subprocesses.

```
M   src/foo.mjs      → worktreeChanged
D   src/bar.mjs      → worktreeDeleted
A   src/baz.mjs      → worktreeAdded
```

**mtime checks for escape detection — RISKY (same as BN-.16):**
See BN-.16 analysis. mtime-only comparison for the post-snapshot violates Constraint #4. Must hash on mtime/size change.

**Parallel syntax checks — RISKY:**
Running syntax checks concurrently introduces the risk that an early failure aborts remaining checks (if using `Promise.race` instead of `Promise.allSettled`). All validation errors must be collected, not just the first.

#### Required mitigations

1. **Batch git diffs**: Use `git diff --name-status` — no mitigation needed, drop-in improvement.
2. **mtime in escape detection**: Same mitigations as BN-.16 — mtime+size as negative filter only, hash on any change indicator.
3. **Parallel syntax checks**: Use `Promise.allSettled()` to collect ALL validation results. Never short-circuit on first error.
4. **Ordering**: Escape detection (post-snapshot) must still run AFTER the agent exits. Do not overlap with agent execution.

---

### BN-.20: Shared backup + hard links instead of copyFileSync

**File**: `lib/isolation.mjs` — `backupFiles()` (lines 61-75)

**VERDICT: BLOCKED**

#### Why this is prohibited

**Hard links share inode content.** When `backupFiles()` creates a hard link from `mainCwd/src/foo.mjs` to `backupDir/src/foo.mjs`, both paths point to the SAME inode on disk. The backup is NOT an independent copy.

**The attack scenario:**
1. `prepareWorktree()` creates hard-link "backup" of `mainCwd/src/foo.mjs`
2. Agent runs in worktree but ESCAPES — writes directly to `mainCwd/src/foo.mjs` via absolute path
3. Escape detection triggers, validation fails
4. Rollback attempts to restore from backup: `copyFileSync(backupDir/src/foo.mjs, mainCwd/src/foo.mjs)`
5. **But the backup hard link points to the SAME file that was corrupted** — rollback copies corrupted content over itself

This defeats the entire purpose of the backup mechanism. The rollback safety net becomes a no-op.

**On macOS APFS**: APFS uses copy-on-write (CoW) for cloned files (`clonefile(2)`), but standard hard links (`link(2)`) are NOT CoW — they share the data. If the optimization uses `fs.linkSync()` (which calls `link(2)`), the backup is compromised.

**Even APFS clones have a subtle issue**: `copyFileSync` on APFS already uses `clonefile` under the hood (since Node.js v16+), so the "optimization" of using hard links would actually be a DOWNGRADE from the current behavior, which already gets CoW benefits transparently.

#### Constraint violations
- **#4 (stale data)**: Backup contains corrupted data after escape
- **#5 (weakened isolation)**: Rollback mechanism rendered ineffective
- **#1 (reduced verification)**: Cannot verify pre-agent state after corruption

#### Alternative
**None needed** — `copyFileSync` on APFS already uses `clonefile(2)` which is O(1) and CoW. The current implementation is already near-optimal on macOS. On Linux ext4/XFS, `copyFileSync` does a full copy, but backup file sizes are typically small (source code, not binaries). The latency is acceptable.

---

### BN-.21: Eliminate repeated Buffer.concat (concat once, reuse)

**File**: `agent-entry.mjs` — lines 554, 581, 635, 647, 658

**VERDICT: SAFE**

#### Current behavior
After the agent process exits, `Buffer.concat(stderrChunks)` is called up to 4 separate times:
- Line 554: Build stdout output
- Line 581: Extract last 2K of stderr for error classification
- Line 635: Show stderr tail on failure
- Line 647: Parse telemetry from stderr
- Line 658: Extract last 3K for quality analysis

Each call creates a new buffer from the same chunks array.

#### Why this is safe

- All calls happen AFTER `proc.on("close")` — the chunks arrays are frozen (no more data arriving).
- Concatenating once and reusing the resulting buffer/string is functionally identical.
- This is a pure memory/CPU optimization with zero behavioral change.

#### Implementation

```javascript
// After process exit:
const stdoutFull = Buffer.concat(stdoutChunks).toString("utf-8").trim();
const stderrFull = Buffer.concat(stderrChunks).toString("utf-8");
// Then use stdoutFull and stderrFull everywhere instead of re-concatenating
```

No safeguards needed — this is a mechanical refactor.

---

### BN-.22: Delta-only env vars instead of full process.env spread

**Files**: `agent-entry.mjs` (line 288), `lib/agent-spawn.mjs` (line 42)

**VERDICT: SAFE**

#### Current behavior
```javascript
const env = { ...process.env };  // Full copy of ~100+ env vars
// Then modify specific keys
delete env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;
env.CLAUDE_CONFIG_DIR = join(__dirname, "config");
// etc.
```

#### Why this is safe

Node.js `spawn()` with `env` option REPLACES the entire environment — it does not merge with `process.env`. So a full env object must be passed. The optimization is to **cache the base spread once** at module scope:

```javascript
const BASE_ENV = { ...process.env };
// In each spawn:
const env = { ...BASE_ENV, CLAUDE_CONFIG_DIR: "...", CLAUDECODE: "" };
```

This produces the same subprocess environment. The only risk would be if `process.env` changes between spawns (e.g., a hook modifies it), but:
- `process.env` is not modified during swarm execution
- Each agent spawn happens in the same event loop tick (inside `Promise.all`)
- The deleted keys (`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`, etc.) are deleted from the copy, not from `process.env`

#### Safeguards
- If any code path modifies `process.env` between spawns, the cache becomes stale. Document that `BASE_ENV` must be refreshed if `process.env` is mutated.
- Practically, the performance gain is minimal (~microseconds for object spread of ~100 keys). This is a low-priority optimization.

---

### BN-.23: Deduplicate git ls-files between decompose and scout

**Files**: `lib/orchestration.mjs` — `decompose()` (lines 33-43), `swarm.mjs` — `scoutProject()` (lines 35-43)

**VERDICT: SAFE**

#### Current behavior
Both functions run `execFileSync("git", ["ls-files"])` independently. They are called in `Promise.all` at `swarm.mjs:170-173`:

```javascript
const [subtasks, scoutOutput] = await Promise.all([
  decompose(args.task, ...),
  scoutProject(args.task, ...),
]);
```

So `git ls-files` runs twice simultaneously.

#### Why this is safe

- `git ls-files` is a read-only operation — no mutations, no lock contention
- Both callers want the same data (file listing of the repo)
- The file list is a point-in-time snapshot — both callers already accept that files might change after the snapshot
- Running it once and passing the result to both functions is semantically identical

#### Implementation

```javascript
// Before Promise.all:
const fileTree = await getFileTree(process.cwd());
const [subtasks, scoutOutput] = await Promise.all([
  decompose(args.task, maxAgents, depth, contextFile, workDir, fileTree),
  scoutProject(args.task, workDir, contextFile, fileTree),
]);
```

No safeguards needed — pure deduplication of a read-only operation.

---

### BN-.24: Convert sync fs ops to async with concurrency pool

**Files**: `lib/isolation.mjs` — `snapshotFiles()`, `backupFiles()`, `lib/lifecycle.mjs` — `cleanOldRuns()`

**VERDICT: RISKY**

#### Current behavior

`snapshotFiles()` (lines 26-54) does a synchronous recursive walk:
```javascript
const content = readFileSync(fullPath);
const hash = createHash("sha256").update(content).digest("hex");
```

`backupFiles()` (lines 61-75):
```javascript
copyFileSync(src, dst);
```

`cleanOldRuns()` (lifecycle.mjs:265-289):
```javascript
const stats = statSync(dirPath);
rmSync(dirPath, { recursive: true, force: true });
```

#### What could go wrong

1. **Concurrent reads during snapshot are safe** — files are only read, not written. Multiple `readFile` calls on different files don't interfere.

2. **Concurrent copies during backup are mostly safe** — each file copies independently. However, if two backup operations target the same directory (shouldn't happen in practice since backup dirs are per-agent), `mkdirSync` could race.

3. **Concurrent cleanup in `cleanOldRuns` is the real risk** — `rmSync` on directories that might still be in use by a late-finishing agent. If another swarm instance is running concurrently and shares `/tmp/swarm/`, deleting its run directory would corrupt its state. **This violates Constraint #5 (weakened isolation).**

4. **File descriptor exhaustion** — without a concurrency limit, opening hundreds of files simultaneously could hit the OS `ulimit -n` (typically 256-1024 on macOS). This would cause EMFILE errors.

#### Required mitigations

1. **Concurrency pool with limit** — use a pool of 10-20 concurrent operations (e.g., `p-limit` or manual semaphore). This prevents fd exhaustion.
2. **`snapshotFiles` async conversion** — safe with pool. No ordering constraint within the walk.
3. **`backupFiles` async conversion** — safe with pool. Each `mkdirSync(dirname(dst))` should use `mkdir` with `recursive: true` (idempotent, handles concurrent creates).
4. **`cleanOldRuns` must check for active processes** — before deleting a directory, verify no processes are running from it (check for a lockfile or PID file). Alternatively, use advisory locking (`flock`).
5. **Overall ordering constraint**: The validate-then-apply pipeline in `validateAndApply()` MUST remain sequential: snapshot → validate → apply/rollback. Do NOT parallelize steps across this boundary.

---

### BN-.25: Batch/parallelize syntax validation (in-process acorn.parse)

**File**: `lib/isolation.mjs` — `validateAndApply()` (lines 261-271)

**VERDICT: RISKY**

#### Current behavior
```javascript
if (/\.(mjs|js|cjs)$/.test(file)) {
  execFileSync("node", ["--check", join(cwd, file)], { timeout: 10000 });
} else if (/\.py$/.test(file)) {
  execFileSync("python3", ["-c", `import py_compile; py_compile.compile('${fullPath}', doraise=True)`], { timeout: 10000 });
}
```

Each file spawns a separate `node` or `python3` process for syntax validation. For N files, this is N sequential subprocess spawns.

#### acorn.parse risks

**False negatives (acorn PASSES, node --check REJECTS):**
- `acorn` is a JavaScript parser, not a V8 syntax validator. It may accept syntax constructs that V8 rejects.
- Example: V8-specific syntax errors related to `import.meta` usage patterns, `await` in non-async contexts in older module systems, or tagged template literal edge cases.
- If acorn passes and we skip `node --check`, invalid code reaches mainCwd. **Violates Constraint #1 (reduced verification) and Constraint #8 (lowered quality bar).**

**False positives (acorn REJECTS, node --check PASSES):**
- `acorn` without proper plugins may reject valid Node.js syntax (`import.meta`, newer ES features, hashbang `#!/usr/bin/env node`).
- This causes valid agent work to be rolled back unnecessarily. While "safe" (no corrupted code applied), it causes **false rejections** that waste compute.

**Python validation unchanged** — `py_compile.compile()` has no in-process equivalent in Node.js.

#### The correct optimization

**Do not replace `node --check` with acorn. Instead, parallelize the subprocess calls:**

```javascript
const checks = allChangedFiles.map(({ file, cwd }) => {
  if (/\.(mjs|js|cjs)$/.test(file)) {
    return execFileAsync("node", ["--check", join(cwd, file)], { timeout: 10000 })
      .catch(err => ({ file, error: err }));
  }
  // ... similar for python
});
const results = await Promise.allSettled(checks);
```

This preserves the authoritative `node --check` validation while achieving O(1) wall-clock time (all checks run concurrently).

#### Required mitigations (if acorn is still pursued)

1. **acorn as fast-REJECT only** — if acorn rejects a file, immediately reject without spawning `node --check` (saves one subprocess). If acorn passes, STILL run `node --check` as authoritative validation.
2. **This means acorn can only SPEED UP the rejection path**, not the acceptance path. For valid code (the common case), no speedup.
3. **Alternative (recommended)**: Parallelize `node --check` calls with a concurrency pool. Use `Promise.allSettled` to collect ALL failures, not just the first.
4. **Python validation**: Must remain subprocess-based (no in-process alternative).

---

### BN-.26: Defer cleanOldRuns to background

**File**: `lib/lifecycle.mjs` — `cleanOldRuns()` (lines 240-313), called at `swarm.mjs:130`

**VERDICT: SAFE**

#### Current behavior
`cleanOldRuns(SWARM_BASE)` runs synchronously at the start of every swarm invocation, before any agents spawn. It scans `/tmp/swarm/`, checks mtime of each subdirectory, and `rmSync`s directories older than TTL (default 24h).

#### Why deferring is safe

1. **The current run has its own UUID-based directory** (`/tmp/swarm/<uuid>`), created AFTER `cleanOldRuns`. Even if cleanup were concurrent, the current directory was just created — its mtime is "now" and will never match the TTL filter.

2. **Old run directories are abandoned** — no active processes reference them (agents exited, results already consumed).

3. **Cleanup is best-effort** — the function already has comprehensive error handling and never throws. If it fails silently, old directories just accumulate until the next cleanup.

4. **No data dependencies** — no code path reads from old run directories. The current run creates everything fresh.

#### Implementation options

```javascript
// Option A: setImmediate (runs after current event loop tick)
setImmediate(() => cleanOldRuns(SWARM_BASE));

// Option B: Background child process (survives if swarm crashes)
spawn("node", ["-e", `require('./lib/lifecycle.mjs').cleanOldRuns('${SWARM_BASE}')`], {
  detached: true, stdio: "ignore"
}).unref();
```

Option A is simpler and sufficient. Option B is overkill.

#### Safeguards
- The deferred cleanup must NOT run during integration tests that assert on `/tmp/swarm/` contents. Gate with `process.env.NODE_ENV !== 'test'` if needed.

---

### BN-.27: Pipeline git worktree add with parallel setup

**File**: `lib/orchestration.mjs` — `executeParallel()` (lines 119-183)

**VERDICT: RISKY**

#### Current behavior
Inside `subtasks.map()`, `prepareWorktree()` is called synchronously for each agent:
```javascript
const promises = subtasks.map((st, i) => {
  const isolation = prepareWorktree(workDir, id, mainCwd);  // SYNC
  return spawnAgent({...}).then(...);
});
```

All worktrees are created sequentially within the `.map()` before any agent starts executing.

#### What could go wrong

**git worktree lock contention:**
- `git worktree add` modifies `.git/worktrees/` directory, which uses file-based locking.
- Concurrent `git worktree add` calls to the SAME repository will contend on this lock.
- Git's lock timeout is short — concurrent adds may fail with `fatal: Unable to create '.../.git/worktrees.lock': File exists.`
- **This violates Constraint #3 (race conditions).**

**Snapshot consistency:**
- Currently, `snapshotFiles(mainCwd)` runs once per `prepareWorktree` call. If 5 agents all snapshot concurrently, they should see the same state (no writes are happening yet). This is fine.
- HOWEVER: if we run snapshots in parallel, we snapshot 5 times instead of once. The correct optimization is to **snapshot once, share across agents**.

**Untracked file copy races:**
- `copyFileSync` into different worktree paths is safe (different destinations).
- `git ls-files --others` is read-only and can run concurrently.

#### Required mitigations

1. **Serialize `git worktree add` calls** — run them sequentially, or with a mutex/semaphore that allows only one at a time. Do NOT run concurrent `git worktree add` on the same repository.

2. **Parallelize everything EXCEPT `git worktree add`:**
   - Snapshot mainCwd ONCE, share the result.
   - Run `git ls-files --others` ONCE, share the result.
   - Create backup dirs in parallel (different paths, no contention).
   - Copy untracked files into worktrees in parallel (different destinations).

3. **The optimized flow:**
   ```
   [sequential] git worktree add ×N (one at a time)
   [parallel]   copy untracked files to each worktree
   [once]       snapshotFiles(mainCwd) → shared snapshot
   [parallel]   backupFiles for each agent (using shared snapshot)
   ```

4. **Retry on git lock errors** — if serialization is deemed too slow, implement retry with 100ms backoff on lock contention errors (match pattern `Unable to create.*lock.*File exists`). Maximum 3 retries.

---

## Cross-Cutting Concerns

### Ordering Invariants That Must Be Preserved

Regardless of which optimizations are implemented, these ordering constraints are **inviolable**:

1. **Snapshot BEFORE agent start** — `snapshotFiles(mainCwd)` must complete before any agent begins execution. This is the escape detection baseline.

2. **Agent completes BEFORE validation** — `validateAndApply()` must not run until the agent process has fully exited and its worktree changes are finalized.

3. **All validations BEFORE any apply** — within `validateAndApply()`, ALL syntax checks must pass before ANY file is copied from worktree to mainCwd. The current code does this correctly (lines 274-308 check errors before lines 310-335 apply).

4. **Backup BEFORE agent start** — `backupFiles()` must complete before the agent runs. If the agent escapes and corrupts mainCwd, the backup must contain the pre-corruption state.

5. **Verification AFTER all agents complete** — `verify()` runs `git diff` to cross-check worker claims. All workers must have their changes applied (or rolled back) before verification.

### Testing Requirements for Any Optimization

Any optimization merged must include tests for:

1. **Escape detection still works** — agent modifies mainCwd directly, detection catches it, rollback succeeds
2. **Syntax validation still rejects invalid code** — agent produces syntactically invalid JS/Python, validation catches it, changes are not applied
3. **Parallel agent isolation** — two agents with overlapping file scopes, conflict is detected and handled
4. **Backup integrity** — after rollback, mainCwd files match their pre-agent state byte-for-byte
5. **Timeout behavior** — agent exceeds timeout, cleanup still runs, no orphaned worktrees

---

## Implementation Priority (Safe optimizations first)

### Phase 1 — Zero-risk improvements (implement immediately)
1. **BN-.21** — Buffer.concat deduplication (mechanical refactor)
2. **BN-.23** — Deduplicate git ls-files (read-only dedup)
3. **BN-.26** — Defer cleanOldRuns (background best-effort cleanup)
4. **BN-.22** — Delta env vars (cached base env)

### Phase 2 — Safe with care
5. **BN-.18** — async execFile (drop-in with `await`, lint for missing awaits)
6. **BN-.17** — Parallelize prepareWorktree internals (respect dependency graph)

### Phase 3 — Requires mitigations
7. **BN-.19** — Batch git diffs (the `--name-status` part only)
8. **BN-.25** — Parallel syntax validation (parallelize `node --check`, NOT acorn replacement)
9. **BN-.24** — Async fs with concurrency pool (needs fd limit, ordering tests)
10. **BN-.16** — xxHash replacement (hash algo swap is fine; mtime fast-path needs careful guards)
11. **BN-.27** — Pipeline worktree setup (serialize git commands, parallelize file ops)

### Phase 4 — Blocked
12. **BN-.20** — Hard links for backup (**DO NOT IMPLEMENT** — breaks rollback integrity)

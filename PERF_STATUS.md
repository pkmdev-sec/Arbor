# Performance Optimizations — Status Report

Verified: 2026-03-10 | Commit: `8690c7b` | All syntax checks: PASS
Convergence-verified: 2026-03-10 | All 10 optimizations independently confirmed correct

## Summary

| # | ID | Optimization | File | Status |
|---|------|---------------------------------------|-------------------------------|--------|
| 1 | S1 | Buffer.concat stderr ONCE after retry | agent-entry.mjs:629-630 | DONE |
| 2 | S2 | Delta-only env (no spread + delete) | agent-entry.mjs:287-298 | DONE |
| 3 | S3 | git ls-files computed once, shared | swarm.mjs:172-191 | DONE |
| 4 | S4 | cleanOldRuns deferred via setTimeout | swarm.mjs:133 | DONE |
| 5 | R1 | snapshotFiles caching + mtime filter | isolation.mjs:25-128 | DONE |
| 6 | R2 | prepareWorktree serial git + parallel | isolation.mjs:231-300, orchestration.mjs:135-157 | DONE |
| 7 | R4 | Syntax validation parallelized | isolation.mjs:399-422 | DONE |
| 8 | R5 | Async fs with concurrency pool (50) | isolation.mjs:151-224 | DONE |
| 9 | R6 | validateAndApply parallel syntax | orchestration.mjs:208-209 | DONE |
| 10 | R3 | Parallel git queries in validateAndApply | isolation.mjs:330-335 | DONE |

**10/10 optimizations implemented and verified.**

## Detail

### S1 — Buffer.concat stderr ONCE after retry loop
- `agent-entry.mjs:630`: `const stderrFull = Buffer.concat(stderrChunks).toString("utf-8")`
- Only in-loop usage is a 2KB tail for error classification (line 582) — intentional and minimal

### S2 — Delta-only env (no spread + V8 delete deopt)
- `agent-entry.mjs:295`: `Object.create(null)` + single-pass filter via `ENV_DELETES` Set
- Better than `Object.create(process.env)` — spawn needs own-property enumeration

### S3 — git ls-files computed once, passed to decompose + scout
- `swarm.mjs:175`: `projectTree` computed once
- Passed to both `decompose()` and `scoutProject()` via `Promise.all` (line 187-190)
- Both functions accept `projectTree` parameter and skip re-computation when provided

### S4 — cleanOldRuns deferred with setTimeout
- `swarm.mjs:133`: `setTimeout(() => cleanOldRuns(SWARM_BASE), 100)`
- Allows actual work to start before cleanup I/O

### R1 — snapshotFiles caching
- Module-scope cache: `_snapshotCache` (isolation.mjs:28)
- `getCachedSnapshot()` / `cacheSnapshotAsync()` / `invalidateSnapshotCache()`
- `snapshotFilesFiltered()` with mtime+size pre-filter for escape detection
- Cache invalidated when `validateAndApply` applies files (line 481-483)

### R2 — prepareWorktree split: serial git + parallel setup
- Phase A: `prepareWorktreeGit()` — serial (git worktree lock)
- Phase B: `prepareWorktreeSnapshot()` — async (snapshot + backup)
- `executeParallel()`: worktrees created in sequence, then snapshot once + backups in parallel via `Promise.all`

### R4 — Syntax validation parallelized
- All validatable files collected into `allChangedFiles` array
- Each file spawns `execFileAsync("node", ["--check", ...])` or `python3 -c "py_compile..."`
- All resolved with `Promise.all(validationPromises)`

### R5 — Async fs with concurrency pool
- `asyncPool(limit, items, fn)` — generic concurrent executor with POOL_LIMIT=50
- `snapshotFilesAsync()` — sync walk + async read/hash with pool
- `backupFilesAsync()` — async copy with pool
- Used by `cacheSnapshotAsync()` and `prepareWorktreeSnapshot()`

### R6 — validateAndApply syntax checking parallel
- Outer agent loop in `executeParallel()` stays sequential (deterministic merge order)
- Inner syntax validation within each `validateAndApply()` call uses R4's parallel Promise.all

### R3 — Parallel git queries in validateAndApply (bonus)
- 4 independent git queries (`diff --name-only`, `--diff-filter=D`, `--diff-filter=A`, `ls-files --others`) run via `Promise.all` (isolation.mjs:330-335)

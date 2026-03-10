/**
 * Worktree isolation — snapshot, backup, validate, apply, rollback
 *
 * Extracted from swarm.mjs.pre-refactor:
 *   - snapshotFiles()      lines ~603-631
 *   - backupFiles()        lines ~638-652
 *   - prepareWorktree()    lines ~659-713
 *   - validateAndApply()   lines ~734-921
 *   - cleanupIsolation()   lines ~926-937
 *
 * Each agent gets an isolated git worktree. After it exits, changes are
 * validated (syntax check) and either applied to mainCwd or rolled back.
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, rmSync, symlinkSync } from "node:fs";
import { readFile, stat, copyFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { colors, log } from "./output.mjs";
import { DEFAULT_EXCLUDES, BACKUP_EXTENSIONS } from "./config.mjs";

// ── R1: Module-scope snapshot cache ──────────────────────────────
// Cache the mainCwd snapshot once per swarm run. Invalidated when
// validateAndApply successfully applies files (mainCwd changed).
let _snapshotCache = { dir: null, snapshot: null };

/** Cache a snapshot for later retrieval. Returns the snapshot. */
export function cacheSnapshot(dir, excludePatterns = DEFAULT_EXCLUDES) {
  _snapshotCache = { dir, snapshot: snapshotFiles(dir, excludePatterns) };
  return _snapshotCache.snapshot;
}

/** R5: Async version of cacheSnapshot — uses async I/O with concurrency pool. */
export async function cacheSnapshotAsync(dir, excludePatterns = DEFAULT_EXCLUDES) {
  const snapshot = await snapshotFilesAsync(dir, excludePatterns);
  _snapshotCache = { dir, snapshot };
  return snapshot;
}

/** Get cached snapshot if dir matches, otherwise null. */
export function getCachedSnapshot(dir) {
  return (_snapshotCache.dir === dir) ? _snapshotCache.snapshot : null;
}

function invalidateSnapshotCache() {
  _snapshotCache = { dir: null, snapshot: null };
}

/**
 * Hash all files in a directory tree for later comparison.
 * Returns { relPath: { hash, size, mtimeMs } }
 */
export function snapshotFiles(dir, excludePatterns = DEFAULT_EXCLUDES) {
  const manifest = {};

  function walk(currentDir, relativeTo) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = fullPath.slice(relativeTo.length + 1);

        // Skip excluded patterns
        if (excludePatterns.some(p => relPath.includes(p))) continue;

        if (entry.isDirectory()) {
          walk(fullPath, relativeTo);
        } else if (entry.isFile()) {
          try {
            const content = readFileSync(fullPath);
            const hash = createHash("sha256").update(content).digest("hex");
            const st = statSync(fullPath);
            manifest[relPath] = { hash, size: content.length, mtimeMs: st.mtimeMs };
          } catch {} // Skip unreadable files
        }
      }
    } catch {} // Skip unreadable dirs
  }

  walk(dir, dir);
  return manifest;
}

/**
 * R1: Fast snapshot using mtime+size pre-filter against a previous snapshot.
 * Files whose mtime AND size match the preSnapshot reuse the cached hash.
 * Files in agentScope are ALWAYS re-hashed (never trust mtime for agent-touched files).
 */
export function snapshotFilesFiltered(dir, preSnapshot, agentScope = [], excludePatterns = DEFAULT_EXCLUDES) {
  const scopeSet = new Set(agentScope);
  const manifest = {};

  function walk(currentDir, relativeTo) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = fullPath.slice(relativeTo.length + 1);
        if (excludePatterns.some(p => relPath.includes(p))) continue;

        if (entry.isDirectory()) {
          walk(fullPath, relativeTo);
        } else if (entry.isFile()) {
          try {
            const st = statSync(fullPath);
            const pre = preSnapshot[relPath];

            // MITIGATION: Always hash files in agent's claimed scope
            if (pre && !scopeSet.has(relPath) &&
                pre.mtimeMs === st.mtimeMs && pre.size === st.size) {
              manifest[relPath] = { hash: pre.hash, size: pre.size, mtimeMs: pre.mtimeMs };
            } else {
              const content = readFileSync(fullPath);
              const hash = createHash("sha256").update(content).digest("hex");
              manifest[relPath] = { hash, size: content.length, mtimeMs: st.mtimeMs };
            }
          } catch {} // Skip unreadable files
        }
      }
    } catch {} // Skip unreadable dirs
  }

  walk(dir, dir);
  return manifest;
}

/**
 * Backup source files from mainCwd for potential rollback.
 * Only backs up files matching BACKUP_EXTENSIONS that appear in the snapshot.
 * Returns the count of backed-up files.
 */
export function backupFiles(mainCwd, backupDir, snapshot) {
  mkdirSync(backupDir, { recursive: true });
  let count = 0;
  for (const relPath of Object.keys(snapshot)) {
    if (!BACKUP_EXTENSIONS.test(relPath)) continue;
    try {
      const src = join(mainCwd, relPath);
      const dst = join(backupDir, relPath);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      count++;
    } catch {} // Skip unreadable files
  }
  return count;
}

// ── R5: Async concurrency pool ──────────────────────────────────
const POOL_LIMIT = 50;

async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = new Set();
  for (const [i, item] of items.entries()) {
    const p = fn(item, i).then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

/**
 * R5: Async snapshotFiles with concurrency-limited readFile.
 * Walks the directory tree synchronously (fast, negligible I/O) but
 * reads+hashes file contents asynchronously with a pool of 50.
 * Returns { relPath: { hash, size, mtimeMs } }
 */
export async function snapshotFilesAsync(dir, excludePatterns = DEFAULT_EXCLUDES) {
  const filePaths = [];

  function walk(currentDir, relativeTo) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = fullPath.slice(relativeTo.length + 1);
        if (excludePatterns.some(p => relPath.includes(p))) continue;
        if (entry.isDirectory()) {
          walk(fullPath, relativeTo);
        } else if (entry.isFile()) {
          filePaths.push({ fullPath, relPath });
        }
      }
    } catch {}
  }

  walk(dir, dir);

  const manifest = {};
  await asyncPool(POOL_LIMIT, filePaths, async ({ fullPath, relPath }) => {
    try {
      const [content, st] = await Promise.all([readFile(fullPath), stat(fullPath)]);
      const hash = createHash("sha256").update(content).digest("hex");
      manifest[relPath] = { hash, size: content.length, mtimeMs: st.mtimeMs };
    } catch {} // Skip unreadable files
  });
  return manifest;
}

/**
 * R5: Async backupFiles with concurrency-limited copyFile.
 * Returns the count of backed-up files.
 */
export async function backupFilesAsync(mainCwd, backupDir, snapshot) {
  await mkdir(backupDir, { recursive: true });
  const filesToBackup = Object.keys(snapshot).filter(relPath => BACKUP_EXTENSIONS.test(relPath));
  let count = 0;
  await asyncPool(POOL_LIMIT, filesToBackup, async (relPath) => {
    try {
      const src = join(mainCwd, relPath);
      const dst = join(backupDir, relPath);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      count++;
    } catch {} // Skip unreadable files
  });
  return count;
}

/**
 * R2 Phase A: Sequential git operations — worktree add + untracked copy + symlink.
 * Must be serial due to git worktree lock.
 * Returns { wtPath, copiedUntracked, backupDir } or throws on failure.
 */
export function prepareWorktreeGit(workDir, agentId, mainCwd) {
  const backupDir = join(workDir, "backups", agentId);
  const wtPath = join(workDir, "worktrees", agentId);
  mkdirSync(join(workDir, "worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "--detach"], { timeout: 10000, cwd: mainCwd });
  log(`${colors.dim}isolation: worktree created ${wtPath}${colors.reset}`);

  // Copy untracked files to worktree (preserving dir structure)
  const copiedUntracked = [];
  try {
    const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: mainCwd, encoding: "utf-8", timeout: 10000,
    }).trim();
    const untrackedFiles = untrackedOut ? untrackedOut.split("\n").filter(Boolean) : [];
    for (const f of untrackedFiles) {
      if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue;
      try {
        const src = join(mainCwd, f);
        const dst = join(wtPath, f);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        copiedUntracked.push(f);
      } catch {}
    }
    if (copiedUntracked.length > 0) {
      log(`${colors.dim}isolation: copied ${copiedUntracked.length} untracked files${colors.reset}`);
    }
  } catch {}

  // Symlink node_modules
  const nmSrc = join(mainCwd, "node_modules");
  const nmDst = join(wtPath, "node_modules");
  if (existsSync(nmSrc) && !existsSync(nmDst)) {
    try {
      symlinkSync(nmSrc, nmDst, "dir");
      log(`${colors.dim}isolation: symlinked node_modules${colors.reset}`);
    } catch {}
  }

  return { wtPath, copiedUntracked, backupDir };
}

/**
 * R2 Phase B: Snapshot + backup — pure I/O, safe to run in parallel.
 * R5: Uses async I/O with concurrency pool for the initial snapshot.
 * Returns { snapshot, backedUp }.
 */
export async function prepareWorktreeSnapshot(mainCwd, backupDir) {
  const snapshot = getCachedSnapshot(mainCwd) || await cacheSnapshotAsync(mainCwd);
  const backedUp = await backupFilesAsync(mainCwd, backupDir, snapshot);
  log(`${colors.dim}isolation: snapshot ${Object.keys(snapshot).length} files, backed up ${backedUp}${colors.reset}`);
  return { snapshot, backedUp };
}

/**
 * Create isolated workspace — git worktree for tracked + copy untracked files.
 * Returns { worktreePath, snapshot, backupDir, copiedUntracked, success }.
 * On ANY failure: returns success: false, caller uses mainCwd as fallback.
 * (Combines Phase A + Phase B for backward compatibility with single/review/pipeline modes)
 */
export async function prepareWorktree(workDir, agentId, mainCwd) {
  try {
    const { wtPath, copiedUntracked, backupDir } = prepareWorktreeGit(workDir, agentId, mainCwd);
    const { snapshot } = await prepareWorktreeSnapshot(mainCwd, backupDir);
    return { worktreePath: wtPath, snapshot, backupDir, copiedUntracked, success: true };
  } catch (err) {
    log(`${colors.yellow}isolation: unavailable (${err.message}), using parent cwd${colors.reset}`);
    return { worktreePath: null, snapshot: null, backupDir: null, copiedUntracked: [], success: false };
  }
}

/**
 * After agent exits — detect changes, validate, apply or rollback.
 *
 * Detects three categories of changes:
 *   1. Worktree changes (tracked via git diff + untracked new files)
 *   2. Modifications to copied untracked files in the worktree
 *   3. Worktree escapes (absolute-path modifications to mainCwd)
 *
 * If ANY validation fails → rollback escaped files from backup, discard worktree.
 * If all valid → apply worktree changes to mainCwd, escaped files stay in place.
 *
 * @param {string} worktreePath - Path to the agent's worktree
 * @param {string} mainCwd - Original working directory
 * @param {object} preSnapshot - Snapshot taken before agent ran
 * @param {string} backupDir - Directory with file backups for rollback
 * @param {string[]} copiedUntracked - Untracked files copied into worktree
 * @param {Set<string>} knownApplied - Files applied by prior agents (skip in escape detection)
 * @returns {{ valid, applied, escaped, rolled_back, errors }}
 */
export async function validateAndApply(worktreePath, mainCwd, preSnapshot, backupDir, copiedUntracked = [], knownApplied = new Set(), agentScope = [], mergedFiles = new Map(), unresolvedConflicts = new Set()) {
  const applied = [];
  const escaped = [];
  const rolled_back = [];
  const errors = [];

  try {
    // ── 1. DETECT WORKTREE CHANGES (tracked files) ──────────────
    // R3: Run all 4 git queries in parallel (independent, no dependency)
    const [diffResult, delResult, addResult, untrackedResult] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only"], { cwd: worktreePath, encoding: "utf-8", timeout: 10000 }).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["diff", "--name-only", "--diff-filter=D"], { cwd: worktreePath, encoding: "utf-8", timeout: 10000 }).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["diff", "--name-only", "--diff-filter=A"], { cwd: worktreePath, encoding: "utf-8", timeout: 10000 }).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath, encoding: "utf-8", timeout: 10000 }).catch(() => ({ stdout: "" })),
    ]);

    const worktreeChanged = diffResult.stdout.trim() ? diffResult.stdout.trim().split("\n").filter(Boolean) : [];
    const worktreeDeleted = delResult.stdout.trim() ? delResult.stdout.trim().split("\n").filter(Boolean) : [];
    let worktreeAdded = addResult.stdout.trim() ? addResult.stdout.trim().split("\n").filter(Boolean) : [];

    // Merge in new untracked files created by the agent
    const untrackedNew = untrackedResult.stdout.trim() ? untrackedResult.stdout.trim().split("\n").filter(Boolean) : [];
    for (const f of untrackedNew) {
      if (!copiedUntracked.includes(f) && !worktreeAdded.includes(f) && !worktreeChanged.includes(f)) {
        worktreeAdded.push(f);
      }
    }

    // Detect modifications to copied untracked files
    if (copiedUntracked.length > 0 && preSnapshot) {
      for (const f of copiedUntracked) {
        try {
          const wtFile = join(worktreePath, f);
          if (!existsSync(wtFile)) continue;
          const content = readFileSync(wtFile);
          const hash = createHash("sha256").update(content).digest("hex");
          const pre = preSnapshot[f];
          if (pre && hash !== pre.hash) {
            if (!worktreeChanged.includes(f)) {
              worktreeChanged.push(f);
            }
          }
        } catch {}
      }
    }

    const worktreeFilesToCopy = [...new Set([...worktreeChanged, ...worktreeAdded])]
      .filter(f => !worktreeDeleted.includes(f));

    // ── 2. DETECT WORKTREE ESCAPES (absolute-path modifications) ──
    const escapedFiles = [];
    if (preSnapshot) {
      // R1: Use mtime pre-filter for escape detection — always re-hash agentScope files
      const postSnapshot = snapshotFilesFiltered(mainCwd, preSnapshot, agentScope);

      for (const [relPath, pre] of Object.entries(preSnapshot)) {
        if (knownApplied.has(relPath)) continue;
        const post = postSnapshot[relPath];
        if (!post) {
          escapedFiles.push({ relPath, type: "deleted" });
        } else if (post.hash !== pre.hash) {
          escapedFiles.push({ relPath, type: "modified" });
        }
      }

      for (const relPath of Object.keys(postSnapshot)) {
        if (knownApplied.has(relPath)) continue;
        if (!preSnapshot[relPath]) {
          escapedFiles.push({ relPath, type: "added" });
        }
      }
    }

    if (escapedFiles.length > 0) {
      log(`${colors.yellow}isolation: detected ${escapedFiles.length} escaped files in mainCwd${colors.reset}`);
    }

    // ── 3. VALIDATE all changed files (syntax check) ────────────
    // R4: Parallel syntax validation — collect all validatable files, run Promise.all
    const allChangedFiles = [
      ...worktreeFilesToCopy.map(f => ({ file: f, cwd: worktreePath, source: "worktree" })),
      ...escapedFiles.filter(e => e.type !== "deleted").map(e => ({ file: e.relPath, cwd: mainCwd, source: "escaped" })),
    ];

    const validationPromises = allChangedFiles.map(({ file, cwd }) => {
      if (/\.(mjs|js|cjs)$/.test(file)) {
        return execFileAsync("node", ["--check", join(cwd, file)], { timeout: 10000 })
          .then(() => null)
          .catch(err => `${file}: ${(err.message || "validation failed").split("\n")[0]}`);
      } else if (/\.py$/.test(file)) {
        const fullPath = join(cwd, file);
        return execFileAsync("python3", ["-c", `import py_compile; py_compile.compile('${fullPath}', doraise=True)`], { timeout: 10000 })
          .then(() => null)
          .catch(err => `${file}: ${(err.message || "validation failed").split("\n")[0]}`);
      }
      return Promise.resolve(null);
    });

    const validationResults = await Promise.all(validationPromises);
    for (const err of validationResults) {
      if (err) errors.push(err);
    }

    // ── 4. IF INVALID → ROLLBACK ────────────────────────────────
    if (errors.length > 0) {
      for (const ef of escapedFiles) {
        if (ef.type === "deleted") {
          try {
            const backupPath = join(backupDir, ef.relPath);
            if (existsSync(backupPath)) {
              const dst = join(mainCwd, ef.relPath);
              mkdirSync(dirname(dst), { recursive: true });
              copyFileSync(backupPath, dst);
              rolled_back.push(ef.relPath);
            }
          } catch {}
        } else if (ef.type === "modified") {
          try {
            const backupPath = join(backupDir, ef.relPath);
            if (existsSync(backupPath)) {
              copyFileSync(backupPath, join(mainCwd, ef.relPath));
              rolled_back.push(ef.relPath);
            }
          } catch {}
        } else if (ef.type === "added") {
          try {
            unlinkSync(join(mainCwd, ef.relPath));
            rolled_back.push(ef.relPath);
          } catch {}
        }
      }
      return { valid: false, applied, escaped: escapedFiles.map(e => e.relPath), rolled_back, errors };
    }

    // ── 5. IF VALID → APPLY (sequential — maintains deterministic merge order) ──
    for (const file of worktreeFilesToCopy) {
      // Skip files with unresolved merge conflicts
      if (unresolvedConflicts.has(file)) {
        log(`${colors.red}  ✗ ${file}: skipped (unresolved merge conflict)${colors.reset}`);
        errors.push(`${file}: unresolved merge conflict — skipped`);
        continue;
      }
      try {
        const dst = join(mainCwd, file);
        mkdirSync(dirname(dst), { recursive: true });
        // Use merged version if available (conflict was resolved via three-way merge)
        if (mergedFiles.has(file)) {
          writeFileSync(dst, mergedFiles.get(file), "utf-8");
          applied.push(file);
          // Consume the merged version so it's only written once
          mergedFiles.delete(file);
        } else {
          const src = join(worktreePath, file);
          copyFileSync(src, dst);
          applied.push(file);
        }
      } catch (err) {
        errors.push(`copy ${file}: ${err.message}`);
      }
    }

    for (const file of worktreeDeleted) {
      try {
        const dst = join(mainCwd, file);
        if (existsSync(dst)) {
          unlinkSync(dst);
          applied.push(`(deleted) ${file}`);
        }
      } catch (err) {
        errors.push(`delete ${file}: ${err.message}`);
      }
    }

    // R1: Invalidate snapshot cache — mainCwd has changed
    if (applied.length > 0 || escapedFiles.length > 0) {
      invalidateSnapshotCache();
    }

    const escapedPaths = escapedFiles.map(e => e.relPath);
    return { valid: true, applied, escaped: escapedPaths, rolled_back, errors };
  } catch (err) {
    errors.push(`validateAndApply: ${err.message}`);
    return { valid: false, applied, escaped: [], rolled_back, errors };
  }
}

/**
 * Clean up worktree + backups. Silent failure — cleanup must never block.
 */
export function cleanupIsolation(worktreePath, backupDir) {
  if (worktreePath) {
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { timeout: 10000 });
    } catch {}
  }
  if (backupDir) {
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {}
  }
}

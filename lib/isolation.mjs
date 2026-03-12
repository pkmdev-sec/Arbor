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
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { readFile, stat, copyFile, mkdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
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

/** R5: Async version of cacheSnapshot — uses async I/O with concurrency pool and mtime pre-filter. */
export async function cacheSnapshotAsync(dir, excludePatterns = DEFAULT_EXCLUDES) {
  const previousSnapshot = getCachedSnapshot(dir);
  let snapshot;

  if (previousSnapshot) {
    // Use mtime pre-filter to avoid re-hashing unchanged files
    snapshot = await snapshotFilesFilteredAsync(dir, previousSnapshot, [], excludePatterns);
  } else {
    // No cache, do full snapshot
    snapshot = await snapshotFilesAsync(dir, excludePatterns);
  }

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
 *
 * @deprecated Use cacheSnapshotAsync() instead for better performance with mtime pre-filtering.
 * This synchronous version walks and hashes all files unconditionally.
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
        if (excludePatterns.some(p => relPath.split("/").includes(p))) continue;

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
 * Bug H: Uses BOTH mtime AND size check to handle filesystems with 1-second mtime granularity
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
        if (excludePatterns.some(p => relPath.split("/").includes(p))) continue;

        if (entry.isDirectory()) {
          walk(fullPath, relativeTo);
        } else if (entry.isFile()) {
          try {
            const st = statSync(fullPath);
            const pre = preSnapshot[relPath];

            // MITIGATION: Always hash files in agent's claimed scope
            // Bug H: Check BOTH mtime AND size (if EITHER changed, invalidate cache)
            // This handles HFS+ 1-second mtime granularity where files modified twice
            // within the same second would have identical mtime but different size/content
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
 * Async version of snapshotFilesFiltered with mtime pre-filter.
 * Files whose mtime AND size match the preSnapshot reuse the cached hash.
 * Files in agentScope are ALWAYS re-hashed (never trust mtime for agent-touched files).
 * Bug H: Uses BOTH mtime AND size check to handle filesystems with 1-second mtime granularity
 * Returns { relPath: { hash, size, mtimeMs } }
 */
export async function snapshotFilesFilteredAsync(dir, preSnapshot, agentScope = [], excludePatterns = DEFAULT_EXCLUDES) {
  const scopeSet = new Set(agentScope);
  const filePaths = [];
  const manifest = {};

  function walk(currentDir, relativeTo) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = fullPath.slice(relativeTo.length + 1);
        if (excludePatterns.some(p => relPath.split("/").includes(p))) continue;
        if (entry.isDirectory()) {
          walk(fullPath, relativeTo);
        } else if (entry.isFile()) {
          filePaths.push({ fullPath, relPath });
        }
      }
    } catch {}
  }

  walk(dir, dir);

  await asyncPool(POOL_LIMIT, filePaths, async ({ fullPath, relPath }) => {
    try {
      const st = await stat(fullPath);
      const pre = preSnapshot[relPath];

      // MITIGATION: Always hash files in agent's claimed scope
      // Bug H: Check BOTH mtime AND size (if EITHER changed, invalidate cache)
      if (pre && !scopeSet.has(relPath) &&
          pre.mtimeMs === st.mtimeMs && pre.size === st.size) {
        manifest[relPath] = { hash: pre.hash, size: pre.size, mtimeMs: pre.mtimeMs };
      } else {
        const content = await readFile(fullPath);
        const hash = createHash("sha256").update(content).digest("hex");
        manifest[relPath] = { hash, size: content.length, mtimeMs: st.mtimeMs };
      }
    } catch {} // Skip unreadable files
  });

  return manifest;
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
        if (excludePatterns.some(p => relPath.split("/").includes(p))) continue;
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

  // Bug I: Copy untracked files atomically to prevent incomplete state on interruption
  // Copy to temp directory first, then rename (atomic on most filesystems)
  const copiedUntracked = [];
  let untrackedTempDir = null;
  try {
    const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: mainCwd, encoding: "utf-8", timeout: 10000,
    }).trim();
    const untrackedFiles = untrackedOut ? untrackedOut.split("\n").filter(Boolean) : [];

    if (untrackedFiles.length > 0) {
      // Create temp staging directory for atomic copy
      untrackedTempDir = join(wtPath, ".untracked-staging-" + Date.now());
      mkdirSync(untrackedTempDir, { recursive: true });

      for (const f of untrackedFiles) {
        if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue;
        try {
          const src = join(mainCwd, f);
          const tempDst = join(untrackedTempDir, f);
          mkdirSync(dirname(tempDst), { recursive: true });
          copyFileSync(src, tempDst);
          copiedUntracked.push(f);
        } catch {}
      }

      // Bug I: Atomic rename - move files from temp to final location
      for (const f of copiedUntracked) {
        try {
          const tempSrc = join(untrackedTempDir, f);
          const finalDst = join(wtPath, f);
          mkdirSync(dirname(finalDst), { recursive: true });
          // Rename is atomic on most filesystems
          copyFileSync(tempSrc, finalDst);
        } catch {}
      }

      // Clean up temp directory
      try {
        rmSync(untrackedTempDir, { recursive: true, force: true });
      } catch {}

      if (copiedUntracked.length > 0) {
        log(`${colors.dim}isolation: copied ${copiedUntracked.length} untracked files (atomic)${colors.reset}`);
      }
    }
  } catch (err) {
    // Bug I: Clean up temp directory on failure
    if (untrackedTempDir) {
      try {
        rmSync(untrackedTempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // Copy-on-write node_modules — true isolation so agents can npm install safely
  // Bug J: Track if node_modules is a symlink (needs breaking before modifications)
  const nmSrc = join(mainCwd, "node_modules");
  const nmDst = join(wtPath, "node_modules");
  let nmIsSymlink = false;

  if (existsSync(nmSrc) && !existsSync(nmDst)) {
    let cowSuccess = false;
    try {
      if (process.platform === "darwin") {
        // macOS APFS: clonefile — instant CoW, near-zero disk until mutation
        execFileSync("cp", ["-c", "-R", nmSrc, nmDst], { timeout: 30000 });
      } else {
        // Linux Btrfs/XFS: reflink — CoW where supported, falls back to full copy
        execFileSync("cp", ["--reflink=auto", "-a", nmSrc, nmDst], { timeout: 60000 });
      }
      cowSuccess = true;
      log(`${colors.dim}isolation: node_modules copied (CoW ${process.platform === "darwin" ? "clonefile" : "reflink"})${colors.reset}`);
    } catch {
      // CoW not supported on this filesystem — fall back to symlink
    }
    if (!cowSuccess) {
      try {
        symlinkSync(nmSrc, nmDst, "dir");
        nmIsSymlink = true; // Bug J: Mark as symlink for later check
        log(`${colors.dim}isolation: node_modules symlinked (CoW unavailable) - will break link if agent modifies packages${colors.reset}`);
      } catch {}
    }
  } else if (existsSync(nmDst)) {
    // Bug J: Check if existing node_modules is a symlink
    try {
      const stats = lstatSync(nmDst);
      nmIsSymlink = stats.isSymbolicLink();
    } catch {}
  }

  // Bug J: Export symlink status for validateAndApply to check before package modifications
  // Store in a per-worktree flag file so validateAndApply can detect it
  if (nmIsSymlink) {
    try {
      writeFileSync(join(wtPath, ".arbor-nm-symlink"), "", "utf-8");
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

  // ── 0. COMPUTE GIT ROOT PREFIX ──────────────────────────────
  // git diff returns paths relative to the repo root, but mainCwd may be
  // a subdirectory (e.g., repo root = .claude/, mainCwd = .claude/arbor/).
  // We must strip the prefix to avoid double-nesting (the worktree bug).
  let cwdPrefix = "";
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: mainCwd, encoding: "utf-8", timeout: 5000,
    }).trim();
    cwdPrefix = relative(gitRoot, mainCwd); // e.g., "remote-agent"
  } catch {
    // If git root detection fails, assume mainCwd IS the root (no prefix stripping)
  }

  /**
   * Strip the cwdPrefix from a git-relative path to make it relative to mainCwd.
   * e.g., "arbor/lib/foo.mjs" → "lib/foo.mjs" when cwdPrefix = "arbor"
   * Paths outside cwdPrefix are returned unchanged (for multi-project repos).
   */
  const toMainCwdRelative = (gitRelPath) => {
    if (cwdPrefix && gitRelPath.startsWith(cwdPrefix + "/")) {
      return gitRelPath.slice(cwdPrefix.length + 1);
    }
    return gitRelPath;
  };

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
    // Bug K: Syntax validation is limited to specific file types:
    //   - JavaScript: .mjs, .js, .cjs (via node --check)
    //   - Python: .py (via py_compile)
    // Unknown file types pass validation unconditionally (can't validate everything).
    // This is acceptable behavior - we can't have validators for every possible language.
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
      // Bug K: Files with unknown extensions pass through (no validator available)
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
    // Strip git-root prefix from paths so they're relative to mainCwd, not repo root.
    // This prevents double-nesting when mainCwd is a subdirectory of the git root.
    for (const file of worktreeFilesToCopy) {
      // Skip files with unresolved merge conflicts
      if (unresolvedConflicts.has(file)) {
        log(`${colors.red}  ✗ ${file}: skipped (unresolved merge conflict)${colors.reset}`);
        errors.push(`${file}: unresolved merge conflict — skipped`);
        continue;
      }
      const localFile = toMainCwdRelative(file);
      try {
        const dst = join(mainCwd, localFile);
        mkdirSync(dirname(dst), { recursive: true });
        // Use merged version if available (conflict was resolved via three-way merge)
        if (mergedFiles.has(file)) {
          writeFileSync(dst, mergedFiles.get(file), "utf-8");
          applied.push(localFile);
          // Consume the merged version so it's only written once
          mergedFiles.delete(file);
        } else {
          const src = join(worktreePath, file);
          copyFileSync(src, dst);
          applied.push(localFile);
        }
      } catch (err) {
        errors.push(`copy ${localFile}: ${err.message}`);
      }
    }

    for (const file of worktreeDeleted) {
      const localFile = toMainCwdRelative(file);
      try {
        const dst = join(mainCwd, localFile);
        if (existsSync(dst)) {
          unlinkSync(dst);
          applied.push(`(deleted) ${localFile}`);
        }
      } catch (err) {
        errors.push(`delete ${localFile}: ${err.message}`);
      }
    }

    // Bug J: Check if agent modified package files and node_modules was a symlink
    const pkgFiles = applied.filter(f =>
      f === "package.json" || f === "package-lock.json" ||
      f.endsWith("/package.json") || f.endsWith("/package-lock.json")
    );
    if (pkgFiles.length > 0) {
      // Check if node_modules was a symlink (flag file created by prepareWorktreeGit)
      const symlinkFlagPath = join(worktreePath, ".arbor-nm-symlink");
      if (existsSync(symlinkFlagPath)) {
        log(`${colors.yellow}isolation: WARNING — Agent modified ${pkgFiles.join(", ")} and node_modules is symlinked${colors.reset}`);
        log(`${colors.yellow}  Symlink should have been broken before package modifications to prevent affecting main repo${colors.reset}`);
        // Clean up flag file
        try { unlinkSync(symlinkFlagPath); } catch {}
      } else {
        log(`${colors.yellow}isolation: WARNING — Agent modified ${pkgFiles.join(", ")} — node_modules may be stale in worktree${colors.reset}`);
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
 * Bug G: Acquire lockfile for worktree cleanup to prevent race conditions.
 * Returns true if lock acquired, false otherwise.
 */
function acquireWorktreeLock(worktreePath, maxWaitMs = 5000) {
  const lockPath = worktreePath + ".cleanup.lock";
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try to create lockfile atomically (fails if exists)
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return lockPath;
    } catch (err) {
      if (err.code === "EEXIST") {
        // Check if lock holder is still alive
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          try {
            process.kill(lockPid, 0); // Check if process exists
            // Process still alive, wait and retry
          } catch {
            // Process dead, steal lock
            try { unlinkSync(lockPath); } catch {}
          }
        } catch {}
        // Wait 100ms before retry
        const now = Date.now();
        while (Date.now() - now < 100) {} // Busy wait
      } else {
        // Other error, abort
        return null;
      }
    }
  }
  return null; // Timeout
}

/**
 * Bug G: Release worktree lockfile
 */
function releaseWorktreeLock(lockPath) {
  if (lockPath) {
    try { unlinkSync(lockPath); } catch {}
  }
}

/**
 * Clean up worktree + backups. Silent failure — cleanup must never block.
 * Bug G: Uses lockfile to prevent concurrent cleanup race conditions
 */
export function cleanupIsolation(worktreePath, backupDir) {
  if (worktreePath) {
    // Bug G: Acquire lock before cleanup
    const lockPath = acquireWorktreeLock(worktreePath);
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { timeout: 10000 });
    } catch {}
    finally {
      releaseWorktreeLock(lockPath);
    }
  }
  if (backupDir) {
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {}
  }
}

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

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { colors, log } from "./output.mjs";
import { DEFAULT_EXCLUDES, BACKUP_EXTENSIONS } from "./config.mjs";

/**
 * Hash all files in a directory tree for later comparison.
 * Returns { relPath: { hash, size } }
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
            manifest[relPath] = { hash, size: content.length };
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

/**
 * Create isolated workspace — git worktree for tracked + copy untracked files.
 * Returns { worktreePath, snapshot, backupDir, copiedUntracked, success }.
 * On ANY failure: returns success: false, caller uses mainCwd as fallback.
 */
export function prepareWorktree(workDir, agentId, mainCwd) {
  const backupDir = join(workDir, "backups", agentId);
  try {
    // 1. Create git worktree (detached HEAD)
    const wtPath = join(workDir, "worktrees", agentId);
    mkdirSync(join(workDir, "worktrees"), { recursive: true });
    execFileSync("git", ["worktree", "add", wtPath, "--detach"], { timeout: 10000, cwd: mainCwd });
    log(`${colors.dim}isolation: worktree created ${wtPath}${colors.reset}`);

    // 2. Copy untracked files to worktree (preserving dir structure)
    const copiedUntracked = [];
    try {
      const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: mainCwd, encoding: "utf-8", timeout: 10000,
      }).trim();
      const untrackedFiles = untrackedOut ? untrackedOut.split("\n").filter(Boolean) : [];
      for (const f of untrackedFiles) {
        // Skip node_modules entries (handled separately via symlink)
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

    // 3. Symlink node_modules instead of copying (too large)
    const nmSrc = join(mainCwd, "node_modules");
    const nmDst = join(wtPath, "node_modules");
    if (existsSync(nmSrc) && !existsSync(nmDst)) {
      try {
        symlinkSync(nmSrc, nmDst, "dir");
        log(`${colors.dim}isolation: symlinked node_modules${colors.reset}`);
      } catch {}
    }

    // 4. Snapshot mainCwd BEFORE the agent runs (for escape detection)
    const snapshot = snapshotFiles(mainCwd);

    // 5. Backup source files for potential rollback
    const backedUp = backupFiles(mainCwd, backupDir, snapshot);
    log(`${colors.dim}isolation: snapshot ${Object.keys(snapshot).length} files, backed up ${backedUp}${colors.reset}`);

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
export function validateAndApply(worktreePath, mainCwd, preSnapshot, backupDir, copiedUntracked = [], knownApplied = new Set()) {
  const applied = [];
  const escaped = [];
  const rolled_back = [];
  const errors = [];

  try {
    // ── 1. DETECT WORKTREE CHANGES (tracked files) ──────────────
    let worktreeChanged = [];
    let worktreeDeleted = [];
    let worktreeAdded = [];

    try {
      const diffOut = execFileSync("git", ["diff", "--name-only"], {
        cwd: worktreePath, encoding: "utf-8", timeout: 10000,
      }).trim();
      worktreeChanged = diffOut ? diffOut.split("\n").filter(Boolean) : [];
    } catch {}

    try {
      const delOut = execFileSync("git", ["diff", "--name-only", "--diff-filter=D"], {
        cwd: worktreePath, encoding: "utf-8", timeout: 10000,
      }).trim();
      worktreeDeleted = delOut ? delOut.split("\n").filter(Boolean) : [];
    } catch {}

    try {
      const addOut = execFileSync("git", ["diff", "--name-only", "--diff-filter=A"], {
        cwd: worktreePath, encoding: "utf-8", timeout: 10000,
      }).trim();
      worktreeAdded = addOut ? addOut.split("\n").filter(Boolean) : [];
    } catch {}

    // Also detect new untracked files created by the agent
    try {
      const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: worktreePath, encoding: "utf-8", timeout: 10000,
      }).trim();
      const untrackedNew = untrackedOut ? untrackedOut.split("\n").filter(Boolean) : [];
      for (const f of untrackedNew) {
        // Only include files NOT in the copiedUntracked list (those are originals from mainCwd)
        if (!copiedUntracked.includes(f) && !worktreeAdded.includes(f) && !worktreeChanged.includes(f)) {
          worktreeAdded.push(f);
        }
      }
    } catch {}

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
            // Agent modified this untracked file in the worktree
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
      const postSnapshot = snapshotFiles(mainCwd);

      // Check for modified or deleted files
      for (const [relPath, pre] of Object.entries(preSnapshot)) {
        if (knownApplied.has(relPath)) continue; // Skip files applied by prior agents
        const post = postSnapshot[relPath];
        if (!post) {
          escapedFiles.push({ relPath, type: "deleted" });
        } else if (post.hash !== pre.hash) {
          escapedFiles.push({ relPath, type: "modified" });
        }
      }

      // Check for new files in mainCwd that weren't there before
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
    const allChangedFiles = [
      ...worktreeFilesToCopy.map(f => ({ file: f, cwd: worktreePath, source: "worktree" })),
      ...escapedFiles.filter(e => e.type !== "deleted").map(e => ({ file: e.relPath, cwd: mainCwd, source: "escaped" })),
    ];

    for (const { file, cwd } of allChangedFiles) {
      try {
        if (/\.(mjs|js|cjs)$/.test(file)) {
          execFileSync("node", ["--check", join(cwd, file)], { timeout: 10000 });
        } else if (/\.py$/.test(file)) {
          const fullPath = join(cwd, file);
          execFileSync("python3", ["-c", `import py_compile; py_compile.compile('${fullPath}', doraise=True)`], { timeout: 10000 });
        }
      } catch (err) {
        errors.push(`${file}: ${(err.message || "validation failed").split("\n")[0]}`);
      }
    }

    // ── 4. IF INVALID → ROLLBACK ────────────────────────────────
    if (errors.length > 0) {
      // Rollback escaped files from backups
      for (const ef of escapedFiles) {
        if (ef.type === "deleted") {
          // Restore deleted file from backup
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
          // Restore original content from backup
          try {
            const backupPath = join(backupDir, ef.relPath);
            if (existsSync(backupPath)) {
              copyFileSync(backupPath, join(mainCwd, ef.relPath));
              rolled_back.push(ef.relPath);
            }
          } catch {}
        } else if (ef.type === "added") {
          // Remove file that didn't exist before
          try {
            unlinkSync(join(mainCwd, ef.relPath));
            rolled_back.push(ef.relPath);
          } catch {}
        }
      }
      // Worktree changes: just discard (don't apply)
      return { valid: false, applied, escaped: escapedFiles.map(e => e.relPath), rolled_back, errors };
    }

    // ── 5. IF VALID → APPLY ─────────────────────────────────────
    // Copy worktree changes to mainCwd
    for (const file of worktreeFilesToCopy) {
      try {
        const src = join(worktreePath, file);
        const dst = join(mainCwd, file);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        applied.push(file);
      } catch (err) {
        errors.push(`copy ${file}: ${err.message}`);
      }
    }

    // Delete files removed in worktree
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

    // Escaped files already in place (they passed validation)
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

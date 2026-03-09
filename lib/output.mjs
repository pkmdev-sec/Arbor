/**
 * Shared terminal output utilities
 *
 * Extracted from agent-entry.mjs (lines ~114-124, ~289-292)
 * and swarm.mjs (lines ~23-33).
 *
 * Provides TTY-aware color codes and a quiet-suppressible log function.
 */

const isTTY = process.stderr.isTTY;

export const colors = {
  bold:    isTTY ? "\x1b[1m"  : "",
  dim:     isTTY ? "\x1b[2m"  : "",
  cyan:    isTTY ? "\x1b[36m" : "",
  green:   isTTY ? "\x1b[32m" : "",
  yellow:  isTTY ? "\x1b[33m" : "",
  red:     isTTY ? "\x1b[31m" : "",
  magenta: isTTY ? "\x1b[35m" : "",
  reset:   isTTY ? "\x1b[0m"  : "",
};

let _quiet = false;
export function setQuiet(q) { _quiet = q; }
export function log(msg) { if (!_quiet) process.stderr.write(msg + "\n"); }

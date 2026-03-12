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

// Backward-compatible log function
export function log(msg) { if (!_quiet) process.stderr.write(msg + "\n"); }

// Structured log methods
export const logLevels = {
  /**
   * Log an informational message
   * @param {string} tag - Message tag
   * @param {string} msg - Message content
   */
  info(tag, msg) {
    if (!_quiet) {
      process.stderr.write(`${colors.dim}[${tag}]${colors.reset} ${msg}\n`);
    }
  },

  /**
   * Log a warning message
   * @param {string} tag - Message tag
   * @param {string} msg - Message content
   */
  warn(tag, msg) {
    if (!_quiet) {
      process.stderr.write(`${colors.yellow}[${tag}]${colors.reset} ${msg}\n`);
    }
  },

  /**
   * Log an error message
   * @param {string} tag - Message tag
   * @param {string} msg - Message content
   */
  error(tag, msg) {
    if (!_quiet) {
      process.stderr.write(`${colors.red}[${tag}]${colors.reset} ${msg}\n`);
    }
  },

  /**
   * Log a debug message (only shown if LOG_LEVEL=debug)
   * @param {string} tag - Message tag
   * @param {string} msg - Message content
   */
  debug(tag, msg) {
    if (process.env.LOG_LEVEL === 'debug' && !_quiet) {
      process.stderr.write(`${colors.dim}[${tag}]${colors.reset} ${msg}\n`);
    }
  }
};

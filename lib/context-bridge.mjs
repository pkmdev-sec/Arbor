/**
 * Context and result I/O for agent communication
 *
 * Extracted from:
 *   - contextToSystemPrompt(): agent-entry.mjs lines ~295-330
 *   - writeResult():           agent-entry.mjs lines ~333-339
 *   - readAgentResult():       swarm.mjs lines ~150-159
 */

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { colors, log } from "./output.mjs";

/**
 * Convert a structured context JSON file into a system prompt string.
 * Reads the file, extracts constraints, scope, decisions, file summaries,
 * and recently modified files into a formatted prompt.
 *
 * @param {string} contextPath - Path to the context JSON file
 * @returns {{ prompt: string|null, error: boolean }}
 */
export function contextToSystemPrompt(contextPath) {
  try {
    const raw = readFileSync(contextPath, "utf-8");
    const ctx = JSON.parse(raw);

    // Validate context is a non-null object
    if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) {
      process.stderr.write(`${colors.yellow}WARN: Context file ${contextPath} is not a valid object${colors.reset}\n`);
      return { prompt: null, error: true, message: "Invalid or missing context" };
    }

    // Warn on unexpected root keys
    const knownKeys = new Set(["task", "prior_knowledge", "project", "metadata"]);
    for (const key of Object.keys(ctx)) {
      if (!knownKeys.has(key)) {
        process.stderr.write(`${colors.dim}context-bridge: skipping unknown key "${key}"${colors.reset}\n`);
      }
    }

    const parts = [];

    if (ctx.task?.constraints?.length) {
      parts.push(`CONSTRAINTS:\n${ctx.task.constraints.map(c => `- ${c}`).join("\n")}`);
    }

    if (ctx.task?.scope?.length) {
      parts.push(`SCOPE: Focus on ${ctx.task.scope.join(", ")}`);
    }

    if (ctx.prior_knowledge?.decisions?.length) {
      parts.push(`KNOWN DECISIONS:\n${ctx.prior_knowledge.decisions.map(d => `- ${d}`).join("\n")}`);
    }

    if (ctx.prior_knowledge?.file_summaries) {
      const summaries = Object.entries(ctx.prior_knowledge.file_summaries)
        .map(([f, s]) => `- ${f}: ${s}`)
        .join("\n");
      if (summaries) parts.push(`FILE CONTEXT:\n${summaries}`);
    }

    if (ctx.project?.recent_files?.length) {
      parts.push(`RECENTLY MODIFIED: ${ctx.project.recent_files.join(", ")}`);
    }

    return { prompt: parts.length > 0 ? `[Parent Session Context]\n${parts.join("\n\n")}` : null, error: false };
  } catch (err) {
    process.stderr.write(`${colors.red}ERROR: Failed to read context file ${contextPath}: ${err.message}${colors.reset}\n`);
    return { prompt: null, error: true };
  }
}

/**
 * Write a structured result object to a JSON file.
 *
 * @param {string} resultPath - Path to write the result file
 * @param {object} data - Result data to serialize
 */
export function writeResult(resultPath, data) {
  try {
    const tmpPath = join(dirname(resultPath), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    try {
      renameSync(tmpPath, resultPath); // Atomic on POSIX
    } catch (renameErr) {
      // EXDEV: cross-device link error — fallback to copy+unlink
      if (renameErr.code === "EXDEV") {
        copyFileSync(tmpPath, resultPath);
        unlinkSync(tmpPath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    log(`${colors.red}Error writing result file: ${err.message}${colors.reset}`);
  }
}

/**
 * Read and parse an agent's result file.
 *
 * @param {string} resultFile - Path to the agent result JSON file
 * @returns {object} Parsed result or error object
 */
export function readAgentResult(resultFile) {
  try {
    if (existsSync(resultFile)) {
      return JSON.parse(readFileSync(resultFile, "utf-8"));
    }
    return { error: "Result file does not exist" };
  } catch (err) {
    return { error: `Failed to read result file: ${err.message}` };
  }
}

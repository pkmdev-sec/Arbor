/**
 * LLM-based Semantic Conflict Resolution for multi-agent orchestration
 *
 * When parallel agents in a swarm modify the same file, git 3-way merge only
 * catches textual conflicts. Semantic conflicts — contradictory intent on
 * different lines, incompatible type changes, conflicting control flow — pass
 * silently. This module uses an LLM merge agent that understands intent and
 * produces semantically correct merges.
 *
 * Architecture:
 *   1. File overlap detection (which agents touched which files)
 *   2. Structural diff classification (additive/modificative/destructive)
 *   3. Semantic conflict detection (same logical unit changed differently)
 *   4. LLM merge agent (understand intent, produce merged result)
 *   5. Post-merge verification (syntax check, dropped-change detection)
 *   6. IPC event publishing for observability
 *
 * Fallback: If the LLM merge fails for any reason (API down, bad output,
 * timeout), falls back to git 3-way merge with a warning.
 *
 * @module semantic-merge
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { aiDecision, isAiClientAvailable } from "./ai-client.mjs";
import { colors, log } from "./output.mjs";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────

/**
 * IPC topic names for merge events.
 * Consumers subscribe to these topics to observe merge progress.
 * @enum {string}
 */
export const MergeTopics = {
  /** Emitted when semantic merge begins. Payload: { files, agents } */
  STARTED: "merge.started",
  /** Emitted per-file when a semantic conflict is detected. Payload: { file, reason } */
  CONFLICT: "merge.conflict",
  /** Emitted when semantic merge completes. Payload: { metrics, overallConfidence } */
  COMPLETED: "merge.completed",
};

/**
 * Confidence levels for merge decisions
 * @enum {string}
 */
const Confidence = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

/** Binary extensions — skip semantic merge entirely */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".flac", ".ogg",
  ".sqlite", ".db", ".bin", ".dat",
  ".pyc", ".pyo", ".class", ".wasm",
]);

/** Maximum file size (bytes) for LLM merge — larger files use git fallback */
const MAX_LLM_MERGE_SIZE = 100_000; // 100KB

/** Maximum combined diff size for LLM merge prompt */
const MAX_DIFF_SIZE = 50_000; // 50KB

/** LLM merge timeout in milliseconds */
const LLM_MERGE_TIMEOUT_MS = 60_000;

// ── Structural diff classification ────────────────────────────────

/**
 * Patterns for identifying code structure elements in diffs.
 * Used for structural classification of changes.
 */
const CODE_PATTERNS = {
  // JavaScript/TypeScript
  jsFunction: /^[+-]\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  jsArrowFn: /^[+-]\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/,
  jsClass: /^[+-]\s*(?:export\s+)?class\s+(\w+)/,
  jsMethod: /^[+-]\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
  jsImport: /^[+-]\s*import\s+/,
  jsExport: /^[+-]\s*export\s+(?:default\s+)?/,

  // Python
  pyFunction: /^[+-]\s*(?:async\s+)?def\s+(\w+)/,
  pyClass: /^[+-]\s*class\s+(\w+)/,
  pyImport: /^[+-]\s*(?:import\s+|from\s+\S+\s+import\s+)/,

  // General
  constDecl: /^[+-]\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/,
  typeDecl: /^[+-]\s*(?:export\s+)?(?:type|interface)\s+(\w+)/,
};

/**
 * Change classification types
 * @typedef {'additive'|'modificative'|'destructive'} ChangeType
 */

/**
 * Classify a unified diff into structural change categories.
 *
 * Parses the diff to identify which code elements (functions, classes,
 * imports, etc.) were affected and whether changes are additive (new code),
 * modificative (changed existing), or destructive (removed code).
 *
 * @param {string} diff - Unified diff string
 * @returns {Array<{type: ChangeType, element: string, category: string}>}
 */
export function classifyChanges(diff) {
  if (!diff || typeof diff !== "string") return [];

  const classifications = [];
  const lines = diff.split("\n");

  let addedLines = 0;
  let removedLines = 0;

  for (const line of lines) {
    // Skip diff headers
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines++;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      removedLines++;
    }

    // Identify structural elements
    for (const [patternName, regex] of Object.entries(CODE_PATTERNS)) {
      const match = line.match(regex);
      if (match) {
        const isAdded = line.startsWith("+");
        const isRemoved = line.startsWith("-");
        const elementName = match[1] || patternName;

        let type;
        if (isAdded && !isRemoved) type = "additive";
        else if (isRemoved && !isAdded) type = "destructive";
        else type = "modificative";

        // Determine category from pattern name
        let category = "other";
        if (patternName.includes("Function") || patternName.includes("Method") || patternName.includes("ArrowFn")) category = "function";
        else if (patternName.includes("Class")) category = "class";
        else if (patternName.includes("Import") || patternName.includes("import")) category = "import";
        else if (patternName.includes("Export") || patternName.includes("export")) category = "export";
        else if (patternName.includes("type") || patternName.includes("Type")) category = "type";
        else if (patternName.includes("const") || patternName.includes("Decl")) category = "variable";

        classifications.push({ type, element: elementName, category });
      }
    }
  }

  // If no structural elements detected but there are changes, classify as bulk change
  if (classifications.length === 0 && (addedLines > 0 || removedLines > 0)) {
    let type;
    if (addedLines > 0 && removedLines === 0) type = "additive";
    else if (removedLines > 0 && addedLines === 0) type = "destructive";
    else type = "modificative";
    classifications.push({ type, element: "(unstructured changes)", category: "other" });
  }

  return classifications;
}

/**
 * Detect potential semantic conflicts between agent changes.
 *
 * Two agents have a semantic conflict when they modify the same logical
 * element (function, class, import, etc.) in different ways. Additive
 * changes to different elements are generally safe; modificative or
 * destructive changes to the SAME element are conflicts.
 *
 * @param {Array<{agentId: string, classifications: Array}>} agentClassifications
 * @returns {Array<{element: string, category: string, agents: string[], types: string[]}>}
 */
function detectSemanticConflicts(agentClassifications) {
  const elementMap = new Map(); // element+category → [{agentId, type}]

  for (const { agentId, classifications } of agentClassifications) {
    for (const { type, element, category } of classifications) {
      const key = `${category}:${element}`;
      if (!elementMap.has(key)) elementMap.set(key, []);
      elementMap.get(key).push({ agentId, type });
    }
  }

  const conflicts = [];
  for (const [key, entries] of elementMap) {
    // Only a conflict if 2+ agents touched the same element
    const uniqueAgents = new Set(entries.map(e => e.agentId));
    if (uniqueAgents.size < 2) continue;

    // Two additive changes to the same function = likely conflict
    // Any modificative/destructive change to same element = definite conflict
    const [category, element] = key.split(":");
    conflicts.push({
      element,
      category,
      agents: Array.from(uniqueAgents),
      types: entries.map(e => e.type),
    });
  }

  return conflicts;
}

// ── Diff computation ──────────────────────────────────────────────

/**
 * Compute a unified diff between base content and agent's modified content.
 * Uses git diff --no-index for reliable diff output.
 *
 * @param {string} baseContent - Original file content
 * @param {string} modifiedContent - Agent's modified content
 * @param {string} filename - Filename (for temp file naming)
 * @param {string} workDir - Working directory for temp files
 * @param {string} agentId - Agent identifier (for temp file naming)
 * @returns {Promise<string>} Unified diff string
 */
async function computeAgentDiff(baseContent, modifiedContent, filename, workDir, agentId) {
  const safeName = filename.replace(/\//g, "_");
  const baseTmp = join(workDir, `diff-base-${safeName}`);
  const modTmp = join(workDir, `diff-${agentId}-${safeName}`);

  try {
    writeFileSync(baseTmp, baseContent, "utf-8");
    writeFileSync(modTmp, modifiedContent, "utf-8");

    const { stdout } = await execFileAsync(
      "git", ["diff", "--no-index", "--unified=3", baseTmp, modTmp],
      { encoding: "utf-8", timeout: 10_000 }
    );
    return stdout;
  } catch (err) {
    // git diff --no-index exits 1 when files differ (normal behavior)
    if (err.code === 1 || (err.status === 1 && err.stdout)) {
      return err.stdout || "";
    }
    // Actual error
    return `(diff computation failed: ${err.message})`;
  } finally {
    safeUnlink(baseTmp);
    safeUnlink(modTmp);
  }
}

// ── LLM merge ─────────────────────────────────────────────────────

/**
 * System prompt for the LLM merge agent.
 * Instructs the model to understand intent and produce semantically correct merges.
 */
const MERGE_SYSTEM_PROMPT = [
  "You are a semantic merge agent for a multi-agent code execution system.",
  "Multiple agents worked on the same file in parallel, each making different changes.",
  "Your job is to merge their changes into a single file that correctly preserves ALL intents.",
  "",
  "## Merge Protocol",
  "1. Read the original file carefully",
  "2. Understand the INTENT behind each agent's changes (not just the text diff)",
  "3. Identify semantic conflicts: places where intents contradict each other",
  "4. Produce a merged version that satisfies ALL non-conflicting intents",
  "5. For genuine conflicts, prioritize based on the overall task goal",
  "6. NEVER silently drop a change — every agent's change must be preserved or explicitly reported as conflicting",
  "",
  "## Conflict Detection Rules",
  "- Same function modified differently by two agents → CONFLICT",
  "- Contradictory imports (one adds, another removes) → CONFLICT",
  "- Incompatible type changes → CONFLICT",
  "- Conflicting control flow (one adds early return, other adds loop) → CONFLICT",
  "- Additive changes to different parts of the file → NOT a conflict",
  "- Both agents add similar code → MERGE (keep one, note duplication)",
  "",
  "## Output Format (MANDATORY — follow EXACTLY)",
  "Respond with three clearly delimited sections:",
  "",
  "===MERGED_FILE_START===",
  "(complete file content here — every line, no omissions, no ellipsis)",
  "===MERGED_FILE_END===",
  "",
  "===CONFLICT_REPORT_START===",
  "(JSON array of conflict objects, or empty array [] if no conflicts)",
  "Each conflict: {",
  '  "location": "function name or line range",',
  '  "agent_a_intent": "what agent A was trying to do",',
  '  "agent_b_intent": "what agent B was trying to do",',
  '  "resolution": "how you resolved it",',
  '  "confidence": "high|medium|low"',
  "}",
  "===CONFLICT_REPORT_END===",
  "",
  "===OVERALL_CONFIDENCE===",
  "high|medium|low",
  "===END_CONFIDENCE===",
].join("\n");

/**
 * Build the user prompt for the LLM merge agent.
 *
 * @param {string} file - File path
 * @param {string} baseContent - Original file content
 * @param {Array<{agentId: string, diff: string, subtask: string}>} agentVersions
 * @param {string} overallTask - The swarm's overall task description
 * @param {Array} potentialConflicts - Pre-detected potential semantic conflicts
 * @returns {string} User prompt
 */
function buildMergePrompt(file, baseContent, agentVersions, overallTask, potentialConflicts) {
  const sections = [];

  sections.push(`## Overall Task\n${overallTask}`);
  sections.push(`## File: ${file}`);

  // Truncate base content if very large (keep first and last portions)
  let baseSection;
  if (baseContent.length > MAX_LLM_MERGE_SIZE) {
    const half = Math.floor(MAX_LLM_MERGE_SIZE / 2);
    baseSection = baseContent.slice(0, half) +
      `\n\n... [${baseContent.length - MAX_LLM_MERGE_SIZE} bytes truncated] ...\n\n` +
      baseContent.slice(-half);
  } else {
    baseSection = baseContent;
  }
  sections.push(`## Original File Content\n\`\`\`\n${baseSection}\n\`\`\``);

  // Agent diffs and task descriptions
  for (const av of agentVersions) {
    if (av.content === null) {
      sections.push(`## ${av.agentId} — DELETED FILE\nTask: ${av.subtask}\nThis agent deleted the file.`);
      continue;
    }

    let diffSection = av.diff;
    if (diffSection.length > MAX_DIFF_SIZE) {
      diffSection = diffSection.slice(0, MAX_DIFF_SIZE) +
        `\n... [diff truncated at ${MAX_DIFF_SIZE} bytes] ...`;
    }

    sections.push([
      `## ${av.agentId}`,
      `Task: ${av.subtask}`,
      `\`\`\`diff\n${diffSection}\n\`\`\``,
    ].join("\n"));
  }

  // Pre-detected conflicts
  if (potentialConflicts.length > 0) {
    const conflictDesc = potentialConflicts.map(c =>
      `- ${c.category} "${c.element}": modified by ${c.agents.join(", ")} (${c.types.join(", ")})`
    ).join("\n");
    sections.push(`## Pre-detected Potential Conflicts\n${conflictDesc}`);
  }

  sections.push([
    "## Instructions",
    "Merge ALL agent changes into the original file. Preserve every change unless there is a genuine semantic conflict.",
    "For conflicts, prioritize changes that better serve the overall task goal.",
    "Output the COMPLETE merged file (not a diff) using the exact format specified in your system prompt.",
  ].join("\n"));

  return sections.join("\n\n");
}

/**
 * Parse the LLM merge agent's response into structured data.
 *
 * @param {string} response - Raw LLM response text
 * @returns {{mergedContent: string|null, conflicts: Array, confidence: string}}
 */
function parseMergeResponse(response) {
  // Extract merged file content
  const fileMatch = response.match(
    /===MERGED_FILE_START===\s*\n?([\s\S]*?)\n?\s*===MERGED_FILE_END===/
  );
  const mergedContent = fileMatch ? fileMatch[1] : null;

  // Extract conflict report
  let conflicts = [];
  const reportMatch = response.match(
    /===CONFLICT_REPORT_START===\s*\n?([\s\S]*?)\n?\s*===CONFLICT_REPORT_END===/
  );
  if (reportMatch) {
    try {
      const jsonStr = reportMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        conflicts = parsed;
      }
    } catch {
      // If JSON parsing fails, try to extract array
      const arrayMatch = reportMatch[1].match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          conflicts = JSON.parse(arrayMatch[0]);
        } catch {
          // Give up on structured conflicts
        }
      }
    }
  }

  // Extract confidence
  let confidence = Confidence.MEDIUM;
  const confMatch = response.match(
    /===OVERALL_CONFIDENCE===\s*\n?\s*(high|medium|low)\s*\n?\s*===END_CONFIDENCE===/i
  );
  if (confMatch) {
    confidence = confMatch[1].toLowerCase();
  }

  return { mergedContent, conflicts, confidence };
}

/**
 * Perform LLM-based semantic merge for a single file.
 *
 * @param {object} params
 * @param {string} params.file - File path
 * @param {string} params.baseContent - Original file content
 * @param {Array} params.agentVersions - Per-agent versions with diffs and tasks
 * @param {string} params.overallTask - Overall swarm task
 * @param {Array} params.potentialConflicts - Pre-detected conflicts
 * @returns {Promise<{success: boolean, content: string, conflicts: Array, confidence: string, source: string, error?: string}>}
 */
async function llmMerge({ file, baseContent, agentVersions, overallTask, potentialConflicts }) {
  const prompt = buildMergePrompt(file, baseContent, agentVersions, overallTask, potentialConflicts);

  // Estimate token budget: base file + diffs + overhead
  const estimatedInputChars = MERGE_SYSTEM_PROMPT.length + prompt.length;

  // Calculate total diff additions size
  const totalDiffSize = agentVersions.reduce((sum, av) => sum + (av.diff?.length || 0), 0);

  // ~4 chars per token, merged output ≈ base size + diff additions + overhead
  // Raised cap from 16384 to 65536 tokens for large file support
  const estimatedOutputTokens = Math.min(65536, Math.ceil((baseContent.length + totalDiffSize) / 4) + 2048);

  const result = await Promise.race([
    aiDecision({
      model: "claude-sonnet-4-6",
      system: MERGE_SYSTEM_PROMPT,
      prompt,
      maxTokens: estimatedOutputTokens,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LLM merge timed out after ${LLM_MERGE_TIMEOUT_MS / 1000}s`)), LLM_MERGE_TIMEOUT_MS)
    ),
  ]);

  const parsed = parseMergeResponse(result.content);

  if (!parsed.mergedContent) {
    return {
      success: false,
      content: null,
      conflicts: parsed.conflicts,
      confidence: Confidence.LOW,
      source: "llm",
      error: "LLM response did not contain merged file content",
    };
  }

  // Basic sanity: merged content should not be empty if base wasn't empty
  if (baseContent.trim().length > 0 && parsed.mergedContent.trim().length === 0) {
    return {
      success: false,
      content: null,
      conflicts: parsed.conflicts,
      confidence: Confidence.LOW,
      source: "llm",
      error: "LLM produced empty merged content from non-empty base",
    };
  }

  return {
    success: true,
    content: parsed.mergedContent,
    conflicts: parsed.conflicts,
    confidence: parsed.confidence,
    source: "llm",
    latencyMs: result.latencyMs,
    usage: result.usage,
  };
}

// ── Git fallback merge ────────────────────────────────────────────

/**
 * Perform a git 3-way merge as fallback when LLM merge fails.
 * Iteratively merges each agent's version onto the base using git merge-file.
 *
 * @param {string} baseContent - Original file content
 * @param {Array<{agentId: string, content: string|null}>} agentVersions
 * @param {string} filename - File name (for temp files)
 * @param {string} workDir - Work directory for temp files
 * @returns {Promise<{success: boolean, content: string|null, conflicts: Array, confidence: string, source: string, error?: string}>}
 */
async function gitFallbackMerge(baseContent, agentVersions, filename, workDir) {
  const safeName = filename.replace(/\//g, "_");
  const versionsWithContent = agentVersions.filter(v => v.content !== null);

  if (versionsWithContent.length === 0) {
    return {
      success: false,
      content: null,
      conflicts: [],
      confidence: Confidence.LOW,
      source: "git-fallback",
      error: "No agent versions with content",
    };
  }

  if (versionsWithContent.length === 1) {
    return {
      success: true,
      content: versionsWithContent[0].content,
      conflicts: [],
      confidence: Confidence.HIGH,
      source: "git-fallback",
    };
  }

  // Iteratively merge: start with first agent's version, merge each subsequent one
  let currentMerged = versionsWithContent[0].content;
  const conflicts = [];
  const tmpPaths = [];

  for (let i = 1; i < versionsWithContent.length; i++) {
    const tmpCurrent = join(workDir, `gitmerge-current-${safeName}-${i}`);
    const tmpBase = join(workDir, `gitmerge-base-${safeName}-${i}`);
    const tmpOther = join(workDir, `gitmerge-other-${safeName}-${i}`);
    tmpPaths.push(tmpCurrent, tmpBase, tmpOther);

    try {
      writeFileSync(tmpCurrent, currentMerged, "utf-8");
      writeFileSync(tmpBase, baseContent, "utf-8");
      writeFileSync(tmpOther, versionsWithContent[i].content, "utf-8");

      // git merge-file modifies tmpCurrent in-place; exit 0 = clean merge
      execFileSync("git", ["merge-file", tmpCurrent, tmpBase, tmpOther], { timeout: 10_000 });
      currentMerged = readFileSync(tmpCurrent, "utf-8");
    } catch (err) {
      // Non-zero exit = textual conflicts in the file
      // Try reading the file anyway — it contains conflict markers
      try {
        const conflictedContent = readFileSync(tmpCurrent, "utf-8");
        // If it has conflict markers, the merge partially worked
        if (conflictedContent.includes("<<<<<<<") || conflictedContent.includes(">>>>>>>")) {
          conflicts.push({
            location: "multiple regions",
            agent_a_intent: `Changes from ${versionsWithContent[0].agentId}`,
            agent_b_intent: `Changes from ${versionsWithContent[i].agentId}`,
            resolution: "Git merge produced conflict markers — manual resolution required",
            confidence: Confidence.LOW,
          });
        }
      } catch {
        // Can't even read the result
      }

      // Clean up temp files
      for (const p of tmpPaths) safeUnlink(p);

      return {
        success: false,
        content: null,
        conflicts,
        confidence: Confidence.LOW,
        source: "git-fallback",
        error: `git merge-file conflict between ${versionsWithContent[0].agentId} and ${versionsWithContent[i].agentId}`,
      };
    }
  }

  // Clean up temp files
  for (const p of tmpPaths) safeUnlink(p);

  return {
    success: true,
    content: currentMerged,
    conflicts,
    confidence: conflicts.length > 0 ? Confidence.MEDIUM : Confidence.HIGH,
    source: "git-fallback",
  };
}

// ── Syntax validation ─────────────────────────────────────────────

/**
 * Validate that merged file content has correct syntax.
 *
 * Runs language-specific syntax checks:
 * - .mjs/.js/.cjs: node --check
 * - .py: python3 -c "import py_compile; ..."
 * - .json: JSON.parse
 * - .ts/.tsx: skipped (needs full project config)
 *
 * @param {string} filename - File name (for extension detection)
 * @param {string} content - File content to validate
 * @param {string} workDir - Work directory for temp files
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function validateSyntax(filename, content, workDir) {
  const ext = extname(filename).toLowerCase();

  // JSON: validate in-memory (no temp file needed)
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `JSON parse error: ${err.message}` };
    }
  }

  // JavaScript/MJS/CJS: node --check
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") {
    const tmpPath = join(workDir, `syntax-check-${Date.now()}${ext}`);
    try {
      writeFileSync(tmpPath, content, "utf-8");
      execFileSync("node", ["--check", tmpPath], { timeout: 10_000, stdio: "pipe" });
      return { valid: true };
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      return { valid: false, error: `Node syntax error: ${stderr.slice(0, 200)}` };
    } finally {
      safeUnlink(tmpPath);
    }
  }

  // Python: py_compile
  if (ext === ".py") {
    const tmpPath = join(workDir, `syntax-check-${Date.now()}.py`);
    try {
      writeFileSync(tmpPath, content, "utf-8");
      execFileSync("python3", ["-c", `import py_compile; py_compile.compile(r'${tmpPath}', doraise=True)`], {
        timeout: 10_000, stdio: "pipe",
      });
      return { valid: true };
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      return { valid: false, error: `Python syntax error: ${stderr.slice(0, 200)}` };
    } finally {
      safeUnlink(tmpPath);
    }
  }

  // YAML: basic check (try parsing if js-yaml available, otherwise skip)
  if (ext === ".yaml" || ext === ".yml") {
    // No built-in validator — accept as valid
    return { valid: true };
  }

  // Unknown extension — accept as valid (can't validate)
  return { valid: true };
}

// ── Dropped-change detection ──────────────────────────────────────

/**
 * Normalize a line for fuzzy comparison: collapse multiple whitespace to single space, trim.
 * @param {string} line - Line to normalize
 * @returns {string} Normalized line
 */
function normalizeLine(line) {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Compute Jaccard similarity between two strings based on whitespace-split tokens.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Jaccard coefficient (0.0 to 1.0)
 */
function jaccardSimilarity(a, b) {
  const tokensA = new Set(a.split(/\s+/).filter(t => t.length > 0));
  const tokensB = new Set(b.split(/\s+/).filter(t => t.length > 0));

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);

  return intersection.size / union.size;
}

/**
 * Check if a line has a fuzzy match in a set of lines (>80% Jaccard similarity).
 * @param {string} line - Line to check
 * @param {Array<string>} lineSet - Set of lines to search
 * @returns {boolean} True if a fuzzy match is found
 */
function hasFuzzyMatch(line, lineSet) {
  const normalizedLine = normalizeLine(line);
  const THRESHOLD = 0.8;

  for (const candidate of lineSet) {
    const normalizedCandidate = normalizeLine(candidate);
    if (jaccardSimilarity(normalizedLine, normalizedCandidate) >= THRESHOLD) {
      return true;
    }
  }

  return false;
}

/**
 * Verify that no agent's changes were silently dropped during merge.
 *
 * For each agent, computes the set of non-trivial lines they added (present
 * in their version but not in the base). Then checks what fraction of those
 * lines appear in the merged result using both exact and fuzzy matching.
 * If coverage drops below 50%, flags it.
 *
 * @param {string} baseContent - Original file content
 * @param {string} mergedContent - Merged file content
 * @param {Array<{agentId: string, content: string|null}>} agentVersions
 * @returns {{droppedChanges: Array<{agentId: string, location: string, description: string}>}}
 */
function verifyNoDroppedChanges(baseContent, mergedContent, agentVersions) {
  const droppedChanges = [];
  const baseLines = new Set(baseContent.split("\n").map(l => l.trim()).filter(l => l.length > 0));
  const mergedLinesArray = mergedContent.split("\n").filter(l => l.trim().length > 0);
  const mergedLines = new Set(mergedLinesArray.map(l => l.trim()));

  for (const av of agentVersions) {
    if (av.content === null) continue;

    const agentLines = av.content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    // Lines added by this agent (in agent version but not in base)
    const addedLines = agentLines.filter(l => !baseLines.has(l));

    if (addedLines.length === 0) continue;

    // Check how many of the agent's added lines appear in the merged result
    // First try exact match, then fuzzy match
    let preserved = 0;
    for (const line of addedLines) {
      if (mergedLines.has(line)) {
        preserved++;
      } else if (hasFuzzyMatch(line, mergedLinesArray)) {
        preserved++;
      }
    }

    const coverage = preserved / addedLines.length;

    if (coverage < 0.5) {
      droppedChanges.push({
        agentId: av.agentId,
        location: "multiple locations",
        description: `${addedLines.length - preserved} of ${addedLines.length} added lines missing from merged result (${(coverage * 100).toFixed(0)}% coverage)`,
      });
    }
  }

  return { droppedChanges };
}

// ── IPC event publishing ──────────────────────────────────────────

/**
 * Publish a merge event on the IPC message bus (if available).
 * Non-blocking, best-effort — failures are silently swallowed.
 *
 * @param {import('./ipc/message-bus.mjs').MessageBus|null} bus - IPC message bus
 * @param {string} topic - Topic name from MergeTopics
 * @param {object} payload - Event payload
 */
function publishMergeEvent(bus, topic, payload) {
  if (!bus || typeof bus.publish !== "function") return;
  try {
    bus.publish(topic, "semantic-merge", {
      ...payload,
      timestamp: Date.now(),
    });
  } catch {
    // Best-effort — merge should not fail because IPC is broken
  }
}

// ── Utility ───────────────────────────────────────────────────────

/**
 * Check if a file is binary based on its extension.
 *
 * @param {string} filename - File name or path
 * @returns {boolean}
 */
export function isBinaryFile(filename) {
  const ext = extname(filename).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Safely delete a file, ignoring errors.
 *
 * @param {string} filePath - Path to delete
 */
function safeUnlink(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore — best effort cleanup
  }
}

/**
 * Compute overall merge confidence from individual file reports.
 *
 * @param {Array} conflictReport - Array of per-file conflict reports
 * @returns {string} Overall confidence: 'high', 'medium', or 'low'
 */
function computeOverallConfidence(conflictReport) {
  if (conflictReport.length === 0) return Confidence.HIGH;

  const hasLow = conflictReport.some(r => r.confidence === Confidence.LOW);
  const hasMedium = conflictReport.some(r => r.confidence === Confidence.MEDIUM);
  const hasUnresolved = conflictReport.some(r => r.resolution === "unresolved");

  if (hasUnresolved || hasLow) return Confidence.LOW;
  if (hasMedium) return Confidence.MEDIUM;
  return Confidence.HIGH;
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Perform semantic merge for all overlapping files between parallel agents.
 *
 * This is the main entry point called from orchestration.mjs. For each file
 * modified by 2+ agents, it:
 *   1. Computes structural diffs and classifies changes
 *   2. Detects potential semantic conflicts
 *   3. Uses an LLM merge agent to produce a semantically correct merge
 *   4. Falls back to git 3-way merge if LLM fails
 *   5. Validates syntax of merged output
 *   6. Verifies no changes were silently dropped
 *   7. Publishes merge events on the IPC bus
 *
 * @param {object} params
 * @param {Map<string, string[]>} params.overlaps - Map of filename → agentId[]
 * @param {Array} params.results - Array of agent results (with isolation.worktreePath)
 * @param {string} params.mainCwd - Main working directory (base file versions)
 * @param {string} params.workDir - Swarm work directory (for temp files)
 * @param {string} params.task - Overall swarm task description
 * @param {import('./ipc/message-bus.mjs').MessageBus|null} [params.bus=null] - Optional IPC bus
 * @returns {Promise<{mergedFiles: Map<string, string>, unresolvedConflicts: Set<string>, conflictReport: Array, metrics: object, overallConfidence: string}>}
 */
export async function performSemanticMerge({ overlaps, results, mainCwd, workDir, task, bus = null }) {
  const mergedFiles = new Map();
  const unresolvedConflicts = new Set();
  const conflictReport = [];
  const metrics = {
    filesAnalyzed: 0,
    semanticConflictsDetected: 0,
    mergesAttempted: 0,
    mergesSucceeded: 0,
    mergesFailed: 0,
    llmMerges: 0,
    gitFallbacks: 0,
    syntaxValidations: 0,
    syntaxFailures: 0,
    droppedChangeWarnings: 0,
    totalLatencyMs: 0,
    llmLatencyMs: 0,
  };

  const startTime = Date.now();

  log(`\n${colors.bold}${colors.cyan}[SEMANTIC MERGE]${colors.reset} Analyzing ${overlaps.size} overlapping file(s)...`);

  // Publish merge started event
  publishMergeEvent(bus, MergeTopics.STARTED, {
    files: Array.from(overlaps.keys()),
    agents: [...new Set(Array.from(overlaps.values()).flat())],
  });

  for (const [file, agents] of overlaps) {
    metrics.filesAnalyzed++;
    log(`  ${colors.dim}${file}${colors.reset} → ${agents.join(", ")}`);

    // ── Skip binary files ──
    if (isBinaryFile(file)) {
      log(`    ${colors.dim}skipped (binary file)${colors.reset}`);
      conflictReport.push({
        file,
        agents,
        semantic_conflicts: 0,
        conflicts: [],
        resolution: "skipped",
        reason: "binary file",
        confidence: Confidence.HIGH,
      });
      continue;
    }

    // ── Get base content ──
    let baseContent;
    try {
      baseContent = readFileSync(join(mainCwd, file), "utf-8");
    } catch {
      // File didn't exist before — can't merge a new file from multiple agents
      log(`    ${colors.red}✗ no base version — cannot merge${colors.reset}`);
      conflictReport.push({
        file,
        agents,
        semantic_conflicts: 1,
        conflicts: [{
          location: "entire file",
          agent_a_intent: "Create new file",
          agent_b_intent: "Create new file",
          resolution: "Cannot merge new file created by multiple agents — needs manual review",
          confidence: Confidence.LOW,
        }],
        resolution: "unresolved",
        reason: "file did not exist in base",
        confidence: Confidence.LOW,
      });
      unresolvedConflicts.add(file);
      publishMergeEvent(bus, MergeTopics.CONFLICT, { file, reason: "new file from multiple agents" });
      continue;
    }

    // ── Collect agent versions and diffs ──
    const agentVersions = [];
    for (const agentId of agents) {
      const r = results.find(ar => ar.id === agentId);
      if (!r?.isolation?.worktreePath) continue;

      const agentPath = join(r.isolation.worktreePath, file);
      try {
        const content = readFileSync(agentPath, "utf-8");

        // Skip if agent didn't actually change the file
        if (content === baseContent) continue;

        const diff = await computeAgentDiff(baseContent, content, file, workDir, agentId);

        agentVersions.push({
          agentId,
          content,
          diff,
          subtask: r.subtask || "(unknown task)",
        });
      } catch {
        // Agent deleted the file or can't read it
        agentVersions.push({
          agentId,
          content: null,
          diff: "(file deleted or inaccessible)",
          subtask: r.subtask || "(unknown task)",
        });
      }
    }

    // Skip if fewer than 2 agents actually changed the file
    const versionsWithChanges = agentVersions.filter(v => v.content !== null);
    const deleters = agentVersions.filter(v => v.content === null);

    if (versionsWithChanges.length < 2) {
      // All agents deleted the file — unanimous deletion
      if (versionsWithChanges.length === 0 && deleters.length > 0) {
        conflictReport.push({
          file,
          agents,
          semantic_conflicts: 0,
          conflicts: [],
          resolution: "resolved",
          reason: `all ${deleters.length} agent(s) deleted the file`,
          confidence: Confidence.HIGH,
        });
        // Record null to signal deletion to the caller
        mergedFiles.set(file, null);
        log(`    ${colors.green}✓ all agents agree — file deleted${colors.reset}`);
        continue;
      }

      if (versionsWithChanges.length === 1) {
        // Only one agent actually changed it — no merge needed
        mergedFiles.set(file, versionsWithChanges[0].content);
        conflictReport.push({
          file,
          agents,
          semantic_conflicts: 0,
          conflicts: [],
          resolution: "resolved",
          reason: "only one agent made actual changes",
          confidence: Confidence.HIGH,
        });
        log(`    ${colors.green}✓ only one agent changed — no merge needed${colors.reset}`);

        // Handle modify vs delete conflict
        if (deleters.length > 0) {
          conflictReport[conflictReport.length - 1].semantic_conflicts = 1;
          conflictReport[conflictReport.length - 1].conflicts = [{
            location: "entire file",
            agent_a_intent: `Modified by ${versionsWithChanges[0].agentId}`,
            agent_b_intent: `Deleted by ${deleters[0].agentId}`,
            resolution: "Preserved modified version",
            confidence: Confidence.MEDIUM,
          }];
          conflictReport[conflictReport.length - 1].confidence = Confidence.MEDIUM;
          publishMergeEvent(bus, MergeTopics.CONFLICT, { file, reason: "modify vs delete" });
        }
      }
      continue;
    }

    // ── Classify changes structurally ──
    const agentClassifications = versionsWithChanges.map(v => ({
      agentId: v.agentId,
      classifications: classifyChanges(v.diff),
    }));

    // ── Detect potential semantic conflicts ──
    const potentialConflicts = detectSemanticConflicts(agentClassifications);
    metrics.semanticConflictsDetected += potentialConflicts.length;

    if (potentialConflicts.length > 0) {
      log(`    ${colors.yellow}⚠ ${potentialConflicts.length} potential semantic conflict(s) detected${colors.reset}`);
      for (const pc of potentialConflicts) {
        log(`      ${colors.dim}${pc.category} "${pc.element}" → ${pc.agents.join(", ")}${colors.reset}`);
      }
    }

    // ── Attempt LLM semantic merge ──
    metrics.mergesAttempted++;
    let mergeResult = null;

    if (isAiClientAvailable() && baseContent.length <= MAX_LLM_MERGE_SIZE) {
      try {
        const llmStart = Date.now();
        mergeResult = await llmMerge({
          file,
          baseContent,
          agentVersions: versionsWithChanges,
          overallTask: task,
          potentialConflicts,
        });
        metrics.llmLatencyMs += Date.now() - llmStart;

        if (mergeResult.success) {
          metrics.llmMerges++;
          log(`    ${colors.green}✓ LLM merge succeeded${colors.reset} (${mergeResult.confidence} confidence${mergeResult.latencyMs ? `, ${(mergeResult.latencyMs / 1000).toFixed(1)}s` : ""})`);
        } else {
          log(`    ${colors.yellow}⚠ LLM merge failed: ${mergeResult.error}${colors.reset}`);
        }
      } catch (err) {
        log(`    ${colors.yellow}⚠ LLM merge error: ${err.message}${colors.reset}`);
      }
    } else if (!isAiClientAvailable()) {
      log(`    ${colors.dim}LLM unavailable — using git fallback${colors.reset}`);
    } else {
      log(`    ${colors.dim}File too large for LLM (${(baseContent.length / 1024).toFixed(0)}KB) — using git fallback${colors.reset}`);
    }

    // ── Git fallback if LLM failed ──
    if (!mergeResult || !mergeResult.success) {
      metrics.gitFallbacks++;
      mergeResult = await gitFallbackMerge(baseContent, versionsWithChanges, file, workDir);

      if (mergeResult.success) {
        log(`    ${colors.green}✓ git 3-way merge succeeded (fallback)${colors.reset}`);
      } else {
        log(`    ${colors.red}✗ git 3-way merge also failed${colors.reset}`);
      }
    }

    // ── Syntax validation ──
    if (mergeResult.success) {
      metrics.syntaxValidations++;
      const validation = await validateSyntax(file, mergeResult.content, workDir);

      if (!validation.valid) {
        metrics.syntaxFailures++;
        log(`    ${colors.yellow}⚠ syntax error in merged content: ${validation.error}${colors.reset}`);

        // If LLM produced invalid syntax, try git fallback
        if (mergeResult.source === "llm") {
          metrics.gitFallbacks++;
          const fallback = await gitFallbackMerge(baseContent, versionsWithChanges, file, workDir);

          if (fallback.success) {
            const revalidation = await validateSyntax(file, fallback.content, workDir);
            if (revalidation.valid) {
              mergeResult = fallback;
              log(`    ${colors.green}✓ git fallback produced valid syntax${colors.reset}`);
            } else {
              metrics.syntaxFailures++;
              // Both failed — use LLM result anyway (more semantically correct)
              log(`    ${colors.yellow}⚠ git fallback also has syntax errors — using LLM result${colors.reset}`);
            }
          }
        }
      }
    }

    // ── Dropped-change detection ──
    if (mergeResult.success) {
      const dropCheck = verifyNoDroppedChanges(baseContent, mergeResult.content, versionsWithChanges);
      if (dropCheck.droppedChanges.length > 0) {
        metrics.droppedChangeWarnings += dropCheck.droppedChanges.length;
        for (const dropped of dropCheck.droppedChanges) {
          log(`    ${colors.yellow}⚠ possible dropped changes from ${dropped.agentId}: ${dropped.description}${colors.reset}`);
          mergeResult.conflicts = mergeResult.conflicts || [];
          mergeResult.conflicts.push({
            location: dropped.location,
            agent_a_intent: `${dropped.agentId}: changes may have been dropped`,
            agent_b_intent: dropped.description,
            resolution: "WARNING: Review recommended — possible dropped changes",
            confidence: Confidence.LOW,
          });
        }
      }
    }

    // ── Record result ──
    if (mergeResult.success) {
      metrics.mergesSucceeded++;
      mergedFiles.set(file, mergeResult.content);

      const fileConflicts = mergeResult.conflicts || [];
      conflictReport.push({
        file,
        agents,
        semantic_conflicts: fileConflicts.length,
        conflicts: fileConflicts,
        resolution: "resolved",
        source: mergeResult.source,
        confidence: mergeResult.confidence || Confidence.MEDIUM,
      });

      log(`    ${colors.green}✓ ${file}: semantic merge complete (${mergeResult.source}, ${mergeResult.confidence} confidence)${colors.reset}`);
    } else {
      metrics.mergesFailed++;
      unresolvedConflicts.add(file);

      conflictReport.push({
        file,
        agents,
        semantic_conflicts: 1,
        conflicts: [{
          location: "entire file",
          agent_a_intent: "Multiple changes",
          agent_b_intent: "Multiple changes",
          resolution: mergeResult.error || "Both LLM and git merge failed",
          confidence: Confidence.LOW,
        }],
        resolution: "unresolved",
        reason: mergeResult.error || "merge failed",
        confidence: Confidence.LOW,
      });

      log(`    ${colors.red}✗ ${file}: merge failed — flagged for manual review${colors.reset}`);
      publishMergeEvent(bus, MergeTopics.CONFLICT, { file, reason: mergeResult.error });
    }
  }

  metrics.totalLatencyMs = Date.now() - startTime;
  const overallConfidence = computeOverallConfidence(conflictReport);

  // ── Summary ──
  log(`\n${colors.bold}${colors.cyan}[SEMANTIC MERGE COMPLETE]${colors.reset}`);
  log(`  Files: ${metrics.filesAnalyzed} analyzed, ${metrics.mergesSucceeded} merged, ${metrics.mergesFailed} failed`);
  log(`  Method: ${metrics.llmMerges} LLM, ${metrics.gitFallbacks} git fallback`);
  log(`  Conflicts: ${metrics.semanticConflictsDetected} semantic conflicts detected`);
  if (metrics.droppedChangeWarnings > 0) {
    log(`  ${colors.yellow}Warnings: ${metrics.droppedChangeWarnings} possible dropped changes${colors.reset}`);
  }
  log(`  Confidence: ${overallConfidence}`);
  log(`  Duration: ${(metrics.totalLatencyMs / 1000).toFixed(1)}s${metrics.llmLatencyMs > 0 ? ` (${(metrics.llmLatencyMs / 1000).toFixed(1)}s LLM)` : ""}`);
  log("");

  // ── Publish completion ──
  publishMergeEvent(bus, MergeTopics.COMPLETED, {
    metrics,
    overallConfidence,
    filesResolved: conflictReport.filter(c => c.resolution === "resolved").length,
    filesUnresolved: conflictReport.filter(c => c.resolution === "unresolved").length,
  });

  // Flag for human review if any LOW confidence
  if (overallConfidence === Confidence.LOW) {
    log(`${colors.bold}${colors.yellow}  ⚠ LOW CONFIDENCE — human review recommended for merged files${colors.reset}\n`);
  }

  return { mergedFiles, unresolvedConflicts, conflictReport, metrics, overallConfidence };
}

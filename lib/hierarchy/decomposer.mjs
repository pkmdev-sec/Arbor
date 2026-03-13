/**
 * Hierarchical task decomposition engine
 *
 * Provides multi-level decomposition for large tasks by:
 * 1. Analyzing task scope and file structure
 * 2. Building dependency graphs from actual imports
 * 3. Finding module boundaries via graph partitioning
 * 4. Recursively decomposing into a hierarchy of sub-tasks
 * 5. Estimating agent budget requirements
 *
 * Exports:
 *   - analyzeTaskScope(task, workDir)
 *   - buildDependencyGraph(workDir, files)
 *   - findModuleBoundaries(graph)
 *   - decomposeHierarchically(task, workDir, config)
 *   - estimateAgentBudget(tree)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, relative, resolve, extname, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { aiJsonDecision, isAiClientAvailable } from "../ai-client.mjs";

// ── Optional integrations (graceful degradation) ────────────────────
let routeModel = null;
try {
  ({ routeModel } = await import("../model-router.mjs"));
} catch {}

let Premortem = null;
try {
  ({ default: Premortem } = await import("../premortem.mjs"));
} catch {}

// ── Validation helpers ───────────────────────────────────────────────

/**
 * Validate AI decomposition result structure
 * @param {*} obj - Parsed AI response
 * @returns {Object|null} Validated object or null if invalid
 */
function validateDecomposeResult(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!["split", "execute"].includes(obj.strategy)) return null;
  if (obj.strategy === "split") {
    if (!Array.isArray(obj.subtasks)) return null;
    for (const st of obj.subtasks) {
      if (!st.description || typeof st.description !== "string") return null;
      if (!Array.isArray(st.files)) return null;
    }
  }
  return obj;
}

// ── Type Definitions (JSDoc) ─────────────────────────────────────────

/**
 * @typedef {Object} TaskScope
 * @property {number} estimatedFiles - Total files in scope
 * @property {string} estimatedComplexity - "small" | "medium" | "large"
 * @property {number} recommendedDepth - Suggested hierarchy depth (1-3)
 * @property {number} recommendedFanOut - Suggested children per node (2-5)
 * @property {string[]} topLevelDirs - Top-level directories in workDir
 * @property {Object.<string, number>} filesByDir - File count per directory
 * @property {string[]} files - Raw list of all files from git ls-files or directory scan
 */

/**
 * @typedef {Object} FileNode
 * @property {string} path - Absolute file path
 * @property {string} relativePath - Path relative to workDir
 * @property {string} module - Top-level module name (first dir component)
 * @property {string[]} imports - Resolved absolute paths of imports
 * @property {string[]} importedBy - Files that import this file
 * @property {boolean} isBinary - True if file is binary/unreadable
 * @property {number} size - File size in bytes
 */

/**
 * @typedef {Object} DependencyGraph
 * @property {Map<string, FileNode>} nodes - Path → FileNode
 * @property {Map<string, Set<string>>} edges - Path → Set<imported paths>
 * @property {Set<string>} circularDeps - Set of paths involved in cycles
 * @property {string[]} entryPoints - Files not imported by others (potential roots)
 */

/**
 * @typedef {Object} ModuleBoundary
 * @property {string} name - Module name (e.g., "auth", "api")
 * @property {string[]} paths - File paths in this module
 * @property {number} fileCount - Number of files
 * @property {string} complexity - "small" | "medium" | "large"
 * @property {Object.<string, number>} crossDependencies - Module → import count
 * @property {number} internalCohesion - 0-1 score of internal imports
 * @property {boolean} isLeaf - True if should not be further decomposed
 */

/**
 * @typedef {Object} DecompositionNode
 * @property {string} id - Unique node ID
 * @property {string} type - "coordinator" | "worker"
 * @property {number} level - Tree depth (0 = root)
 * @property {string} task - Task description
 * @property {string[]} scope - File paths or directory prefixes
 * @property {string} model - "sonnet" | "opus"
 * @property {number} turns - Estimated turns needed
 * @property {number} budget - Agent budget (self + children)
 * @property {DecompositionNode[]} children - Child nodes
 * @property {string} [parent] - Parent node ID
 * @property {string} [effort] - Thinking effort level: "low", "medium", "high"
 */

/**
 * @typedef {Object} DecompositionTree
 * @property {DecompositionNode} root - Root coordinator node
 * @property {number} depth - Maximum tree depth
 * @property {number} totalNodes - Total nodes in tree
 * @property {number} leafNodes - Leaf worker count
 * @property {Object} metadata - Additional tree metadata
 */

/**
 * @typedef {Object} AgentBudgetEstimate
 * @property {number} totalAgents - Total leaf workers + coordinators
 * @property {number} workers - Leaf workers only
 * @property {number} coordinators - Non-leaf coordinators
 * @property {number} maxConcurrent - Max agents running simultaneously
 * @property {Object.<number, number>} byLevel - Agent count per level
 * @property {number} estimatedCost - Estimated USD cost
 */

// ── Constants ────────────────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".ttf", ".woff", ".woff2", ".eot", ".otf",
  ".pyc", ".pyo", ".so", ".dll", ".dylib", ".exe",
  ".db", ".sqlite", ".sqlite3"
]);

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".tsx",
  ".py", ".pyw",
  ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml"
]);

const IMPORT_PATTERNS = {
  // ESM: import foo from "bar"; import { x } from "bar"; import * as foo from "bar"
  esm: /import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // CJS: require("bar"); const foo = require("bar")
  cjs: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python: import foo; from foo import bar; from .foo import bar
  python: /(?:^|\n)(?:from\s+([.\w]+)\s+)?import\s+([\w\s,*]+)/gm,
  // Dynamic imports: import("bar")
  dynamic: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
};

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".beads", "__pycache__", ".cache",
  "dist", "build", "out", ".next", ".nuxt", "target",
  "venv", ".venv", "env", ".env", "vendor"
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - skip larger files

// ── Helper: Structured logging ───────────────────────────────────────

/**
 * Log structured JSON to stderr for monitoring
 * @param {string} component - Component name
 * @param {string} event - Event type
 * @param {Object} data - Event data
 */
function logStructured(component, event, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    component,
    event,
    ...data
  };
  console.error(JSON.stringify(logEntry));
}

// ── Helper: Check if file is binary ──────────────────────────────────

/**
 * Determine if a file is binary based on extension
 * @param {string} filePath - File path
 * @returns {boolean}
 */
function isBinaryFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Determine if a file is code we can analyze
 * @param {string} filePath - File path
 * @returns {boolean}
 */
function isCodeFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

// ── Helper: Scan directory recursively ───────────────────────────────

/**
 * Recursively scan directory for files
 * @param {string} dir - Directory to scan
 * @param {string} workDir - Base working directory
 * @param {Set<string>} ignoreSet - Directories to ignore
 * @returns {string[]} Relative file paths
 */
function scanDirectory(dir, workDir, ignoreSet = IGNORE_DIRS) {
  const results = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreSet.has(entry.name) && !entry.name.startsWith(".")) {
          results.push(...scanDirectory(fullPath, workDir, ignoreSet));
        }
      } else if (entry.isFile()) {
        try {
          const stat = statSync(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            results.push(relative(workDir, fullPath));
          }
        } catch (err) {
          logStructured("decomposer", "file_scan_error", {
            file: fullPath,
            error: err.message
          });
        }
      }
    }
  } catch (err) {
    logStructured("decomposer", "dir_scan_error", {
      dir,
      error: err.message
    });
  }

  return results;
}

// ── Helper: Extract imports from file content ────────────────────────

/**
 * Extract import statements from file content
 * @param {string} content - File content
 * @param {string} filePath - File path (for extension detection)
 * @returns {string[]} Array of import specifiers
 */
function extractImports(content, filePath) {
  const imports = new Set();
  const ext = extname(filePath).toLowerCase();

  try {
    // JavaScript/TypeScript - ESM and CJS
    if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
      // ESM imports
      let match;
      const esmPattern = new RegExp(IMPORT_PATTERNS.esm);
      while ((match = esmPattern.exec(content)) !== null) {
        imports.add(match[1]);
      }

      // CJS requires
      const cjsPattern = new RegExp(IMPORT_PATTERNS.cjs);
      while ((match = cjsPattern.exec(content)) !== null) {
        imports.add(match[1]);
      }

      // Dynamic imports
      const dynPattern = new RegExp(IMPORT_PATTERNS.dynamic);
      while ((match = dynPattern.exec(content)) !== null) {
        imports.add(match[1]);
      }
    }

    // Python imports
    if ([".py", ".pyw"].includes(ext)) {
      let match;
      const pyPattern = new RegExp(IMPORT_PATTERNS.python);
      while ((match = pyPattern.exec(content)) !== null) {
        if (match[1]) {
          // from X import Y
          imports.add(match[1]);
        } else if (match[2]) {
          // import X, Y, Z
          const modules = match[2].split(",").map(m => m.trim().split(/\s+/)[0]);
          modules.forEach(m => {
            if (m && m !== "*") imports.add(m);
          });
        }
      }
    }
  } catch (err) {
    logStructured("decomposer", "import_extraction_error", {
      file: filePath,
      error: err.message
    });
  }

  return Array.from(imports);
}

// ── Helper: Resolve import path to absolute ──────────────────────────

/**
 * Resolve an import specifier to absolute path
 * @param {string} importSpec - Import specifier (e.g., "./foo", "lodash", "../bar")
 * @param {string} fromFile - File containing the import (absolute path)
 * @param {string} workDir - Working directory
 * @param {Set<string>} allFiles - Set of all known file paths in project
 * @returns {string|null} Resolved absolute path or null
 */
function resolveImport(importSpec, fromFile, workDir, allFiles) {
  try {
    // Skip external packages (no ./ or ../)
    if (!importSpec.startsWith(".") && !importSpec.startsWith("/")) {
      return null;
    }

    const fromDir = dirname(fromFile);
    let resolved = resolve(fromDir, importSpec);

    // Try exact match first
    if (allFiles.has(resolved)) {
      return resolved;
    }

    // Try adding common extensions
    const extensions = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".json"];
    for (const ext of extensions) {
      const withExt = resolved + ext;
      if (allFiles.has(withExt)) {
        return withExt;
      }
    }

    // Try index files
    for (const ext of extensions) {
      const indexPath = join(resolved, "index" + ext);
      if (allFiles.has(indexPath)) {
        return indexPath;
      }
    }

    // Not found
    return null;
  } catch (err) {
    return null;
  }
}

// ── Helper: Detect circular dependencies ─────────────────────────────

/**
 * Detect cycles in dependency graph using 3-color DFS algorithm
 * BUG FIX G: Use proper 3-color (white/gray/black) DFS to catch indirect cycles (A→B→C→A)
 * @param {Map<string, Set<string>>} edges - Adjacency list
 * @returns {Set<string>} Set of file paths involved in cycles
 */
function detectCycles(edges) {
  // Three states: white (unvisited), gray (in-progress), black (completed)
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const colors = new Map();
  const inCycle = new Set();

  // Initialize all nodes as white
  for (const node of edges.keys()) {
    colors.set(node, WHITE);
  }

  function dfs(node) {
    if (colors.get(node) === BLACK) {
      // Already processed, no cycle through this node
      return false;
    }

    if (colors.get(node) === GRAY) {
      // Back edge detected - cycle found
      inCycle.add(node);
      return true;
    }

    // Mark as gray (in-progress)
    colors.set(node, GRAY);

    const neighbors = edges.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (dfs(neighbor)) {
        // Propagate cycle detection
        inCycle.add(node);
      }
    }

    // Mark as black (completed)
    colors.set(node, BLACK);
    return false;
  }

  // Run DFS from each white node
  for (const node of edges.keys()) {
    if (colors.get(node) === WHITE) {
      dfs(node);
    }
  }

  return inCycle;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Analyze task scope and estimate decomposition parameters
 * Uses LLM for task analysis + fs scanning for file structure
 *
 * @param {string} task - Task description
 * @param {string} workDir - Working directory path
 * @returns {Promise<TaskScope>} Scope analysis
 */
export async function analyzeTaskScope(task, workDir) {
  const startTime = Date.now();

  logStructured("decomposer", "analyze_scope_start", { workDir });

  try {
    // Scan directory structure
    let files = [];
    try {
      if (existsSync(join(workDir, ".git"))) {
        // Prefer git ls-files for git repos
        const output = execFileSync("git", ["ls-files"], {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024
        });
        files = output.split("\n").filter(Boolean);
      } else {
        // Fallback to directory scan
        files = scanDirectory(workDir, workDir);
      }
    } catch (err) {
      logStructured("decomposer", "file_listing_error", {
        error: err.message,
        fallback: "directory scan"
      });
      files = scanDirectory(workDir, workDir);
    }

    // Filter to code files only
    const codeFiles = files.filter(isCodeFile);
    const estimatedFiles = codeFiles.length;

    // Analyze directory structure
    const topLevelDirs = new Set();
    const filesByDir = {};

    for (const file of codeFiles) {
      const parts = file.split(sep);
      if (parts.length > 1) {
        const topDir = parts[0];
        topLevelDirs.add(topDir);
        filesByDir[topDir] = (filesByDir[topDir] || 0) + 1;
      }
    }

    // Estimate complexity based on file count
    let estimatedComplexity = "small";
    if (estimatedFiles > 50) {
      estimatedComplexity = "large";
    } else if (estimatedFiles > 15) {
      estimatedComplexity = "medium";
    }

    // Recommended depth based on file count and directory structure
    let recommendedDepth = 1;
    if (estimatedFiles > 30 && topLevelDirs.size > 3) {
      recommendedDepth = 2;
    }
    if (estimatedFiles > 100 && topLevelDirs.size > 5) {
      recommendedDepth = 3;
    }

    // Recommended fan-out based on top-level directory count
    let recommendedFanOut = Math.min(Math.max(2, topLevelDirs.size), 5);

    // Use LLM for deeper task analysis if available
    let isGreenfield = false;
    let targetPath = null;

    // Heuristic greenfield detection (fallback when AI is unavailable)
    // Look for creation verbs + paths that don't exist in the workspace
    const greenfieldVerbs = /\b(implement|create|build|write|scaffold|generate|set up|bootstrap|initialize|init)\b/i;
    const pathPattern = /(?:at|in|under|into)\s+(\S+\/[\w-]+\/?)/i;
    if (greenfieldVerbs.test(task)) {
      const pathMatch = task.match(pathPattern);
      if (pathMatch) {
        const candidatePath = pathMatch[1].replace(/\/$/, "");
        const absCandidate = resolve(workDir, candidatePath);
        if (!existsSync(absCandidate)) {
          // Task mentions creating something at a path that doesn't exist — greenfield
          isGreenfield = true;
          targetPath = candidatePath;
          logStructured("decomposer", "heuristic_greenfield", {
            verb: task.match(greenfieldVerbs)?.[0],
            targetPath: candidatePath
          });
        }
      }
    }

    if (isAiClientAvailable() && task.length > 20) {
      try {
        // Model routing for scope analysis
        let selectedModel = "claude-sonnet-4-6";
        if (routeModel) {
          const routing = routeModel({ type: "decomposition", fileCount: estimatedFiles, depth: 0 });
          selectedModel = routing.model;
          logStructured("decomposer", "model_routing", {
            context: "scope_analysis",
            selectedModel,
            reason: routing.reason
          });
        }

        const aiResult = await aiJsonDecision({
          model: selectedModel,
          system: [
            "You are a task complexity analyzer. Given a task description and file statistics,",
            "estimate the decomposition parameters for hierarchical agent execution.",
            "",
            "Output JSON with:",
            '- adjustedComplexity: "small" | "medium" | "large"',
            "- adjustedDepth: 1-3 (recommended tree depth)",
            "- adjustedFanOut: 2-5 (recommended children per node)",
            "- isGreenfield: boolean — true if the task is PRIMARILY about CREATING new code/files/modules",
            "  that do NOT yet exist (e.g., 'implement a new tool', 'create a CLI app', 'build a new service').",
            "  False if the task modifies, fixes, or refactors existing code.",
            "- targetPath: string or null — if the task mentions a specific target directory or path for",
            "  the new code (e.g., '/path/to/new-tool/' or 'src/new-module/'), extract it here. null otherwise.",
            "- reasoning: brief explanation of adjustments"
          ].join("\n"),
          prompt: [
            `Task: ${task.slice(0, 500)}`,
            ``,
            `File statistics:`,
            `- Total code files: ${estimatedFiles}`,
            `- Top-level directories: ${Array.from(topLevelDirs).slice(0, 10).join(", ")}`,
            `- Largest directories: ${Object.entries(filesByDir).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, c]) => `${d}(${c})`).join(", ")}`,
            ``,
            `Current estimates:`,
            `- Complexity: ${estimatedComplexity}`,
            `- Depth: ${recommendedDepth}`,
            `- Fan-out: ${recommendedFanOut}`,
            ``,
            `Adjust if needed based on task nature. Output JSON only.`
          ].join("\n"),
          maxTokens: 512
        });

        // Validate AI response structure
        const validated = aiResult.parsed && typeof aiResult.parsed === "object" ? aiResult.parsed : null;
        if (validated) {
          if (validated.adjustedComplexity && typeof validated.adjustedComplexity === "string") {
            estimatedComplexity = validated.adjustedComplexity;
          }
          if (typeof validated.adjustedDepth === "number") {
            recommendedDepth = Math.max(1, Math.min(3, validated.adjustedDepth));
          }
          if (typeof validated.adjustedFanOut === "number") {
            recommendedFanOut = Math.max(2, Math.min(5, validated.adjustedFanOut));
          }
          if (validated.isGreenfield === true) {
            isGreenfield = true;
          }
          if (validated.targetPath && typeof validated.targetPath === "string") {
            targetPath = validated.targetPath;
          }

          logStructured("decomposer", "ai_adjustment", {
            reasoning: validated.reasoning || "no reasoning provided",
            isGreenfield,
            targetPath
          });
        } else {
          logStructured("decomposer", "ai_validation_failed", {
            reason: "Invalid AI response structure in scope analysis"
          });
        }
      } catch (err) {
        logStructured("decomposer", "ai_analysis_failed", {
          error: err.message,
          fallback: "heuristic estimates"
        });
      }
    }

    const result = {
      estimatedFiles,
      estimatedComplexity,
      recommendedDepth,
      recommendedFanOut,
      topLevelDirs: Array.from(topLevelDirs),
      filesByDir,
      files, // O5: Include raw file list to avoid re-fetching in decomposeHierarchically
      isGreenfield,
      targetPath
    };

    const elapsed = Date.now() - startTime;
    logStructured("decomposer", "analyze_scope_complete", {
      ...result,
      files: undefined, // Don't log full file list (can be large)
      durationMs: elapsed
    });

    return result;

  } catch (err) {
    logStructured("decomposer", "analyze_scope_error", {
      error: err.message,
      stack: err.stack
    });

    // Return minimal safe defaults on error
    return {
      estimatedFiles: 0,
      estimatedComplexity: "small",
      recommendedDepth: 1,
      recommendedFanOut: 2,
      topLevelDirs: [],
      filesByDir: {}
    };
  }
}

/**
 * O6: Async pool pattern for concurrent file operations with concurrency limit.
 * Executes async function fn on each item with max `limit` concurrent operations.
 * @param {number} limit - Max concurrent operations
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function (item, index) => result
 * @returns {Promise<Array>} Results in order
 */
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
 * Build dependency graph from file imports
 * Reads each file, parses imports, resolves paths
 *
 * @param {string} workDir - Working directory
 * @param {string[]} files - Relative file paths to analyze
 * @returns {Promise<DependencyGraph>} Dependency graph
 */
export async function buildDependencyGraph(workDir, files) {
  const startTime = Date.now();

  logStructured("decomposer", "build_graph_start", {
    fileCount: files.length
  });

  const nodes = new Map();
  const edges = new Map();
  const allAbsolutePaths = new Set();

  try {
    // Pass 1: Create nodes and collect all file paths
    for (const relPath of files) {
      const absPath = resolve(workDir, relPath);
      allAbsolutePaths.add(absPath);

      const isBinary = isBinaryFile(absPath);
      let size = 0;

      try {
        const stat = statSync(absPath);
        size = stat.size;
      } catch (err) {
        logStructured("decomposer", "stat_error", {
          file: relPath,
          error: err.message
        });
      }

      const parts = relPath.split(sep);
      const module = parts.length > 1 ? parts[0] : "root";

      nodes.set(absPath, {
        path: absPath,
        relativePath: relPath,
        module,
        imports: [],
        importedBy: [],
        isBinary,
        size
      });

      edges.set(absPath, new Set());
    }

    // Pass 2: Extract imports and build edges
    let processedCount = 0;
    let errorCount = 0;

    for (const [absPath, node] of nodes.entries()) {
      if (node.isBinary || !isCodeFile(absPath)) {
        continue;
      }

      try {
        const content = readFileSync(absPath, "utf-8");
        const importSpecs = extractImports(content, absPath);

        for (const spec of importSpecs) {
          const resolved = resolveImport(spec, absPath, workDir, allAbsolutePaths);
          if (resolved && nodes.has(resolved)) {
            node.imports.push(resolved);
            edges.get(absPath).add(resolved);

            // Add reverse edge (importedBy)
            const targetNode = nodes.get(resolved);
            if (targetNode) {
              targetNode.importedBy.push(absPath);
            }
          }
        }

        processedCount++;
      } catch (err) {
        errorCount++;
        logStructured("decomposer", "import_parse_error", {
          file: node.relativePath,
          error: err.message
        });
      }
    }

    // Detect circular dependencies
    const circularDeps = detectCycles(edges);

    // Find entry points (not imported by anyone)
    const entryPoints = Array.from(nodes.keys()).filter(path => {
      const node = nodes.get(path);
      return node.importedBy.length === 0 && node.imports.length > 0;
    });

    const elapsed = Date.now() - startTime;
    logStructured("decomposer", "build_graph_complete", {
      totalNodes: nodes.size,
      totalEdges: Array.from(edges.values()).reduce((sum, set) => sum + set.size, 0),
      circularDeps: circularDeps.size,
      entryPoints: entryPoints.length,
      processedCount,
      errorCount,
      durationMs: elapsed
    });

    return {
      nodes,
      edges,
      circularDeps,
      entryPoints
    };

  } catch (err) {
    logStructured("decomposer", "build_graph_error", {
      error: err.message,
      stack: err.stack
    });

    // Return empty graph on catastrophic failure
    return {
      nodes: new Map(),
      edges: new Map(),
      circularDeps: new Set(),
      entryPoints: []
    };
  }
}

/**
 * Find module boundaries from dependency graph
 * Groups files by top-level directory + import density scoring
 *
 * @param {DependencyGraph} graph - Dependency graph
 * @returns {ModuleBoundary[]} Array of module boundaries
 */
export function findModuleBoundaries(graph) {
  const startTime = Date.now();

  logStructured("decomposer", "find_boundaries_start", {
    nodeCount: graph.nodes.size
  });

  try {
    // Group files by module (top-level directory)
    const moduleGroups = new Map();

    for (const node of graph.nodes.values()) {
      if (!moduleGroups.has(node.module)) {
        moduleGroups.set(node.module, []);
      }
      moduleGroups.get(node.module).push(node);
    }

    const boundaries = [];

    for (const [moduleName, moduleNodes] of moduleGroups.entries()) {
      const paths = moduleNodes.map(n => n.relativePath);
      const fileCount = moduleNodes.length;

      // Calculate internal cohesion (imports within module / total imports)
      let internalImports = 0;
      let externalImports = 0;
      const crossDeps = new Map();

      for (const node of moduleNodes) {
        for (const importPath of node.imports) {
          const importedNode = graph.nodes.get(importPath);
          if (importedNode) {
            if (importedNode.module === moduleName) {
              internalImports++;
            } else {
              externalImports++;
              const targetModule = importedNode.module;
              crossDeps.set(targetModule, (crossDeps.get(targetModule) || 0) + 1);
            }
          }
        }
      }

      const totalImports = internalImports + externalImports;
      const internalCohesion = totalImports > 0 ? internalImports / totalImports : 0;

      // Estimate complexity
      let complexity = "small";
      if (fileCount > 20) {
        complexity = "large";
      } else if (fileCount > 8) {
        complexity = "medium";
      }

      // Determine if this is a leaf (should not be further decomposed)
      const isLeaf = fileCount <= 3 || (complexity === "small" && internalCohesion > 0.8);

      boundaries.push({
        name: moduleName,
        paths,
        fileCount,
        complexity,
        crossDependencies: Object.fromEntries(crossDeps),
        internalCohesion,
        isLeaf
      });
    }

    // Sort by file count descending
    boundaries.sort((a, b) => b.fileCount - a.fileCount);

    const elapsed = Date.now() - startTime;
    logStructured("decomposer", "find_boundaries_complete", {
      boundaryCount: boundaries.length,
      leafCount: boundaries.filter(b => b.isLeaf).length,
      durationMs: elapsed
    });

    return boundaries;

  } catch (err) {
    logStructured("decomposer", "find_boundaries_error", {
      error: err.message,
      stack: err.stack
    });

    // Return empty array on error
    return [];
  }
}

/**
 * Decompose a greenfield task by logical concerns using AI
 * Instead of partitioning by existing file boundaries, asks the AI to
 * break the creation task into logical subtasks (CLI, models, parsers, etc.)
 *
 * @param {string} task - Task description
 * @param {string|null} targetPath - Target directory for new code (from scope analysis)
 * @param {Object} config - Decomposition config (maxFanOut, maxDepth, etc.)
 * @returns {Promise<DecompositionTree>} Tree with workers for each logical concern
 */
async function decomposeGreenfieldTask(task, targetPath, config) {
  const startTime = Date.now();
  logStructured("decomposer", "greenfield_decompose_start", { task: task.slice(0, 100), targetPath });

  // The scope for greenfield workers: target dir if known, otherwise "." (full workspace)
  const workerScope = targetPath ? [targetPath] : ["."];

  // Use AI to break the task into logical concerns
  let concerns = null;
  if (isAiClientAvailable()) {
    try {
      // Model routing for greenfield decomposition
      let selectedModel = "claude-sonnet-4-6";
      if (routeModel) {
        const routing = routeModel({ type: "decomposition", fileCount: 0, depth: 0 });
        selectedModel = routing.model;
        logStructured("decomposer", "model_routing", {
          context: "greenfield_decomposition",
          selectedModel,
          reason: routing.reason
        });
      }

      const aiResult = await aiJsonDecision({
        model: selectedModel,
        system: [
          "You are a task decomposition expert. Given a task that requires CREATING new code/files,",
          "break it into 2-5 logical subtasks that can be executed by independent worker agents.",
          "",
          "Each subtask should be a self-contained unit of work (e.g., 'CLI entry point and commands',",
          "'data models and types', 'file parsers', 'output generators', 'tests').",
          "",
          "Output JSON with:",
          "- concerns: array of { name: string, task: string, complexity: 'small'|'medium'|'large' }",
          "  where name is a short identifier and task is a detailed description of what to create.",
          "- reasoning: brief explanation of the decomposition"
        ].join("\n"),
        prompt: [
          `Task: ${task.slice(0, 800)}`,
          ``,
          targetPath ? `Target directory: ${targetPath}` : "No specific target directory mentioned.",
          ``,
          `Break this into 2-5 independent subtasks. Output JSON only.`
        ].join("\n"),
        maxTokens: 1024
      });

      // Validate AI response structure
      const validated = aiResult.parsed && typeof aiResult.parsed === "object" ? aiResult.parsed : null;
      if (validated && Array.isArray(validated.concerns) && validated.concerns.length > 0) {
        // Validate each concern has required fields
        const validConcerns = validated.concerns.filter(c =>
          c && typeof c === "object" &&
          typeof c.name === "string" &&
          typeof c.task === "string"
        );

        if (validConcerns.length > 0) {
          concerns = validConcerns.slice(0, config.maxFanOut || 5);
          logStructured("decomposer", "greenfield_ai_decompose", {
            concerns: concerns.map(c => c.name),
            reasoning: validated.reasoning || "no reasoning"
          });
        } else {
          logStructured("decomposer", "greenfield_validation_failed", {
            reason: "No valid concerns in AI response"
          });
        }
      }
    } catch (err) {
      logStructured("decomposer", "greenfield_ai_failed", {
        error: err.message,
        fallback: "single worker"
      });
    }
  }

  // Fallback: single worker gets the full task
  if (!concerns || concerns.length === 0) {
    const elapsed = Date.now() - startTime;
    logStructured("decomposer", "greenfield_decompose_complete", {
      mode: "single_worker",
      durationMs: elapsed
    });

    return {
      root: {
        id: "root",
        type: "worker",
        level: 0,
        task,
        scope: workerScope,
        model: "sonnet",
        turns: 30,
        budget: 1,
        effort: "high",
        children: []
      },
      depth: 0,
      totalNodes: 1,
      leafNodes: 1,
      metadata: {
        reason: "greenfield_single",
        targetPath,
        fallback: true,
        durationMs: elapsed
      }
    };
  }

  // Build tree from AI concerns
  const children = concerns.map((concern, i) => ({
    id: `L0-worker-${i + 1}`,
    type: "worker",
    level: 1,
    task: `${concern.task}\n\nThis is part of: ${task.slice(0, 200)}`,
    scope: workerScope,
    model: "sonnet",
    turns: concern.complexity === "large" ? 30 : concern.complexity === "medium" ? 20 : 15,
    budget: 1,
    effort: concern.complexity === "large" ? "high" : concern.complexity === "small" ? "low" : "medium",
    children: [],
    parent: "root"
  }));

  const elapsed = Date.now() - startTime;
  logStructured("decomposer", "greenfield_decompose_complete", {
    mode: "ai_concerns",
    concerns: concerns.length,
    durationMs: elapsed
  });

  return {
    root: {
      id: "L0-root",
      type: "coordinator",
      level: 0,
      task,
      scope: workerScope,
      model: "sonnet",
      turns: 5,
      budget: children.length + 1,
      effort: "low",
      children
    },
    depth: 1,
    totalNodes: children.length + 1,
    leafNodes: children.length,
    metadata: {
      reason: "greenfield_semantic",
      targetPath,
      concerns: concerns.map(c => c.name),
      fallback: false,
      durationMs: elapsed
    }
  };
}

/**
 * Decompose task hierarchically into tree of sub-tasks
 * Main orchestration function - uses all above helpers
 *
 * @param {string} task - Task description
 * @param {string} workDir - Working directory
 * @param {Object} config - Decomposition configuration
 * @param {number} [config.maxDepth=3] - Maximum tree depth
 * @param {number} [config.maxFanOut=5] - Maximum children per node
 * @param {number} [config.maxTotalAgents=15] - Total agent budget
 * @param {number} [config.minFilesForSplit=4] - Minimum files to warrant split
 * @param {string} [config.fallbackMode="parallel"] - Mode if hierarchy not applicable
 * @param {Object} [config.projectProfile] - Optional project profile for threshold adaptation
 * @returns {Promise<DecompositionTree>} Decomposition tree
 */
export async function decomposeHierarchically(task, workDir, config = {}) {
  const startTime = Date.now();

  // Project-aware threshold adaptation
  let adaptedConfig = null;
  if (config.projectProfile && config.projectProfile.languages) {
    const fileCount = Object.values(config.projectProfile.languages).reduce((s, n) => s + n, 0);
    adaptedConfig = {
      maxDepth: fileCount < 50 ? 2 : fileCount < 200 ? 3 : 4,
      maxFanOut: fileCount < 50 ? 3 : fileCount < 200 ? 5 : 7,
      minFilesForSplit: fileCount < 50 ? 6 : fileCount < 200 ? 4 : 3,
    };
    logStructured("decomposer", "project_profile_adaptation", {
      fileCount,
      adapted: adaptedConfig
    });
  }

  const cfg = {
    maxDepth: adaptedConfig?.maxDepth || config.maxDepth || 3,
    maxFanOut: adaptedConfig?.maxFanOut || config.maxFanOut || 5,
    maxTotalAgents: config.maxTotalAgents || 15,
    minFilesForSplit: adaptedConfig?.minFilesForSplit || config.minFilesForSplit || 4,
    fallbackMode: config.fallbackMode || "parallel",
    ...config
  };

  logStructured("decomposer", "decompose_start", {
    task: task.slice(0, 100),
    workDir,
    config: cfg
  });

  try {
    // Handle empty task edge case
    if (!task || task.trim().length === 0) {
      logStructured("decomposer", "decompose_empty_task", {});

      return {
        root: {
          id: "root",
          type: "worker",
          level: 0,
          task: "No task provided",
          scope: [],
          model: "sonnet",
          turns: 1,
          budget: 1,
          effort: "low",
          children: []
        },
        depth: 0,
        totalNodes: 1,
        leafNodes: 1,
        metadata: {
          reason: "empty_task",
          fallback: true
        }
      };
    }

    // Step 1: Analyze task scope
    const scope = await analyzeTaskScope(task, workDir);

    // Step 1b: Greenfield detection — if task is creating new code, use semantic decomposition
    // instead of file-boundary decomposition (existing boundaries are irrelevant for new code)
    if (scope.isGreenfield) {
      logStructured("decomposer", "greenfield_detected", {
        targetPath: scope.targetPath,
        existingFiles: scope.estimatedFiles
      });

      return decomposeGreenfieldTask(task, scope.targetPath, cfg);
    }

    // Handle single file edge case
    if (scope.estimatedFiles <= 1) {
      logStructured("decomposer", "decompose_single_file", {
        fileCount: scope.estimatedFiles
      });

      return {
        root: {
          id: "root",
          type: "worker",
          level: 0,
          task,
          scope: scope.topLevelDirs,
          model: "sonnet",
          turns: 10,
          budget: 1,
          effort: calculateEffort(scope.estimatedFiles),
          children: []
        },
        depth: 0,
        totalNodes: 1,
        leafNodes: 1,
        metadata: {
          reason: "single_file",
          fallback: false
        }
      };
    }

    // Step 2: Build dependency graph
    // O5: Reuse file list from analyzeTaskScope instead of re-fetching
    const files = scope.files.filter(isCodeFile);

    const graph = await buildDependencyGraph(workDir, files);

    // Step 3: Find module boundaries
    const boundaries = findModuleBoundaries(graph);

    // Handle no boundaries edge case
    if (boundaries.length === 0) {
      logStructured("decomposer", "decompose_no_boundaries", {});

      return {
        root: {
          id: "root",
          type: "worker",
          level: 0,
          task,
          scope: ["."],
          model: "sonnet",
          turns: 20,
          budget: 1,
          effort: "medium",
          children: []
        },
        depth: 0,
        totalNodes: 1,
        leafNodes: 1,
        metadata: {
          reason: "no_boundaries",
          fallback: true
        }
      };
    }

    // Step 4: Check if hierarchy is applicable
    // If all modules are leaves or too tightly coupled, fall back to flat
    const leafCount = boundaries.filter(b => b.isLeaf).length;
    const couplingDensity = boundaries.reduce((sum, b) => {
      const crossDepCount = Object.keys(b.crossDependencies).length;
      return sum + crossDepCount;
    }, 0) / boundaries.length;

    if (leafCount === boundaries.length || couplingDensity > 2.5) {
      logStructured("decomposer", "decompose_fallback_flat", {
        reason: leafCount === boundaries.length ? "all_leaves" : "high_coupling",
        leafCount,
        couplingDensity
      });

      // Return flat structure (single coordinator with worker children)
      let children = boundaries.slice(0, Math.min(cfg.maxFanOut, cfg.maxTotalAgents - 1)).map((b, i) => ({
        id: `worker-${i + 1}`,
        type: "worker",
        level: 1,
        task: `Handle ${b.name} module: ${b.paths.slice(0, 3).join(", ")}${b.paths.length > 3 ? "..." : ""}`,
        scope: b.paths,
        model: "sonnet",
        turns: b.complexity === "large" ? 30 : b.complexity === "medium" ? 20 : 10,
        budget: 1,
        effort: calculateEffort(b.fileCount),
        children: [],
        parent: "root",
        description: `Handle ${b.name} module`,
        targetFiles: b.paths
      }));

      // Premortem gate: filter out wasteful tasks
      if (Premortem) {
        const pm = new Premortem();
        const { accepted, filtered, stats } = pm.filter(children);
        if (filtered.length > 0) {
          logStructured("decomposer", "premortem_filtered", {
            context: "flat_fallback",
            filteredCount: filtered.length,
            acceptedCount: accepted.length,
            stats
          });
        }
        children = accepted;
      }

      return {
        root: {
          id: "root",
          type: "coordinator",
          level: 0,
          task,
          scope: boundaries.map(b => b.name),
          model: "sonnet",
          turns: 5,
          budget: children.length + 1,
          effort: "low",
          children
        },
        depth: 1,
        totalNodes: children.length + 1,
        leafNodes: children.length,
        metadata: {
          reason: "flat_fallback",
          fallback: true,
          boundaries: boundaries.length
        }
      };
    }

    // Step 5: Build hierarchical tree
    const tree = buildTreeRecursive(task, boundaries, 0, cfg, cfg.maxTotalAgents - 1);

    const totalNodes = countNodes(tree.root);
    const leafNodes = countLeaves(tree.root);

    const elapsed = Date.now() - startTime;
    logStructured("decomposer", "decompose_complete", {
      depth: tree.depth,
      totalNodes,
      leafNodes,
      durationMs: elapsed
    });

    return {
      ...tree,
      totalNodes,
      leafNodes,
      metadata: {
        ...tree.metadata,
        boundaries: boundaries.length,
        durationMs: elapsed
      }
    };

  } catch (err) {
    logStructured("decomposer", "decompose_error", {
      error: err.message,
      stack: err.stack
    });

    // Return safe fallback on error
    return {
      root: {
        id: "root",
        type: "worker",
        level: 0,
        task,
        scope: ["."],
        model: "sonnet",
        turns: 25,
        budget: 1,
        effort: "medium",
        children: []
      },
      depth: 0,
      totalNodes: 1,
      leafNodes: 1,
      metadata: {
        reason: "error",
        error: err.message,
        fallback: true
      }
    };
  }
}

/**
 * Build tree recursively from module boundaries
 * @private
 * @param {string} task - Task description
 * @param {ModuleBoundary[]} boundaries - Module boundaries
 * @param {number} level - Current tree level
 * @param {Object} config - Configuration
 * @param {number} remainingBudget - Remaining agent budget
 * @returns {DecompositionTree} Tree (partial, root + metadata)
 */
function buildTreeRecursive(task, boundaries, level, config, remainingBudget) {
  const maxChildren = Math.min(config.maxFanOut, remainingBudget);

  // Base case: no budget or max depth reached
  if (remainingBudget <= 0 || level >= config.maxDepth) {
    const totalFiles = boundaries.reduce((sum, b) => sum + b.fileCount, 0);
    return {
      root: {
        id: `node-${level}`,
        type: "worker",
        level,
        task,
        scope: boundaries.flatMap(b => b.paths),
        model: "sonnet",
        turns: 25,
        budget: 1,
        effort: calculateEffort(totalFiles),
        children: []
      },
      depth: level,
      metadata: {}
    };
  }

  // Separate leaves from splittable modules
  const leaves = boundaries.filter(b => b.isLeaf || b.fileCount < config.minFilesForSplit);
  const splittable = boundaries.filter(b => !b.isLeaf && b.fileCount >= config.minFilesForSplit);

  // If no splittable modules, create flat worker list
  if (splittable.length === 0) {
    let children = boundaries.slice(0, maxChildren).map((b, i) => ({
      id: `L${level}-worker-${i + 1}`,
      type: "worker",
      level: level + 1,
      task: `Handle ${b.name}: ${task.slice(0, 100)}`,
      scope: b.paths,
      model: "sonnet",
      turns: b.complexity === "large" ? 30 : b.complexity === "medium" ? 20 : 10,
      budget: 1,
      effort: calculateEffort(b.fileCount),
      children: [],
      description: `Handle ${b.name}`,
      targetFiles: b.paths
    }));

    // Premortem gate: filter out wasteful tasks
    if (Premortem) {
      const pm = new Premortem();
      const { accepted, filtered, stats } = pm.filter(children);
      if (filtered.length > 0) {
        logStructured("decomposer", "premortem_filtered", {
          context: "build_tree_flat",
          level,
          filteredCount: filtered.length,
          acceptedCount: accepted.length,
          stats
        });
      }
      children = accepted;
    }

    return {
      root: {
        id: `L${level}-root`,
        type: "coordinator",
        level,
        task,
        scope: boundaries.map(b => b.name),
        model: "sonnet",
        turns: 5,
        budget: children.length + 1,
        effort: "low",
        children
      },
      depth: level + 1,
      metadata: {}
    };
  }

  // Allocate budget across children
  const childCount = Math.min(splittable.length + leaves.length, maxChildren);
  const budgetPerChild = Math.floor(remainingBudget / childCount);

  const children = [];
  let usedBudget = 0;

  // Process splittable modules (coordinators)
  for (let i = 0; i < splittable.length && children.length < maxChildren; i++) {
    const module = splittable[i];
    const childBudget = Math.min(budgetPerChild, remainingBudget - usedBudget - 1);

    if (childBudget <= 0) break;

    // Recursively decompose this module
    const subBoundaries = [module]; // Simplified: treat each module as atomic
    const subtree = buildTreeRecursive(
      `Handle ${module.name} module`,
      subBoundaries,
      level + 1,
      config,
      childBudget
    );

    children.push({
      ...subtree.root,
      id: `L${level}-coord-${i + 1}`,
      parent: `L${level}-root`
    });

    usedBudget += countNodes(subtree.root);
  }

  // Process leaf modules (workers)
  for (let i = 0; i < leaves.length && children.length < maxChildren; i++) {
    const leaf = leaves[i];

    children.push({
      id: `L${level}-leaf-${i + 1}`,
      type: "worker",
      level: level + 1,
      task: `Handle ${leaf.name}: ${task.slice(0, 80)}`,
      scope: leaf.paths,
      model: "sonnet",
      turns: leaf.complexity === "medium" ? 20 : 10,
      budget: 1,
      effort: calculateEffort(leaf.fileCount),
      children: [],
      parent: `L${level}-root`,
      description: `Handle ${leaf.name}`,
      targetFiles: leaf.paths
    });

    usedBudget += 1;
  }

  // Premortem gate: filter assembled children
  if (Premortem && children.length > 0) {
    const pm = new Premortem();
    const { accepted, filtered, stats } = pm.filter(children);
    if (filtered.length > 0) {
      logStructured("decomposer", "premortem_filtered", {
        context: "build_tree_recursive",
        level,
        filteredCount: filtered.length,
        acceptedCount: accepted.length,
        stats
      });
      // Adjust used budget for filtered tasks
      usedBudget -= filtered.length;
    }
    children.splice(0, children.length, ...accepted);
  }

  const maxDepth = Math.max(...children.map(c => getDepth(c))) + 1;

  return {
    root: {
      id: `L${level}-root`,
      type: "coordinator",
      level,
      task,
      scope: boundaries.map(b => b.name),
      model: "sonnet",
      turns: 5,
      budget: usedBudget + 1,
      effort: "low",
      children
    },
    depth: maxDepth,
    metadata: {
      childCoordinators: children.filter(c => c.type === "coordinator").length,
      childWorkers: children.filter(c => c.type === "worker").length
    }
  };
}

/**
 * Calculate effort level based on file count
 * @private
 * @param {number} fileCount - Number of files in scope
 * @returns {string} "low" | "medium" | "high"
 */
function calculateEffort(fileCount) {
  if (fileCount < 5) return "low";
  if (fileCount <= 15) return "medium";
  return "high";
}

/**
 * Get depth of a node
 * @private
 */
function getDepth(node) {
  if (!node.children || node.children.length === 0) {
    return 0;
  }
  return 1 + Math.max(...node.children.map(getDepth));
}

/**
 * Count total nodes in tree
 * @private
 */
function countNodes(node) {
  if (!node.children || node.children.length === 0) {
    return 1;
  }
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/**
 * Count leaf nodes in tree
 * @private
 */
function countLeaves(node) {
  if (!node.children || node.children.length === 0) {
    return 1;
  }
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/**
 * Estimate agent budget from decomposition tree
 * Walks tree counting all agents + concurrent estimates
 * BUG FIX H: Include overhead for governor, sub-coordinators, and IPC bus
 *
 * @param {DecompositionTree} tree - Decomposition tree
 * @returns {AgentBudgetEstimate} Budget estimate
 */
export function estimateAgentBudget(tree) {
  try {
    const byLevel = {};
    let totalWorkers = 0;
    let totalCoordinators = 0;

    function walk(node, level) {
      byLevel[level] = (byLevel[level] || 0) + 1;

      if (node.type === "worker") {
        totalWorkers++;
      } else {
        totalCoordinators++;
      }

      if (node.children) {
        for (const child of node.children) {
          walk(child, level + 1);
        }
      }
    }

    walk(tree.root, 0);

    // BUG FIX H: Add overhead constants for infrastructure
    const GOVERNOR_OVERHEAD = 1.0;           // 1 agent-equivalent for governor
    const COORDINATOR_OVERHEAD = 0.5;        // 0.5 per coordinator
    const IPC_BUS_OVERHEAD = 0.25;           // 0.25 agent-equivalent for IPC bus

    const infrastructureOverhead = GOVERNOR_OVERHEAD
      + (totalCoordinators * COORDINATOR_OVERHEAD)
      + IPC_BUS_OVERHEAD;

    const totalAgents = totalWorkers + totalCoordinators + infrastructureOverhead;

    // Max concurrent = max agents at any single level + infrastructure overhead
    // (since levels execute sequentially in a pipeline model)
    const maxConcurrent = Math.max(...Object.values(byLevel)) + Math.ceil(infrastructureOverhead);

    // Rough cost estimate: $0.03 per agent (avg sonnet call)
    const estimatedCost = totalAgents * 0.03;

    logStructured("decomposer", "budget_estimate", {
      totalAgents,
      workers: totalWorkers,
      coordinators: totalCoordinators,
      infrastructureOverhead, // BUG FIX H: Log overhead
      maxConcurrent,
      estimatedCost,
      byLevel
    });

    return {
      totalAgents,
      workers: totalWorkers,
      coordinators: totalCoordinators,
      maxConcurrent,
      byLevel,
      estimatedCost
    };

  } catch (err) {
    logStructured("decomposer", "budget_estimate_error", {
      error: err.message
    });

    return {
      totalAgents: 1,
      workers: 1,
      coordinators: 0,
      maxConcurrent: 1,
      byLevel: { 0: 1 },
      estimatedCost: 0.03
    };
  }
}

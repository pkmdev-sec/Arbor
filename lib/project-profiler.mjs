/**
 * Project Profiler — Phase 0 (Fernis REQ-031)
 *
 * Classify the target project before any work begins.
 * Deterministic profiler (no AI calls) — fast and free.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";

// ── Constants ────────────────────────────────────────────────────

/** File extensions → language mapping */
const LANGUAGE_MAP = {
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".h": "C",
  ".hpp": "C++",
  ".rb": "Ruby",
  ".php": "PHP",
  ".sh": "Shell",
  ".bash": "Shell",
};

/** Package manager detection patterns */
const PACKAGE_MANAGERS = {
  "package.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "Cargo.toml": "cargo",
  "go.mod": "go",
  "requirements.txt": "pip",
  "Pipfile": "pip",
  "pyproject.toml": "pip",
};

/** Framework detection patterns (package.json dependencies) */
const FRAMEWORK_PATTERNS = {
  react: "React",
  vue: "Vue",
  angular: "Angular",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  next: "Next.js",
  nuxt: "Nuxt",
  svelte: "Svelte",
  nestjs: "NestJS",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
  axum: "Axum",
  actix: "Actix",
  rocket: "Rocket",
  gin: "Gin",
  echo: "Echo",
  fiber: "Fiber",
  "bubbletea": "Bubble Tea",
  "tview": "tview",
};

/** Test framework detection patterns */
const TEST_FRAMEWORKS = {
  jest: "Jest",
  vitest: "Vitest",
  mocha: "Mocha",
  ava: "AVA",
  "node:test": "Node.js Test Runner",
  pytest: "pytest",
  "cargo test": "Cargo Test",
  "go test": "Go Test",
};

// ── Type Definitions ─────────────────────────────────────────────

/**
 * @typedef {object} ProjectProfile
 * @property {string} projectType - web_app|api_service|cli_tool|library|tui|monorepo|data_pipeline|unknown
 * @property {Record<string, number>} languages - Extension → file count
 * @property {string} primaryLanguage - Most common language
 * @property {string[]} frameworks - Detected from manifests
 * @property {string[]} entryPoints - Detected main files, bin entries, cmd/ dirs
 * @property {string} testFramework - Detected test framework
 * @property {string} packageManager - npm|yarn|pnpm|cargo|go|pip|unknown
 * @property {number} estimatedComplexity - 1-10 scale based on file count and depth
 * @property {string[]} keyDirectories - Important directories (src, lib, test, etc.)
 * @property {string} decompositionStrategy - by_module|by_feature|by_layer|by_file
 */

// ── Core Profiler Functions ──────────────────────────────────────

/**
 * Profile a project directory to understand its type, languages, and architecture.
 * This is a deterministic profiler (no AI calls) — fast and free.
 *
 * @param {string} projectDir - Path to project root
 * @returns {Promise<ProjectProfile>}
 */
export async function profileProject(projectDir) {
  // Step 1: Read directory tree (top 2 levels)
  const { files, directories } = await scanDirectory(projectDir, 2);

  // Step 2: Count files by extension
  const languages = countLanguages(files);
  const primaryLanguage = getPrimaryLanguage(languages);

  // Step 3: Detect package manager
  const packageManager = detectPackageManager(files);

  // Step 4: Read manifest to extract dependencies → detect frameworks
  const frameworks = await detectFrameworks(projectDir, packageManager, files);

  // Step 5: Find entry points
  const entryPoints = await detectEntryPoints(projectDir, packageManager, files);

  // Step 6: Detect test framework
  const testFramework = detectTestFramework(files, frameworks);

  // Step 7: Classify project type
  const projectType = classifyProjectType(directories, frameworks, entryPoints, packageManager);

  // Step 8: Estimate complexity (1-10)
  const estimatedComplexity = estimateComplexity(files.length);

  // Step 9: Suggest decomposition strategy
  const decompositionStrategy = suggestDecomposition(projectType, estimatedComplexity);

  return {
    projectType,
    languages,
    primaryLanguage,
    frameworks,
    entryPoints,
    testFramework,
    packageManager,
    estimatedComplexity,
    keyDirectories: directories,
    decompositionStrategy,
  };
}

/**
 * Format profile as context for agent prompt injection.
 *
 * @param {ProjectProfile} profile
 * @returns {string}
 */
export function formatProfileForPrompt(profile) {
  const lines = [
    "PROJECT PROFILE:",
    `  Type: ${profile.projectType}`,
    `  Primary Language: ${profile.primaryLanguage}`,
    `  Package Manager: ${profile.packageManager}`,
    `  Complexity: ${profile.estimatedComplexity}/10`,
  ];

  if (profile.frameworks.length > 0) {
    lines.push(`  Frameworks: ${profile.frameworks.join(", ")}`);
  }

  if (profile.entryPoints.length > 0) {
    lines.push(`  Entry Points: ${profile.entryPoints.join(", ")}`);
  }

  if (profile.testFramework !== "unknown") {
    lines.push(`  Test Framework: ${profile.testFramework}`);
  }

  lines.push(`  Decomposition Strategy: ${profile.decompositionStrategy}`);

  return lines.join("\n");
}

// ── Helper Functions ─────────────────────────────────────────────

/**
 * Recursively scan directory up to maxDepth levels.
 *
 * @param {string} dir - Directory to scan
 * @param {number} maxDepth - Maximum depth to traverse
 * @param {number} [currentDepth=0] - Current depth (for recursion)
 * @returns {Promise<{files: string[], directories: string[]}>}
 */
async function scanDirectory(dir, maxDepth, currentDepth = 0) {
  const files = [];
  const directories = [];

  if (currentDepth > maxDepth) {
    return { files, directories };
  }

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files and common excludes
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      const relativePath = fullPath.replace(dir, "").slice(1); // Remove leading slash

      if (entry.isDirectory()) {
        directories.push(relativePath);

        // Recurse into subdirectories
        if (currentDepth < maxDepth) {
          const nested = await scanDirectory(fullPath, maxDepth, currentDepth + 1);
          files.push(...nested.files);
          directories.push(...nested.directories);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch (err) {
    // Silently skip directories we can't read
  }

  return { files, directories };
}

/**
 * Count files by language based on extension.
 *
 * @param {string[]} files - Array of file paths
 * @returns {Record<string, number>}
 */
function countLanguages(files) {
  const counts = {};

  for (const file of files) {
    const ext = extname(file);
    const language = LANGUAGE_MAP[ext];

    if (language) {
      counts[language] = (counts[language] || 0) + 1;
    }
  }

  return counts;
}

/**
 * Get primary language (most common).
 *
 * @param {Record<string, number>} languages
 * @returns {string}
 */
function getPrimaryLanguage(languages) {
  let maxCount = 0;
  let primary = "unknown";

  for (const [lang, count] of Object.entries(languages)) {
    if (count > maxCount) {
      maxCount = count;
      primary = lang;
    }
  }

  return primary;
}

/**
 * Detect package manager from manifest files.
 *
 * @param {string[]} files
 * @returns {string}
 */
function detectPackageManager(files) {
  for (const [file, manager] of Object.entries(PACKAGE_MANAGERS)) {
    if (files.includes(file)) {
      return manager;
    }
  }

  return "unknown";
}

/**
 * Detect frameworks from manifest files.
 *
 * @param {string} projectDir
 * @param {string} packageManager
 * @param {string[]} files
 * @returns {Promise<string[]>}
 */
async function detectFrameworks(projectDir, packageManager, files) {
  const frameworks = [];

  // Try package.json for JS/TS projects
  if (files.includes("package.json")) {
    try {
      const content = await readFile(join(projectDir, "package.json"), "utf-8");
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      for (const [pattern, framework] of Object.entries(FRAMEWORK_PATTERNS)) {
        if (Object.keys(deps).some(dep => dep.includes(pattern))) {
          frameworks.push(framework);
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Try Cargo.toml for Rust projects
  if (files.includes("Cargo.toml")) {
    try {
      const content = await readFile(join(projectDir, "Cargo.toml"), "utf-8");

      for (const [pattern, framework] of Object.entries(FRAMEWORK_PATTERNS)) {
        if (content.includes(pattern)) {
          frameworks.push(framework);
        }
      }
    } catch (err) {
      // Ignore read errors
    }
  }

  // Try go.mod for Go projects
  if (files.includes("go.mod")) {
    try {
      const content = await readFile(join(projectDir, "go.mod"), "utf-8");

      for (const [pattern, framework] of Object.entries(FRAMEWORK_PATTERNS)) {
        if (content.includes(pattern)) {
          frameworks.push(framework);
        }
      }
    } catch (err) {
      // Ignore read errors
    }
  }

  return frameworks;
}

/**
 * Detect entry points from manifests and directory structure.
 *
 * @param {string} projectDir
 * @param {string} packageManager
 * @param {string[]} files
 * @returns {Promise<string[]>}
 */
async function detectEntryPoints(projectDir, packageManager, files) {
  const entryPoints = [];

  // Check package.json bin and main
  if (files.includes("package.json")) {
    try {
      const content = await readFile(join(projectDir, "package.json"), "utf-8");
      const pkg = JSON.parse(content);

      if (pkg.bin) {
        if (typeof pkg.bin === "string") {
          entryPoints.push(pkg.bin);
        } else {
          entryPoints.push(...Object.values(pkg.bin));
        }
      }

      if (pkg.main && !entryPoints.includes(pkg.main)) {
        entryPoints.push(pkg.main);
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Check Rust entry points
  if (files.includes("src/main.rs")) {
    entryPoints.push("src/main.rs");
  }

  if (files.includes("src/lib.rs")) {
    entryPoints.push("src/lib.rs");
  }

  // Check Go entry points
  if (files.includes("main.go")) {
    entryPoints.push("main.go");
  }

  // Check for cmd/ directory (Go convention)
  if (files.some(f => f.startsWith("cmd/"))) {
    entryPoints.push("cmd/");
  }

  return entryPoints;
}

/**
 * Detect test framework from files and dependencies.
 *
 * @param {string[]} files
 * @param {string[]} frameworks
 * @returns {string}
 */
function detectTestFramework(files, frameworks) {
  // Check for test configuration files
  for (const [pattern, framework] of Object.entries(TEST_FRAMEWORKS)) {
    if (files.some(f => f.includes(pattern))) {
      return framework;
    }
  }

  // Check framework list
  for (const framework of frameworks) {
    const lower = framework.toLowerCase();
    if (lower in TEST_FRAMEWORKS || TEST_FRAMEWORKS[lower]) {
      return TEST_FRAMEWORKS[lower] || framework;
    }
  }

  return "unknown";
}

/**
 * Classify project type from structure and frameworks.
 *
 * @param {string[]} directories
 * @param {string[]} frameworks
 * @param {string[]} entryPoints
 * @param {string} packageManager
 * @returns {string}
 */
function classifyProjectType(directories, frameworks, entryPoints, packageManager) {
  const dirSet = new Set(directories);
  const frameworkStr = frameworks.join(" ").toLowerCase();

  // Check for monorepo
  if (dirSet.has("packages") || dirSet.has("apps") || directories.filter(d => d.includes("package.json")).length > 1) {
    return "monorepo";
  }

  // Check for TUI
  if (dirSet.has("tui") || frameworkStr.includes("bubble") || frameworkStr.includes("tview")) {
    return "tui";
  }

  // Check for web app
  if (dirSet.has("routes") || dirSet.has("pages") || frameworkStr.includes("next") || frameworkStr.includes("nuxt")) {
    return "web_app";
  }

  // Check for API service
  if (frameworkStr.includes("express") || frameworkStr.includes("fastify") || frameworkStr.includes("fastapi") || frameworkStr.includes("gin") || frameworkStr.includes("axum")) {
    return "api_service";
  }

  // Check for CLI tool
  if (entryPoints.some(e => e.includes("cmd/") || e.includes("bin/")) || dirSet.has("cmd")) {
    return "cli_tool";
  }

  // Check for library
  if (dirSet.has("lib") || entryPoints.includes("src/lib.rs") || (packageManager === "cargo" && !entryPoints.includes("src/main.rs"))) {
    return "library";
  }

  return "unknown";
}

/**
 * Estimate complexity (1-10) based on file count.
 *
 * @param {number} fileCount
 * @returns {number}
 */
function estimateComplexity(fileCount) {
  if (fileCount < 10) return 1;
  if (fileCount < 50) return 3;
  if (fileCount < 200) return 5;
  if (fileCount < 500) return 7;
  return 9;
}

/**
 * Suggest decomposition strategy based on project type.
 *
 * @param {string} projectType
 * @param {number} complexity
 * @returns {string}
 */
function suggestDecomposition(projectType, complexity) {
  if (projectType === "monorepo") return "by_module";
  if (projectType === "web_app") return "by_feature";
  if (projectType === "library") return "by_layer";
  if (complexity <= 3) return "by_file";

  return "by_module";
}

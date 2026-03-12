// Domain-specific guidance supplements for agent prompts

const DOMAIN_GUIDANCE = {
  rust: "Rust: ensure ownership/borrow checker compliance, avoid unsafe blocks unless necessary, use checked arithmetic, handle errors with Result/Option types.",
  go: "Go: ensure goroutine safety, always check errors (if err != nil), use defer for cleanup, propagate context.Context through call chains.",
  python: "Python: use type hints, respect virtualenv boundaries, handle import resolution carefully, maintain __init__.py conventions.",
  react: "React: follow component patterns, manage state correctly, handle hydration properly.",
  vue: "Vue: follow component patterns, use reactive state, handle lifecycle correctly.",
  svelte: "Svelte: follow component patterns, use stores for state, understand reactivity.",
  next: "Next.js: handle SSR/SSG correctly, manage hydration, follow routing conventions.",
  "next.js": "Next.js: handle SSR/SSG correctly, manage hydration, follow routing conventions.",
  angular: "Angular: follow component patterns, use services for state, handle dependency injection.",
  cli_tool: "CLI: parse args correctly, use proper exit codes, handle stdin/stdout, respond to signals.",
  library: "Library: maintain API stability, follow semver strictly, ensure backward compatibility, document public APIs thoroughly.",
};

/**
 * Check if we have relevant domain knowledge for the given project info
 * @param {Object} projectInfo
 * @param {string[]} projectInfo.languages - Programming languages used
 * @param {string} projectInfo.projectType - Type of project (cli_tool, library, etc.)
 * @param {string[]} projectInfo.frameworks - Frameworks used
 * @returns {boolean}
 */
export function shouldIncludeSupplement(projectInfo) {
  if (!projectInfo) return false;

  const { languages = [], projectType = "", frameworks = [] } = projectInfo;

  // Check languages
  const relevantLanguages = ["rust", "go", "python"];
  if (languages.some((lang) => relevantLanguages.includes(lang.toLowerCase()))) {
    return true;
  }

  // Check project type
  if (projectType === "cli_tool" || projectType === "library") {
    return true;
  }

  // Check frameworks
  const relevantFrameworks = ["react", "vue", "svelte", "next", "next.js", "angular"];
  if (frameworks.some((fw) => relevantFrameworks.includes(fw.toLowerCase()))) {
    return true;
  }

  return false;
}

/**
 * Generate domain-specific guidance for agent prompts
 * @param {Object} projectInfo
 * @param {string[]} projectInfo.languages - Programming languages used
 * @param {string} projectInfo.projectType - Type of project (cli_tool, library, etc.)
 * @param {string[]} projectInfo.frameworks - Frameworks used
 * @returns {string} Domain-specific guidance (max 500 chars) or empty string
 */
export function generateSupplement(projectInfo) {
  if (!projectInfo || !shouldIncludeSupplement(projectInfo)) {
    return "";
  }

  const { languages = [], projectType = "", frameworks = [] } = projectInfo;
  const supplements = [];

  // Add language-specific guidance
  for (const lang of languages) {
    const key = lang.toLowerCase();
    if (DOMAIN_GUIDANCE[key]) {
      supplements.push(DOMAIN_GUIDANCE[key]);
    }
  }

  // Add project type guidance
  if (DOMAIN_GUIDANCE[projectType]) {
    supplements.push(DOMAIN_GUIDANCE[projectType]);
  }

  // Add framework guidance
  for (const fw of frameworks) {
    const key = fw.toLowerCase();
    if (DOMAIN_GUIDANCE[key]) {
      supplements.push(DOMAIN_GUIDANCE[key]);
    }
  }

  // Join and truncate to 500 chars
  const result = supplements.join(" ");
  return result.length > 500 ? result.substring(0, 497) + "..." : result;
}

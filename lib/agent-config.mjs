/**
 * Adaptive Agent Configuration (Fernis REQ-036)
 *
 * Generate domain-specific configuration for agents based on project profile.
 * Provides framework-specific guidance, turn budgets, and context optimization.
 */

// ── Type Definitions ─────────────────────────────────────────────

/**
 * @typedef {object} AgentConfig
 * @property {string} domainSupplement - Domain-specific prompt text for agents
 * @property {Record<string, string>} frameworkHints - Per-framework guidance
 * @property {string[]} relevantSwarmTypes - Which task types matter for this project
 * @property {Record<string, number>} turnsBudget - Task type → max turns
 * @property {string[]} skipPatterns - Patterns to avoid for this project type
 */

// ── Framework Guidance Database ──────────────────────────────────

/** Built-in framework-specific guidance */
const FRAMEWORK_GUIDANCE = {
  "React": [
    "Component architecture: Build reusable components with clear props interfaces.",
    "Hooks: Use useState for local state, useEffect for side effects, useMemo/useCallback for optimization.",
    "JSX: Expressions in curly braces, fragments with <> for grouping, key prop for lists.",
    "State management: Lift state up for shared data, consider Context for deep prop drilling.",
  ].join("\n"),

  "Express": [
    "Route handlers: Define routes with app.get/post/etc, use middleware for shared logic.",
    "Middleware: Functions with (req, res, next) signature, call next() to continue chain.",
    "Request lifecycle: Parse body with express.json(), validate inputs, handle errors with error middleware.",
    "Response patterns: Use res.json() for APIs, res.render() for views, res.status() for HTTP codes.",
  ].join("\n"),

  "FastAPI": [
    "Route handlers: Use @app.get/@app.post decorators, type hints for automatic validation.",
    "Pydantic models: Define request/response schemas with BaseModel, automatic OpenAPI docs.",
    "Async support: Use async def for I/O operations, await database/external calls.",
    "Dependency injection: Use Depends() for shared logic, database connections, auth.",
  ].join("\n"),

  "Flask": [
    "Route handlers: Use @app.route decorator, return tuples for (body, status) or Response objects.",
    "Templates: Jinja2 syntax, pass context via render_template(template, **vars).",
    "Request object: Access form data with request.form, JSON with request.json, query with request.args.",
    "Blueprints: Organize large apps with Blueprint for modular route registration.",
  ].join("\n"),

  "Bubble Tea": [
    "tea.Model interface: Implement Init() tea.Cmd, Update(tea.Msg) (tea.Model, tea.Cmd), View() string.",
    "Cmd pattern: Commands represent side effects, return tea.Batch for multiple commands.",
    "Message handling: Pattern match on msg type in Update, return updated model and commands.",
    "View rendering: Return string representation, use lipgloss for styling, keep stateless when possible.",
  ].join("\n"),

  "Rust": [
    "Ownership: Each value has one owner, moved by default unless Copy trait implemented.",
    "Borrowing: Use &T for immutable refs, &mut T for mutable, follow borrow checker rules.",
    "Error handling: Use Result<T, E> for recoverable errors, ? operator for propagation, panic! for unrecoverable.",
    "Unsafe blocks: Minimize unsafe code, document invariants, only for FFI or low-level optimizations.",
  ].join("\n"),

  "Go": [
    "Goroutines: Use go keyword for concurrent execution, cheap to spawn thousands.",
    "Channels: Typed conduits for goroutine communication, buffered vs unbuffered, close() to signal completion.",
    "Defer: Schedule function calls for cleanup, runs in LIFO order, commonly used for Close() calls.",
    "Error returns: Return (value, error) tuples, check err != nil, wrap with fmt.Errorf for context.",
  ].join("\n"),

  "Next.js": [
    "File-based routing: pages/ directory maps to routes, dynamic routes with [param].js.",
    "Data fetching: getServerSideProps for SSR, getStaticProps for SSG, SWR/React Query for client.",
    "API routes: pages/api/ for serverless functions, export handler(req, res).",
    "App Router (13+): app/ directory, Server Components by default, 'use client' for interactivity.",
  ].join("\n"),

  "Default": [
    "Read before write: Always verify existing code structure before modifications.",
    "Test coverage: Write tests for new functionality, run tests after changes.",
    "Error handling: Validate inputs, handle edge cases, provide meaningful error messages.",
    "Documentation: Update docs for API changes, add comments for complex logic.",
  ].join("\n"),
};

// ── Project Type Configurations ──────────────────────────────────

/** Relevant swarm types per project type */
const PROJECT_SWARM_TYPES = {
  web_app: ["frontend", "backend", "integration", "testing"],
  api_service: ["backend", "integration", "testing", "documentation"],
  cli_tool: ["implementation", "testing", "documentation"],
  library: ["implementation", "testing", "documentation", "examples"],
  tui: ["implementation", "testing"],
  monorepo: ["module", "integration", "testing"],
  data_pipeline: ["implementation", "testing", "validation"],
  unknown: ["implementation", "testing"],
};

/** Skip patterns per project type */
const PROJECT_SKIP_PATTERNS = {
  web_app: ["vendor/", "dist/", "build/", ".next/", ".nuxt/"],
  api_service: ["vendor/", "dist/", "build/", "__pycache__/"],
  cli_tool: ["vendor/", "target/", "dist/", "build/"],
  library: ["vendor/", "target/", "dist/", "build/", "examples/*/vendor/"],
  tui: ["vendor/", "target/", "dist/"],
  monorepo: ["node_modules/", "vendor/", "target/", "dist/", ".next/", "__pycache__/"],
  data_pipeline: ["vendor/", "__pycache__/", ".venv/", "data/raw/", "data/processed/"],
  unknown: ["vendor/", "node_modules/", "target/", "dist/"],
};

// ── Turn Budget Configuration ────────────────────────────────────

/**
 * Generate turn budgets based on project complexity.
 * Complexity 1-3: small projects, tight budgets
 * Complexity 4-6: medium projects, balanced budgets
 * Complexity 7-10: large projects, generous budgets
 *
 * @param {number} complexity - Project complexity (1-10)
 * @returns {Record<string, number>}
 */
function generateTurnsBudget(complexity) {
  if (complexity <= 3) {
    return {
      research: 10,
      implementation: 15,
      testing: 8,
      review: 5,
      documentation: 5,
    };
  } else if (complexity <= 6) {
    return {
      research: 15,
      implementation: 20,
      testing: 12,
      review: 8,
      documentation: 8,
    };
  } else {
    return {
      research: 20,
      implementation: 30,
      testing: 15,
      review: 10,
      documentation: 10,
    };
  }
}

// ── Main Configuration Generator ─────────────────────────────────

/**
 * Generate domain-specific configuration for agents based on project profile.
 *
 * @param {import('./project-profiler.mjs').ProjectProfile} profile
 * @returns {AgentConfig}
 */
export function generateAgentConfig(profile) {
  // Build framework hints
  const frameworkHints = {};
  for (const framework of profile.frameworks) {
    frameworkHints[framework] = getFrameworkGuidance(framework);
  }

  // Add primary language guidance if not already covered
  if (profile.primaryLanguage && profile.primaryLanguage !== "unknown") {
    const langGuidance = getFrameworkGuidance(profile.primaryLanguage);
    if (langGuidance !== FRAMEWORK_GUIDANCE["Default"]) {
      frameworkHints[profile.primaryLanguage] = langGuidance;
    }
  }

  // Generate domain supplement (combined guidance for system prompt)
  const domainSupplement = generateDomainSupplement(profile, frameworkHints);

  // Get relevant swarm types
  const relevantSwarmTypes = PROJECT_SWARM_TYPES[profile.projectType] || PROJECT_SWARM_TYPES["unknown"];

  // Generate turn budgets
  const turnsBudget = generateTurnsBudget(profile.estimatedComplexity);

  // Get skip patterns
  const skipPatterns = PROJECT_SKIP_PATTERNS[profile.projectType] || PROJECT_SKIP_PATTERNS["unknown"];

  return {
    domainSupplement,
    frameworkHints,
    relevantSwarmTypes,
    turnsBudget,
    skipPatterns,
  };
}

/**
 * Get framework-specific guidance text.
 *
 * @param {string} framework - Framework or language name
 * @returns {string}
 */
export function getFrameworkGuidance(framework) {
  return FRAMEWORK_GUIDANCE[framework] || FRAMEWORK_GUIDANCE["Default"];
}

/**
 * Generate domain supplement text for system prompt injection.
 *
 * @param {import('./project-profiler.mjs').ProjectProfile} profile
 * @param {Record<string, string>} frameworkHints
 * @returns {string}
 */
function generateDomainSupplement(profile, frameworkHints) {
  const lines = [
    "DOMAIN-SPECIFIC GUIDANCE:",
    "",
    `Project Type: ${profile.projectType}`,
    `Primary Language: ${profile.primaryLanguage}`,
    `Complexity: ${profile.estimatedComplexity}/10`,
    "",
  ];

  // Add framework-specific sections
  if (Object.keys(frameworkHints).length > 0) {
    lines.push("Framework Best Practices:");
    for (const [framework, guidance] of Object.entries(frameworkHints)) {
      lines.push(`\n## ${framework}`);
      lines.push(guidance);
    }
    lines.push("");
  }

  // Add project type specific guidance
  lines.push("Project-Specific Guidelines:");
  lines.push(getProjectTypeGuidance(profile.projectType));
  lines.push("");

  // Add decomposition strategy hint
  lines.push(`Decomposition Strategy: ${profile.decompositionStrategy}`);
  lines.push(getDecompositionGuidance(profile.decompositionStrategy));

  return lines.join("\n");
}

/**
 * Get guidance specific to project type.
 *
 * @param {string} projectType
 * @returns {string}
 */
function getProjectTypeGuidance(projectType) {
  const guidance = {
    web_app: [
      "- Separate frontend and backend concerns clearly",
      "- Consider responsive design and accessibility",
      "- Validate user inputs on both client and server",
      "- Optimize for bundle size and load performance",
    ].join("\n"),

    api_service: [
      "- Design RESTful or GraphQL endpoints with clear contracts",
      "- Implement proper authentication and authorization",
      "- Add request validation and rate limiting",
      "- Return consistent error responses with appropriate status codes",
    ].join("\n"),

    cli_tool: [
      "- Provide clear help text and usage examples",
      "- Validate arguments and provide helpful error messages",
      "- Support common flags (--help, --version, --verbose)",
      "- Exit with appropriate codes (0=success, 1=error)",
    ].join("\n"),

    library: [
      "- Design clean, minimal public APIs",
      "- Document all public functions with examples",
      "- Follow semver for versioning",
      "- Provide comprehensive test coverage",
    ].join("\n"),

    tui: [
      "- Handle terminal resize events gracefully",
      "- Implement responsive layout for different terminal sizes",
      "- Provide keyboard shortcuts and navigation",
      "- Test in multiple terminal emulators",
    ].join("\n"),

    monorepo: [
      "- Maintain clear boundaries between packages",
      "- Use workspace features for shared dependencies",
      "- Consider build order and inter-package dependencies",
      "- Keep shared code in dedicated packages",
    ].join("\n"),

    data_pipeline: [
      "- Validate data schemas at pipeline boundaries",
      "- Handle missing or malformed data gracefully",
      "- Log processing steps for debugging",
      "- Consider idempotency for reprocessing",
    ].join("\n"),

    unknown: [
      "- Analyze existing code structure before making changes",
      "- Follow existing patterns and conventions",
      "- Write tests for new functionality",
      "- Document non-obvious design decisions",
    ].join("\n"),
  };

  return guidance[projectType] || guidance["unknown"];
}

/**
 * Get guidance for decomposition strategy.
 *
 * @param {string} strategy
 * @returns {string}
 */
function getDecompositionGuidance(strategy) {
  const guidance = {
    by_module: "Break tasks by module boundaries — each subtask should own a complete module or package.",
    by_feature: "Break tasks by user-facing features — each subtask delivers a complete feature slice.",
    by_layer: "Break tasks by architectural layers — separate interface, business logic, and data layers.",
    by_file: "Break tasks by individual files — simple projects can parallelize at file granularity.",
  };

  return guidance[strategy] || guidance["by_module"];
}

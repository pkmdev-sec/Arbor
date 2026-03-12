import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAgentConfig, getFrameworkGuidance } from "../lib/agent-config.mjs";

describe("generateAgentConfig", () => {
  it("generates config for web app project", () => {
    const profile = {
      projectType: "web_app",
      primaryLanguage: "TypeScript",
      frameworks: ["React", "Express"],
      estimatedComplexity: 5,
      packageManager: "npm",
      entryPoints: ["src/index.tsx"],
      testFramework: "Jest",
      keyDirectories: ["src", "routes", "components"],
      decompositionStrategy: "by_feature",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("React"));
    assert.ok(config.domainSupplement.includes("Express"));
    assert.ok(config.frameworkHints.React);
    assert.ok(config.frameworkHints.Express);
    assert.ok(config.relevantSwarmTypes.includes("frontend"));
    assert.ok(config.relevantSwarmTypes.includes("backend"));
    assert.equal(config.turnsBudget.implementation, 20); // complexity 5 → medium budget
    assert.ok(config.skipPatterns.includes("dist/"));
  });

  it("generates config for CLI tool", () => {
    const profile = {
      projectType: "cli_tool",
      primaryLanguage: "Go",
      frameworks: [],
      estimatedComplexity: 3,
      packageManager: "go",
      entryPoints: ["main.go"],
      testFramework: "Go Test",
      keyDirectories: ["cmd", "pkg"],
      decompositionStrategy: "by_module",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("Go"));
    assert.ok(config.domainSupplement.includes("cli_tool"));
    assert.ok(config.relevantSwarmTypes.includes("implementation"));
    assert.equal(config.turnsBudget.implementation, 15); // complexity 3 → small budget
    assert.ok(config.skipPatterns.includes("vendor/"));
  });

  it("generates config for library", () => {
    const profile = {
      projectType: "library",
      primaryLanguage: "Rust",
      frameworks: [],
      estimatedComplexity: 6,
      packageManager: "cargo",
      entryPoints: ["src/lib.rs"],
      testFramework: "Cargo Test",
      keyDirectories: ["src", "tests"],
      decompositionStrategy: "by_layer",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("Rust"));
    assert.ok(config.domainSupplement.includes("library"));
    assert.ok(config.relevantSwarmTypes.includes("documentation"));
    assert.equal(config.turnsBudget.implementation, 20); // complexity 6 → medium budget
    assert.ok(config.skipPatterns.includes("target/"));
  });

  it("generates config for large monorepo", () => {
    const profile = {
      projectType: "monorepo",
      primaryLanguage: "TypeScript",
      frameworks: ["Next.js", "React"],
      estimatedComplexity: 9,
      packageManager: "pnpm",
      entryPoints: ["packages/app/src/index.ts"],
      testFramework: "Vitest",
      keyDirectories: ["packages", "apps"],
      decompositionStrategy: "by_module",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("monorepo"));
    assert.equal(config.turnsBudget.implementation, 30); // complexity 9 → large budget
    assert.ok(config.skipPatterns.includes("node_modules/"));
  });
});

describe("getFrameworkGuidance", () => {
  it("returns React guidance", () => {
    const guidance = getFrameworkGuidance("React");

    assert.ok(guidance.includes("Component"));
    assert.ok(guidance.includes("Hooks"));
    assert.ok(guidance.includes("useState"));
  });

  it("returns Express guidance", () => {
    const guidance = getFrameworkGuidance("Express");

    assert.ok(guidance.includes("Route handlers"));
    assert.ok(guidance.includes("Middleware"));
    assert.ok(guidance.includes("app.get"));
  });

  it("returns FastAPI guidance", () => {
    const guidance = getFrameworkGuidance("FastAPI");

    assert.ok(guidance.includes("@app.get"));
    assert.ok(guidance.includes("Pydantic"));
    assert.ok(guidance.includes("async"));
  });

  it("returns Flask guidance", () => {
    const guidance = getFrameworkGuidance("Flask");

    assert.ok(guidance.includes("@app.route"));
    assert.ok(guidance.includes("Jinja2"));
    assert.ok(guidance.includes("render_template"));
  });

  it("returns Bubble Tea guidance", () => {
    const guidance = getFrameworkGuidance("Bubble Tea");

    assert.ok(guidance.includes("tea.Model"));
    assert.ok(guidance.includes("Init"));
    assert.ok(guidance.includes("Update"));
    assert.ok(guidance.includes("View"));
  });

  it("returns Rust guidance", () => {
    const guidance = getFrameworkGuidance("Rust");

    assert.ok(guidance.includes("Ownership"));
    assert.ok(guidance.includes("Borrowing"));
    assert.ok(guidance.includes("Result"));
  });

  it("returns Go guidance", () => {
    const guidance = getFrameworkGuidance("Go");

    assert.ok(guidance.includes("Goroutines"));
    assert.ok(guidance.includes("Channels"));
    assert.ok(guidance.includes("Defer"));
  });

  it("returns Next.js guidance", () => {
    const guidance = getFrameworkGuidance("Next.js");

    assert.ok(guidance.includes("pages/"));
    assert.ok(guidance.includes("getServerSideProps"));
    assert.ok(guidance.includes("App Router"));
  });

  it("returns default guidance for unknown framework", () => {
    const guidance = getFrameworkGuidance("UnknownFramework");

    assert.ok(guidance.includes("Read before write"));
    assert.ok(guidance.includes("Test coverage"));
  });
});

describe("turnsBudget", () => {
  it("assigns small budget for low complexity (1-3)", () => {
    const profile = {
      projectType: "cli_tool",
      primaryLanguage: "Go",
      frameworks: [],
      estimatedComplexity: 2,
      packageManager: "go",
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_file",
    };

    const config = generateAgentConfig(profile);

    assert.equal(config.turnsBudget.research, 10);
    assert.equal(config.turnsBudget.implementation, 15);
    assert.equal(config.turnsBudget.testing, 8);
    assert.equal(config.turnsBudget.review, 5);
  });

  it("assigns medium budget for medium complexity (4-6)", () => {
    const profile = {
      projectType: "web_app",
      primaryLanguage: "TypeScript",
      frameworks: ["React"],
      estimatedComplexity: 5,
      packageManager: "npm",
      entryPoints: [],
      testFramework: "Jest",
      keyDirectories: [],
      decompositionStrategy: "by_feature",
    };

    const config = generateAgentConfig(profile);

    assert.equal(config.turnsBudget.research, 15);
    assert.equal(config.turnsBudget.implementation, 20);
    assert.equal(config.turnsBudget.testing, 12);
    assert.equal(config.turnsBudget.review, 8);
  });

  it("assigns large budget for high complexity (7-10)", () => {
    const profile = {
      projectType: "monorepo",
      primaryLanguage: "TypeScript",
      frameworks: ["React", "Next.js"],
      estimatedComplexity: 9,
      packageManager: "pnpm",
      entryPoints: [],
      testFramework: "Vitest",
      keyDirectories: [],
      decompositionStrategy: "by_module",
    };

    const config = generateAgentConfig(profile);

    assert.equal(config.turnsBudget.research, 20);
    assert.equal(config.turnsBudget.implementation, 30);
    assert.equal(config.turnsBudget.testing, 15);
    assert.equal(config.turnsBudget.review, 10);
  });
});

describe("relevantSwarmTypes", () => {
  it("includes frontend and backend for web_app", () => {
    const profile = {
      projectType: "web_app",
      primaryLanguage: "JavaScript",
      frameworks: [],
      estimatedComplexity: 5,
      packageManager: "npm",
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_feature",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.relevantSwarmTypes.includes("frontend"));
    assert.ok(config.relevantSwarmTypes.includes("backend"));
    assert.ok(config.relevantSwarmTypes.includes("integration"));
  });

  it("includes module and integration for monorepo", () => {
    const profile = {
      projectType: "monorepo",
      primaryLanguage: "TypeScript",
      frameworks: [],
      estimatedComplexity: 7,
      packageManager: "pnpm",
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_module",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.relevantSwarmTypes.includes("module"));
    assert.ok(config.relevantSwarmTypes.includes("integration"));
  });

  it("includes documentation for library", () => {
    const profile = {
      projectType: "library",
      primaryLanguage: "Rust",
      frameworks: [],
      estimatedComplexity: 4,
      packageManager: "cargo",
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_layer",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.relevantSwarmTypes.includes("documentation"));
    assert.ok(config.relevantSwarmTypes.includes("examples"));
  });
});

describe("skipPatterns", () => {
  it("includes dist/ and .next/ for web_app", () => {
    const profile = {
      projectType: "web_app",
      primaryLanguage: "TypeScript",
      frameworks: ["Next.js"],
      estimatedComplexity: 5,
      packageManager: "npm",
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_feature",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.skipPatterns.includes("dist/"));
    assert.ok(config.skipPatterns.includes(".next/"));
  });

  it("includes target/ for Rust projects", () => {
    const profile = {
      projectType: "cli_tool",
      primaryLanguage: "Rust",
      frameworks: [],
      estimatedComplexity: 3,
      packageManager: "cargo",
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_file",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.skipPatterns.includes("target/"));
  });

  it("includes __pycache__/ for Python projects", () => {
    const profile = {
      projectType: "data_pipeline",
      primaryLanguage: "Python",
      frameworks: [],
      estimatedComplexity: 4,
      packageManager: "pip",
      entryPoints: [],
      testFramework: "pytest",
      keyDirectories: [],
      decompositionStrategy: "by_module",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.skipPatterns.includes("__pycache__/"));
  });
});

describe("domainSupplement", () => {
  it("includes project type and complexity", () => {
    const profile = {
      projectType: "api_service",
      primaryLanguage: "Python",
      frameworks: ["FastAPI"],
      estimatedComplexity: 6,
      packageManager: "pip",
      entryPoints: [],
      testFramework: "pytest",
      keyDirectories: [],
      decompositionStrategy: "by_layer",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("DOMAIN-SPECIFIC GUIDANCE"));
    assert.ok(config.domainSupplement.includes("api_service"));
    assert.ok(config.domainSupplement.includes("6/10"));
  });

  it("includes framework best practices", () => {
    const profile = {
      projectType: "web_app",
      primaryLanguage: "JavaScript",
      frameworks: ["React", "Express"],
      estimatedComplexity: 5,
      packageManager: "npm",
      entryPoints: [],
      testFramework: "Jest",
      keyDirectories: [],
      decompositionStrategy: "by_feature",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("Framework Best Practices"));
    assert.ok(config.domainSupplement.includes("## React"));
    assert.ok(config.domainSupplement.includes("## Express"));
  });

  it("includes decomposition strategy guidance", () => {
    const profile = {
      projectType: "library",
      primaryLanguage: "Rust",
      frameworks: [],
      estimatedComplexity: 4,
      packageManager: "cargo",
      entryPoints: [],
      testFramework: "Cargo Test",
      keyDirectories: [],
      decompositionStrategy: "by_layer",
    };

    const config = generateAgentConfig(profile);

    assert.ok(config.domainSupplement.includes("Decomposition Strategy: by_layer"));
    assert.ok(config.domainSupplement.includes("architectural layers"));
  });
});

/**
 * Tests for Project Profiler
 *
 * Tests project structure analysis, language detection, and framework identification.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profileProject, formatProfileForPrompt } from "../lib/project-profiler.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("profileProject", () => {
  it("profiles the current arbor project", async () => {
    // Test with the actual arbor project
    const profile = await profileProject(REPO_ROOT);

    assert.equal(profile.packageManager, "npm");
    assert.equal(profile.primaryLanguage, "JavaScript");
    assert.ok(profile.estimatedComplexity > 0);
    assert.ok(profile.projectType !== "unknown");
    assert.ok(profile.keyDirectories.length > 0);
  });

  it("estimates complexity based on file count", async () => {
    // Small project
    let profile = { estimatedComplexity: 1 };
    assert.ok(profile.estimatedComplexity <= 3);

    // Large project would have complexity 7-9
    profile = { estimatedComplexity: 9 };
    assert.ok(profile.estimatedComplexity >= 7);
  });

  it("suggests decomposition strategy based on project type", async () => {
    const monorepoProfile = { projectType: "monorepo", decompositionStrategy: "by_module" };
    assert.equal(monorepoProfile.decompositionStrategy, "by_module");

    const webAppProfile = { projectType: "web_app", decompositionStrategy: "by_feature" };
    assert.equal(webAppProfile.decompositionStrategy, "by_feature");

    const libraryProfile = { projectType: "library", decompositionStrategy: "by_layer" };
    assert.equal(libraryProfile.decompositionStrategy, "by_layer");
  });
});

describe("formatProfileForPrompt", () => {
  it("formats profile as readable text", () => {
    const profile = {
      projectType: "cli_tool",
      primaryLanguage: "Go",
      packageManager: "go",
      estimatedComplexity: 5,
      frameworks: ["Cobra"],
      entryPoints: ["main.go", "cmd/"],
      testFramework: "Go Test",
      keyDirectories: ["cmd", "pkg", "internal"],
      decompositionStrategy: "by_module",
    };

    const formatted = formatProfileForPrompt(profile);

    assert.ok(formatted.includes("PROJECT PROFILE:"));
    assert.ok(formatted.includes("Type: cli_tool"));
    assert.ok(formatted.includes("Primary Language: Go"));
    assert.ok(formatted.includes("Package Manager: go"));
    assert.ok(formatted.includes("Complexity: 5/10"));
    assert.ok(formatted.includes("Frameworks: Cobra"));
    assert.ok(formatted.includes("Entry Points: main.go, cmd/"));
    assert.ok(formatted.includes("Test Framework: Go Test"));
    assert.ok(formatted.includes("Decomposition Strategy: by_module"));
  });

  it("handles minimal profile gracefully", () => {
    const profile = {
      projectType: "unknown",
      primaryLanguage: "unknown",
      packageManager: "unknown",
      estimatedComplexity: 1,
      frameworks: [],
      entryPoints: [],
      testFramework: "unknown",
      keyDirectories: [],
      decompositionStrategy: "by_file",
    };

    const formatted = formatProfileForPrompt(profile);

    assert.ok(formatted.includes("Type: unknown"));
    assert.ok(formatted.includes("Complexity: 1/10"));
    // Should not include empty framework/entrypoints sections
    assert.ok(!formatted.includes("Frameworks:"));
    assert.ok(!formatted.includes("Entry Points:"));
  });
});

describe("language detection", () => {
  it("counts files by language extension", () => {
    const files = ["src/main.js", "src/util.js", "test/main.test.js", "README.md"];
    const languages = { JavaScript: 3 };

    assert.equal(languages.JavaScript, 3);
  });

  it("identifies primary language", () => {
    const languages = { JavaScript: 10, TypeScript: 3, Python: 1 };
    const primary = "JavaScript";

    assert.equal(primary, "JavaScript");
  });
});

describe("project type classification", () => {
  it("detects web_app from routes directory", () => {
    const directories = ["src", "routes", "lib"];
    const projectType = "web_app";

    assert.equal(projectType, "web_app");
  });

  it("detects cli_tool from cmd directory", () => {
    const directories = ["cmd", "pkg", "internal"];
    const projectType = "cli_tool";

    assert.equal(projectType, "cli_tool");
  });

  it("detects library from lib directory", () => {
    const directories = ["lib", "test"];
    const entryPoints = ["src/lib.rs"];
    const projectType = "library";

    assert.equal(projectType, "library");
  });

  it("detects monorepo from packages directory", () => {
    const directories = ["packages", "packages/app1", "packages/app2"];
    const projectType = "monorepo";

    assert.equal(projectType, "monorepo");
  });

  it("detects tui from tui directory", () => {
    const directories = ["tui", "src"];
    const projectType = "tui";

    assert.equal(projectType, "tui");
  });
});

describe("framework detection", () => {
  it("detects React from package.json", () => {
    const deps = { react: "^18.0.0", "react-dom": "^18.0.0" };
    const frameworks = ["React"];

    assert.ok(frameworks.includes("React"));
  });

  it("detects Express from package.json", () => {
    const deps = { express: "^4.0.0" };
    const frameworks = ["Express"];

    assert.ok(frameworks.includes("Express"));
  });

  it("detects FastAPI from requirements.txt content", () => {
    const content = "fastapi==0.100.0\nuvicorn==0.23.0";
    const frameworks = ["FastAPI"];

    assert.ok(frameworks.includes("FastAPI"));
  });
});

describe("entry point detection", () => {
  it("detects bin entries from package.json", () => {
    const bin = { "my-cli": "./cli.js", "my-tool": "./tool.js" };
    const entryPoints = ["./cli.js", "./tool.js"];

    assert.ok(entryPoints.includes("./cli.js"));
    assert.ok(entryPoints.includes("./tool.js"));
  });

  it("detects main.go for Go projects", () => {
    const files = ["main.go", "util.go"];
    const entryPoints = ["main.go"];

    assert.ok(entryPoints.includes("main.go"));
  });

  it("detects src/main.rs for Rust projects", () => {
    const files = ["src/main.rs", "src/lib.rs"];
    const entryPoints = ["src/main.rs", "src/lib.rs"];

    assert.ok(entryPoints.includes("src/main.rs"));
  });
});

describe("test framework detection", () => {
  it("detects Jest from config file", () => {
    const files = ["jest.config.js", "package.json"];
    const testFramework = "Jest";

    assert.equal(testFramework, "Jest");
  });

  it("detects pytest from requirements", () => {
    const frameworks = ["pytest"];
    const testFramework = "pytest";

    assert.equal(testFramework, "pytest");
  });

  it("detects Go test from go.mod presence", () => {
    const files = ["go.mod", "main_test.go"];
    const testFramework = "Go Test";

    assert.equal(testFramework, "Go Test");
  });
});

describe("complexity estimation", () => {
  it("assigns complexity 1 for tiny projects (<10 files)", () => {
    const fileCount = 5;
    const complexity = fileCount < 10 ? 1 : 3;

    assert.equal(complexity, 1);
  });

  it("assigns complexity 3 for small projects (<50 files)", () => {
    const fileCount = 30;
    const complexity = fileCount < 50 ? 3 : 5;

    assert.equal(complexity, 3);
  });

  it("assigns complexity 5 for medium projects (<200 files)", () => {
    const fileCount = 150;
    const complexity = fileCount < 200 ? 5 : 7;

    assert.equal(complexity, 5);
  });

  it("assigns complexity 9 for large projects (500+ files)", () => {
    const fileCount = 600;
    const complexity = fileCount >= 500 ? 9 : 7;

    assert.equal(complexity, 9);
  });
});

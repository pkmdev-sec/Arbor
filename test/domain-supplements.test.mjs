import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSupplement, shouldIncludeSupplement } from "../lib/domain-supplements.mjs";

describe("shouldIncludeSupplement", () => {
  it("returns true for Rust projects", () => {
    const projectInfo = {
      languages: ["Rust"],
      projectType: "library",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns true for Go projects", () => {
    const projectInfo = {
      languages: ["Go"],
      projectType: "cli_tool",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns true for Python projects", () => {
    const projectInfo = {
      languages: ["Python"],
      projectType: "web_app",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns true for React projects", () => {
    const projectInfo = {
      languages: ["JavaScript"],
      projectType: "web_app",
      frameworks: ["React"],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns true for Vue projects", () => {
    const projectInfo = {
      languages: ["TypeScript"],
      projectType: "web_app",
      frameworks: ["Vue"],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns true for CLI tools", () => {
    const projectInfo = {
      languages: ["JavaScript"],
      projectType: "cli_tool",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns true for libraries", () => {
    const projectInfo = {
      languages: ["TypeScript"],
      projectType: "library",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("returns false for projects without relevant domains", () => {
    const projectInfo = {
      languages: ["JavaScript"],
      projectType: "web_app",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), false);
  });

  it("returns false for null/undefined input", () => {
    assert.equal(shouldIncludeSupplement(null), false);
    assert.equal(shouldIncludeSupplement(undefined), false);
  });

  it("handles case-insensitive language names", () => {
    const projectInfo = {
      languages: ["RUST", "golang"],
      projectType: "unknown",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });

  it("handles case-insensitive framework names", () => {
    const projectInfo = {
      languages: [],
      projectType: "unknown",
      frameworks: ["REACT", "Next.js"],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
  });
});

describe("generateSupplement", () => {
  it("generates Rust guidance", () => {
    const projectInfo = {
      languages: ["Rust"],
      projectType: "unknown",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("ownership"));
    assert.ok(supplement.includes("borrow checker"));
    assert.ok(supplement.includes("Result/Option"));
  });

  it("generates Go guidance", () => {
    const projectInfo = {
      languages: ["Go"],
      projectType: "unknown",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("goroutine"));
    assert.ok(supplement.includes("if err != nil"));
    assert.ok(supplement.includes("defer"));
    assert.ok(supplement.includes("context.Context"));
  });

  it("generates Python guidance", () => {
    const projectInfo = {
      languages: ["Python"],
      projectType: "unknown",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("type hints"));
    assert.ok(supplement.includes("virtualenv"));
    assert.ok(supplement.includes("__init__.py"));
  });

  it("generates React guidance", () => {
    const projectInfo = {
      languages: ["JavaScript"],
      projectType: "web_app",
      frameworks: ["React"],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("component patterns"));
    assert.ok(supplement.includes("state"));
    assert.ok(supplement.includes("hydration"));
  });

  it("generates Next.js guidance", () => {
    const projectInfo = {
      languages: ["TypeScript"],
      projectType: "web_app",
      frameworks: ["Next.js"],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("SSR") || supplement.includes("SSG"));
    assert.ok(supplement.includes("hydration"));
  });

  it("generates CLI tool guidance", () => {
    const projectInfo = {
      languages: ["JavaScript"],
      projectType: "cli_tool",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("args"));
    assert.ok(supplement.includes("exit codes"));
    assert.ok(supplement.includes("stdin/stdout"));
    assert.ok(supplement.includes("signals"));
  });

  it("generates library guidance", () => {
    const projectInfo = {
      languages: ["TypeScript"],
      projectType: "library",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("API stability"));
    assert.ok(supplement.includes("semver"));
    assert.ok(supplement.includes("backward compatibility"));
    assert.ok(supplement.includes("document"));
  });

  it("combines multiple domain guidances", () => {
    const projectInfo = {
      languages: ["Rust", "Go"],
      projectType: "cli_tool",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("Rust"));
    assert.ok(supplement.includes("Go"));
    assert.ok(supplement.includes("CLI"));
  });

  it("returns empty string for projects without relevant domains", () => {
    const projectInfo = {
      languages: ["JavaScript"],
      projectType: "web_app",
      frameworks: [],
    };
    const supplement = generateSupplement(projectInfo);
    assert.equal(supplement, "");
  });

  it("returns empty string for null/undefined input", () => {
    assert.equal(generateSupplement(null), "");
    assert.equal(generateSupplement(undefined), "");
  });

  it("truncates output to 500 characters max", () => {
    const projectInfo = {
      languages: ["Rust", "Go", "Python"],
      projectType: "library",
      frameworks: ["React", "Vue", "Angular"],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.length <= 500);
  });

  it("adds ellipsis when truncating", () => {
    const projectInfo = {
      languages: ["Rust", "Go", "Python"],
      projectType: "library",
      frameworks: ["React", "Vue", "Angular", "Svelte"],
    };
    const supplement = generateSupplement(projectInfo);
    if (supplement.length === 500) {
      assert.ok(supplement.endsWith("..."));
    }
  });

  it("handles mixed-case language and framework names", () => {
    const projectInfo = {
      languages: ["RUST"],
      projectType: "unknown",
      frameworks: ["REACT"],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.length > 0);
    assert.ok(supplement.includes("Rust") || supplement.includes("ownership"));
  });

  it("handles web framework projects with languages", () => {
    const projectInfo = {
      languages: ["TypeScript", "Python"],
      projectType: "web_app",
      frameworks: ["Next.js"],
    };
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.includes("Python"));
    assert.ok(supplement.includes("Next.js"));
  });
});

describe("edge cases", () => {
  it("handles empty arrays", () => {
    const projectInfo = {
      languages: [],
      projectType: "",
      frameworks: [],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), false);
    assert.equal(generateSupplement(projectInfo), "");
  });

  it("handles missing fields", () => {
    const projectInfo = {};
    assert.equal(shouldIncludeSupplement(projectInfo), false);
    assert.equal(generateSupplement(projectInfo), "");
  });

  it("handles partial projectInfo", () => {
    const projectInfo = {
      languages: ["Rust"],
    };
    assert.equal(shouldIncludeSupplement(projectInfo), true);
    const supplement = generateSupplement(projectInfo);
    assert.ok(supplement.length > 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import OutputValidator, { SEVERITY } from "../lib/output-validator.mjs";

describe("OutputValidator", () => {
  describe("validateAgentOutput", () => {
    it("passes validation for well-formed output", () => {
      const validator = new OutputValidator();
      const task = {
        description: "Fix bug in src/auth.js",
        targetFiles: ["src/auth.js"],
      };
      const result = {
        output: "Fixed authentication bug by adding null check",
        toolCalls: 3,
      };
      const filesChanged = ["src/auth.js"];

      const validation = validator.validateAgentOutput(task, result, filesChanged);

      assert.equal(validation.valid, true);
      assert.ok(validation.score >= 0.7);
    });

    it("fails validation for out-of-scope changes", () => {
      const validator = new OutputValidator();
      const task = {
        description: "Update README",
        targetFiles: ["README.md"],
      };
      const result = {
        output: "Updated documentation",
        toolCalls: 2,
      };
      const filesChanged = ["src/config.js"]; // Wrong file

      const validation = validator.validateAgentOutput(task, result, filesChanged);

      assert.equal(validation.valid, false);
      const scopeCheck = validation.checks.find(c => c.name === "scope");
      assert.equal(scopeCheck.passed, false);
      assert.equal(scopeCheck.severity, SEVERITY.ERROR);
    });

    it("calculates score correctly with multiple issues", () => {
      const validator = new OutputValidator();
      const task = {
        description: "Optimize database queries",
      };
      const result = {
        output: "Successfully built", // Overclaim without evidence
        toolCalls: Array(10).fill(null), // Array of 10 items
      };
      const filesChanged = [];

      const validation = validator.validateAgentOutput(task, result, filesChanged);

      // Should have empty_result ERROR (-0.3) and overclaim WARNING (-0.1)
      assert.ok(validation.score <= 0.6);
    });
  });

  describe("_checkScope", () => {
    it("passes when no target files/dirs specified", () => {
      const validator = new OutputValidator();
      const task = { description: "General refactoring" };
      const filesChanged = ["src/util.js"];

      const check = validator._checkScope(task, filesChanged);

      assert.equal(check.passed, true);
      assert.equal(check.severity, SEVERITY.INFO);
    });

    it("passes when changed files match target files", () => {
      const validator = new OutputValidator();
      const task = {
        targetFiles: ["src/auth.js", "src/user.js"],
      };
      const filesChanged = ["src/auth.js"];

      const check = validator._checkScope(task, filesChanged);

      assert.equal(check.passed, true);
    });

    it("passes when changed files are within target dirs", () => {
      const validator = new OutputValidator();
      const task = {
        targetDirs: ["src/components/"],
      };
      const filesChanged = ["src/components/Button.jsx"];

      const check = validator._checkScope(task, filesChanged);

      assert.equal(check.passed, true);
    });

    it("fails when changed files are out of scope", () => {
      const validator = new OutputValidator();
      const task = {
        targetFiles: ["README.md"],
        targetDirs: ["docs/"],
      };
      const filesChanged = ["src/index.js"];

      const check = validator._checkScope(task, filesChanged);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.ERROR);
    });

    it("passes when no files changed", () => {
      const validator = new OutputValidator();
      const task = { targetFiles: ["src/auth.js"] };
      const filesChanged = [];

      const check = validator._checkScope(task, filesChanged);

      assert.equal(check.passed, true);
      assert.equal(check.severity, SEVERITY.INFO);
    });
  });

  describe("_checkRelevance", () => {
    it("passes when no specific files mentioned", () => {
      const validator = new OutputValidator();
      const task = { description: "Refactor authentication logic" };
      const filesChanged = ["src/auth.js"];

      const check = validator._checkRelevance(task, filesChanged);

      assert.equal(check.passed, true);
      assert.equal(check.severity, SEVERITY.INFO);
    });

    it("passes when mentioned files were changed", () => {
      const validator = new OutputValidator();
      const task = {
        description: "Fix bug in src/auth.js and update src/user.js",
      };
      const filesChanged = ["src/auth.js", "src/user.js"];

      const check = validator._checkRelevance(task, filesChanged);

      assert.equal(check.passed, true);
    });

    it("warns when mentioned files were not changed", () => {
      const validator = new OutputValidator();
      const task = {
        description: "Update config.json with new settings",
      };
      const filesChanged = ["src/settings.js"];

      const check = validator._checkRelevance(task, filesChanged);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.WARNING);
      assert.ok(check.message.includes("config.json"));
    });
  });

  describe("_checkDestructiveActions", () => {
    it("passes when no deletions detected", () => {
      const validator = new OutputValidator();
      const task = { description: "Add new feature" };
      const result = { output: "Added authentication module" };
      const filesChanged = ["src/auth.js"];

      const check = validator._checkDestructiveActions(task, filesChanged, result);

      assert.equal(check.passed, true);
      assert.equal(check.severity, SEVERITY.INFO);
    });

    it("passes when deletions are authorized", () => {
      const validator = new OutputValidator();
      const task = { description: "Delete deprecated files" };
      const result = { output: "Deleted old-auth.js from src/" };
      const filesChanged = [];

      const check = validator._checkDestructiveActions(task, filesChanged, result);

      assert.equal(check.passed, true);
    });

    it("warns when deletions are not authorized", () => {
      const validator = new OutputValidator();
      const task = { description: "Update authentication" };
      const result = { output: "Removed legacy-auth.js and updated auth.js" };
      const filesChanged = ["src/auth.js"];

      const check = validator._checkDestructiveActions(task, filesChanged, result);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.WARNING);
    });

    it("detects rm commands", () => {
      const validator = new OutputValidator();
      const task = { description: "Clean up codebase" }; // Authorized
      const result = { output: "Ran rm deprecated.js to clean up" };
      const filesChanged = [];

      const check = validator._checkDestructiveActions(task, filesChanged, result);

      assert.equal(check.passed, true); // "clean" authorizes deletion
    });
  });

  describe("_checkEmptyResult", () => {
    it("passes when output has content", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Successfully implemented authentication with JWT tokens. " +
                "Updated src/auth.js to use bcrypt for password hashing.",
      };
      const filesChanged = ["src/auth.js"];

      const check = validator._checkEmptyResult(result, filesChanged, 3);

      assert.equal(check.passed, true);
    });

    it("fails when many tool calls but minimal output and no changes", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Done",
      };
      const filesChanged = [];

      const check = validator._checkEmptyResult(result, filesChanged, 10);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.ERROR);
      assert.ok(check.message.includes("10 tool calls"));
    });

    it("passes when few tool calls despite minimal output", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Done",
      };
      const filesChanged = [];

      const check = validator._checkEmptyResult(result, filesChanged, 2);

      assert.equal(check.passed, true);
    });
  });

  describe("_checkOverclaim", () => {
    it("passes when no claims made", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Updated authentication logic in src/auth.js",
      };

      const check = validator._checkOverclaim(result);

      assert.equal(check.passed, true);
    });

    it("passes when claims have evidence", () => {
      const validator = new OutputValidator();
      const result = {
        output: "All tests pass\n\nTest results:\n✓ auth.test.js - 15 tests passed",
      };

      const check = validator._checkOverclaim(result);

      assert.equal(check.passed, true);
    });

    it("warns when 'all tests pass' without evidence", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Fixed the bug. No errors detected.",
      };

      const check = validator._checkOverclaim(result);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.WARNING);
      assert.ok(check.message.includes("without evidence"));
    });

    it("warns when 'successfully built' without evidence", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Updated configuration. Successfully built the project.",
      };

      const check = validator._checkOverclaim(result);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.WARNING);
    });

    it("warns when 'no errors' without evidence", () => {
      const validator = new OutputValidator();
      const result = {
        output: "Completed refactoring with no errors.",
      };

      const check = validator._checkOverclaim(result);

      assert.equal(check.passed, false);
      assert.equal(check.severity, SEVERITY.WARNING);
    });
  });

  describe("score calculation", () => {
    it("deducts 0.3 for ERROR severity", () => {
      const validator = new OutputValidator();
      const task = { targetFiles: ["src/auth.js"] };
      const result = { output: "Done", toolCalls: Array(10).fill(null) };
      const filesChanged = [];

      const validation = validator.validateAgentOutput(task, result, filesChanged);

      // empty_result is ERROR, should deduct 0.3
      const emptyCheck = validation.checks.find(c => c.name === "empty_result");
      assert.equal(emptyCheck.severity, SEVERITY.ERROR);
      assert.ok(validation.score <= 0.7);
    });

    it("deducts 0.1 for WARNING severity", () => {
      const validator = new OutputValidator();
      const task = { description: "Update code" };
      const result = { output: "Successfully built" }; // Overclaim
      const filesChanged = ["src/auth.js"];

      const validation = validator.validateAgentOutput(task, result, filesChanged);

      // overclaim is WARNING, should deduct 0.1
      const overclaimCheck = validation.checks.find(c => c.name === "overclaim");
      assert.equal(overclaimCheck.severity, SEVERITY.WARNING);
      assert.ok(validation.score >= 0.8 && validation.score <= 1.0);
    });

    it("does not go below 0", () => {
      const validator = new OutputValidator();
      const task = {
        description: "Fix src/auth.js",
        targetFiles: ["src/auth.js"],
      };
      const result = {
        output: "All tests pass. Successfully built. No errors.",
        toolCalls: 15,
      };
      const filesChanged = ["src/config.js"]; // Wrong file

      const validation = validator.validateAgentOutput(task, result, filesChanged);

      assert.ok(validation.score >= 0, `Score should be >= 0, got ${validation.score}`);
    });
  });
});

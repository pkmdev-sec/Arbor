import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateCriteria, formatCriteriaForPrompt, evaluateCriteria } from "../lib/task-criteria.mjs";

// ── generateCriteria ─────────────────────────────────────────────

describe("generateCriteria", () => {
  it("bugfix: includes bug reproduction, root cause, tests", () => {
    const task = { type: "bugfix", description: "Fix login timeout" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.acceptIf.includes("Bug reproduction confirmed"));
    assert.ok(criteria.acceptIf.includes("Fix addresses root cause"));
    assert.ok(criteria.acceptIf.includes("Tests pass after fix"));
    assert.ok(criteria.risks.length > 0);
  });

  it("feature: includes feature works, tests added, no regressions", () => {
    const task = { type: "feature", description: "Add dark mode toggle" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.acceptIf.includes("Feature works as described"));
    assert.ok(criteria.acceptIf.includes("Tests added for new code"));
    assert.ok(criteria.acceptIf.includes("No regressions"));
  });

  it("refactor: includes behavior unchanged, tests pass, simpler code", () => {
    const task = { type: "refactor", description: "Simplify auth module" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.acceptIf.includes("Behavior unchanged"));
    assert.ok(criteria.acceptIf.includes("All tests pass"));
    assert.ok(criteria.acceptIf.includes("Code is simpler"));
  });

  it("targetFiles: adds 'Target files were modified' criterion", () => {
    const task = {
      description: "Update config",
      targetFiles: ["config.json", "settings.js"],
    };
    const criteria = generateCriteria(task);

    assert.ok(criteria.acceptIf.includes("Target files were modified"));
  });

  it("targetFiles > 5: adds merge conflict risk", () => {
    const task = {
      description: "Update all configs",
      targetFiles: ["a", "b", "c", "d", "e", "f"],
    };
    const criteria = generateCriteria(task);

    assert.ok(criteria.risks.some(r => r.includes("merge conflict")));
  });

  it("targetDirs: adds 'focused within target directories' criterion", () => {
    const task = {
      description: "Refactor auth module",
      targetDirs: ["src/auth/", "test/auth/"],
    };
    const criteria = generateCriteria(task);

    assert.ok(criteria.acceptIf.includes("Changes focused within target directories"));
  });

  it("rejectIf: always includes wandered off-scope, deleted files, tests fail", () => {
    const task = { description: "Simple task" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.rejectIf.includes("Agent wandered off-scope"));
    assert.ok(criteria.rejectIf.includes("Files deleted without authorization"));
    assert.ok(criteria.rejectIf.includes("Tests fail"));
  });

  it("database in description: adds migration risk", () => {
    const task = { description: "Update database schema" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.risks.some(r => r.includes("migration")));
  });

  it("API in description: adds client breaking risk", () => {
    const task = { description: "Change API endpoint structure" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.risks.some(r => r.includes("API changes")));
  });

  it("security in description: adds scrutiny risk", () => {
    const task = { description: "Update security headers" };
    const criteria = generateCriteria(task);

    assert.ok(criteria.risks.some(r => r.includes("security")));
  });

  it("null task: returns empty criteria with risk", () => {
    const criteria = generateCriteria(null);

    assert.deepStrictEqual(criteria.acceptIf, []);
    assert.deepStrictEqual(criteria.rejectIf, []);
    assert.ok(criteria.risks.includes("Invalid task object"));
  });

  it("empty task: returns default criteria", () => {
    const criteria = generateCriteria({});

    assert.ok(criteria.acceptIf.length > 0);
    assert.ok(criteria.rejectIf.length > 0);
  });
});

// ── formatCriteriaForPrompt ──────────────────────────────────────

describe("formatCriteriaForPrompt", () => {
  it("formats acceptIf with checkmarks", () => {
    const criteria = {
      acceptIf: ["Tests pass", "Code works"],
      rejectIf: [],
      risks: [],
    };
    const formatted = formatCriteriaForPrompt(criteria);

    assert.ok(formatted.includes("ACCEPTANCE CRITERIA:"));
    assert.ok(formatted.includes("✓ Tests pass"));
    assert.ok(formatted.includes("✓ Code works"));
  });

  it("formats rejectIf with X marks", () => {
    const criteria = {
      acceptIf: [],
      rejectIf: ["Tests fail", "Errors introduced"],
      risks: [],
    };
    const formatted = formatCriteriaForPrompt(criteria);

    assert.ok(formatted.includes("REJECTION CRITERIA:"));
    assert.ok(formatted.includes("✗ Tests fail"));
    assert.ok(formatted.includes("✗ Errors introduced"));
  });

  it("formats risks with warning symbols", () => {
    const criteria = {
      acceptIf: [],
      rejectIf: [],
      risks: ["May break API", "Database migration needed"],
    };
    const formatted = formatCriteriaForPrompt(criteria);

    assert.ok(formatted.includes("KNOWN RISKS:"));
    assert.ok(formatted.includes("⚠ May break API"));
    assert.ok(formatted.includes("⚠ Database migration needed"));
  });

  it("formats all sections together", () => {
    const criteria = {
      acceptIf: ["Tests pass"],
      rejectIf: ["Tests fail"],
      risks: ["May break API"],
    };
    const formatted = formatCriteriaForPrompt(criteria);

    assert.ok(formatted.includes("ACCEPTANCE CRITERIA:"));
    assert.ok(formatted.includes("REJECTION CRITERIA:"));
    assert.ok(formatted.includes("KNOWN RISKS:"));
  });

  it("null criteria: returns empty string", () => {
    const formatted = formatCriteriaForPrompt(null);
    assert.equal(formatted, "");
  });

  it("empty criteria: returns empty string", () => {
    const criteria = { acceptIf: [], rejectIf: [], risks: [] };
    const formatted = formatCriteriaForPrompt(criteria);
    assert.equal(formatted, "");
  });
});

// ── evaluateCriteria ─────────────────────────────────────────────

describe("evaluateCriteria", () => {
  it("tests pass criterion: met when testsPassed=true", () => {
    const criteria = { acceptIf: ["Tests pass after fix"], rejectIf: [], risks: [] };
    const result = { testsPassed: true, output: "", filesChanged: [] };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.met.includes("Tests pass after fix"));
    assert.equal(evaluation.unmet.length, 0);
    assert.equal(evaluation.score, 1.0);
  });

  it("tests pass criterion: unmet when testsPassed=false", () => {
    const criteria = { acceptIf: ["Tests pass after fix"], rejectIf: [], risks: [] };
    const result = { testsPassed: false, output: "", filesChanged: [] };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.unmet.includes("Tests pass after fix"));
    assert.equal(evaluation.met.length, 0);
    assert.equal(evaluation.score, 0);
  });

  it("target files modified: met when filesChanged non-empty", () => {
    const criteria = { acceptIf: ["Target files were modified"], rejectIf: [], risks: [] };
    const result = { filesChanged: ["config.json"], output: "", testsPassed: true };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.met.includes("Target files were modified"));
    assert.equal(evaluation.score, 1.0);
  });

  it("target files modified: unmet when filesChanged empty", () => {
    const criteria = { acceptIf: ["Target files were modified"], rejectIf: [], risks: [] };
    const result = { filesChanged: [], output: "", testsPassed: true };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.unmet.includes("Target files were modified"));
  });

  it("no errors criterion: met when no error", () => {
    const criteria = { acceptIf: ["No errors introduced"], rejectIf: [], risks: [] };
    const result = { output: "Success", filesChanged: ["file.js"], testsPassed: true };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.met.includes("No errors introduced"));
  });

  it("no errors criterion: unmet when error present", () => {
    const criteria = { acceptIf: ["No errors introduced"], rejectIf: [], risks: [] };
    const result = { error: "Something broke", output: "", filesChanged: [] };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.unmet.includes("No errors introduced"));
  });

  it("root cause criterion: met when output mentions fix/fixed/resolved", () => {
    const criteria = { acceptIf: ["Fix addresses root cause"], rejectIf: [], risks: [] };
    const result = { output: "Fixed the null pointer issue", filesChanged: ["app.js"], testsPassed: true };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.met.includes("Fix addresses root cause"));
  });

  it("rejectIf tests fail: violated when testsPassed=false", () => {
    const criteria = { acceptIf: [], rejectIf: ["Tests fail"], risks: [] };
    const result = { testsPassed: false, output: "", filesChanged: [] };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.unmet.some(c => c.includes("Tests fail")));
  });

  it("rejectIf deleted files: violated when output mentions delete", () => {
    const criteria = { acceptIf: [], rejectIf: ["Files deleted without authorization"], risks: [] };
    const result = { output: "Deleted old config files", filesChanged: [], testsPassed: true };
    const evaluation = evaluateCriteria(criteria, result);

    assert.ok(evaluation.unmet.some(c => c.includes("deleted without authorization")));
  });

  it("score calculation: partial success", () => {
    const criteria = {
      acceptIf: ["Tests pass", "Target files modified", "No errors"],
      rejectIf: [],
      risks: [],
    };
    const result = {
      testsPassed: true,
      filesChanged: ["config.json"],
      output: "",
      error: "Minor warning",
    };
    const evaluation = evaluateCriteria(criteria, result);

    // Should have 2 met (tests pass, files modified) and 1 unmet (no errors)
    assert.equal(evaluation.met.length, 2);
    assert.equal(evaluation.unmet.length, 1);
    assert.ok(Math.abs(evaluation.score - 0.667) < 0.01);
  });

  it("null criteria: returns empty evaluation", () => {
    const result = { output: "test", filesChanged: [], testsPassed: true };
    const evaluation = evaluateCriteria(null, result);

    assert.deepStrictEqual(evaluation.met, []);
    assert.deepStrictEqual(evaluation.unmet, []);
    assert.equal(evaluation.score, 0);
  });

  it("null result: returns all criteria as unmet", () => {
    const criteria = { acceptIf: ["Tests pass", "Files modified"], rejectIf: [], risks: [] };
    const evaluation = evaluateCriteria(criteria, null);

    assert.equal(evaluation.met.length, 0);
    assert.equal(evaluation.unmet.length, 2);
    assert.equal(evaluation.score, 0);
  });
});

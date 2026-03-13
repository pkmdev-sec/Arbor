/**
 * Tests for Hierarchy Decomposer
 *
 * Tests task decomposition, dependency analysis, and agent budget estimation for hierarchical swarms.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeTaskScope,
  buildDependencyGraph,
  findModuleBoundaries,
  estimateAgentBudget,
} from "../lib/hierarchy/decomposer.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "arbor-decomposer-test-"));
}

function createProjectStructure(dir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

// ── analyzeTaskScope ─────────────────────────────────────────────────

describe("analyzeTaskScope", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns small complexity for few files", async () => {
    createProjectStructure(dir, {
      "lib/a.mjs": "export const a = 1;",
      "lib/b.mjs": "export const b = 2;",
    });

    const scope = await analyzeTaskScope("Fix a bug in lib", dir);

    assert.equal(scope.estimatedComplexity, "small");
    assert.ok(scope.estimatedFiles <= 15);
    assert.equal(scope.recommendedDepth, 1);
  });

  it("returns medium complexity for moderate file count", async () => {
    // Create 20 code files across directories
    const files = {};
    for (let i = 0; i < 20; i++) {
      files[`src/mod${i}.mjs`] = `export const x${i} = ${i};`;
    }
    createProjectStructure(dir, files);

    const scope = await analyzeTaskScope("Refactor the source code", dir);

    assert.equal(scope.estimatedComplexity, "medium");
    assert.ok(scope.estimatedFiles > 15);
    assert.ok(scope.estimatedFiles <= 50);
  });

  it("returns large complexity for many files", async () => {
    // Create 55 code files across multiple directories
    const files = {};
    for (let i = 0; i < 55; i++) {
      const dirName = `dir${Math.floor(i / 10)}`;
      files[`${dirName}/file${i}.mjs`] = `export const v${i} = ${i};`;
    }
    createProjectStructure(dir, files);

    const scope = await analyzeTaskScope("Full rewrite of all modules", dir);

    assert.equal(scope.estimatedComplexity, "large");
    assert.ok(scope.estimatedFiles > 50);
  });

  it("detects top-level directories", async () => {
    createProjectStructure(dir, {
      "lib/main.mjs": "// main",
      "test/test.mjs": "// test",
      "utils/helpers.mjs": "// helpers",
    });

    const scope = await analyzeTaskScope("Organize modules", dir);

    assert.ok(scope.topLevelDirs.includes("lib"));
    assert.ok(scope.topLevelDirs.includes("test"));
    assert.ok(scope.topLevelDirs.includes("utils"));
  });

  it("returns filesByDir counts", async () => {
    createProjectStructure(dir, {
      "lib/a.mjs": "// a",
      "lib/b.mjs": "// b",
      "test/t.mjs": "// t",
    });

    const scope = await analyzeTaskScope("Add tests", dir);

    assert.ok(scope.filesByDir["lib"] >= 2, "lib should have at least 2 files");
    assert.ok(scope.filesByDir["test"] >= 1, "test should have at least 1 file");
  });

  it("recommends depth 2 for large projects with many directories", async () => {
    const files = {};
    const dirs = ["auth", "api", "db", "utils"];
    for (const d of dirs) {
      for (let i = 0; i < 10; i++) {
        files[`${d}/file${i}.mjs`] = `export const v = ${i};`;
      }
    }
    createProjectStructure(dir, files);

    const scope = await analyzeTaskScope("Refactor everything", dir);

    assert.ok(scope.recommendedDepth >= 2, `Expected depth >= 2, got ${scope.recommendedDepth}`);
  });

  it("handles empty directory", async () => {
    const scope = await analyzeTaskScope("Init project", dir);

    assert.equal(scope.estimatedFiles, 0);
    assert.equal(scope.estimatedComplexity, "small");
    assert.equal(scope.recommendedDepth, 1);
  });

  it("calculates recommendedFanOut between 2 and 5", async () => {
    createProjectStructure(dir, {
      "a/f.mjs": "//",
      "b/f.mjs": "//",
      "c/f.mjs": "//",
    });

    const scope = await analyzeTaskScope("Multi-dir task", dir);
    assert.ok(scope.recommendedFanOut >= 2 && scope.recommendedFanOut <= 5,
      `Expected fanOut in [2,5], got ${scope.recommendedFanOut}`);
  });
});

// ── buildDependencyGraph ─────────────────────────────────────────────

describe("buildDependencyGraph", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds nodes for each file", async () => {
    createProjectStructure(dir, {
      "lib/a.mjs": 'import { b } from "./b.mjs";\nexport const a = b + 1;',
      "lib/b.mjs": "export const b = 42;",
    });

    const graph = await buildDependencyGraph(dir, ["lib/a.mjs", "lib/b.mjs"]);

    assert.equal(graph.nodes.size, 2);
    assert.ok(graph.edges.size >= 0);
  });

  it("detects import edges between files", async () => {
    createProjectStructure(dir, {
      "lib/main.mjs": 'import { helper } from "./helper.mjs";\nconsole.log(helper());',
      "lib/helper.mjs": "export function helper() { return 'hi'; }",
    });

    const graph = await buildDependencyGraph(dir, ["lib/main.mjs", "lib/helper.mjs"]);

    // main.mjs should have an import pointing to helper.mjs
    const mainNodeKey = [...graph.nodes.keys()].find(k => k.includes("main.mjs"));
    const mainNode = graph.nodes.get(mainNodeKey);
    assert.ok(mainNode, "main.mjs node should exist");
    assert.ok(mainNode.imports.length > 0, "main.mjs should have imports");
  });

  it("assigns module based on top-level directory", async () => {
    createProjectStructure(dir, {
      "lib/a.mjs": "export const a = 1;",
      "test/b.mjs": "export const b = 2;",
    });

    const graph = await buildDependencyGraph(dir, ["lib/a.mjs", "test/b.mjs"]);

    const libNode = [...graph.nodes.values()].find(n => n.relativePath === "lib/a.mjs");
    const testNode = [...graph.nodes.values()].find(n => n.relativePath === "test/b.mjs");

    assert.equal(libNode.module, "lib");
    assert.equal(testNode.module, "test");
  });

  it("handles files with no imports", async () => {
    createProjectStructure(dir, {
      "lib/standalone.mjs": "export const value = 42;",
    });

    const graph = await buildDependencyGraph(dir, ["lib/standalone.mjs"]);

    assert.equal(graph.nodes.size, 1);
    const node = [...graph.nodes.values()][0];
    assert.deepEqual(node.imports, []);
  });

  it("handles empty file list", async () => {
    const graph = await buildDependencyGraph(dir, []);

    assert.equal(graph.nodes.size, 0);
    assert.equal(graph.edges.size, 0);
  });

  it("tracks file size", async () => {
    const content = "export const big = 'x'.repeat(1000);";
    createProjectStructure(dir, {
      "lib/big.mjs": content,
    });

    const graph = await buildDependencyGraph(dir, ["lib/big.mjs"]);
    const node = [...graph.nodes.values()][0];

    assert.ok(node.size > 0, "File size should be tracked");
  });
});

// ── findModuleBoundaries ─────────────────────────────────────────────

describe("findModuleBoundaries", () => {
  it("groups files by module", () => {
    // Build a mock graph
    const nodes = new Map();
    const edges = new Map();

    const files = [
      { path: "/proj/lib/a.mjs", relativePath: "lib/a.mjs", module: "lib", imports: [], importedBy: [], isBinary: false, size: 100 },
      { path: "/proj/lib/b.mjs", relativePath: "lib/b.mjs", module: "lib", imports: [], importedBy: [], isBinary: false, size: 200 },
      { path: "/proj/test/t.mjs", relativePath: "test/t.mjs", module: "test", imports: [], importedBy: [], isBinary: false, size: 50 },
    ];

    for (const f of files) {
      nodes.set(f.path, f);
      edges.set(f.path, new Set());
    }

    const boundaries = findModuleBoundaries({ nodes, edges });

    assert.ok(boundaries.length >= 2, "Should find at least 2 module boundaries");
    const names = boundaries.map(b => b.name);
    assert.ok(names.includes("lib"));
    assert.ok(names.includes("test"));
  });

  it("sorts boundaries by file count descending", () => {
    const nodes = new Map();
    const edges = new Map();

    // lib has 3 files, test has 1
    for (let i = 0; i < 3; i++) {
      const key = `/proj/lib/f${i}.mjs`;
      nodes.set(key, { path: key, relativePath: `lib/f${i}.mjs`, module: "lib", imports: [], importedBy: [], isBinary: false, size: 100 });
      edges.set(key, new Set());
    }
    const testKey = "/proj/test/t.mjs";
    nodes.set(testKey, { path: testKey, relativePath: "test/t.mjs", module: "test", imports: [], importedBy: [], isBinary: false, size: 50 });
    edges.set(testKey, new Set());

    const boundaries = findModuleBoundaries({ nodes, edges });

    assert.equal(boundaries[0].name, "lib", "Largest module should be first");
    assert.equal(boundaries[0].fileCount, 3);
  });

  it("calculates internal cohesion", () => {
    const nodes = new Map();
    const edges = new Map();

    const aKey = "/proj/lib/a.mjs";
    const bKey = "/proj/lib/b.mjs";
    // a imports b (both in lib) — 100% internal cohesion
    nodes.set(aKey, { path: aKey, relativePath: "lib/a.mjs", module: "lib", imports: [bKey], importedBy: [], isBinary: false, size: 100 });
    nodes.set(bKey, { path: bKey, relativePath: "lib/b.mjs", module: "lib", imports: [], importedBy: [aKey], isBinary: false, size: 100 });
    edges.set(aKey, new Set([bKey]));
    edges.set(bKey, new Set());

    const boundaries = findModuleBoundaries({ nodes, edges });
    const libBoundary = boundaries.find(b => b.name === "lib");

    assert.equal(libBoundary.internalCohesion, 1.0, "Should be 100% internal cohesion");
  });

  it("marks small modules as leaf", () => {
    const nodes = new Map();
    const edges = new Map();

    // Module with 2 files (< 3 threshold) = leaf
    for (let i = 0; i < 2; i++) {
      const key = `/proj/utils/u${i}.mjs`;
      nodes.set(key, { path: key, relativePath: `utils/u${i}.mjs`, module: "utils", imports: [], importedBy: [], isBinary: false, size: 50 });
      edges.set(key, new Set());
    }

    const boundaries = findModuleBoundaries({ nodes, edges });
    const utilsBoundary = boundaries.find(b => b.name === "utils");

    assert.equal(utilsBoundary.isLeaf, true, "Small module should be marked as leaf");
  });

  it("classifies complexity by file count", () => {
    const nodes = new Map();
    const edges = new Map();

    // Create 25 files in one module (medium = 8-20, large > 20)
    for (let i = 0; i < 25; i++) {
      const key = `/proj/big/f${i}.mjs`;
      nodes.set(key, { path: key, relativePath: `big/f${i}.mjs`, module: "big", imports: [], importedBy: [], isBinary: false, size: 100 });
      edges.set(key, new Set());
    }

    const boundaries = findModuleBoundaries({ nodes, edges });
    const bigBoundary = boundaries.find(b => b.name === "big");

    assert.equal(bigBoundary.complexity, "large");
  });

  it("returns empty array for empty graph", () => {
    const boundaries = findModuleBoundaries({ nodes: new Map(), edges: new Map() });
    assert.deepEqual(boundaries, []);
  });

  it("tracks cross-dependencies between modules", () => {
    const nodes = new Map();
    const edges = new Map();

    const libKey = "/proj/lib/main.mjs";
    const utilKey = "/proj/utils/helper.mjs";

    // lib imports utils — cross-dependency
    nodes.set(libKey, { path: libKey, relativePath: "lib/main.mjs", module: "lib", imports: [utilKey], importedBy: [], isBinary: false, size: 100 });
    nodes.set(utilKey, { path: utilKey, relativePath: "utils/helper.mjs", module: "utils", imports: [], importedBy: [libKey], isBinary: false, size: 50 });
    edges.set(libKey, new Set([utilKey]));
    edges.set(utilKey, new Set());

    const boundaries = findModuleBoundaries({ nodes, edges });
    const libBoundary = boundaries.find(b => b.name === "lib");

    assert.ok(libBoundary.crossDependencies["utils"] >= 1, "Should track cross-dependency to utils");
  });
});

// ── estimateAgentBudget ──────────────────────────────────────────────

describe("estimateAgentBudget", () => {
  it("counts workers and coordinators", () => {
    const tree = {
      root: {
        type: "coordinator",
        children: [
          { type: "worker", children: [] },
          { type: "worker", children: [] },
          { type: "worker", children: [] },
        ],
      },
    };

    const budget = estimateAgentBudget(tree);

    assert.equal(budget.workers, 3);
    assert.equal(budget.coordinators, 1);
  });

  it("includes infrastructure overhead in totalAgents", () => {
    const tree = {
      root: {
        type: "coordinator",
        children: [
          { type: "worker", children: [] },
          { type: "worker", children: [] },
        ],
      },
    };

    const budget = estimateAgentBudget(tree);

    // Total should be workers + coordinators + infrastructure overhead
    // overhead = 1.0 (governor) + 0.5 * coordinators + 0.25 (IPC)
    const expectedOverhead = 1.0 + 0.5 * budget.coordinators + 0.25;
    const expectedTotal = budget.workers + budget.coordinators + expectedOverhead;
    assert.equal(budget.totalAgents, expectedTotal);
  });

  it("calculates maxConcurrent from level counts", () => {
    const tree = {
      root: {
        type: "coordinator",
        children: [
          {
            type: "coordinator",
            children: [
              { type: "worker", children: [] },
              { type: "worker", children: [] },
            ],
          },
          {
            type: "coordinator",
            children: [
              { type: "worker", children: [] },
            ],
          },
        ],
      },
    };

    const budget = estimateAgentBudget(tree);

    // Level 0: 1 (root), Level 1: 2 (sub-coords), Level 2: 3 (workers)
    // maxConcurrent = max(1, 2, 3) + ceil(overhead)
    assert.ok(budget.maxConcurrent >= 3, `maxConcurrent should be at least 3, got ${budget.maxConcurrent}`);
  });

  it("provides byLevel breakdown", () => {
    const tree = {
      root: {
        type: "coordinator",
        children: [
          { type: "worker", children: [] },
          { type: "worker", children: [] },
        ],
      },
    };

    const budget = estimateAgentBudget(tree);

    assert.equal(budget.byLevel[0], 1, "Level 0 should have 1 agent (root)");
    assert.equal(budget.byLevel[1], 2, "Level 1 should have 2 agents (workers)");
  });

  it("estimates cost", () => {
    const tree = {
      root: {
        type: "coordinator",
        children: [
          { type: "worker", children: [] },
        ],
      },
    };

    const budget = estimateAgentBudget(tree);

    assert.ok(budget.estimatedCost > 0, "Estimated cost should be positive");
    assert.equal(typeof budget.estimatedCost, "number");
  });

  it("handles single worker (no children)", () => {
    const tree = {
      root: {
        type: "worker",
        children: [],
      },
    };

    const budget = estimateAgentBudget(tree);

    assert.equal(budget.workers, 1);
    assert.equal(budget.coordinators, 0);
  });

  it("handles deep hierarchy", () => {
    const tree = {
      root: {
        type: "coordinator",
        children: [
          {
            type: "coordinator",
            children: [
              {
                type: "coordinator",
                children: [
                  { type: "worker", children: [] },
                ],
              },
            ],
          },
        ],
      },
    };

    const budget = estimateAgentBudget(tree);

    assert.equal(budget.workers, 1);
    assert.equal(budget.coordinators, 3);
    assert.ok(budget.byLevel[0] === 1);
    assert.ok(budget.byLevel[1] === 1);
    assert.ok(budget.byLevel[2] === 1);
    assert.ok(budget.byLevel[3] === 1);
  });
});

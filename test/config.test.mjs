/**
 * Tests for Configuration Module
 *
 * Tests model resolution, constants, and configuration defaults.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, TOOL_CALL_RE, ALLOWED_MODELS, DEPTH, MAX_BUFFER_SIZE, DEFAULT_EXCLUDES } from "../lib/config.mjs";

describe("resolveModel", () => {
  it("resolves 'sonnet' to sonnet[1m]", () => {
    const result = resolveModel("sonnet");
    assert.ok(result.startsWith("sonnet"), `Expected sonnet prefix, got: ${result}`);
  });

  it("resolves 'opus' to opus[1m]", () => {
    const result = resolveModel("opus");
    assert.ok(result.startsWith("opus"), `Expected opus prefix, got: ${result}`);
  });

  it("returns null for unknown model", () => {
    assert.equal(resolveModel("gpt-4"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(resolveModel(""), null);
  });
});

describe("TOOL_CALL_RE", () => {
  it("matches Read(", () => {
    assert.ok(TOOL_CALL_RE.test("Read("));
  });

  it("matches Bash(", () => {
    assert.ok(TOOL_CALL_RE.test("some text Bash(command)"));
  });

  it("matches all 8 tools", () => {
    const tools = ["Read", "Grep", "Bash", "Edit", "Write", "Glob", "WebSearch", "WebFetch"];
    for (const tool of tools) {
      assert.ok(TOOL_CALL_RE.test(`${tool}(`), `Should match ${tool}`);
    }
  });

  it("does not match non-tool words", () => {
    assert.ok(!TOOL_CALL_RE.test("Reading files"));
    assert.ok(!TOOL_CALL_RE.test("no tools here"));
  });

  it("captures the tool name in group 1", () => {
    const m = "Read(".match(TOOL_CALL_RE);
    assert.equal(m[1], "Read");
  });
});

describe("DEPTH presets", () => {
  it("has shallow, normal, thorough presets", () => {
    assert.ok(DEPTH.shallow);
    assert.ok(DEPTH.normal);
    assert.ok(DEPTH.thorough);
  });

  it("thorough has higher turns than shallow", () => {
    assert.ok(DEPTH.thorough.turns > DEPTH.shallow.turns);
  });

  it("each preset has turns, budget, verifyModel", () => {
    for (const [name, preset] of Object.entries(DEPTH)) {
      assert.ok(typeof preset.turns === "number", `${name}.turns should be number`);
      assert.ok(typeof preset.budget === "number", `${name}.budget should be number`);
      assert.ok(typeof preset.verifyModel === "string", `${name}.verifyModel should be string`);
    }
  });
});

describe("constants", () => {
  it("MAX_BUFFER_SIZE is 50MB", () => {
    assert.equal(MAX_BUFFER_SIZE, 52428800);
  });

  it("DEFAULT_EXCLUDES includes node_modules and .git", () => {
    assert.ok(DEFAULT_EXCLUDES.includes("node_modules"));
    assert.ok(DEFAULT_EXCLUDES.includes(".git"));
  });
});

describe("validateConfig", () => {
  it("validates basic object schema", async () => {
    const { validateConfig } = await import("../lib/config.mjs");
    const schema = {
      properties: {
        name: { type: "string", required: true },
        count: { type: "number", required: false }
      }
    };

    // Valid config
    assert.doesNotThrow(() => {
      validateConfig({ name: "test", count: 5 }, schema, "test.json");
    });

    // Missing required field
    assert.throws(() => {
      validateConfig({ count: 5 }, schema, "test.json");
    }, /name/);
  });

  it("validates nested objects", async () => {
    const { validateConfig } = await import("../lib/config.mjs");
    const schema = {
      properties: {
        server: {
          type: "object",
          properties: {
            host: { type: "string", required: true },
            port: { type: "number", required: true }
          }
        }
      }
    };

    // Valid nested config
    assert.doesNotThrow(() => {
      validateConfig({ server: { host: "localhost", port: 3000 } }, schema, "test.json");
    });

    // Invalid nested field
    assert.throws(() => {
      validateConfig({ server: { host: "localhost", port: "3000" } }, schema, "test.json");
    }, /port/);
  });

  it("validates arrays", async () => {
    const { validateConfig } = await import("../lib/config.mjs");
    const schema = {
      properties: {
        tags: { type: "array", itemType: "string" }
      }
    };

    // Valid array
    assert.doesNotThrow(() => {
      validateConfig({ tags: ["tag1", "tag2"] }, schema, "test.json");
    });

    // Invalid array item type
    assert.throws(() => {
      validateConfig({ tags: ["tag1", 123] }, schema, "test.json");
    }, /tags\[1\]/);

    // Non-array value
    assert.throws(() => {
      validateConfig({ tags: "not-an-array" }, schema, "test.json");
    }, /array/);
  });

  it("detects circular references", async () => {
    const { validateConfig } = await import("../lib/config.mjs");
    const schema = {
      properties: {
        data: {
          type: "object",
          properties: {
            nested: { type: "object" }
          }
        }
      }
    };

    const circular = { data: {} };
    circular.data.nested = circular.data; // circular reference to parent

    assert.throws(() => {
      validateConfig(circular, schema, "test.json");
    }, /circular reference/i);
  });

  it("handles type mismatches", async () => {
    const { validateConfig } = await import("../lib/config.mjs");
    const schema = {
      properties: {
        value: { type: "string" }
      }
    };

    assert.throws(() => {
      validateConfig({ value: 123 }, schema, "test.json");
    }, /value.*expected.*string/i);
  });
});

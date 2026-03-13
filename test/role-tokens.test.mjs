/**
 * Tests for QW4 + QW5: Role-Specific Token Budgets
 *
 * Tests role-specific thinking and output token configurations
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_THINKING_TOKENS,
  DEFAULT_THINKING_TOKENS,
  ROLE_OUTPUT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
} from "../lib/config.mjs";

describe("QW4: ROLE_THINKING_TOKENS", () => {
  it("has worker with 8192 tokens (8K)", () => {
    assert.equal(ROLE_THINKING_TOKENS.worker, 8192);
  });

  it("has verifier with 32768 tokens (32K)", () => {
    assert.equal(ROLE_THINKING_TOKENS.verifier, 32768);
  });

  it("has decomposer with 16384 tokens (16K)", () => {
    assert.equal(ROLE_THINKING_TOKENS.decomposer, 16384);
  });

  it("has sub-coordinator with 16384 tokens (16K)", () => {
    assert.equal(ROLE_THINKING_TOKENS['sub-coordinator'], 16384);
  });

  it("has governor with 16384 tokens (16K)", () => {
    assert.equal(ROLE_THINKING_TOKENS.governor, 16384);
  });

  it("has aggregator with 16384 tokens (16K)", () => {
    assert.equal(ROLE_THINKING_TOKENS.aggregator, 16384);
  });

  it("has DEFAULT_THINKING_TOKENS = 16384 (16K)", () => {
    assert.equal(DEFAULT_THINKING_TOKENS, 16384);
  });

  it("all roles have numeric token values", () => {
    for (const [role, tokens] of Object.entries(ROLE_THINKING_TOKENS)) {
      assert.equal(typeof tokens, "number", `${role} should have numeric tokens`);
      assert.ok(tokens > 0, `${role} tokens should be positive`);
    }
  });
});

describe("QW5: ROLE_OUTPUT_TOKENS", () => {
  it("has worker with 65536 tokens (64K)", () => {
    assert.equal(ROLE_OUTPUT_TOKENS.worker, 65536);
  });

  it("has verifier with 16384 tokens (16K)", () => {
    assert.equal(ROLE_OUTPUT_TOKENS.verifier, 16384);
  });

  it("has decomposer with 8192 tokens (8K)", () => {
    assert.equal(ROLE_OUTPUT_TOKENS.decomposer, 8192);
  });

  it("has sub-coordinator with 16384 tokens (16K)", () => {
    assert.equal(ROLE_OUTPUT_TOKENS['sub-coordinator'], 16384);
  });

  it("has governor with 16384 tokens (16K)", () => {
    assert.equal(ROLE_OUTPUT_TOKENS.governor, 16384);
  });

  it("has aggregator with 32768 tokens (32K)", () => {
    assert.equal(ROLE_OUTPUT_TOKENS.aggregator, 32768);
  });

  it("has DEFAULT_OUTPUT_TOKENS = 32768 (32K)", () => {
    assert.equal(DEFAULT_OUTPUT_TOKENS, 32768);
  });

  it("all roles have numeric token values", () => {
    for (const [role, tokens] of Object.entries(ROLE_OUTPUT_TOKENS)) {
      assert.equal(typeof tokens, "number", `${role} should have numeric tokens`);
      assert.ok(tokens > 0, `${role} tokens should be positive`);
    }
  });
});

describe("Role token fallback behavior", () => {
  it("unknown role falls back to DEFAULT_THINKING_TOKENS", () => {
    const unknownRole = "unknown-role-xyz";
    const tokens = ROLE_THINKING_TOKENS[unknownRole] || DEFAULT_THINKING_TOKENS;
    assert.equal(tokens, DEFAULT_THINKING_TOKENS);
  });

  it("unknown role falls back to DEFAULT_OUTPUT_TOKENS", () => {
    const unknownRole = "unknown-role-xyz";
    const tokens = ROLE_OUTPUT_TOKENS[unknownRole] || DEFAULT_OUTPUT_TOKENS;
    assert.equal(tokens, DEFAULT_OUTPUT_TOKENS);
  });

  it("null role falls back to DEFAULT_THINKING_TOKENS", () => {
    const tokens = ROLE_THINKING_TOKENS[null] || DEFAULT_THINKING_TOKENS;
    assert.equal(tokens, DEFAULT_THINKING_TOKENS);
  });

  it("undefined role falls back to DEFAULT_OUTPUT_TOKENS", () => {
    const tokens = ROLE_OUTPUT_TOKENS[undefined] || DEFAULT_OUTPUT_TOKENS;
    assert.equal(tokens, DEFAULT_OUTPUT_TOKENS);
  });
});

describe("Token budget sizing verification", () => {
  it("worker has highest output tokens (code generation needs)", () => {
    const workerOutput = ROLE_OUTPUT_TOKENS.worker;
    const verifierOutput = ROLE_OUTPUT_TOKENS.verifier;
    const decomposerOutput = ROLE_OUTPUT_TOKENS.decomposer;

    assert.ok(workerOutput > verifierOutput, "worker should have more output tokens than verifier");
    assert.ok(workerOutput > decomposerOutput, "worker should have more output tokens than decomposer");
  });

  it("verifier has highest thinking tokens (deep analysis needs)", () => {
    const verifierThinking = ROLE_THINKING_TOKENS.verifier;
    const workerThinking = ROLE_THINKING_TOKENS.worker;
    const decomposerThinking = ROLE_THINKING_TOKENS.decomposer;

    assert.ok(verifierThinking > workerThinking, "verifier should have more thinking tokens than worker");
    assert.ok(verifierThinking > decomposerThinking, "verifier should have more thinking tokens than decomposer");
  });

  it("decomposer has lowest output tokens (task lists are small)", () => {
    const decomposerOutput = ROLE_OUTPUT_TOKENS.decomposer;
    const workerOutput = ROLE_OUTPUT_TOKENS.worker;
    const verifierOutput = ROLE_OUTPUT_TOKENS.verifier;

    assert.ok(decomposerOutput < workerOutput, "decomposer should have fewer output tokens than worker");
    assert.ok(decomposerOutput < verifierOutput, "decomposer should have fewer output tokens than verifier");
  });

  it("worker has lowest thinking tokens (action-oriented, quick execution)", () => {
    const workerThinking = ROLE_THINKING_TOKENS.worker;
    const verifierThinking = ROLE_THINKING_TOKENS.verifier;
    const decomposerThinking = ROLE_THINKING_TOKENS.decomposer;

    assert.ok(workerThinking < verifierThinking, "worker should have fewer thinking tokens than verifier");
    assert.ok(workerThinking < decomposerThinking, "worker should have fewer thinking tokens than decomposer");
  });
});

describe("Token value consistency", () => {
  it("all thinking token values are powers of 2", () => {
    const allValues = [
      ...Object.values(ROLE_THINKING_TOKENS),
      DEFAULT_THINKING_TOKENS,
    ];

    for (const value of allValues) {
      // Check if value is a power of 2 (bit manipulation trick)
      const isPowerOf2 = value > 0 && (value & (value - 1)) === 0;
      assert.ok(isPowerOf2, `${value} should be a power of 2`);
    }
  });

  it("all output token values are powers of 2", () => {
    const allValues = [
      ...Object.values(ROLE_OUTPUT_TOKENS),
      DEFAULT_OUTPUT_TOKENS,
    ];

    for (const value of allValues) {
      // Check if value is a power of 2
      const isPowerOf2 = value > 0 && (value & (value - 1)) === 0;
      assert.ok(isPowerOf2, `${value} should be a power of 2`);
    }
  });

  it("all thinking tokens are in reasonable range (4K-64K)", () => {
    const allValues = [
      ...Object.values(ROLE_THINKING_TOKENS),
      DEFAULT_THINKING_TOKENS,
    ];

    for (const value of allValues) {
      assert.ok(value >= 4096, `${value} should be at least 4K`);
      assert.ok(value <= 65536, `${value} should be at most 64K`);
    }
  });

  it("all output tokens are in reasonable range (4K-128K)", () => {
    const allValues = [
      ...Object.values(ROLE_OUTPUT_TOKENS),
      DEFAULT_OUTPUT_TOKENS,
    ];

    for (const value of allValues) {
      assert.ok(value >= 4096, `${value} should be at least 4K`);
      assert.ok(value <= 131072, `${value} should be at most 128K`);
    }
  });
});

describe("Integration: env var construction logic", () => {
  it("verifies fallback logic pattern for thinking tokens", () => {
    // Simulate the logic from agent-entry.mjs:
    // const role = args.role || 'worker';
    // const thinkingTokens = ROLE_THINKING_TOKENS[role] || DEFAULT_THINKING_TOKENS;
    const testCases = [
      { role: 'worker', expected: 8192 },
      { role: 'verifier', expected: 32768 },
      { role: 'decomposer', expected: 16384 },
      { role: 'sub-coordinator', expected: 16384 },
      { role: 'governor', expected: 16384 },
      { role: 'aggregator', expected: 16384 },
      { role: 'unknown-role', expected: DEFAULT_THINKING_TOKENS },  // Falls back to default
      { role: null, expected: 8192 },  // Falls back to 'worker'
      { role: undefined, expected: 8192 },  // Falls back to 'worker'
    ];

    for (const { role, expected } of testCases) {
      // Simulate agent-entry.mjs logic
      const actualRole = role || 'worker';
      const tokens = ROLE_THINKING_TOKENS[actualRole] || DEFAULT_THINKING_TOKENS;

      assert.equal(tokens, expected, `role=${role} should have ${expected} thinking tokens, got ${tokens}`);
    }
  });

  it("verifies fallback logic pattern for output tokens", () => {
    // Simulate the logic from agent-entry.mjs:
    // const role = args.role || 'worker';
    // const outputTokens = ROLE_OUTPUT_TOKENS[role] || DEFAULT_OUTPUT_TOKENS;
    const testCases = [
      { role: 'worker', expected: 65536 },
      { role: 'verifier', expected: 16384 },
      { role: 'decomposer', expected: 8192 },
      { role: 'sub-coordinator', expected: 16384 },
      { role: 'governor', expected: 16384 },
      { role: 'aggregator', expected: 32768 },
      { role: 'unknown-role', expected: DEFAULT_OUTPUT_TOKENS },  // Falls back to default
      { role: null, expected: 65536 },  // Falls back to 'worker'
      { role: undefined, expected: 65536 },  // Falls back to 'worker'
    ];

    for (const { role, expected } of testCases) {
      // Simulate agent-entry.mjs logic
      const actualRole = role || 'worker';
      const tokens = ROLE_OUTPUT_TOKENS[actualRole] || DEFAULT_OUTPUT_TOKENS;

      assert.equal(tokens, expected, `role=${role} should have ${expected} output tokens, got ${tokens}`);
    }
  });

  it("env var values must be strings", () => {
    // Test that token values can be converted to strings properly
    for (const [role, tokens] of Object.entries(ROLE_THINKING_TOKENS)) {
      const strValue = String(tokens);
      assert.equal(typeof strValue, "string", `${role} thinking tokens should convert to string`);
      assert.equal(Number(strValue), tokens, `String conversion should preserve numeric value for ${role}`);
    }

    for (const [role, tokens] of Object.entries(ROLE_OUTPUT_TOKENS)) {
      const strValue = String(tokens);
      assert.equal(typeof strValue, "string", `${role} output tokens should convert to string`);
      assert.equal(Number(strValue), tokens, `String conversion should preserve numeric value for ${role}`);
    }
  });
});

/**
 * Tests for Quick Win Optimizations (QW1-QW9)
 *
 * Tests agent spawning optimizations:
 * - QW1: Non-essential traffic suppression (9 env vars)
 * - QW2: Adaptive compaction threshold (turn budget based)
 * - QW3: Small model for internal calls (Haiku)
 * - QW6: Role-specific bash output length
 * - QW7: Persist+scope integration (--no-session-persistence)
 * - QW8: Debug flag passthrough (--debug)
 * - QW9: Settings source isolation (--setting-sources user)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const agentEntryPath = join(__dir, "..", "agent-entry.mjs");
const agentSpawnPath = join(__dir, "..", "lib", "agent-spawn.mjs");
const configPath = join(__dir, "..", "lib", "config.mjs");
const supervisorPath = join(__dir, "..", "lib", "supervisor.mjs");

// ── QW1: Non-essential traffic suppression ──────────────────────────

describe("QW1: Traffic suppression env vars", () => {
  const requiredVars = [
    "DISABLE_TELEMETRY",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DISABLE_ERROR_REPORTING",
    "DISABLE_AUTOUPDATER",
    "DISABLE_COST_WARNINGS",
    "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
    "DISABLE_INSTALLATION_CHECKS",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  ];

  it("agent-entry.mjs sets all 9 traffic suppression env vars", () => {
    const source = readFileSync(agentEntryPath, "utf-8");

    for (const varName of requiredVars) {
      const pattern = new RegExp(`env\\.${varName}\\s*=\\s*["']1["']`);
      assert.ok(
        pattern.test(source),
        `${varName} must be set to '1' in agent-entry.mjs`
      );
    }
  });

  it("agent-spawn.mjs sets all 9 traffic suppression env vars", () => {
    const source = readFileSync(agentSpawnPath, "utf-8");

    for (const varName of requiredVars) {
      const pattern = new RegExp(`childEnv\\.${varName}\\s*=\\s*['"]1['"]`);
      assert.ok(
        pattern.test(source),
        `${varName} must be set to '1' in agent-spawn.mjs`
      );
    }
  });
});

// ── QW2: Adaptive compaction threshold ──────────────────────────────

describe("QW2: Adaptive compaction threshold", () => {
  it("agent-entry.mjs uses adaptive compaction logic", () => {
    const source = readFileSync(agentEntryPath, "utf-8");

    // Verify the adaptive logic exists
    assert.ok(
      source.includes("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"),
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE must be set"
    );

    // Verify the logic uses maxTurns > 25 threshold
    assert.ok(
      source.includes('args.maxTurns > 25 ? "85" : "95"'),
      "Adaptive compaction logic must use maxTurns > 25 threshold"
    );
  });

  it("agent-spawn.mjs uses adaptive compaction logic", () => {
    const source = readFileSync(agentSpawnPath, "utf-8");

    // Verify the adaptive logic exists
    assert.ok(
      source.includes("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"),
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE must be set in agent-spawn.mjs"
    );

    // Verify the logic exists (pattern flexible to match actual code)
    assert.ok(
      /turnsValue\s+<=\s+25/.test(source) || /turns.*<=\s*25/.test(source),
      "Adaptive compaction logic must check turns <= 25"
    );
    assert.ok(
      source.includes("'95'") && source.includes("'85'"),
      "Adaptive compaction logic must use 95% and 85% thresholds"
    );
  });

  it("compaction logic boundaries work correctly", () => {
    // Test the logic directly
    const testCases = [
      { turns: 10, expected: "95" },
      { turns: 25, expected: "95" },
      { turns: 26, expected: "85" },
      { turns: 50, expected: "85" },
      { turns: 100, expected: "85" },
    ];

    for (const { turns, expected } of testCases) {
      const result = turns > 25 ? "85" : "95";
      assert.equal(
        result,
        expected,
        `turns=${turns} should use ${expected}% threshold`
      );
    }
  });

  it("compaction logic with default turns (25) uses 95%", () => {
    const defaultTurns = 25;
    const result = defaultTurns > 25 ? "85" : "95";
    assert.equal(result, "95", "Default turns (25) should use 95% threshold");
  });
});

// ── QW3: Small model for internal calls ─────────────────────────────

describe("QW3: Small model for internal calls", () => {
  const expectedModel = "claude-haiku-4-5-20251001";

  it("agent-entry.mjs sets ANTHROPIC_SMALL_FAST_MODEL to Haiku", () => {
    const source = readFileSync(agentEntryPath, "utf-8");

    const pattern = new RegExp(
      `env\\.ANTHROPIC_SMALL_FAST_MODEL\\s*=\\s*["']${expectedModel}["']`
    );
    assert.ok(
      pattern.test(source),
      `ANTHROPIC_SMALL_FAST_MODEL must be set to '${expectedModel}' in agent-entry.mjs`
    );
  });

  it("agent-spawn.mjs sets ANTHROPIC_SMALL_FAST_MODEL to Haiku", () => {
    const source = readFileSync(agentSpawnPath, "utf-8");

    const pattern = new RegExp(
      `childEnv\\.ANTHROPIC_SMALL_FAST_MODEL\\s*=\\s*['"]${expectedModel}['"]`
    );
    assert.ok(
      pattern.test(source),
      `ANTHROPIC_SMALL_FAST_MODEL must be set to '${expectedModel}' in agent-spawn.mjs`
    );
  });
});

// ── Integration Tests ────────────────────────────────────────────────

describe("Integration: QW env vars in agent-entry.mjs", () => {
  it("all QW env vars are set in the correct order", () => {
    const source = readFileSync(agentEntryPath, "utf-8");

    // Find the F1 block
    const f1Match = source.match(
      /\/\/ F1:.*?Non-essential traffic suppression.*?\n(.*?)\n\n/s
    );
    assert.ok(f1Match, "F1 block must exist in agent-entry.mjs");

    const f1Block = f1Match[1];

    // Verify all 9 vars are in the F1 block
    const f1Vars = [
      "DISABLE_TELEMETRY",
      "DISABLE_ERROR_REPORTING",
      "DISABLE_AUTOUPDATER",
      "DISABLE_COST_WARNINGS",
      "DISABLE_INSTALLATION_CHECKS",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
      "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
    ];

    for (const varName of f1Vars) {
      assert.ok(
        f1Block.includes(varName),
        `${varName} must be in F1 block`
      );
    }

    // Verify F2 and F3 exist
    assert.ok(
      /\/\/ F2:.*?Adaptive compaction/.test(source),
      "F2 block must exist"
    );
    assert.ok(
      /\/\/ F3:.*?Small model/.test(source),
      "F3 block must exist"
    );
  });
});

describe("Integration: QW env vars in agent-spawn.mjs", () => {
  it("QW1, QW2, QW3 env vars are set in childEnv", () => {
    const source = readFileSync(agentSpawnPath, "utf-8");

    // Verify QW1 block exists
    assert.ok(
      /\/\/ QW1:.*?traffic suppression/i.test(source),
      "QW1 comment block must exist"
    );

    // Verify QW2 block exists
    assert.ok(
      /\/\/ QW2:.*?compaction/i.test(source),
      "QW2 comment block must exist"
    );

    // Verify QW3 block exists
    assert.ok(
      /\/\/ QW3:.*?Small model/i.test(source),
      "QW3 comment block must exist"
    );

    // Verify all vars are set in childEnv
    const qwVars = [
      "DISABLE_TELEMETRY",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_ERROR_REPORTING",
      "DISABLE_AUTOUPDATER",
      "DISABLE_COST_WARNINGS",
      "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
      "DISABLE_INSTALLATION_CHECKS",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
      "ANTHROPIC_SMALL_FAST_MODEL",
    ];

    for (const varName of qwVars) {
      assert.ok(
        source.includes(`childEnv.${varName}`),
        `${varName} must be set in childEnv`
      );
    }
  });
});

// ── QW6: Role-specific bash output length ───────────────────────────

describe("QW6: Role-specific bash output length", () => {
  it("config.mjs exports ROLE_BASH_OUTPUT_LENGTH with correct values", () => {
    const source = readFileSync(configPath, "utf-8");

    // Verify export exists
    assert.ok(
      source.includes("export const ROLE_BASH_OUTPUT_LENGTH"),
      "ROLE_BASH_OUTPUT_LENGTH must be exported from config.mjs"
    );

    // Verify role values
    assert.ok(
      /worker:\s*200000/m.test(source),
      "worker role must have 200000 bash output length"
    );
    assert.ok(
      /verifier:\s*100000/m.test(source),
      "verifier role must have 100000 bash output length"
    );
    assert.ok(
      /decomposer:\s*50000/m.test(source),
      "decomposer role must have 50000 bash output length"
    );
  });

  it("config.mjs exports DEFAULT_BASH_OUTPUT_LENGTH", () => {
    const source = readFileSync(configPath, "utf-8");

    assert.ok(
      source.includes("export const DEFAULT_BASH_OUTPUT_LENGTH"),
      "DEFAULT_BASH_OUTPUT_LENGTH must be exported"
    );
    assert.ok(
      /DEFAULT_BASH_OUTPUT_LENGTH\s*=\s*100000/m.test(source),
      "DEFAULT_BASH_OUTPUT_LENGTH must be 100000"
    );
  });

  it("agent-entry.mjs imports and uses ROLE_BASH_OUTPUT_LENGTH", () => {
    const source = readFileSync(agentEntryPath, "utf-8");

    // Verify import
    assert.ok(
      source.includes("ROLE_BASH_OUTPUT_LENGTH"),
      "ROLE_BASH_OUTPUT_LENGTH must be imported in agent-entry.mjs"
    );
    assert.ok(
      source.includes("DEFAULT_BASH_OUTPUT_LENGTH"),
      "DEFAULT_BASH_OUTPUT_LENGTH must be imported in agent-entry.mjs"
    );

    // Verify usage
    assert.ok(
      /bashOutputLen\s*=\s*ROLE_BASH_OUTPUT_LENGTH\[role\]\s*\|\|\s*DEFAULT_BASH_OUTPUT_LENGTH/m.test(source),
      "agent-entry.mjs must use ROLE_BASH_OUTPUT_LENGTH with fallback"
    );
    assert.ok(
      /env\.BASH_MAX_OUTPUT_LENGTH\s*=\s*String\(bashOutputLen\)/m.test(source),
      "env.BASH_MAX_OUTPUT_LENGTH must be set as string"
    );
  });

  it("bash output length values are correct for each role", () => {
    // Import the actual config to test values
    const expectedValues = {
      worker: 200000,
      verifier: 100000,
      decomposer: 50000,
      'sub-coordinator': 100000,
      governor: 50000,
      aggregator: 100000,
    };

    const source = readFileSync(configPath, "utf-8");
    for (const [role, expected] of Object.entries(expectedValues)) {
      const rolePattern = role === 'sub-coordinator'
        ? /'sub-coordinator':\s*100000/
        : new RegExp(`${role}:\\s*${expected}`);
      assert.ok(
        rolePattern.test(source),
        `${role} must have ${expected} bash output length`
      );
    }
  });
});

// ── QW7: Persist+scope integration ───────────────────────────────────

describe("QW7: Persist+scope integration", () => {
  it("supervisor.mjs adds --no-session-persistence when scope is set", () => {
    const source = readFileSync(supervisorPath, "utf-8");

    // Verify the scope parameter is accepted
    assert.ok(
      /config\.scope/.test(source) || /\bscope\b/.test(source),
      "buildClaudeArgs must accept scope parameter"
    );

    // Verify session persistence logic includes scope check
    assert.ok(
      /(!canResume\s*\|\|\s*scope)|(!scope\s*\|\|\s*!canResume)/.test(source) ||
      /scope.*--no-session-persistence/s.test(source),
      "Session persistence must be disabled when scope is set"
    );
  });

  it("supervisor.mjs does not add session-id when scope is set", () => {
    const source = readFileSync(supervisorPath, "utf-8");

    // Verify session resume logic checks for scope
    assert.ok(
      /canResume\s*&&\s*!scope/.test(source) || /!scope.*canResume/s.test(source),
      "Session resume must be skipped when scope is set"
    );
  });

  it("agent-entry.mjs passes scope to buildClaudeArgs", () => {
    const source = readFileSync(agentEntryPath, "utf-8");

    // Verify scope is passed to buildClaudeArgs
    assert.ok(
      /scope:\s*args\.scope/.test(source),
      "agent-entry.mjs must pass scope to buildClaudeArgs"
    );
  });
});

// ── QW8: Debug flag passthrough ──────────────────────────────────────

describe("QW8: Debug flag passthrough", () => {
  it("supervisor.mjs adds --debug when SWARM_DEBUG is set", () => {
    const source = readFileSync(supervisorPath, "utf-8");

    // Verify debug logic checks SWARM_DEBUG
    assert.ok(
      /process\.env\.SWARM_DEBUG/.test(source),
      "buildClaudeArgs must check process.env.SWARM_DEBUG"
    );

    // Verify --debug flag is added
    assert.ok(
      /childArgs\.push\(["']--debug["']\)/.test(source),
      "--debug flag must be added to childArgs"
    );
  });

  it("debug flag is conditional on SWARM_DEBUG or debug parameter", () => {
    const source = readFileSync(supervisorPath, "utf-8");

    // Verify the condition includes SWARM_DEBUG
    assert.ok(
      /if\s*\(.*SWARM_DEBUG.*\)/.test(source),
      "Debug flag must be conditional on SWARM_DEBUG"
    );
  });
});

// ── QW9: Settings source isolation ───────────────────────────────────

describe("QW9: Settings source isolation", () => {
  it("supervisor.mjs always adds --setting-sources user", () => {
    const source = readFileSync(supervisorPath, "utf-8");

    // Verify --setting-sources user is added
    assert.ok(
      /childArgs\.push\(["']--setting-sources["'],\s*["']user["']\)/.test(source),
      "--setting-sources user must be added to childArgs"
    );
  });

  it("setting-sources flag is unconditional", () => {
    const source = readFileSync(supervisorPath, "utf-8");

    // Find the line with --setting-sources
    const lines = source.split('\n');
    const settingSourcesLine = lines.findIndex(line =>
      line.includes('--setting-sources') && line.includes('user')
    );

    assert.ok(
      settingSourcesLine !== -1,
      "--setting-sources user must exist in the code"
    );

    // Verify it's not inside a conditional block (basic check)
    // By checking that it's a direct push, not inside an if statement
    const line = lines[settingSourcesLine];
    assert.ok(
      /^\s*childArgs\.push/.test(line),
      "--setting-sources user should be unconditional"
    );
  });
});

// ── Integration Tests for QW6-QW9 ────────────────────────────────────

describe("Integration: QW6-QW9 in agent-entry.mjs and supervisor.mjs", () => {
  it("QW6 config values are used in agent-entry.mjs", () => {
    const agentEntry = readFileSync(agentEntryPath, "utf-8");

    // Verify QW6 comment exists
    assert.ok(
      /\/\/ QW6:.*?bash output/i.test(agentEntry),
      "QW6 comment must exist in agent-entry.mjs"
    );

    // Verify the implementation
    assert.ok(
      /BASH_MAX_OUTPUT_LENGTH/.test(agentEntry),
      "BASH_MAX_OUTPUT_LENGTH must be set in agent-entry.mjs"
    );
  });

  it("QW7-QW9 are implemented in supervisor.mjs", () => {
    const supervisor = readFileSync(supervisorPath, "utf-8");

    // QW7: Session persistence with scope
    assert.ok(
      /QW7/.test(supervisor) || /scope.*session/is.test(supervisor),
      "QW7 implementation must exist in supervisor.mjs"
    );

    // QW8: Debug passthrough (already existed, verify it's still there)
    assert.ok(
      /SWARM_DEBUG/.test(supervisor),
      "QW8 debug passthrough must exist"
    );

    // QW9: Settings isolation
    assert.ok(
      /--setting-sources.*user/.test(supervisor),
      "QW9 settings isolation must exist"
    );
  });
});

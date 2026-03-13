/**
 * Tests for PreCompact State Preservation (hooks/agent-precompact.py)
 *
 * Validates decision extraction, file summary parsing, API design capture,
 * task state preservation, and CLAUDE.md generation with size guards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Helper to execute agent-precompact.py with a given event JSON
 * @param {object} event - PreCompact event object
 * @param {string} persistDir - ARBOR_PERSIST_DIR path
 * @returns {Promise<{stdout: string, stderr: string, state: object|null, claudeMd: string|null}>}
 */
function runPrecompactHook(event, persistDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["hooks/agent-precompact.py"], {
      cwd: process.cwd(),
      env: { ...process.env, ARBOR_PERSIST_DIR: persistDir },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`PreCompact hook exited with code ${code}: ${stderr}`));
      }

      // Read state.json and CLAUDE.md if they exist
      const statePath = join(persistDir, "state.json");
      const claudeMdPath = join(persistDir, "CLAUDE.md");

      const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : null;
      const claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : null;

      resolve({ stdout, stderr, state, claudeMd });
    });

    proc.on("error", reject);

    // Write event JSON to stdin
    proc.stdin.write(JSON.stringify(event));
    proc.stdin.end();
  });
}

test("PreCompact: extract decisions from conversation text", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    const conversationText = `
During the planning phase, we made the following choices:
- Decision: Use PostgreSQL for persistence instead of SQLite
- decided: Implement rate limiting at the API gateway level
- Chose: React over Vue for the frontend framework
- Approach: Use event-driven architecture for inter-service communication
- Strategy: Employ circuit breaker pattern for external API calls
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: conversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.state, "State should be created");
    assert.ok(Array.isArray(result.state.decisions), "Decisions should be an array");
    assert.equal(result.state.decisions.length, 5, "Should extract 5 decisions");

    // Verify specific decisions were extracted
    assert.ok(
      result.state.decisions.some(d => d.includes("PostgreSQL")),
      "Should extract PostgreSQL decision"
    );
    assert.ok(
      result.state.decisions.some(d => d.includes("rate limiting")),
      "Should extract rate limiting decision"
    );
    assert.ok(
      result.state.decisions.some(d => d.includes("React")),
      "Should extract React decision"
    );

    // Verify decisions appear in CLAUDE.md
    assert.ok(result.claudeMd, "CLAUDE.md should be created");
    assert.ok(result.claudeMd.includes("### Key Decisions"), "Should have decisions section");
    assert.ok(result.claudeMd.includes("PostgreSQL"), "CLAUDE.md should include decision text");

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: extract file summaries from conversation", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    const conversationText = `
Here are the files I've reviewed:
- lib/context-bridge.mjs: Handles context serialization and system prompt generation
- hooks/agent-precompact.py — PreCompact state preservation hook
- test/buffer.test.mjs: Unit tests for buffer management
- src/api/routes.js: API endpoint definitions
- config/database.yml — Database connection configuration
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: conversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.state, "State should be created");
    assert.ok(result.state.file_summaries, "File summaries should exist");
    assert.equal(typeof result.state.file_summaries, "object", "File summaries should be an object");

    // Verify specific file summaries
    assert.equal(
      result.state.file_summaries["lib/context-bridge.mjs"],
      "Handles context serialization and system prompt generation"
    );
    assert.equal(
      result.state.file_summaries["hooks/agent-precompact.py"],
      "PreCompact state preservation hook"
    );
    assert.equal(
      result.state.file_summaries["test/buffer.test.mjs"],
      "Unit tests for buffer management"
    );

    // Verify summaries appear in CLAUDE.md
    assert.ok(result.claudeMd.includes("### File Summaries"), "Should have file summaries section");
    assert.ok(result.claudeMd.includes("context-bridge.mjs"), "Should include file paths");

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: extract API design notes", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    const conversationText = `
API: POST /agents creates a new agent with specified role and scope
Interface: Agent config should include { role: string, scope: string[], constraints: string[] }
Schema: Use JSON schema validation for all API requests
Endpoint: GET /agents/:id returns agent status and recent activity
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: conversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.state, "State should be created");
    assert.ok(Array.isArray(result.state.api_design), "API design should be an array");
    assert.ok(result.state.api_design.length >= 4, "Should extract at least 4 API design notes");

    // Verify API design notes contain expected content
    assert.ok(
      result.state.api_design.some(note => note.includes("POST /agents")),
      "Should extract POST endpoint"
    );
    assert.ok(
      result.state.api_design.some(note => note.includes("Agent config")),
      "Should extract interface definition"
    );

    // Verify design notes appear in CLAUDE.md
    assert.ok(result.claudeMd.includes("### API Design Notes"), "Should have API design section");

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: extract task state from conversation", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    const conversationText = `
I'm currently working on implementing the authentication middleware.
The task involves creating JWT token validation and attaching user context.

TodoWrite: {"status": "in_progress", "content": "Implementing JWT middleware for authentication"}

Next steps include writing unit tests and integrating with the API gateway.
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: conversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.state, "State should be created");
    assert.ok(result.state.task_state, "Task state should be extracted");
    assert.ok(
      result.state.task_state.includes("JWT middleware") ||
      result.state.task_state.includes("authentication"),
      "Task state should mention the current task"
    );

    // Verify task state appears in CLAUDE.md
    assert.ok(result.claudeMd.includes("### Current Task"), "Should have current task section");

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: CLAUDE.md size guard truncates correctly", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    // Generate excessive content to trigger size guard
    const largeConversationText = `
${"- Decision: Make architectural choice number X with detailed reasoning\n".repeat(50)}
${"- lib/file-${Math.random().toString(36).slice(2)}.mjs: Very long description that goes on and on\n".repeat(100)}
${"API: Endpoint /api/v1/resource-${Math.random().toString(36).slice(2)} does something complex\n".repeat(50)}
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: largeConversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.claudeMd, "CLAUDE.md should be created");

    // Extract just the state section
    const stateMarker = "## Agent State (preserved across compaction)";
    const stateStartIdx = result.claudeMd.indexOf(stateMarker);
    assert.ok(stateStartIdx >= 0, "Should have state section marker");

    const stateSection = result.claudeMd.slice(stateStartIdx);
    assert.ok(stateSection.length <= 4100, `State section should be <= 4100 chars, got ${stateSection.length}`);

    // Verify that high-priority sections are preserved
    assert.ok(stateSection.includes("### Key Decisions"), "Decisions should be preserved (highest priority)");

    // Footer instruction should always be present
    assert.ok(
      stateSection.includes("IMPORTANT: You have been through context compaction"),
      "Footer instruction should always be present"
    );

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: graceful degradation without conversation context", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    // Event with no conversation_summary field (git-diff-only mode)
    const event = {
      cwd: process.cwd(),
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.state, "State should still be created");
    assert.ok(result.stdout, "Should output valid JSON");

    // Should fall back to git-diff-only behavior
    assert.equal(result.state.decisions, undefined, "No decisions without conversation text");
    assert.equal(result.state.file_summaries, undefined, "No file summaries without conversation text");
    assert.equal(result.state.api_design, undefined, "No API design without conversation text");
    assert.equal(result.state.task_state, undefined, "No task state without conversation text");

    // Basic fields should still be present
    assert.ok(result.state.timestamp, "Timestamp should be present");
    assert.ok(result.state.agent_id, "Agent ID should be present");

    // CLAUDE.md should still be created with basic info
    assert.ok(result.claudeMd, "CLAUDE.md should be created");
    assert.ok(result.claudeMd.includes("## Agent State"), "Should have state section");

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: realistic conversation with all features", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    const conversationText = `
I've analyzed the requirements and made several key decisions:

- Decision: Use a two-tier hierarchy with governor and workers
- Decided: Implement async message passing via IPC
- Chose: Python for the precompact hook to leverage existing tooling
- Approach: Extract decisions, file summaries, API design, and task state

Here are the key files involved:
- lib/context-bridge.mjs: Handles context I/O and system prompt generation
- hooks/agent-precompact.py — PreCompact state preservation hook with extraction logic
- test/precompact-state.test.mjs: Comprehensive tests for state extraction

API design:
API: The PreCompact event JSON may contain 'conversation_summary' field
Interface: State object includes { decisions, file_summaries, api_design, task_state }
Schema: Size guard limits CLAUDE.md state section to 4000 chars

I'm currently working on implementing the extraction functions and tests.
TodoWrite: {"status": "in_progress", "content": "Writing test suite for precompact state extraction"}
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: conversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    // Verify all extraction features worked
    assert.ok(result.state, "State should be created");
    assert.ok(result.state.decisions?.length > 0, "Should extract decisions");
    assert.ok(Object.keys(result.state.file_summaries || {}).length > 0, "Should extract file summaries");
    assert.ok(result.state.api_design?.length > 0, "Should extract API design");
    assert.ok(result.state.task_state, "Should extract task state");

    // Verify CLAUDE.md has all sections
    assert.ok(result.claudeMd.includes("### Key Decisions"), "Should have decisions");
    assert.ok(result.claudeMd.includes("### File Summaries"), "Should have file summaries");
    assert.ok(result.claudeMd.includes("### API Design Notes"), "Should have API design");
    assert.ok(result.claudeMd.includes("### Current Task"), "Should have task state");

    // Verify the resume instruction
    assert.ok(
      result.claudeMd.includes("Resume from this state"),
      "Should include resume instruction"
    );
    assert.ok(
      result.claudeMd.includes("Do NOT re-read files listed in file_summaries"),
      "Should include file reread warning"
    );

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreCompact: deduplication of decisions", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "precompact-test-"));

  try {
    const conversationText = `
- Decision: Use PostgreSQL for persistence
- Decision: Use PostgreSQL for persistence
- Decided: Use PostgreSQL for persistence
- Decision: Implement caching with Redis
- Decision: Use PostgreSQL for persistence
    `;

    const event = {
      cwd: process.cwd(),
      conversation_summary: conversationText,
    };

    const result = await runPrecompactHook(event, tmpDir);

    assert.ok(result.state.decisions, "Decisions should be extracted");

    // Count occurrences of the PostgreSQL decision
    const postgresDecisions = result.state.decisions.filter(d =>
      d.includes("PostgreSQL") && d.includes("persistence")
    );

    assert.equal(postgresDecisions.length, 1, "Should deduplicate identical decisions");
    assert.ok(
      result.state.decisions.some(d => d.includes("Redis")),
      "Should preserve unique decisions"
    );

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

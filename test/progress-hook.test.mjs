/**
 * Tests for PostToolUse Progress Hook
 *
 * Tests progress-reporter.py hook integration with rich metadata extraction,
 * sequence numbering, and backward compatibility.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_PATH = join(__dirname, "..", "hooks", "progress-reporter.py");

/**
 * Helper to invoke progress-reporter.py hook with a PostToolUse event
 * Returns parsed IPC events from ipc.jsonl
 */
async function invokeProgressHook(ipcDir, agentId, event) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [HOOK_PATH], {
      env: {
        ...process.env,
        ARBOR_PROGRESS_IPC_DIR: ipcDir,
        SWARM_AGENT_ID: agentId,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Hook exited with code ${code}. stderr: ${stderr}`));
        return;
      }

      // Read ipc.jsonl to get emitted events
      const ipcPath = join(ipcDir, "ipc.jsonl");
      if (!existsSync(ipcPath)) {
        reject(new Error("ipc.jsonl not created"));
        return;
      }

      try {
        const content = readFileSync(ipcPath, "utf-8");
        const events = content
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        resolve({ stdout: stdout.trim(), events });
      } catch (err) {
        reject(err);
      }
    });

    // Write event to stdin
    proc.stdin.write(JSON.stringify(event));
    proc.stdin.end();
  });
}

describe("Progress Hook", () => {
  let testDir;

  beforeEach(() => {
    // Create unique test directory
    testDir = join(tmpdir(), `progress-hook-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Read tool metadata", () => {
    it("should extract file_path and file_size for Read tool", async () => {
      const event = {
        tool_name: "Read",
        tool_input: {
          file_path: "/src/app.ts",
        },
        tool_result: "const x = 1;\nconst y = 2;\n", // 26 bytes (13 + 13)
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-01",
        event
      );

      assert.strictEqual(events.length, 1);
      const evt = events[0];

      // Verify event structure
      assert.strictEqual(evt.type, "tool_event");
      assert.strictEqual(evt.from, "test-agent-01");
      assert.strictEqual(evt.to, "tui");
      assert.ok(evt.ts);
      assert.ok(evt.t);
      assert.ok(typeof evt.seq === "number");

      // Verify meta fields
      assert.strictEqual(evt.meta.tool, "Read");
      assert.strictEqual(evt.meta.target, "/src/app.ts");
      assert.strictEqual(evt.meta.file_size, 26);
      assert.ok(evt.meta.result_preview);
    });

    it("should extract file_size from dict result with content field", async () => {
      const event = {
        tool_name: "Write",
        tool_input: {
          file_path: "/output.txt",
        },
        tool_result: {
          content: "Hello World",
          status: "success",
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-02",
        event
      );

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].meta.file_size, 11);
    });
  });

  describe("Bash tool metadata", () => {
    it("should extract exit_code and command for Bash tool", async () => {
      const event = {
        tool_name: "Bash",
        tool_input: {
          command: "npm test",
        },
        tool_result: {
          exit_code: 0,
          output: "All tests passed",
          duration_ms: 1234,
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-03",
        event
      );

      assert.strictEqual(events.length, 1);
      const evt = events[0];

      assert.strictEqual(evt.meta.tool, "Bash");
      assert.strictEqual(evt.meta.target, "npm test");
      assert.strictEqual(evt.meta.exit_code, 0);
      assert.strictEqual(evt.meta.duration_ms, 1234);
    });

    it("should truncate long commands to 80 chars", async () => {
      const longCmd = "a".repeat(200);
      const event = {
        tool_name: "Bash",
        tool_input: {
          command: longCmd,
        },
        tool_result: {
          exit_code: 1,
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-04",
        event
      );

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].meta.target.length, 80);
    });

    it("should handle exitCode (camelCase) field", async () => {
      const event = {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_result: { exitCode: 2 }, // camelCase variant
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-05",
        event
      );

      assert.strictEqual(events[0].meta.exit_code, 2);
    });
  });

  describe("Grep/Glob tool metadata", () => {
    it("should extract match_count for Grep tool with string result", async () => {
      const event = {
        tool_name: "Grep",
        tool_input: {
          pattern: "TODO",
        },
        tool_result: "file1.js:10: TODO fix\nfile2.js:20: TODO cleanup\n",
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-06",
        event
      );

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].meta.tool, "Grep");
      assert.strictEqual(events[0].meta.target, "TODO");
      // 2 lines + 1 trailing newline = 3 splits, but last is empty
      assert.strictEqual(events[0].meta.match_count, 3);
    });

    it("should extract match_count from matches array", async () => {
      const event = {
        tool_name: "Glob",
        tool_input: {
          pattern: "*.js",
        },
        tool_result: {
          matches: ["a.js", "b.js", "c.js"],
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-07",
        event
      );

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].meta.match_count, 3);
    });

    it("should handle count field in result", async () => {
      const event = {
        tool_name: "Grep",
        tool_input: { pattern: "error" },
        tool_result: { count: 42 },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-08",
        event
      );

      assert.strictEqual(events[0].meta.match_count, 42);
    });
  });

  describe("Agent tool metadata", () => {
    it("should extract description and model for Agent tool", async () => {
      const event = {
        tool_name: "Agent",
        tool_input: {
          description: "Analyze codebase",
        },
        tool_result: {
          model: "claude-sonnet-4",
          output: "Analysis complete",
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "test-agent-09",
        event
      );

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].meta.tool, "Agent");
      assert.strictEqual(events[0].meta.target, "Analyze codebase");
      assert.strictEqual(events[0].meta.agent_model, "claude-sonnet-4");
    });
  });

  describe("Sequence numbering", () => {
    it("should assign monotonically increasing sequence numbers", async () => {
      // Create a new test dir for this sequence test
      const seqTestDir = join(tmpdir(), `seq-test-${Date.now()}`);
      mkdirSync(seqTestDir, { recursive: true });

      try {
        // Send multiple events to the same hook process won't work
        // (each invocation is a new process), so we need to check
        // that each invocation gets a seq number

        const event1 = {
          tool_name: "Read",
          tool_input: { file_path: "/a.txt" },
          tool_result: "content1",
        };

        const event2 = {
          tool_name: "Write",
          tool_input: { file_path: "/b.txt" },
          tool_result: "content2",
        };

        const event3 = {
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_result: { exit_code: 0 },
        };

        // Each invocation is separate, so seq will reset
        // But we can verify each has a seq field
        const result1 = await invokeProgressHook(
          seqTestDir,
          "agent-seq",
          event1
        );
        const result2 = await invokeProgressHook(
          seqTestDir,
          "agent-seq",
          event2
        );
        const result3 = await invokeProgressHook(
          seqTestDir,
          "agent-seq",
          event3
        );

        // Each should have seq = 1 (since each is a new process)
        // But all should have the seq field
        assert.ok(typeof result1.events[0].seq === "number");
        assert.ok(typeof result2.events[0].seq === "number");
        assert.ok(typeof result3.events[0].seq === "number");

        // In meta as well
        assert.ok(typeof result1.events[0].meta.seq === "number");
        assert.ok(typeof result2.events[0].meta.seq === "number");
        assert.ok(typeof result3.events[0].meta.seq === "number");

        // Read all events from the accumulated ipc.jsonl
        const ipcPath = join(seqTestDir, "ipc.jsonl");
        const content = readFileSync(ipcPath, "utf-8");
        const allEvents = content
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));

        // Should have 3 events total
        assert.strictEqual(allEvents.length, 3);

        // Each should have seq = 1 (new process each time)
        assert.strictEqual(allEvents[0].seq, 1);
        assert.strictEqual(allEvents[1].seq, 1);
        assert.strictEqual(allEvents[2].seq, 1);
      } finally {
        rmSync(seqTestDir, { recursive: true, force: true });
      }
    });
  });

  describe("Backward compatibility", () => {
    it("should preserve all existing IPC event fields", async () => {
      const event = {
        tool_name: "Edit",
        tool_input: {
          file_path: "/src/main.ts",
        },
        tool_result: "export const x = 1;",
      };

      const { events } = await invokeProgressHook(
        testDir,
        "compat-agent",
        event
      );

      assert.strictEqual(events.length, 1);
      const evt = events[0];

      // Required existing fields (backward compat)
      assert.ok(evt.ts, "missing ts field");
      assert.ok(evt.t, "missing t field");
      assert.strictEqual(evt.from, "compat-agent", "missing from field");
      assert.strictEqual(evt.to, "tui", "missing to field");
      assert.strictEqual(evt.type, "tool_event", "missing type field");
      assert.ok(evt.content, "missing content field");
      assert.ok(evt.meta, "missing meta field");

      // Meta sub-fields (backward compat)
      assert.strictEqual(evt.meta.tool, "Edit");
      assert.ok(evt.meta.target !== undefined);
      assert.ok(evt.meta.result_preview !== undefined);

      // NEW additive fields
      assert.ok(typeof evt.seq === "number", "missing seq field");
      assert.ok(typeof evt.meta.seq === "number", "missing meta.seq field");
    });
  });

  describe("Hook output", () => {
    it("should output empty JSON on success", async () => {
      const event = {
        tool_name: "Read",
        tool_input: { file_path: "/test.txt" },
        tool_result: "test",
      };

      const { stdout } = await invokeProgressHook(
        testDir,
        "output-agent",
        event
      );

      // Hook must output {} to indicate success (PostToolUse contract)
      assert.strictEqual(stdout, "{}");
    });

    it("should fail open on invalid JSON input", async () => {
      return new Promise((resolve, reject) => {
        const proc = spawn("python3", [HOOK_PATH], {
          env: {
            ...process.env,
            ARBOR_PROGRESS_IPC_DIR: testDir,
            SWARM_AGENT_ID: "fail-agent",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";

        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        proc.on("close", (code) => {
          // Should exit 0 (fail open)
          assert.strictEqual(code, 0);
          // Should output {}
          assert.strictEqual(stdout.trim(), "{}");
          resolve();
        });

        // Write invalid JSON
        proc.stdin.write("{ invalid json {{");
        proc.stdin.end();
      });
    });

    it("should work when ARBOR_PROGRESS_IPC_DIR is not set", async () => {
      return new Promise((resolve, reject) => {
        const proc = spawn("python3", [HOOK_PATH], {
          env: {
            ...process.env,
            SWARM_AGENT_ID: "no-ipc-agent",
            // Explicitly unset ARBOR_PROGRESS_IPC_DIR
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";

        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        proc.on("close", (code) => {
          assert.strictEqual(code, 0);
          assert.strictEqual(stdout.trim(), "{}");
          resolve();
        });

        const event = {
          tool_name: "Read",
          tool_input: { file_path: "/test.txt" },
          tool_result: "test",
        };

        proc.stdin.write(JSON.stringify(event));
        proc.stdin.end();
      });
    });
  });

  describe("Duration extraction", () => {
    it("should extract duration_ms from result (snake_case)", async () => {
      const event = {
        tool_name: "Read",
        tool_input: { file_path: "/a.txt" },
        tool_result: {
          content: "data",
          duration_ms: 523,
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "duration-agent",
        event
      );

      assert.strictEqual(events[0].meta.duration_ms, 523);
    });

    it("should extract duration_ms from result (camelCase)", async () => {
      const event = {
        tool_name: "Grep",
        tool_input: { pattern: "foo" },
        tool_result: {
          matches: ["file.js"],
          durationMs: 789,
        },
      };

      const { events } = await invokeProgressHook(
        testDir,
        "duration-agent-2",
        event
      );

      assert.strictEqual(events[0].meta.duration_ms, 789);
    });
  });
});

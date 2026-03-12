#!/usr/bin/env node
/**
 * IPC Bridge: Node.js ↔ Python communication bridge
 *
 * Provides two-way communication between Node.js agents and Python hooks:
 *
 * 1. **Node → Python** (subprocess invocation):
 *    - Spawns Python script as subprocess
 *    - Sends JSON payload via stdin
 *    - Receives response via stdout
 *
 * 2. **Python → Node** (CLI mode):
 *    - Python scripts can invoke this bridge as a subprocess
 *    - `node bridge.mjs send agent-01 '{"type": "task", "data": {...}}'`
 *    - Connects to IPC bus and sends message
 *
 * 3. **Dynamic hook registration**:
 *    - Python hooks can register their socket paths
 *    - Node agents can discover and communicate with hooks
 *
 * @module ipc/bridge
 */

import { spawn } from "child_process";
import { existsSync, unlinkSync } from "fs";
import net from "net";
import { createAgentChannel } from "./agent-channel.mjs";

/**
 * Registry of Python hook socket paths
 * Format: hookName → { socketPath, lastSeen }
 */
const pythonHooks = new Map();

/**
 * Send message to a Python hook via subprocess invocation
 *
 * Spawns the Python script, sends JSON payload via stdin, and collects stdout response.
 *
 * @param {string} hookName - Hook identifier (e.g., "auto_orchestrator", "acontext_bridge")
 * @param {object} payload - JSON-serializable payload
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=10000] - Timeout in milliseconds
 * @param {string} [options.hookPath] - Full path to Python script (auto-detected if omitted)
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 *
 * @example
 * const result = await sendToPython("auto_orchestrator", {
 *   session_id: "abc123",
 *   prompt: "implement feature X"
 * });
 *
 * if (result.success) {
 *   console.log("Hook output:", result.output);
 * }
 */
export async function sendToPython(hookName, payload, options = {}) {
  const timeout = options.timeout || 10000;
  const hookPath = options.hookPath || _resolveHookPath(hookName);

  if (!hookPath) {
    return {
      success: false,
      output: "",
      error: `Hook '${hookName}' not found`
    };
  }

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const child = spawn("python3", [hookPath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeout
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      done({
        success: code === 0,
        output: stdout.trim(),
        error: code !== 0 ? stderr.trim() : undefined,
        exitCode: code
      });
    });

    child.on("error", (err) => {
      done({
        success: false,
        output: "",
        error: `Failed to spawn hook: ${err.message}`
      });
    });

    // Send payload via stdin
    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    } catch (err) {
      child.kill("SIGTERM");
      done({
        success: false,
        output: "",
        error: `Failed to write to stdin: ${err.message}`
      });
    }

    // Timeout handling
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
        done({
          success: false,
          output: stdout.trim(),
          error: `Hook timeout after ${timeout}ms`
        });
      }
    }, timeout);
  });
}

/**
 * Register a Python hook's socket path for direct communication
 *
 * @param {string} hookName - Hook identifier
 * @param {string} socketPath - Unix socket path
 */
export function registerPythonHook(hookName, socketPath) {
  pythonHooks.set(hookName, {
    socketPath,
    lastSeen: Date.now()
  });
}

/**
 * Unregister a Python hook
 *
 * @param {string} hookName - Hook identifier
 */
export function unregisterPythonHook(hookName) {
  pythonHooks.delete(hookName);
}

/**
 * Get registered Python hooks
 *
 * @returns {Map<string, {socketPath: string, lastSeen: number}>}
 */
export function getPythonHooks() {
  return new Map(pythonHooks);
}

/**
 * Resolve hook path from hook name (internal)
 *
 * @private
 * @param {string} hookName - Hook identifier
 * @returns {string|null} Full path to Python script or null
 */
function _resolveHookPath(hookName) {
  // Check environment variable first
  const envPath = process.env[`HOOK_${hookName.toUpperCase()}_PATH`];
  if (envPath) {
    return envPath;
  }

  // Default hook directory
  const hookDir = process.env.CLAUDE_HOOKS_DIR || `${process.env.HOME}/.claude/hooks`;

  // Common hook patterns
  const candidates = [
    `${hookDir}/${hookName}.py`,
    `${hookDir}/${hookName}_hook.py`,
    `${hookDir}/hooks/${hookName}.py`
  ];

  // Check existence (sync for simplicity in subprocess context)
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        return path;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * CLI mode: Send message to IPC bus from command line
 *
 * Usage:
 *   node bridge.mjs send <target> '<json>'
 *   node bridge.mjs publish <topic> '<json>'
 *   node bridge.mjs request <target> '<json>'
 *
 * @example
 * # Send direct message
 * node bridge.mjs send agent-01 '{"type": "pause", "reason": "debugging"}'
 *
 * # Publish to topic
 * node bridge.mjs publish control '{"type": "shutdown", "reason": "user requested"}'
 *
 * # Request-response
 * node bridge.mjs request orchestrator '{"type": "get_status"}'
 */
async function cli() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(`Usage:
  ${process.argv[1]} send <target> '<json>'
  ${process.argv[1]} publish <topic> '<json>'
  ${process.argv[1]} request <target> '<json>' [timeout_ms]`);
    process.exit(1);
  }

  const command = args[0];
  const targetOrTopic = args[1];
  const jsonPayload = args[2];

  let payload;
  try {
    payload = JSON.parse(jsonPayload);
  } catch (err) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  // Connect to IPC bus
  const senderId = `bridge-${process.pid}`;
  let channel;

  try {
    channel = await createAgentChannel(senderId, {
      autoReconnect: false
    });
  } catch (err) {
    console.error(`Failed to connect to IPC bus: ${err.message}`);
    process.exit(1);
  }

  try {
    switch (command) {
      case "send":
        await channel.send(targetOrTopic, payload);
        console.log(`Sent message to ${targetOrTopic}`);
        break;

      case "publish":
        await channel.publish(targetOrTopic, payload);
        console.log(`Published to topic ${targetOrTopic}`);
        break;

      case "request": {
        const timeout = args[3] ? parseInt(args[3], 10) : 5000;
        const response = await channel.request(targetOrTopic, payload, timeout);
        console.log(JSON.stringify(response, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }

    await channel.close();
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    await channel.close();
    process.exit(1);
  }
}

/**
 * Bridge server mode: Listen for Python hook connections
 *
 * Starts a Unix socket server that Python hooks can connect to for
 * bidirectional communication. This is an alternative to subprocess invocation
 * for long-running hooks.
 *
 * @param {string} socketPath - Unix socket path
 * @param {function(object, function): void} handler - Message handler: (message, respond) => void
 * @returns {Promise<{server: net.Server, close: function}>}
 *
 * @example
 * const bridge = await startBridgeServer("/tmp/python-bridge.sock", (msg, respond) => {
 *   console.log("Received from Python:", msg);
 *   respond({ status: "ok", received: msg });
 * });
 *
 * // Later: await bridge.close();
 */
export async function startBridgeServer(socketPath, handler) {
  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const clients = new Set();

  const server = net.createServer((socket) => {
    clients.add(socket);

    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse length-prefixed frames
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);

        if (buffer.length < 4 + length) {
          break; // Incomplete frame
        }

        const jsonBuf = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);

        try {
          const message = JSON.parse(jsonBuf.toString("utf-8"));

          // Provide respond callback
          const respond = (response) => {
            const replyJson = JSON.stringify(response);
            const replyBuf = Buffer.from(replyJson, "utf-8");
            const combined = Buffer.allocUnsafe(4 + replyBuf.length);
            combined.writeUInt32BE(replyBuf.length, 0);
            replyBuf.copy(combined, 4);
            socket.write(combined);
          };

          handler(message, respond);
        } catch (err) {
          console.error(`Bridge server parse error: ${err.message}`);
        }
      }
    });

    socket.on("end", () => {
      clients.delete(socket);
    });

    socket.on("error", (err) => {
      console.error(`Bridge server socket error: ${err.message}`);
      clients.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(socketPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  console.error(`[Bridge] Server listening on ${socketPath}`);

  return {
    server,
    async close() {
      for (const client of clients) {
        client.end();
      }
      clients.clear();

      return new Promise((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) {
            unlinkSync(socketPath);
          }
          resolve();
        });
      });
    }
  };
}

// Run CLI if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

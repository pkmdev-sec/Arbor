import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pythonScriptPath = join(__dirname, "../lib/ipc/python-bridge/bus_client.py");

describe("AsyncBusClient", () => {
  let MessageBus, AgentChannel;
  let bus;
  let pythonProc;
  const socketPath = "/tmp/test-async-bus-client.sock";
  const testTimeout = 10000; // 10s timeout for tests

  before(async () => {
    // Import MessageBus
    const messageBusModule = await import("../lib/ipc/message-bus.mjs");
    MessageBus = messageBusModule.MessageBus;

    const agentChannelModule = await import("../lib/ipc/agent-channel.mjs");
    AgentChannel = agentChannelModule.AgentChannel;

    // Start message bus
    bus = new MessageBus({ socketPath, enableLogging: false });
    await bus.start();
  });

  after(async () => {
    // Clean up Python process if still running
    if (pythonProc && !pythonProc.killed) {
      pythonProc.kill("SIGTERM");
    }

    // Stop bus
    if (bus) {
      await bus.stop();
    }
  });

  it("async client connects and publishes messages", { timeout: testTimeout }, async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Test timeout"));
      }, testTimeout);

      // Create a listener client to receive published messages
      const listener = new AgentChannel("test-listener", { socketPath, autoReconnect: false });

      listener.connect().then(() => {
        // Subscribe to test topic
        listener.subscribe("async-test-topic", (msg) => {
          try {
            assert.ok(msg, "should receive message");
            assert.equal(msg.test, "async-publish", "message content should match");
            clearTimeout(timeout);
            listener.close();
            pythonProc.kill("SIGTERM");
            resolve();
          } catch (err) {
            clearTimeout(timeout);
            listener.close();
            pythonProc.kill("SIGTERM");
            reject(err);
          }
        });

        // Spawn Python async client
        pythonProc = spawn("python3", [
          pythonScriptPath,
          "--async",
          "publish",
          "async-test-topic",
          '{"test": "async-publish"}',
        ], {
          env: { ...process.env, ARBOR_IPC_SOCKET: socketPath },
        });

        pythonProc.stderr.on("data", (data) => {
          console.error(`Python stderr: ${data}`);
        });

        pythonProc.on("error", (err) => {
          clearTimeout(timeout);
          listener.close();
          reject(new Error(`Failed to spawn Python: ${err.message}`));
        });

        pythonProc.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            listener.close();
            reject(new Error(`Python exited with code ${code}`));
          }
        });
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  it("async client can send direct messages", { timeout: testTimeout }, async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Test timeout"));
      }, testTimeout);

      // Create a receiver client
      const receiver = new AgentChannel("test-receiver", { socketPath, autoReconnect: false });

      receiver.connect().then(() => {
        receiver.on("message", (msg) => {
          if (msg.type === "DIRECT_SEND" && msg.payload?.test === "async-direct") {
            try {
              assert.equal(msg.to, "test-receiver", "message should be addressed to receiver");
              assert.equal(msg.payload.test, "async-direct", "payload should match");
              clearTimeout(timeout);
              receiver.close();
              pythonProc.kill("SIGTERM");
              resolve();
            } catch (err) {
              clearTimeout(timeout);
              receiver.close();
              pythonProc.kill("SIGTERM");
              reject(err);
            }
          }
        });

        // Spawn Python async client to send direct message
        pythonProc = spawn("python3", [
          pythonScriptPath,
          "--async",
          "send",
          "test-receiver",
          '{"test": "async-direct"}',
        ], {
          env: { ...process.env, ARBOR_IPC_SOCKET: socketPath },
        });

        pythonProc.stderr.on("data", (data) => {
          console.error(`Python stderr: ${data}`);
        });

        pythonProc.on("error", (err) => {
          clearTimeout(timeout);
          receiver.close();
          reject(new Error(`Failed to spawn Python: ${err.message}`));
        });

        pythonProc.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            receiver.close();
            reject(new Error(`Python exited with code ${code}`));
          }
        });
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  it("async client can subscribe and receive messages", { timeout: testTimeout }, async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Test timeout"));
      }, testTimeout);

      let messageReceived = false;

      // Spawn Python async client in subscribe mode
      pythonProc = spawn("python3", [
        pythonScriptPath,
        "--async",
        "subscribe",
        "async-subscribe-topic",
      ], {
        env: { ...process.env, ARBOR_IPC_SOCKET: socketPath },
      });

      pythonProc.stdout.on("data", (data) => {
        const output = data.toString();
        if (output.includes('"subscribed": "yes"')) {
          messageReceived = true;
          clearTimeout(timeout);
          pythonProc.kill("SIGTERM");
          setTimeout(() => {
            assert.ok(messageReceived, "should receive subscribed message");
            resolve();
          }, 100);
        }
      });

      pythonProc.stderr.on("data", (data) => {
        const errMsg = data.toString();
        // Wait for "Subscribed to" message before publishing
        if (errMsg.includes("Subscribed to async-subscribe-topic")) {
          // Give Python client time to fully subscribe
          setTimeout(() => {
            // Create a publisher to send a test message
            const publisher = new AgentChannel("test-publisher", { socketPath, autoReconnect: false });
            publisher.connect().then(() => {
              publisher.publish("async-subscribe-topic", { subscribed: "yes" });
              setTimeout(() => {
                publisher.close();
              }, 500);
            });
          }, 500);
        }
      });

      pythonProc.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn Python: ${err.message}`));
      });

      pythonProc.on("exit", (code) => {
        if (code !== 0 && code !== null && !messageReceived) {
          clearTimeout(timeout);
          reject(new Error(`Python exited with code ${code}`));
        }
      });
    });
  });

  it("async client handles request-response pattern", { timeout: testTimeout }, async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Test timeout"));
      }, testTimeout);

      // Create a responder client
      const responder = new AgentChannel("test-responder", { socketPath, autoReconnect: false });

      responder.connect().then(() => {
        responder.on("message", async (msg) => {
          if (msg.type === "REQUEST" && msg.payload?.test === "async-request") {
            // Send response back
            responder.respond(msg, { result: "async-response" });
          }
        });

        // Spawn Python async client to send request
        pythonProc = spawn("python3", [
          pythonScriptPath,
          "--async",
          "request",
          "test-responder",
          '{"test": "async-request"}',
          "5",
        ], {
          env: { ...process.env, ARBOR_IPC_SOCKET: socketPath },
        });

        let responseReceived = false;

        pythonProc.stdout.on("data", (data) => {
          const output = data.toString();
          if (output.includes("async-response")) {
            responseReceived = true;
            try {
              const response = JSON.parse(output);
              assert.equal(response.result, "async-response", "response should match");
              clearTimeout(timeout);
              responder.close();
              pythonProc.kill("SIGTERM");
              resolve();
            } catch (err) {
              clearTimeout(timeout);
              responder.close();
              pythonProc.kill("SIGTERM");
              reject(err);
            }
          }
        });

        pythonProc.stderr.on("data", (data) => {
          console.error(`Python stderr: ${data}`);
        });

        pythonProc.on("error", (err) => {
          clearTimeout(timeout);
          responder.close();
          reject(new Error(`Failed to spawn Python: ${err.message}`));
        });

        pythonProc.on("exit", (code) => {
          if (code !== 0 && code !== null && !responseReceived) {
            clearTimeout(timeout);
            responder.close();
            reject(new Error(`Python exited with code ${code}`));
          }
        });
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
});

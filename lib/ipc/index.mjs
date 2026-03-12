/**
 * IPC Infrastructure Module
 *
 * Provides a complete inter-process communication system for agent coordination:
 * - Unix domain socket message bus for reliable IPC
 * - Length-prefixed JSON protocol for message framing
 * - Agent registry for capability tracking and discovery
 * - Client channels for agent-side communication
 * - Orchestrator control interface for privileged operations
 * - Bridge utilities for cross-context communication
 * - Telemetry channel for metrics collection
 *
 * @module ipc
 */

// Protocol definitions and message handling
export * from "./protocol.mjs";

// Message bus server (broker)
export * from "./message-bus.mjs";

// Agent registry for tracking and discovery
export * from "./registry.mjs";

// Agent-side client channel
export * from "./agent-channel.mjs";

// Orchestrator control interface
export * from "./orchestrator-control.mjs";

// Bridge utilities
export * from "./bridge.mjs";

// Telemetry channel
export * from "./telemetry-channel.mjs";

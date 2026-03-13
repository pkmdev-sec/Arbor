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
 * - Discovery bus for real-time finding propagation (REQ-029)
 * - Audit hook for message bus observability (REQ-011)
 * - Wave coordinator for distributed wave execution (REQ-008)
 * - Council RPC for distributed multi-judge validation (REQ-025)
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

// Discovery bus — real-time finding propagation via pub/sub (REQ-029)
export * from "./discovery-bus.mjs";

// Audit hook — message bus observability (REQ-011)
export * from "./audit-hook.mjs";

// Wave coordinator — distributed wave execution (REQ-008)
export * from "./wave-coordinator.mjs";

// Council RPC — distributed multi-judge validation (REQ-025)
export * from "./council-rpc.mjs";

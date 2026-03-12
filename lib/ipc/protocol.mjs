/**
 * IPC Protocol Specification
 *
 * Defines the complete message protocol for Unix domain socket communication
 * between swarm orchestrator and remote agents. Uses length-prefixed JSON
 * framing for reliable message boundary detection.
 *
 * Message Format:
 * [4 bytes: length (big-endian uint32)] [N bytes: JSON payload]
 *
 * The length prefix enables streaming parsers to know exactly how many bytes
 * to read before attempting JSON.parse(), preventing partial message errors.
 *
 * @module ipc/protocol
 */

import { randomUUID } from "node:crypto";

/**
 * Maximum allowed message size in bytes (16MB).
 * Prevents memory exhaustion from malicious/buggy length prefixes.
 * @type {number}
 */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/**
 * Message type enumeration
 * @enum {string}
 */
export const MessageType = {
  /** One-way broadcast to all subscribers of a topic */
  PUBLISH: "PUBLISH",

  /** Register interest in messages on a topic */
  SUBSCRIBE: "SUBSCRIBE",

  /** Unregister from a topic */
  UNSUBSCRIBE: "UNSUBSCRIBE",

  /** Direct message to a specific agent */
  DIRECT_SEND: "DIRECT_SEND",

  /** Request that expects a correlated response */
  REQUEST: "REQUEST",

  /** Response to a prior REQUEST (carries correlation ID) */
  RESPONSE: "RESPONSE",

  /** Agent announces presence and capabilities */
  REGISTER: "REGISTER",

  /** Agent gracefully disconnects */
  UNREGISTER: "UNREGISTER",

  /** Periodic heartbeat to maintain connection liveness */
  HEARTBEAT: "HEARTBEAT",

  /** Error notification (can be in response to a REQUEST) */
  ERROR: "ERROR",
};

/**
 * Message priority levels (for future queue prioritization)
 * @enum {string}
 */
export const Priority = {
  HIGH: "HIGH",
  NORMAL: "NORMAL",
  LOW: "LOW",
};

/**
 * Agent health status enumeration
 * @enum {string}
 */
export const HealthStatus = {
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  OFFLINE: "OFFLINE",
};

/**
 * Complete message schema
 * @typedef {Object} Message
 * @property {string} id - Unique message identifier (UUID v4)
 * @property {MessageType} type - Message type
 * @property {string} from - Sender agent ID (e.g., "agent-01", "orchestrator", "main-session")
 * @property {string} [to] - Recipient agent ID (required for DIRECT_SEND, REQUEST, RESPONSE)
 * @property {string} [topic] - Topic name (required for PUBLISH, SUBSCRIBE, UNSUBSCRIBE)
 * @property {string} [correlationId] - Original REQUEST message ID (required for RESPONSE)
 * @property {Priority} [priority] - Message priority (default: NORMAL)
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {any} payload - Message payload (arbitrary JSON-serializable data)
 */

/**
 * Agent metadata for registration
 * @typedef {Object} AgentMetadata
 * @property {string} agentId - Unique agent identifier
 * @property {string} role - Agent role (e.g., "worker", "verifier", "orchestrator")
 * @property {string} model - Model identifier (e.g., "sonnet[1m]", "opus[1m]")
 * @property {string[]} capabilities - List of capabilities (e.g., ["code-review", "testing", "refactoring"])
 * @property {string} worktreePath - Absolute path to agent's worktree (if applicable)
 * @property {number} pid - Process ID
 */

/**
 * Generate a new correlation ID for request-response tracking
 * @returns {string} UUID v4 correlation identifier
 */
export function generateCorrelationId() {
  return randomUUID();
}

/**
 * Create a complete message envelope with all required fields
 *
 * @param {MessageType} type - Message type
 * @param {string} from - Sender agent ID
 * @param {any} payload - Message payload
 * @param {Object} [options] - Optional fields
 * @param {string} [options.to] - Recipient agent ID
 * @param {string} [options.topic] - Topic name
 * @param {string} [options.correlationId] - Correlation ID for responses
 * @param {Priority} [options.priority] - Message priority
 * @returns {Message} Complete message object
 */
export function createMessage(type, from, payload, options = {}) {
  return {
    id: randomUUID(),
    type,
    from,
    to: options.to || null,
    topic: options.topic || null,
    correlationId: options.correlationId || null,
    priority: options.priority || Priority.NORMAL,
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Validate message structure and required fields
 *
 * @param {any} msg - Message object to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export function validateMessage(msg) {
  if (!msg || typeof msg !== "object") {
    return { valid: false, error: "Message must be an object" };
  }

  if (!msg.id || typeof msg.id !== "string") {
    return { valid: false, error: "Message must have a string 'id'" };
  }

  if (!msg.type || !Object.values(MessageType).includes(msg.type)) {
    return { valid: false, error: `Invalid message type: ${msg.type}` };
  }

  if (!msg.from || typeof msg.from !== "string") {
    return { valid: false, error: "Message must have a string 'from' field" };
  }

  if (typeof msg.timestamp !== "number") {
    return { valid: false, error: "Message must have a numeric 'timestamp'" };
  }

  // Type-specific validation
  switch (msg.type) {
    case MessageType.DIRECT_SEND:
    case MessageType.REQUEST:
      if (!msg.to || typeof msg.to !== "string") {
        return { valid: false, error: `${msg.type} requires a string 'to' field` };
      }
      break;

    case MessageType.RESPONSE:
      if (!msg.to || typeof msg.to !== "string") {
        return { valid: false, error: "RESPONSE requires a string 'to' field" };
      }
      if (!msg.correlationId || typeof msg.correlationId !== "string") {
        return { valid: false, error: "RESPONSE requires a string 'correlationId' field" };
      }
      break;

    case MessageType.PUBLISH:
    case MessageType.SUBSCRIBE:
    case MessageType.UNSUBSCRIBE:
      if (!msg.topic || typeof msg.topic !== "string") {
        return { valid: false, error: `${msg.type} requires a string 'topic' field` };
      }
      break;
  }

  return { valid: true };
}

/**
 * Serialize a message to length-prefixed JSON buffer
 *
 * Format: [4 bytes: length (big-endian uint32)] [N bytes: JSON string (UTF-8)]
 *
 * @param {Message} message - Message object to serialize
 * @returns {Buffer} Binary buffer ready for socket.write()
 * @throws {Error} If message validation fails or JSON serialization fails
 */
export function serializeMessage(message) {
  const validation = validateMessage(message);
  if (!validation.valid) {
    throw new Error(`Invalid message: ${validation.error}`);
  }

  const json = JSON.stringify(message);
  const jsonBuffer = Buffer.from(json, "utf-8");
  const length = jsonBuffer.length;

  // Allocate: 4 bytes for length + JSON bytes
  const buffer = Buffer.allocUnsafe(4 + length);

  // Write length as big-endian uint32
  buffer.writeUInt32BE(length, 0);

  // Copy JSON bytes
  jsonBuffer.copy(buffer, 4);

  return buffer;
}

/**
 * Streaming message parser for length-prefixed JSON protocol
 *
 * Handles partial receives by buffering incomplete messages until the full
 * length-prefixed payload arrives. Supports multiple messages in a single
 * data chunk.
 *
 * @example
 * const parser = new MessageParser();
 * socket.on("data", (chunk) => {
 *   const messages = parser.feed(chunk);
 *   for (const msg of messages) {
 *     handleMessage(msg);
 *   }
 * });
 */
export class MessageParser {
  constructor() {
    /** @type {Buffer[]} Accumulated chunk array for efficient buffering */
    this.chunks = [];

    /** @type {number} Total buffered bytes */
    this.bufferedBytes = 0;

    /** @type {number|null} Expected payload length (null = waiting for length prefix) */
    this.expectedLength = null;
  }

  /**
   * Feed incoming data and extract complete messages
   *
   * Resilient to malformed messages: JSON parse errors and validation failures
   * are silently skipped (the connection survives). Oversized messages throw
   * (caller should destroy the socket — it's a protocol-level violation).
   *
   * @param {Buffer} chunk - Data chunk from socket
   * @returns {Message[]} Array of complete, parsed, valid messages
   * @throws {Error} If a message claims a length exceeding MAX_MESSAGE_SIZE
   */
  feed(chunk) {
    // Accumulate chunks in array (O(1) operation)
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;

    const messages = [];

    while (true) {
      // State 1: Waiting for length prefix (4 bytes)
      if (this.expectedLength === null) {
        if (this.bufferedBytes < 4) {
          break;
        }

        // Concat only when we need to read the frame boundary
        const buffer = Buffer.concat(this.chunks);

        this.expectedLength = buffer.readUInt32BE(0);

        // Reject oversized messages — protocol-level violation
        if (this.expectedLength > MAX_MESSAGE_SIZE) {
          const claimed = this.expectedLength;
          this.expectedLength = null;
          this.chunks = [];
          this.bufferedBytes = 0;
          throw new Error(`Message too large: ${claimed} bytes (max: ${MAX_MESSAGE_SIZE})`);
        }

        // Update buffer after consuming length prefix
        const remaining = buffer.subarray(4);
        this.chunks = remaining.length > 0 ? [remaining] : [];
        this.bufferedBytes = remaining.length;
      }

      // State 2: Waiting for payload
      if (this.bufferedBytes < this.expectedLength) {
        break;
      }

      // Concat only when extracting complete message
      const buffer = Buffer.concat(this.chunks);

      // Extract payload
      const payloadBuffer = buffer.subarray(0, this.expectedLength);
      const json = payloadBuffer.toString("utf-8");

      // Consume payload
      const remaining = buffer.subarray(this.expectedLength);
      this.chunks = remaining.length > 0 ? [remaining] : [];
      this.bufferedBytes = remaining.length;
      this.expectedLength = null;

      // Parse and validate — skip bad messages, don't kill the connection
      let message;
      try {
        message = JSON.parse(json);
      } catch (_err) {
        // Malformed JSON — skip this message, continue parsing
        continue;
      }

      const validation = validateMessage(message);
      if (!validation.valid) {
        // Invalid message structure — skip, continue parsing
        continue;
      }

      messages.push(message);
    }

    return messages;
  }

  /**
   * Reset parser state (useful after socket errors)
   */
  reset() {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.expectedLength = null;
  }

  /**
   * Get current buffer size (for debugging/monitoring)
   * @returns {number} Bytes in buffer
   */
  getBufferSize() {
    return this.bufferedBytes;
  }
}

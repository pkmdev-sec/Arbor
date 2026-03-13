/**
 * Audit Trail Hook for Message Bus
 *
 * Provides message bus hooks that capture ALL agent communications into AuditTrail.
 * This enables full IPC transparency for debugging, compliance, and monitoring.
 *
 * Features:
 * - Captures all message types (publish, direct, request, response)
 * - Logs agent connection/disconnection events
 * - Redacts sensitive payload patterns (e.g., credentials, tokens)
 * - Optional topic filtering to reduce audit volume
 * - Never blocks messages (always returns true)
 * - Provides audit statistics aggregation
 *
 * @module ipc/audit-hook
 */

import { readdirSync } from "node:fs";

/**
 * Create an audit hook for the message bus.
 *
 * @param {import('../audit-trail.mjs').default} auditTrail - AuditTrail instance
 * @param {Object} [options] - Hook configuration
 * @param {boolean} [options.captureContent=true] - Whether to log message payloads
 * @param {RegExp[]} [options.redactPatterns=[]] - Patterns to redact from payloads
 * @param {string|null} [options.topicFilter=null] - Only audit messages matching this topic pattern (exact or wildcard)
 * @returns {Object} Hook methods compatible with MessageBus.registerHook()
 *
 * @example
 * const audit = new AuditTrail();
 * const hook = createAuditHook(audit, {
 *   captureContent: true,
 *   redactPatterns: [/password/i, /token/i],
 *   topicFilter: 'agent.**'
 * });
 * bus.registerHook('onMessageReceived', hook.onMessageReceived);
 * bus.registerHook('onAgentConnected', hook.onAgentConnected);
 * bus.registerHook('onAgentDisconnected', hook.onAgentDisconnected);
 */
export function createAuditHook(auditTrail, options = {}) {
  const {
    captureContent = true,
    redactPatterns = [],
    topicFilter = null,
  } = options;

  /**
   * Redact sensitive content from payload using configured patterns.
   *
   * @param {any} payload - Message payload to redact
   * @returns {any} Redacted payload (or '[REDACTED]' if fully sensitive)
   * @private
   */
  function redactPayload(payload) {
    if (!captureContent || redactPatterns.length === 0) {
      return payload;
    }

    try {
      // Convert payload to string for pattern matching and redaction
      let payloadStr = JSON.stringify(payload);

      // Apply each redaction pattern
      for (const pattern of redactPatterns) {
        const patternStr = pattern.toString();

        // Check if pattern looks like a key-value pattern (contains :)
        if (patternStr.includes(':')) {
          // Try to apply the pattern directly first
          let newPayloadStr = payloadStr.replace(pattern, (match) => {
            const colonIndex = match.lastIndexOf('":');
            if (colonIndex !== -1) {
              return match.substring(0, colonIndex + 2) + '"[REDACTED]"';
            }
            // If no ": found, try just : (for non-JSON patterns)
            const colonIndex2 = match.lastIndexOf(':');
            if (colonIndex2 !== -1) {
              return match.substring(0, colonIndex2 + 1) + '"[REDACTED]"';
            }
            return '"[REDACTED]"';
          });

          // If no changes, try to adapt pattern for JSON format
          // e.g., /password:\s*"[^"]+"/gi -> /"password"\s*:\s*"[^"]+"/gi
          if (newPayloadStr === payloadStr) {
            try {
              let adaptedPatternStr = pattern.source;
              const flags = pattern.flags || '';

              // Find word before : and wrap in quotes if not already
              // This handles patterns like /password:\s*"[^"]+"/ -> /"password"\s*:\s*"[^"]+"/
              adaptedPatternStr = adaptedPatternStr.replace(/(\w+)(\s*:)/, '"$1"$2');

              const adaptedPattern = new RegExp(adaptedPatternStr, flags);
              payloadStr = payloadStr.replace(adaptedPattern, (match) => {
                const colonIndex = match.lastIndexOf('":');
                if (colonIndex !== -1) {
                  return match.substring(0, colonIndex + 2) + '"[REDACTED]"';
                }
                return '"[REDACTED]"';
              });
            } catch (e) {
              // If adaptation fails, use original result
              payloadStr = newPayloadStr;
            }
          } else {
            payloadStr = newPayloadStr;
          }
        } else {
          // Simple pattern (like /password/gi) - create key-value pattern
          try {
            const patternSource = pattern.source;
            const flags = pattern.flags || 'g';

            // Match "keyname":"value"
            const keyPattern = new RegExp(
              `"(${patternSource})"\\s*:\\s*"([^"]*)"`,
              flags
            );

            payloadStr = payloadStr.replace(keyPattern, `"$1":"[REDACTED]"`);
          } catch (e) {
            // If pattern fails, skip
          }
        }
      }

      return JSON.parse(payloadStr);
    } catch (err) {
      // If redaction fails, return safe fallback
      return '[REDACTION_ERROR]';
    }
  }

  /**
   * Check if a topic matches the configured filter.
   *
   * @param {string} topic - Topic to check
   * @returns {boolean} True if topic matches filter (or no filter set)
   * @private
   */
  function matchesTopicFilter(topic) {
    if (!topicFilter) {
      return true; // No filter = audit all topics
    }

    // Exact match
    if (topicFilter === topic) {
      return true;
    }

    // Wildcard match: convert glob pattern to regex
    // * matches one segment, ** matches multiple segments
    if (topicFilter.includes('*')) {
      const regexPattern = topicFilter
        .replace(/\./g, '\\.') // Escape dots
        .replace(/\*\*/g, '##MULTI##') // Temporarily replace **
        .replace(/\*/g, '[^.]+') // * matches one segment
        .replace(/##MULTI##/g, '.+'); // ** matches multiple segments

      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(topic);
    }

    return false;
  }

  /**
   * Hook: Called when a message is received by the bus.
   * Extracts message metadata and optionally payload, applies redaction,
   * and logs to audit trail. ALWAYS returns true (never blocks).
   *
   * @param {Object} msg - Received message
   * @param {import('net').Socket} socket - Sender's socket
   * @returns {boolean} Always true (never blocks messages)
   */
  function onMessageReceived(msg, socket) {
    try {
      // Extract message metadata
      const {
        type,
        from: source,
        to: target,
        topic,
        id: correlationId,
        timestamp,
        payload,
      } = msg;

      // Apply topic filter if configured
      if (topic && !matchesTopicFilter(topic)) {
        return true; // Skip audit but don't block
      }

      // Build audit record
      const auditRecord = {
        type: 'ipc_message',
        messageType: type,
        target: target || null,
        topic: topic || null,
        correlationId: correlationId || null,
        timestamp: timestamp || Date.now(),
      };

      // Include payload if content capture is enabled
      if (captureContent && payload !== undefined) {
        auditRecord.payload = redactPayload(payload);
      }

      // Log to audit trail
      auditTrail.recordInvocation(source || 'unknown', auditRecord);
    } catch (err) {
      // Audit errors should not disrupt message flow
      // Silent fail with optional debug logging
      if (process.env.DEBUG_AUDIT) {
        console.error('[audit-hook] Error in onMessageReceived:', err.message);
      }
    }

    // ALWAYS return true - never block messages
    return true;
  }

  /**
   * Hook: Called when an agent connects to the bus.
   * Logs connection event to audit trail.
   *
   * @param {string} agentId - Connected agent ID
   * @param {import('net').Socket} socket - Agent's socket
   */
  function onAgentConnected(agentId, socket) {
    try {
      auditTrail.recordInvocation(agentId, {
        type: 'ipc_connect',
        timestamp: Date.now(),
        // Optional: Include socket metadata
        remoteAddress: socket?.remoteAddress || null,
      });
    } catch (err) {
      // Silent fail - audit is not critical path
      if (process.env.DEBUG_AUDIT) {
        console.error('[audit-hook] Error in onAgentConnected:', err.message);
      }
    }
  }

  /**
   * Hook: Called when an agent disconnects from the bus.
   * Logs disconnection event to audit trail.
   *
   * @param {string} agentId - Disconnected agent ID
   * @param {string} reason - Disconnection reason
   */
  function onAgentDisconnected(agentId, reason) {
    try {
      auditTrail.recordResult(agentId, {
        type: 'ipc_disconnect',
        reason: reason || 'unknown',
        timestamp: Date.now(),
      });
    } catch (err) {
      // Silent fail - audit is not critical path
      if (process.env.DEBUG_AUDIT) {
        console.error('[audit-hook] Error in onAgentDisconnected:', err.message);
      }
    }
  }

  // Return hook methods compatible with MessageBus.registerHook()
  return {
    onMessageReceived,
    onAgentConnected,
    onAgentDisconnected,
  };
}

/**
 * Get audit statistics from an audit trail instance.
 * Analyzes all agent audit files to compute aggregate statistics.
 *
 * @param {import('../audit-trail.mjs').default} auditTrail - AuditTrail instance
 * @returns {Object} Statistics object
 * @returns {number} .totalMessages - Total IPC messages audited
 * @returns {Object} .byType - Message counts by type (ipc_message, ipc_connect, ipc_disconnect)
 * @returns {Object} .byAgent - Message counts per agent ID
 *
 * @example
 * const stats = getAuditStats(auditTrail);
 * console.log(`Total messages: ${stats.totalMessages}`);
 * console.log(`By type:`, stats.byType);
 * console.log(`By agent:`, stats.byAgent);
 */
export function getAuditStats(auditTrail) {
  const stats = {
    totalMessages: 0,
    byType: {},
    byAgent: {},
  };

  try {
    // Read audit directory
    const auditDir = auditTrail.getAuditDir();

    const files = readdirSync(auditDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const agentId = file.replace('.json', '');
      const audit = auditTrail.getAgentAudit(agentId);

      if (!audit || !audit.records) {
        continue;
      }

      // Initialize agent counter
      if (!stats.byAgent[agentId]) {
        stats.byAgent[agentId] = 0;
      }

      // Process each record
      for (const record of audit.records) {
        const recordType = record.invocation?.type || record.result?.type;

        if (!recordType) {
          continue;
        }

        // Count by type
        stats.byType[recordType] = (stats.byType[recordType] || 0) + 1;

        // Count by agent
        stats.byAgent[agentId]++;

        // Increment total
        stats.totalMessages++;
      }
    }
  } catch (err) {
    // If stats collection fails, return empty stats
    if (process.env.DEBUG_AUDIT) {
      console.error('[audit-hook] Error collecting stats:', err.message);
    }
  }

  return stats;
}

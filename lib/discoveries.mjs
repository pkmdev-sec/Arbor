/**
 * P2-C: Shared Discoveries Channel
 *
 * Inspired by Fernis REQ-029. Agents share critical findings in real-time
 * via append-only store. Supports deduplication, severity filtering, and
 * context injection for downstream agents.
 *
 * Usage:
 *   const channel = new DiscoveryChannel({ maxDiscoveries: 5, minSeverity: 'high' });
 *   channel.record('agent-01', { type: 'bug', severity: 'critical', summary: '...', files: [...], details: '...' });
 *   const contextText = channel.getContextInjection();
 */

// ── Severity levels ──────────────────────────────────────────────

const SEVERITY_LEVELS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Shared Discoveries Channel — real-time finding propagation between agents.
 */
export class DiscoveryChannel {
  /**
   * @param {object} options - Configuration
   * @param {number} options.maxDiscoveries - Maximum discoveries to retain (default: 5)
   * @param {string} options.minSeverity - Minimum severity threshold (default: 'high')
   */
  constructor(options = {}) {
    this.maxDiscoveries = options.maxDiscoveries ?? 5;
    this.minSeverity = options.minSeverity ?? 'high';
    this.discoveries = [];
  }

  /**
   * Record a discovery from an agent.
   * @param {string} agentId - Agent that made the discovery
   * @param {object} discovery - { type, severity, summary, files, details }
   * @returns {boolean} Whether it was accepted (meets severity threshold)
   */
  record(agentId, discovery) {
    if (!discovery || typeof discovery !== 'object') return false;

    const { type, severity, summary, files, details } = discovery;

    // Validate required fields
    if (!type || !severity || !summary) return false;

    // Check severity threshold
    const severityLevel = SEVERITY_LEVELS[severity];
    const minLevel = SEVERITY_LEVELS[this.minSeverity];
    if (!severityLevel || severityLevel < minLevel) return false;

    // Check for duplicates
    if (this.isDuplicate(discovery)) return false;

    // Add discovery
    const entry = {
      agentId,
      type,
      severity,
      summary,
      files: files ?? [],
      details: details ?? '',
      timestamp: Date.now(),
    };

    this.discoveries.push(entry);

    // Sort by severity (highest first), then by timestamp (most recent first)
    this.discoveries.sort((a, b) => {
      const severityDiff = SEVERITY_LEVELS[b.severity] - SEVERITY_LEVELS[a.severity];
      if (severityDiff !== 0) return severityDiff;
      return b.timestamp - a.timestamp;
    });

    // Trim to max size
    if (this.discoveries.length > this.maxDiscoveries) {
      this.discoveries = this.discoveries.slice(0, this.maxDiscoveries);
    }

    return true;
  }

  /**
   * Get all discoveries for injection into agent context.
   * Returns most recent N discoveries, formatted for prompt injection.
   * @returns {string} Formatted discoveries text
   */
  getContextInjection() {
    if (this.discoveries.length === 0) return '';

    const lines = ['## SHARED DISCOVERIES', ''];
    for (const d of this.discoveries) {
      lines.push(`**[${d.severity.toUpperCase()}]** ${d.type} (${d.agentId})`);
      lines.push(`  Summary: ${d.summary}`);
      if (d.files.length > 0) {
        lines.push(`  Files: ${d.files.join(', ')}`);
      }
      if (d.details) {
        lines.push(`  Details: ${d.details}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get raw discoveries array.
   * @returns {Array}
   */
  getAll() {
    return this.discoveries;
  }

  /**
   * Check if a discovery already exists (dedup by file + type).
   * @param {object} discovery
   * @returns {boolean}
   */
  isDuplicate(discovery) {
    const files = discovery.files ?? [];
    const type = discovery.type;

    for (const existing of this.discoveries) {
      if (existing.type === type) {
        // Check if any file overlaps
        if (files.length === 0 && existing.files.length === 0) return true;
        for (const file of files) {
          if (existing.files.includes(file)) return true;
        }
      }
    }

    return false;
  }

  /**
   * Clear all discoveries (for new swarm run).
   */
  clear() {
    this.discoveries = [];
  }
}

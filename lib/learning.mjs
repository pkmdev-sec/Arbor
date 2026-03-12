/**
 * Cross-session learning store
 *
 * Tracks successful patterns, dead ends, and prompt improvements across
 * agent executions. Backed by ~/.arbor/learning-store.json for persistence.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Constants ────────────────────────────────────────────────────

/** Store file location */
const STORE_PATH = join(homedir(), ".arbor", "learning-store.json");

/** Schema version for migrations */
const SCHEMA_VERSION = 1;

/** Maximum dead ends to keep per task type */
const MAX_DEAD_ENDS_PER_TYPE = 10;

/** Maximum prompt hints to return per query */
const MAX_PROMPT_HINTS = 20;

/** Freshness half-life in months (patterns decay over 6 months) */
const FRESHNESS_HALF_LIFE = 6;

/** Minimum freshness score before pruning */
const MIN_FRESHNESS = 0.1;

/** Minimum observations before promoting staged → active */
const MIN_OBSERVATIONS_FOR_PROMOTION = 2;

// ── LearningStore class ──────────────────────────────────────────

/**
 * Persistent learning store for cross-session pattern tracking.
 * Thread-safe via atomic writes. Auto-loads on construction.
 *
 * @example
 * const store = new LearningStore();
 * store.record("refactor", "javascript", "react", { approach: "hooks", success: true });
 * const patterns = store.query("refactor", "javascript", "react");
 */
export default class LearningStore {
  constructor() {
    this.store = this._load();
  }

  /**
   * Record a successful pattern for future reference.
   * Patterns start as "staged" and get promoted after multiple observations.
   *
   * @param {string} taskType - Type of task (e.g., "refactor", "bugfix", "feature")
   * @param {string} language - Programming language (e.g., "javascript", "python")
   * @param {string} framework - Framework/library (e.g., "react", "django")
   * @param {object} pattern - Pattern data (approach, tools used, etc.)
   */
  record(taskType, language, framework, pattern) {
    const key = this._makePatternKey(taskType, language, framework);
    const now = Date.now();

    if (!this.store.patterns[key]) {
      this.store.patterns[key] = {
        taskType,
        language,
        framework,
        pattern,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        status: "staged",
        projects: new Set([this._getProjectId()]),
      };
    } else {
      const existing = this.store.patterns[key];
      existing.count += 1;
      existing.lastSeen = now;
      existing.pattern = { ...existing.pattern, ...pattern };
      existing.projects.add(this._getProjectId());
    }

    this._updateMetadata();
    this._save();
  }

  /**
   * Record a failed approach (dead end) to avoid repeating mistakes.
   *
   * @param {string} taskType - Type of task that failed
   * @param {string} reason - Why the approach failed
   * @param {string[]} revivalConditions - Conditions under which to retry this approach
   */
  recordDeadEnd(taskType, reason, revivalConditions = []) {
    if (!this.store.deadEnds[taskType]) {
      this.store.deadEnds[taskType] = [];
    }

    this.store.deadEnds[taskType].push({
      reason,
      revivalConditions,
      timestamp: Date.now(),
    });

    // Keep only the most recent MAX_DEAD_ENDS_PER_TYPE
    if (this.store.deadEnds[taskType].length > MAX_DEAD_ENDS_PER_TYPE) {
      this.store.deadEnds[taskType] = this.store.deadEnds[taskType]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_DEAD_ENDS_PER_TYPE);
    }

    this._updateMetadata();
    this._save();
  }

  /**
   * Record a prompt hint for improving swarm coordination.
   *
   * @param {string} swarmType - Type of swarm (e.g., "parallel", "sequential")
   * @param {string} hint - Prompt improvement suggestion
   */
  recordPromptHint(swarmType, hint) {
    if (!this.store.promptHints[swarmType]) {
      this.store.promptHints[swarmType] = [];
    }

    // Check if hint already exists
    const existing = this.store.promptHints[swarmType].find(h => h.hint === hint);
    if (existing) {
      existing.useCount += 1;
      existing.lastUsed = Date.now();
    } else {
      this.store.promptHints[swarmType].push({
        hint,
        useCount: 1,
        addedAt: Date.now(),
        lastUsed: Date.now(),
      });
    }

    this._updateMetadata();
    this._save();
  }

  /**
   * Query patterns for a given task type, language, and framework.
   * Returns patterns sorted by relevance (count * freshness).
   *
   * @param {string} taskType - Type of task
   * @param {string} language - Programming language
   * @param {string} framework - Framework/library
   * @returns {Array<object>} Relevant patterns, sorted by relevance
   */
  query(taskType, language, framework) {
    const key = this._makePatternKey(taskType, language, framework);
    const pattern = this.store.patterns[key];

    if (!pattern || pattern.status !== "active") {
      return [];
    }

    const freshness = this._calculateFreshness(pattern.lastSeen);
    if (freshness < MIN_FRESHNESS) {
      return [];
    }

    const relevance = pattern.count * freshness;

    return [{
      ...pattern,
      freshness,
      relevance,
      projects: Array.from(pattern.projects),
    }];
  }

  /**
   * Get dead ends for a task type to avoid repeating failed approaches.
   *
   * @param {string} taskType - Type of task
   * @returns {Array<object>} Dead ends for this task type
   */
  getDeadEnds(taskType) {
    return this.store.deadEnds[taskType] || [];
  }

  /**
   * Get prompt hints for a swarm type.
   * Returns hints sorted by useCount descending, max 20.
   *
   * @param {string} swarmType - Type of swarm
   * @returns {Array<object>} Prompt hints, sorted by useCount
   */
  getPromptHints(swarmType) {
    const hints = this.store.promptHints[swarmType] || [];
    return hints
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, MAX_PROMPT_HINTS);
  }

  /**
   * Promote staged patterns to active if they have enough observations
   * from different projects.
   */
  promote() {
    let promoted = 0;

    for (const [key, pattern] of Object.entries(this.store.patterns)) {
      if (pattern.status === "staged" &&
          pattern.projects.size >= MIN_OBSERVATIONS_FOR_PROMOTION) {
        pattern.status = "active";
        promoted++;
      }
    }

    if (promoted > 0) {
      this._updateMetadata();
      this._save();
    }

    return promoted;
  }

  /**
   * Prune stale patterns with freshness below threshold.
   */
  prune() {
    let pruned = 0;

    for (const [key, pattern] of Object.entries(this.store.patterns)) {
      const freshness = this._calculateFreshness(pattern.lastSeen);
      if (freshness < MIN_FRESHNESS) {
        delete this.store.patterns[key];
        pruned++;
      }
    }

    if (pruned > 0) {
      this._updateMetadata();
      this._save();
    }

    return pruned;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Create pattern key from task type, language, framework.
   * @private
   */
  _makePatternKey(taskType, language, framework) {
    return `${taskType}:${language}:${framework}`;
  }

  /**
   * Calculate freshness score with exponential decay.
   * freshness = exp(-0.693 * ageMonths / halfLife)
   * @private
   */
  _calculateFreshness(timestamp) {
    const ageMs = Date.now() - timestamp;
    const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
    return Math.exp(-0.693 * ageMonths / FRESHNESS_HALF_LIFE);
  }

  /**
   * Get current project ID (basename of cwd).
   * @private
   */
  _getProjectId() {
    return process.cwd().split("/").pop() || "unknown";
  }

  /**
   * Update metadata timestamp and record count.
   * @private
   */
  _updateMetadata() {
    this.store.metadata.lastUpdated = Date.now();
    this.store.metadata.totalRecords =
      Object.keys(this.store.patterns).length +
      Object.values(this.store.deadEnds).flat().length +
      Object.values(this.store.promptHints).flat().length;
  }

  /**
   * Load store from disk. Creates empty store if file doesn't exist.
   * @private
   */
  _load() {
    try {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const data = JSON.parse(raw);

      // Deserialize Sets in patterns
      for (const pattern of Object.values(data.patterns || {})) {
        if (pattern.projects && Array.isArray(pattern.projects)) {
          pattern.projects = new Set(pattern.projects);
        }
      }

      return data;
    } catch (err) {
      // File doesn't exist or is invalid - create empty store
      return {
        version: SCHEMA_VERSION,
        patterns: {},
        deadEnds: {},
        promptHints: {},
        metadata: {
          created: Date.now(),
          lastUpdated: Date.now(),
          totalRecords: 0,
        },
      };
    }
  }

  /**
   * Atomically save store to disk (write to .tmp, rename over original).
   * @private
   */
  _save() {
    // Ensure directory exists
    const dir = join(homedir(), ".arbor");
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Directory already exists
    }

    // Serialize Sets in patterns to arrays
    const serializable = {
      ...this.store,
      patterns: {},
    };

    for (const [key, pattern] of Object.entries(this.store.patterns)) {
      serializable.patterns[key] = {
        ...pattern,
        projects: Array.from(pattern.projects),
      };
    }

    const tmpPath = STORE_PATH + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(serializable, null, 2), "utf-8");

    // Atomic rename
    try {
      renameSync(tmpPath, STORE_PATH);
    } catch (err) {
      throw new Error('Failed to save learning store: ' + err.message);
    }
  }
}

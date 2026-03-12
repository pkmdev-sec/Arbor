/**
 * Pipeline Checkpointing
 *
 * Checkpoint after each phase so crashes don't lose expensive prior work
 * (inspired by Fernis REQ-012).
 *
 * @module checkpoint
 */

import { existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Manages checkpoints for multi-phase pipelines
 */
export class CheckpointManager {
  /**
   * Create a new checkpoint manager
   *
   * @param {string} workDir - Working directory for checkpoints
   */
  constructor(workDir) {
    if (!workDir || typeof workDir !== 'string') {
      throw new TypeError('workDir must be a non-empty string');
    }

    this.workDir = workDir;
    this.checkpointDir = join(workDir, 'checkpoints');

    // Ensure checkpoint directory exists
    if (!existsSync(this.checkpointDir)) {
      try {
        mkdirSync(this.checkpointDir, { recursive: true });
      } catch (err) {
        throw new Error(`Failed to create checkpoint directory: ${err.message}`);
      }
    }
  }

  /**
   * Get checkpoint file path for a phase
   *
   * @param {number} phase - Phase number
   * @param {string} phaseName - Phase name
   * @returns {string} File path
   * @private
   */
  _getPath(phase, phaseName) {
    const safeName = phaseName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return join(this.checkpointDir, `phase-${phase}-${safeName}.json`);
  }

  /**
   * Save checkpoint after a phase completes
   *
   * @param {number} phase - Phase number (1, 2, 3...)
   * @param {string} phaseName - Human-readable name
   * @param {object} data - Phase output data to persist
   */
  save(phase, phaseName, data) {
    if (typeof phase !== 'number' || phase < 1) {
      throw new TypeError('phase must be a positive number');
    }
    if (!phaseName || typeof phaseName !== 'string') {
      throw new TypeError('phaseName must be a non-empty string');
    }
    if (!data || typeof data !== 'object') {
      throw new TypeError('data must be an object');
    }

    const checkpoint = {
      phase,
      phaseName,
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      data,
      metadata: {
        agentCount: data.agentCount || 0,
        filesChanged: data.filesChanged || [],
        cost: data.cost || 0,
      },
    };

    const filePath = this._getPath(phase, phaseName);
    const tmpPath = filePath + '.tmp';

    try {
      // Atomic write: write to temp file, then rename
      writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {}
      throw new Error(`Failed to save checkpoint: ${err.message}`);
    }
  }

  /**
   * Check if a checkpoint exists for a given phase
   *
   * @param {number} phase - Phase number
   * @returns {boolean} True if checkpoint exists
   */
  exists(phase) {
    if (typeof phase !== 'number' || phase < 1) {
      return false;
    }

    try {
      const files = readdirSync(this.checkpointDir);
      return files.some(f => f.startsWith(`phase-${phase}-`) && f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  /**
   * Load a checkpoint
   *
   * @param {number} phase - Phase number
   * @returns {object|null} Checkpoint data or null if not found
   */
  load(phase) {
    if (typeof phase !== 'number' || phase < 1) {
      return null;
    }

    try {
      const files = readdirSync(this.checkpointDir);
      const checkpointFile = files.find(f => f.startsWith(`phase-${phase}-`) && f.endsWith('.json'));

      if (!checkpointFile) {
        return null;
      }

      const filePath = join(this.checkpointDir, checkpointFile);
      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Find the latest completed checkpoint
   *
   * @returns {{ phase: number, phaseName: string, data: object }|null} Latest checkpoint or null
   */
  findLatest() {
    try {
      const files = readdirSync(this.checkpointDir);
      const checkpoints = files
        .filter(f => f.startsWith('phase-') && f.endsWith('.json'))
        .map(f => {
          const match = f.match(/^phase-(\d+)-/);
          return match ? { file: f, phase: parseInt(match[1], 10) } : null;
        })
        .filter(Boolean);

      if (checkpoints.length === 0) {
        return null;
      }

      // Sort by phase number descending
      checkpoints.sort((a, b) => b.phase - a.phase);
      const latest = checkpoints[0];

      const filePath = join(this.checkpointDir, latest.file);
      const content = readFileSync(filePath, 'utf-8');
      const checkpoint = JSON.parse(content);

      return {
        phase: checkpoint.phase,
        phaseName: checkpoint.phaseName,
        data: checkpoint.data,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get resume point (phase after latest checkpoint)
   *
   * @returns {number} Phase to resume from (1 if no checkpoints)
   */
  getResumePoint() {
    const latest = this.findLatest();
    return latest ? latest.phase + 1 : 1;
  }

  /**
   * Clean up all checkpoints (after successful completion)
   */
  cleanup() {
    try {
      const files = readdirSync(this.checkpointDir);
      for (const file of files) {
        if (file.startsWith('phase-') && file.endsWith('.json')) {
          try {
            unlinkSync(join(this.checkpointDir, file));
          } catch {}
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

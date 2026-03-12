/**
 * Ring Buffer with Overflow-to-Disk
 *
 * Circular buffer for managing streamed output with a 10MB in-memory cap.
 * When the buffer exceeds the cap, older data is flushed to a temporary file.
 *
 * @module buffer
 */

import { writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_MEMORY_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Ring buffer with automatic overflow to disk
 */
export class RingBuffer {
  /**
   * Create a new ring buffer
   *
   * @param {Object} [options] - Configuration options
   * @param {number} [options.maxSize=10485760] - Maximum in-memory size (default: 10MB)
   * @param {string} [options.overflowPath] - Path for overflow file (default: temp file)
   */
  constructor(options = {}) {
    this.maxSize = options.maxSize || MAX_MEMORY_SIZE;
    this.overflowPath = options.overflowPath || join(tmpdir(), `ring-buffer-${process.pid}-${randomUUID().slice(0, 8)}.bin`);

    /** @type {Buffer[]} In-memory buffer chunks */
    this.chunks = [];

    /** @type {number} Current size in bytes */
    this.size = 0;

    /** @type {boolean} Whether overflow has occurred */
    this.hasOverflowed = false;

    /** @type {number} Total bytes written to disk */
    this.diskSize = 0;
  }

  /**
   * Write data to the buffer
   *
   * @param {Buffer} chunk - Data chunk to write
   */
  write(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("chunk must be a Buffer");
    }

    const chunkSize = chunk.length;

    // If adding this chunk would exceed max size, flush to disk
    if (this.size + chunkSize > this.maxSize) {
      this._flushToDisk();
    }

    this.chunks.push(chunk);
    this.size += chunkSize;
  }

  /**
   * Get all buffered data (memory + disk)
   *
   * @returns {Buffer} Complete buffer contents
   */
  getAll() {
    let result;

    if (this.hasOverflowed) {
      // Read from disk + memory
      const diskData = existsSync(this.overflowPath) ? readFileSync(this.overflowPath) : Buffer.alloc(0);
      const memoryData = Buffer.concat(this.chunks);
      result = Buffer.concat([diskData, memoryData]);
    } else {
      // Only memory
      result = Buffer.concat(this.chunks);
    }

    return result;
  }

  /**
   * Get buffered data as a string
   *
   * @param {string} [encoding='utf-8'] - Text encoding
   * @returns {string} Buffer contents as string
   */
  toString(encoding = 'utf-8') {
    return this.getAll().toString(encoding);
  }

  /**
   * Get the last N bytes from the buffer
   *
   * @param {number} n - Number of bytes to retrieve
   * @returns {Buffer} Last N bytes
   */
  tail(n) {
    if (n <= 0) {
      return Buffer.alloc(0);
    }

    const all = this.getAll();
    const start = Math.max(0, all.length - n);
    return all.subarray(start);
  }

  /**
   * Clear the buffer and remove overflow file
   */
  clear() {
    this.chunks = [];
    this.size = 0;
    this.diskSize = 0;

    if (this.hasOverflowed && existsSync(this.overflowPath)) {
      try {
        unlinkSync(this.overflowPath);
      } catch (err) {
        // Ignore cleanup errors
      }
    }

    this.hasOverflowed = false;
  }

  /**
   * Get buffer statistics
   *
   * @returns {Object} Stats object
   */
  getStats() {
    return {
      memorySize: this.size,
      diskSize: this.diskSize,
      totalSize: this.size + this.diskSize,
      hasOverflowed: this.hasOverflowed,
      chunkCount: this.chunks.length,
    };
  }

  /**
   * Flush current memory buffer to disk
   * @private
   */
  _flushToDisk() {
    if (this.chunks.length === 0) {
      return;
    }

    const data = Buffer.concat(this.chunks);

    try {
      if (this.hasOverflowed) {
        // Append to existing overflow file
        appendFileSync(this.overflowPath, data);
      } else {
        // Create new overflow file
        writeFileSync(this.overflowPath, data);
        this.hasOverflowed = true;
      }

      this.diskSize += data.length;
      this.chunks = [];
      this.size = 0;
    } catch (err) {
      // If disk write fails, keep data in memory (risk of OOM, but better than data loss)
      throw new Error(`Failed to flush buffer to disk: ${err.message}`);
    }
  }

  /**
   * Destructor cleanup (call before discarding instance)
   */
  destroy() {
    this.clear();
  }
}

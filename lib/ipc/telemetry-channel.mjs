/**
 * TelemetryChannel — High-throughput buffered telemetry publishing
 *
 * Specialized channel for telemetry data that buffers messages in memory
 * and flushes periodically. Provides:
 * - Non-blocking emit() for metrics, events, logs
 * - Automatic batching (flushes every 100ms or when buffer full)
 * - Backpressure detection with warnings at 80% buffer capacity
 * - Separate 'telemetry' topic on the bus for filtering
 * - Drop-oldest policy when buffer is full (no blocking)
 * - Built-in error handling and recovery
 *
 * @module telemetry-channel
 */

const DEFAULT_BUFFER_SIZE = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const BACKPRESSURE_THRESHOLD = 0.8; // Warn at 80% capacity

/**
 * Telemetry channel with buffering and batching
 *
 * @example
 * const telemetry = TelemetryChannel.init(agentChannel);
 *
 * // Non-blocking metric emission
 * telemetry.emit("tool_call", { tool: "Read", status: "success" });
 * telemetry.emit("buffer_size", { bytes: 1024768, stream: "stdout" });
 *
 * // Emit with metadata
 * telemetry.emitEvent("task_completed", {
 *   taskId: "MKLY-123",
 *   duration: 45000,
 *   exitCode: 0
 * });
 *
 * // Force flush (blocks until sent)
 * await telemetry.flush();
 *
 * // Graceful shutdown (flushes buffer)
 * await telemetry.close();
 */
export class TelemetryChannel {
  /**
   * @param {object} agentChannel - Connected AgentChannel instance
   * @param {object} [options] - Configuration options
   * @param {number} [options.bufferSize=1000] - Max buffered messages before flush
   * @param {number} [options.flushInterval=100] - Flush interval in ms
   * @param {boolean} [options.dropOnFull=true] - Drop oldest messages when buffer full
   */
  constructor(agentChannel, options = {}) {
    this.channel = agentChannel;
    this.agentId = agentChannel?.agentId || "unknown";
    this.enabled = !!agentChannel?.connected;

    this.bufferSize = options.bufferSize || DEFAULT_BUFFER_SIZE;
    this.flushInterval = options.flushInterval || DEFAULT_FLUSH_INTERVAL_MS;
    this.dropOnFull = options.dropOnFull !== false;

    // Telemetry buffer (true ring buffer with head/tail indices)
    this._buf = new Array(this.bufferSize);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
    this.droppedCount = 0;
    this.emittedCount = 0;
    this.flushedCount = 0;
    this.backpressureWarned = false;

    // Flush timer
    this.flushTimer = null;

    // Stats
    this.lastFlushTime = Date.now();
    this.lastFlushSize = 0;

    /** @type {boolean} Guard against concurrent flushes */
    this._flushing = false;

    // Start periodic flush if enabled
    if (this.enabled) {
      this._startFlushTimer();
    }
  }

  /**
   * Push an item into the ring buffer (internal)
   * @private
   * @param {object} item - Item to push
   */
  _bufPush(item) {
    this._buf[this._tail] = item;
    this._tail = (this._tail + 1) % this.bufferSize;

    if (this._count < this.bufferSize) {
      this._count++;
    } else {
      // Buffer is full, drop oldest by advancing head
      this._head = (this._head + 1) % this.bufferSize;
    }
  }

  /**
   * Drain the ring buffer and return all items (internal)
   * @private
   * @returns {Array} All items in the buffer
   */
  _bufDrain() {
    if (this._count === 0) {
      return [];
    }

    const result = [];
    while (this._count > 0) {
      result.push(this._buf[this._head]);
      this._head = (this._head + 1) % this.bufferSize;
      this._count--;
    }

    return result;
  }

  /**
   * Get current buffer length (internal)
   * @private
   * @returns {number} Number of items in buffer
   */
  _bufLength() {
    return this._count;
  }

  /**
   * Initialize telemetry channel (called at module load)
   * Non-blocking: if channel is unavailable, telemetry is simply not sent
   *
   * @param {object} agentChannel - Connected AgentChannel instance
   * @param {object} [options] - Configuration options
   * @returns {TelemetryChannel} Telemetry channel instance
   */
  static init(agentChannel, options = {}) {
    return new TelemetryChannel(agentChannel, options);
  }

  /**
   * Emit a metric (non-blocking)
   *
   * @param {string} metric - Metric name or event type
   * @param {object} data - Event data
   * @returns {boolean} True if buffered, false if dropped or disabled
   */
  emit(metric, data) {
    const buffered = this._bufferTelemetry({
      type: "metric",
      metric: metric,
      data: data,
      timestamp: Date.now()
    });

    this.emittedCount++;
    return buffered;
  }

  /**
   * Emit an event (non-blocking)
   *
   * @param {string} event - Event name
   * @param {object} data - Event data
   * @returns {boolean} True if buffered, false if dropped or disabled
   */
  emitEvent(event, data = {}) {
    const buffered = this._bufferTelemetry({
      type: "event",
      event: event,
      data: data,
      timestamp: Date.now()
    });

    this.emittedCount++;
    return buffered;
  }

  /**
   * Emit a log entry (non-blocking)
   *
   * @param {string} level - Log level (debug, info, warn, error)
   * @param {string} message - Log message
   * @param {object} [context={}] - Optional context
   * @returns {boolean} True if buffered, false if dropped or disabled
   */
  emitLog(level, message, context = {}) {
    const buffered = this._bufferTelemetry({
      type: "log",
      level: level,
      message: message,
      context: context,
      timestamp: Date.now()
    });

    this.emittedCount++;
    return buffered;
  }

  /**
   * Emit tool call event (convenience method)
   *
   * @param {string} toolName - Tool name
   * @param {object} [params={}] - Tool parameters
   * @returns {boolean}
   */
  toolCall(toolName, params = {}) {
    return this.emit("tool_call", {
      tool: toolName,
      params: typeof params === "object" ? Object.keys(params) : [],
    });
  }

  /**
   * Emit checklist item (convenience method)
   *
   * @param {string} status - Status: "pass", "fail", "skip"
   * @param {string} description - Item description
   * @param {string} [file=null] - File path
   * @param {number} [line=null] - Line number
   * @returns {boolean}
   */
  checklistItem(status, description, file = null, line = null) {
    return this.emit("checklist", {
      status, // "pass", "fail", "skip"
      description,
      file,
      line,
    });
  }

  /**
   * Emit quality signal (convenience method)
   *
   * @param {string} signal - Signal name
   * @param {any} value - Signal value
   * @returns {boolean}
   */
  qualitySignal(signal, value) {
    return this.emit("quality", {
      signal,
      value,
    });
  }

  /**
   * Emit memory usage (convenience method)
   *
   * @param {number} peakBytes - Peak memory usage in bytes
   * @param {number} currentBytes - Current memory usage in bytes
   * @param {number} limit - Memory limit in bytes
   * @returns {boolean}
   */
  memoryUsage(peakBytes, currentBytes, limit) {
    return this.emit("memory", {
      peak_bytes: peakBytes,
      current_bytes: currentBytes,
      limit_bytes: limit,
      utilization_percent: ((peakBytes / limit) * 100).toFixed(1),
    });
  }

  /**
   * Emit progress update (convenience method)
   *
   * @param {number} toolCount - Number of tools called
   * @param {number} elapsedMs - Elapsed time in ms
   * @param {string} [lastTool=null] - Last tool called
   * @param {number} [stdoutBytes=0] - Stdout size in bytes
   * @returns {boolean}
   */
  progress(toolCount, elapsedMs, lastTool = null, stdoutBytes = 0) {
    return this.emit("progress", {
      tool_count: toolCount,
      elapsed_ms: elapsedMs,
      last_tool: lastTool,
      stdout_bytes: stdoutBytes,
    });
  }

  /**
   * Force flush the buffer (blocks until sent)
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._flushing || this._bufLength() === 0) {
      return;
    }
    this._flushing = true;

    const batch = this._bufDrain();
    this.backpressureWarned = false;

    if (!this.enabled || !this.channel?.connected) {
      // Drop telemetry if not connected
      this.droppedCount += batch.length;
      this._flushing = false;
      return;
    }

    try {
      // Publish batched telemetry
      await this.channel.publish("telemetry", {
        agentId: this.agentId,
        batch: batch,
        batchSize: batch.length,
        timestamp: Date.now()
      });

      this.flushedCount += batch.length;
      this.lastFlushTime = Date.now();
      this.lastFlushSize = batch.length;
    } catch (err) {
      // Re-buffer on failure (if space available)
      if (this._bufLength() + batch.length <= this.bufferSize) {
        for (const item of batch) {
          this._bufPush(item);
        }
      } else {
        this.droppedCount += batch.length;
      }

      console.error(`[TelemetryChannel:${this.agentId}] Flush error: ${err.message}`);
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Get telemetry statistics
   *
   * @returns {object} Stats: { emitted, flushed, dropped, buffered, backpressure }
   */
  getStats() {
    const bufferedCount = this._bufLength();
    const utilizationPercent = (bufferedCount / this.bufferSize) * 100;

    return {
      emitted: this.emittedCount,
      flushed: this.flushedCount,
      dropped: this.droppedCount,
      buffered: bufferedCount,
      bufferSize: this.bufferSize,
      utilizationPercent: utilizationPercent.toFixed(1),
      backpressure: utilizationPercent >= BACKPRESSURE_THRESHOLD * 100,
      lastFlushTime: this.lastFlushTime,
      lastFlushSize: this.lastFlushSize
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.emittedCount = 0;
    this.flushedCount = 0;
    this.droppedCount = 0;
  }

  /**
   * Close and flush remaining telemetry
   *
   * @returns {Promise<void>}
   */
  async close() {
    this._stopFlushTimer();

    // Flush remaining buffer
    await this.flush();
  }

  /**
   * Buffer a telemetry item (internal)
   *
   * @private
   * @param {object} item - Telemetry item
   * @returns {boolean} True if buffered, false if dropped or disabled
   */
  _bufferTelemetry(item) {
    if (!this.enabled) return false;

    // Check backpressure
    const utilization = this._bufLength() / this.bufferSize;

    if (utilization >= BACKPRESSURE_THRESHOLD && !this.backpressureWarned) {
      this.backpressureWarned = true;
      console.error(
        `[TelemetryChannel:${this.agentId}] Backpressure warning: buffer at ${(utilization * 100).toFixed(1)}% capacity (${this._bufLength()}/${this.bufferSize})`
      );
    }

    // Add to buffer
    if (this._bufLength() < this.bufferSize) {
      this._bufPush(item);
    } else {
      // Buffer full
      if (this.dropOnFull) {
        // Drop oldest (FIFO) - ring buffer handles this automatically in _bufPush
        this._bufPush(item);
        this.droppedCount++;
      } else {
        // Drop newest (this message)
        this.droppedCount++;
        return false;
      }
    }

    // Flush immediately if buffer full
    if (this._bufLength() >= this.bufferSize) {
      setImmediate(() => this.flush().catch(() => {}));
    }

    return true;
  }

  /**
   * Start periodic flush timer (internal)
   *
   * @private
   */
  _startFlushTimer() {
    this._stopFlushTimer();

    this.flushTimer = setInterval(() => {
      if (this._bufLength() > 0) {
        this.flush().catch(() => {});
      }
    }, this.flushInterval);
    this.flushTimer.unref(); // Don't prevent process exit
  }

  /**
   * Stop flush timer (internal)
   *
   * @private
   */
  _stopFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

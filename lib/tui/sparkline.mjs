/**
 * Sparkline — Braille/block character sparkline component and tracker.
 *
 * Tracks numeric values over time in fixed-width buckets, then renders
 * as a compact sparkline using Unicode block characters: ▁▂▃▄▅▆▇█
 *
 * Uses React.createElement (no JSX) to avoid needing a build step.
 */

import React from 'react';
import { Text } from 'ink';
import { SPARK_CHARS } from './theme.mjs';

const e = React.createElement;

// ── Sparkline data tracker ────────────────────────────────────────

/**
 * Create a sparkline tracker that accumulates values in time buckets.
 *
 * @param {number} bucketMs    Width of each time bucket in ms (default: 10000 = 10s)
 * @param {number} maxBuckets  Number of buckets to retain (default: 20)
 * @returns {object} { record(value), getValues(), reset() }
 */
export function createSparklineTracker(bucketMs = 10000, maxBuckets = 20) {
  let buckets = [];       // Array of { startMs, value }
  let currentBucket = null;

  function ensureBucket() {
    const now = Date.now();
    if (!currentBucket || now - currentBucket.startMs >= bucketMs) {
      // Seal current bucket
      if (currentBucket) {
        buckets.push(currentBucket.value);
        // Trim to maxBuckets
        if (buckets.length > maxBuckets) {
          buckets = buckets.slice(buckets.length - maxBuckets);
        }
      }
      currentBucket = { startMs: now, value: 0 };
    }
  }

  return {
    /**
     * Record a value increment (e.g., a tool call).
     * @param {number} delta Amount to add to current bucket (default: 1)
     */
    record(delta = 1) {
      ensureBucket();
      currentBucket.value += delta;
    },

    /**
     * Get all bucket values including the current partial bucket.
     * Pads with leading zeros if fewer than maxBuckets exist.
     * @returns {number[]}
     */
    getValues() {
      ensureBucket();
      const all = [...buckets, currentBucket ? currentBucket.value : 0];
      // Pad to maxBuckets with leading zeros
      while (all.length < maxBuckets) {
        all.unshift(0);
      }
      return all.slice(-maxBuckets);
    },

    /**
     * Get raw bucket count (not padded).
     * @returns {number}
     */
    size() {
      return buckets.length + (currentBucket ? 1 : 0);
    },

    /** Reset all data. */
    reset() {
      buckets = [];
      currentBucket = null;
    },
  };
}

// ── Sparkline rendering ───────────────────────────────────────────

/**
 * Render a numeric array as a sparkline string.
 *
 * @param {number[]} values  Array of numeric values
 * @param {number} [width]   Max width in characters (defaults to values.length)
 * @returns {string} Sparkline string using ▁▂▃▄▅▆▇█ characters
 */
export function renderSparkline(values, width) {
  if (!values || values.length === 0) return '';

  const w = width || values.length;
  const data = values.slice(-w);
  const max = Math.max(...data, 1); // Avoid division by zero
  const levels = SPARK_CHARS.length - 1;

  return data.map(v => {
    const idx = Math.round((v / max) * levels);
    return SPARK_CHARS[Math.min(idx, levels)];
  }).join('');
}

// ── React component ───────────────────────────────────────────────

/**
 * Sparkline Ink component.
 *
 * @param {object} props
 * @param {number[]} props.values - Array of numeric values to render
 * @param {number} [props.width] - Max display width
 * @param {string} [props.color] - Text color
 */
export function Sparkline({ values, width, color }) {
  const line = renderSparkline(values || [], width);
  return e(Text, { color: color || 'cyan', dimColor: !color }, line);
}

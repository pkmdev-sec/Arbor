/**
 * Tests for RingBuffer
 *
 * Tests ring buffer implementation for bounded memory usage with overflow handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RingBuffer } from "../lib/buffer.mjs";

describe("RingBuffer", () => {
  it("stores and retrieves data", () => {
    const buf = new RingBuffer({ maxSize: 1024 });
    buf.write(Buffer.from("hello"));
    assert.equal(buf.toString(), "hello");
  });

  it("accumulates multiple writes", () => {
    const buf = new RingBuffer({ maxSize: 1024 });
    buf.write(Buffer.from("hello "));
    buf.write(Buffer.from("world"));
    assert.equal(buf.toString(), "hello world");
  });

  it("respects maxSize by flushing to disk", () => {
    const buf = new RingBuffer({ maxSize: 10 });
    buf.write(Buffer.from("12345")); // 5 bytes, fits
    buf.write(Buffer.from("67890")); // 5 more, fits
    buf.write(Buffer.from("ABCDE")); // 5 more, over 10 → flush to disk
    const all = buf.toString();
    assert.ok(all.includes("12345"), "should contain first chunk");
    assert.ok(all.includes("ABCDE"), "should contain latest chunk");
  });

  it("tracks overflow state", () => {
    const buf = new RingBuffer({ maxSize: 5 });
    assert.equal(buf.hasOverflowed, false);
    buf.write(Buffer.from("12345"));
    buf.write(Buffer.from("67890")); // triggers flush
    assert.equal(buf.hasOverflowed, true);
  });

  it("clear resets all state", () => {
    const buf = new RingBuffer({ maxSize: 10 });
    buf.write(Buffer.from("data"));
    buf.clear();
    assert.equal(buf.toString(), "");
    assert.equal(buf.size, 0);
    assert.equal(buf.hasOverflowed, false);
  });

  it("getStats returns correct info", () => {
    const buf = new RingBuffer({ maxSize: 100 });
    buf.write(Buffer.from("hello"));
    const stats = buf.getStats();
    assert.equal(stats.memorySize, 5);
    assert.equal(stats.diskSize, 0);
    assert.equal(stats.hasOverflowed, false);
    assert.equal(stats.chunkCount, 1);
  });

  it("tail returns last N bytes", () => {
    const buf = new RingBuffer({ maxSize: 1024 });
    buf.write(Buffer.from("hello world"));
    assert.equal(buf.tail(5).toString(), "world");
  });

  it("rejects non-Buffer input", () => {
    const buf = new RingBuffer({ maxSize: 1024 });
    assert.throws(() => buf.write("string"), TypeError);
  });

  it("destroy cleans up", () => {
    const buf = new RingBuffer({ maxSize: 5 });
    buf.write(Buffer.from("12345"));
    buf.write(Buffer.from("67890")); // overflow
    buf.destroy();
    assert.equal(buf.size, 0);
  });

  it("tail with n <= 0 returns empty buffer", () => {
    const buf = new RingBuffer({ maxSize: 1024 });
    buf.write(Buffer.from("hello"));
    assert.equal(buf.tail(0).length, 0);
    assert.equal(buf.tail(-5).length, 0);
  });

  it("handles multiple overflows (append mode)", () => {
    const buf = new RingBuffer({ maxSize: 10 });
    buf.write(Buffer.from("12345"));
    buf.write(Buffer.from("67890"));
    buf.write(Buffer.from("ABCDE")); // First overflow
    buf.write(Buffer.from("FGHIJ")); // Second overflow (append mode)
    buf.write(Buffer.from("KLMNO")); // Third overflow

    const all = buf.toString();
    assert.ok(all.includes("ABCDE"), "should contain first overflow");
    assert.ok(all.includes("KLMNO"), "should contain latest overflow");
    assert.ok(buf.hasOverflowed);
  });

  it("getStats reports disk size after overflow", () => {
    const buf = new RingBuffer({ maxSize: 5 });
    buf.write(Buffer.from("12345"));
    buf.write(Buffer.from("67890")); // triggers overflow

    const stats = buf.getStats();
    assert.ok(stats.diskSize > 0, "should have data on disk");
    assert.equal(stats.hasOverflowed, true);
    assert.ok(stats.totalSize > stats.memorySize);
  });
});

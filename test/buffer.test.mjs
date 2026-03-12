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
});

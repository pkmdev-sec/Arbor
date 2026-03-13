/**
 * Tests for Discovery Channel
 *
 * Tests discovery tracking and propagation mechanism for agent findings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DiscoveryChannel } from "../lib/discoveries.mjs";

// ── DiscoveryChannel constructor ────────────────────────────────

describe("DiscoveryChannel constructor", () => {
  it("uses default options", () => {
    const channel = new DiscoveryChannel();
    assert.equal(channel.maxDiscoveries, 5);
    assert.equal(channel.minSeverity, 'high');
    assert.deepStrictEqual(channel.discoveries, []);
  });

  it("accepts custom options", () => {
    const channel = new DiscoveryChannel({ maxDiscoveries: 10, minSeverity: 'medium' });
    assert.equal(channel.maxDiscoveries, 10);
    assert.equal(channel.minSeverity, 'medium');
  });
});

// ── record() ─────────────────────────────────────────────────────

describe("DiscoveryChannel.record()", () => {
  it("accepts valid discovery above severity threshold", () => {
    const channel = new DiscoveryChannel({ minSeverity: 'high' });
    const result = channel.record('agent-01', {
      type: 'bug',
      severity: 'critical',
      summary: 'Memory leak in auth module',
      files: ['src/auth.ts'],
      details: 'Details here',
    });
    assert.equal(result, true);
    assert.equal(channel.discoveries.length, 1);
  });

  it("rejects discovery below severity threshold", () => {
    const channel = new DiscoveryChannel({ minSeverity: 'high' });
    const result = channel.record('agent-01', {
      type: 'bug',
      severity: 'medium',
      summary: 'Minor typo',
    });
    assert.equal(result, false);
    assert.equal(channel.discoveries.length, 0);
  });

  it("rejects discovery with missing required fields", () => {
    const channel = new DiscoveryChannel();
    assert.equal(channel.record('agent-01', { type: 'bug' }), false);
    assert.equal(channel.record('agent-01', { severity: 'high' }), false);
    assert.equal(channel.record('agent-01', { summary: 'test' }), false);
  });

  it("rejects null or invalid discovery", () => {
    const channel = new DiscoveryChannel();
    assert.equal(channel.record('agent-01', null), false);
    assert.equal(channel.record('agent-01', 'string'), false);
  });

  it("stores discovery with timestamp and agentId", () => {
    const channel = new DiscoveryChannel();
    const before = Date.now();
    channel.record('agent-02', {
      type: 'performance',
      severity: 'high',
      summary: 'Slow query detected',
    });
    const after = Date.now();

    assert.equal(channel.discoveries.length, 1);
    const d = channel.discoveries[0];
    assert.equal(d.agentId, 'agent-02');
    assert.equal(d.type, 'performance');
    assert.equal(d.severity, 'high');
    assert.equal(d.summary, 'Slow query detected');
    assert.ok(d.timestamp >= before && d.timestamp <= after);
  });

  it("sets empty defaults for files and details", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', {
      type: 'bug',
      severity: 'critical',
      summary: 'Test',
    });

    const d = channel.discoveries[0];
    assert.deepStrictEqual(d.files, []);
    assert.equal(d.details, '');
  });

  it("sorts by severity (highest first), then by timestamp (most recent first)", () => {
    const channel = new DiscoveryChannel({ maxDiscoveries: 10, minSeverity: 'low' });

    // Add low severity
    channel.record('agent-01', { type: 'bug', severity: 'low', summary: 'Low 1', files: ['a.ts'] });
    // Add high severity
    channel.record('agent-02', { type: 'bug', severity: 'high', summary: 'High 1', files: ['b.ts'] });
    // Add critical severity
    channel.record('agent-03', { type: 'bug', severity: 'critical', summary: 'Critical 1', files: ['c.ts'] });
    // Add medium severity
    channel.record('agent-04', { type: 'bug', severity: 'medium', summary: 'Medium 1', files: ['d.ts'] });

    const severities = channel.discoveries.map(d => d.severity);
    assert.deepStrictEqual(severities, ['critical', 'high', 'medium', 'low']);
  });

  it("caps discoveries at maxDiscoveries", () => {
    const channel = new DiscoveryChannel({ maxDiscoveries: 3, minSeverity: 'high' });

    for (let i = 1; i <= 5; i++) {
      channel.record(`agent-${i}`, {
        type: 'bug',
        severity: 'high',
        summary: `Bug ${i}`,
        files: [`file${i}.ts`], // Different files to avoid duplicate detection
      });
    }

    assert.equal(channel.discoveries.length, 3);
  });

  it("keeps highest severity discoveries when at capacity", () => {
    const channel = new DiscoveryChannel({ maxDiscoveries: 2, minSeverity: 'low' });

    channel.record('agent-01', { type: 'bug', severity: 'medium', summary: 'Medium', files: ['a.ts'] });
    channel.record('agent-02', { type: 'bug', severity: 'critical', summary: 'Critical', files: ['b.ts'] });
    channel.record('agent-03', { type: 'bug', severity: 'low', summary: 'Low', files: ['c.ts'] });

    assert.equal(channel.discoveries.length, 2);
    const severities = channel.discoveries.map(d => d.severity);
    assert.deepStrictEqual(severities, ['critical', 'medium']);
  });
});

// ── isDuplicate() ────────────────────────────────────────────────

describe("DiscoveryChannel.isDuplicate()", () => {
  it("detects duplicate by type + file", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', {
      type: 'bug',
      severity: 'high',
      summary: 'Bug in auth',
      files: ['src/auth.ts'],
    });

    const isDup = channel.isDuplicate({
      type: 'bug',
      files: ['src/auth.ts'],
    });
    assert.equal(isDup, true);
  });

  it("detects duplicate by type when both have no files", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', {
      type: 'performance',
      severity: 'high',
      summary: 'Slow',
    });

    const isDup = channel.isDuplicate({
      type: 'performance',
      summary: 'Different summary',
    });
    assert.equal(isDup, true);
  });

  it("allows same type with different files", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', {
      type: 'bug',
      severity: 'high',
      summary: 'Bug in auth',
      files: ['src/auth.ts'],
    });

    const isDup = channel.isDuplicate({
      type: 'bug',
      files: ['src/api.ts'],
    });
    assert.equal(isDup, false);
  });

  it("allows different type with same files", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', {
      type: 'bug',
      severity: 'high',
      summary: 'Bug in auth',
      files: ['src/auth.ts'],
    });

    const isDup = channel.isDuplicate({
      type: 'performance',
      files: ['src/auth.ts'],
    });
    assert.equal(isDup, false);
  });

  it("rejects duplicate discoveries via record()", () => {
    const channel = new DiscoveryChannel();
    const discovery = {
      type: 'bug',
      severity: 'high',
      summary: 'Bug in auth',
      files: ['src/auth.ts'],
    };

    assert.equal(channel.record('agent-01', discovery), true);
    assert.equal(channel.record('agent-02', discovery), false);
    assert.equal(channel.discoveries.length, 1);
  });
});

// ── getContextInjection() ────────────────────────────────────────

describe("DiscoveryChannel.getContextInjection()", () => {
  it("returns empty string when no discoveries", () => {
    const channel = new DiscoveryChannel();
    assert.equal(channel.getContextInjection(), '');
  });

  it("formats discoveries for prompt injection", () => {
    const channel = new DiscoveryChannel({ minSeverity: 'critical' });
    channel.record('agent-01', {
      type: 'bug',
      severity: 'critical',
      summary: 'Memory leak',
      files: ['src/auth.ts', 'src/api.ts'],
      details: 'Found in line 42',
    });

    const text = channel.getContextInjection();
    assert.ok(text.includes('## SHARED DISCOVERIES'));
    assert.ok(text.includes('**[CRITICAL]** bug (agent-01)'));
    assert.ok(text.includes('Summary: Memory leak'));
    assert.ok(text.includes('Files: src/auth.ts, src/api.ts'));
    assert.ok(text.includes('Details: Found in line 42'));
  });

  it("omits files and details when not provided", () => {
    const channel = new DiscoveryChannel({ minSeverity: 'high' });
    channel.record('agent-01', {
      type: 'performance',
      severity: 'high',
      summary: 'Slow query',
    });

    const text = channel.getContextInjection();
    assert.ok(text.includes('**[HIGH]** performance (agent-01)'));
    assert.ok(text.includes('Summary: Slow query'));
    assert.ok(!text.includes('Files:'));
    assert.ok(!text.includes('Details:'));
  });

  it("formats multiple discoveries", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', { type: 'bug', severity: 'critical', summary: 'Bug 1' });
    channel.record('agent-02', { type: 'performance', severity: 'high', summary: 'Slow 2' });

    const text = channel.getContextInjection();
    assert.ok(text.includes('bug (agent-01)'));
    assert.ok(text.includes('performance (agent-02)'));
  });
});

// ── getAll() ─────────────────────────────────────────────────────

describe("DiscoveryChannel.getAll()", () => {
  it("returns raw discoveries array", () => {
    const channel = new DiscoveryChannel();
    channel.record('agent-01', { type: 'bug', severity: 'high', summary: 'Test' });

    const all = channel.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].type, 'bug');
    assert.equal(all[0].agentId, 'agent-01');
  });

  it("returns empty array when no discoveries", () => {
    const channel = new DiscoveryChannel();
    assert.deepStrictEqual(channel.getAll(), []);
  });
});

// ── clear() ──────────────────────────────────────────────────────

describe("DiscoveryChannel.clear()", () => {
  it("clears all discoveries", () => {
    const channel = new DiscoveryChannel({ minSeverity: 'high' });
    channel.record('agent-01', { type: 'bug', severity: 'high', summary: 'Bug 1', files: ['a.ts'] });
    channel.record('agent-02', { type: 'bug', severity: 'high', summary: 'Bug 2', files: ['b.ts'] });

    assert.equal(channel.discoveries.length, 2);
    channel.clear();
    assert.equal(channel.discoveries.length, 0);
  });
});

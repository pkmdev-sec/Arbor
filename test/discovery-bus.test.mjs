/**
 * Tests for DiscoveryBus (REQ-029: Shared Findings via IPC Pub/Sub)
 *
 * Tests real-time finding propagation between agents via IPC message bus.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryBus, createDiscoveryBus } from '../lib/ipc/discovery-bus.mjs';

// ── Mock AgentChannel ────────────────────────────────────────────────────────

class MockAgentChannel {
  constructor() {
    this.subscriptions = new Map(); // topic -> [handlers]
    this.publishedMessages = []; // { topic, message }
  }

  async publish(topic, message) {
    this.publishedMessages.push({ topic, message });

    // Simulate message delivery to subscribers (for testing loopback)
    const handlers = this.subscriptions.get(topic) || [];
    for (const handler of handlers) {
      // Wrap in setImmediate to simulate async delivery
      setImmediate(() => handler({ payload: message }));
    }
  }

  subscribe(topic, handler) {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
    }
    this.subscriptions.get(topic).push(handler);
  }

  unsubscribe(topic, handler) {
    if (!this.subscriptions.has(topic)) {
      return;
    }
    const handlers = this.subscriptions.get(topic);
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
    if (handlers.length === 0) {
      this.subscriptions.delete(topic);
    }
  }

  // Helper to simulate external discovery message
  simulateIncomingDiscovery(agentId, discovery) {
    const topic = `discoveries.${discovery.severity}`;
    const handlers = this.subscriptions.get('discoveries.*') || [];
    const message = { agentId, discovery, timestamp: Date.now() };
    for (const handler of handlers) {
      handler({ payload: message });
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DiscoveryBus', () => {
  let mockChannel;
  let bus;

  beforeEach(() => {
    mockChannel = new MockAgentChannel();
  });

  describe('constructor', () => {
    it('should require AgentChannel instance', () => {
      assert.throws(
        () => new DiscoveryBus(null),
        /AgentChannel instance is required/
      );
    });

    it('should create with default options', () => {
      bus = new DiscoveryBus(mockChannel);
      assert.equal(bus._subscribed, false);
      assert.equal(bus.discoveryChannel.maxDiscoveries, 5);
      assert.equal(bus.discoveryChannel.minSeverity, 'high');
    });

    it('should create with custom options', () => {
      bus = new DiscoveryBus(mockChannel, {
        maxDiscoveries: 10,
        minSeverity: 'medium',
      });
      assert.equal(bus.discoveryChannel.maxDiscoveries, 10);
      assert.equal(bus.discoveryChannel.minSeverity, 'medium');
    });
  });

  describe('start()', () => {
    it('should subscribe to discoveries.* wildcard topic', async () => {
      bus = new DiscoveryBus(mockChannel);
      await bus.start();

      assert.equal(bus._subscribed, true);
      assert.ok(mockChannel.subscriptions.has('discoveries.*'));
      assert.equal(mockChannel.subscriptions.get('discoveries.*').length, 1);
    });

    it('should be idempotent (multiple starts OK)', async () => {
      bus = new DiscoveryBus(mockChannel);
      await bus.start();
      await bus.start();

      assert.equal(bus._subscribed, true);
      assert.equal(mockChannel.subscriptions.get('discoveries.*').length, 1);
    });
  });

  describe('record()', () => {
    beforeEach(async () => {
      bus = new DiscoveryBus(mockChannel, { minSeverity: 'high' });
      await bus.start();
      mockChannel.publishedMessages = []; // Reset after start
    });

    it('should record discovery and publish to correct topic', () => {
      const discovery = {
        type: 'bug',
        severity: 'critical',
        summary: 'Memory leak detected',
        files: ['memory.mjs'],
        details: 'Growing heap usage',
      };

      const recorded = bus.record('agent-01', discovery);

      assert.equal(recorded, true);
      assert.equal(mockChannel.publishedMessages.length, 1);
      assert.equal(mockChannel.publishedMessages[0].topic, 'discoveries.critical');
      assert.deepEqual(mockChannel.publishedMessages[0].message.agentId, 'agent-01');
      assert.deepEqual(mockChannel.publishedMessages[0].message.discovery, discovery);
      assert.ok(mockChannel.publishedMessages[0].message.timestamp);
    });

    it('should not publish discoveries below severity threshold', () => {
      const discovery = {
        type: 'info',
        severity: 'low',
        summary: 'Minor optimization opportunity',
      };

      const recorded = bus.record('agent-01', discovery);

      assert.equal(recorded, false);
      assert.equal(mockChannel.publishedMessages.length, 0);
    });

    it('should not publish duplicate discoveries', () => {
      const discovery = {
        type: 'bug',
        severity: 'high',
        summary: 'Test failure',
        files: ['test.mjs'],
      };

      const recorded1 = bus.record('agent-01', discovery);
      const recorded2 = bus.record('agent-02', discovery);

      assert.equal(recorded1, true);
      assert.equal(recorded2, false); // Duplicate
      assert.equal(mockChannel.publishedMessages.length, 1);
    });

    it('should handle different severity levels', () => {
      bus.record('agent-01', { type: 'bug', severity: 'critical', summary: 'Critical issue', files: ['critical.mjs'] });
      bus.record('agent-02', { type: 'bug', severity: 'high', summary: 'High issue', files: ['high.mjs'] });

      assert.equal(mockChannel.publishedMessages.length, 2);
      assert.equal(mockChannel.publishedMessages[0].topic, 'discoveries.critical');
      assert.equal(mockChannel.publishedMessages[1].topic, 'discoveries.high');
    });
  });

  describe('_handleIncoming()', () => {
    beforeEach(async () => {
      bus = new DiscoveryBus(mockChannel, { minSeverity: 'high' });
      await bus.start();
    });

    it('should receive and store incoming discoveries', (t, done) => {
      const discovery = {
        type: 'bug',
        severity: 'critical',
        summary: 'Remote finding',
        files: ['remote.mjs'],
      };

      // Simulate external agent publishing discovery
      setTimeout(() => {
        mockChannel.simulateIncomingDiscovery('agent-remote', discovery);

        // Give time for async processing
        setTimeout(() => {
          const all = bus.getAll();
          assert.equal(all.length, 1);
          assert.equal(all[0].agentId, 'agent-remote');
          assert.equal(all[0].summary, 'Remote finding');
          done();
        }, 10);
      }, 10);
    });

    it('should deduplicate incoming discoveries', (t, done) => {
      const discovery = {
        type: 'bug',
        severity: 'high',
        summary: 'Duplicate test',
        files: ['dup.mjs'],
      };

      // Record locally first
      bus.record('agent-01', discovery);

      // Simulate remote agent sending same discovery
      setTimeout(() => {
        mockChannel.simulateIncomingDiscovery('agent-02', discovery);

        setTimeout(() => {
          const all = bus.getAll();
          assert.equal(all.length, 1); // Should still be 1 (deduped)
          assert.equal(all[0].agentId, 'agent-01'); // Original agent preserved
          done();
        }, 10);
      }, 10);
    });

    it('should handle malformed messages gracefully', () => {
      // Should not throw on invalid messages
      bus._handleIncoming({});
      bus._handleIncoming({ payload: {} });
      bus._handleIncoming({ payload: { agentId: 'test' } });
      bus._handleIncoming({ payload: { discovery: {} } });

      const all = bus.getAll();
      assert.equal(all.length, 0);
    });
  });

  describe('onDiscovery()', () => {
    beforeEach(async () => {
      bus = new DiscoveryBus(mockChannel);
      await bus.start();
    });

    it('should call handler when local discovery is recorded', (t, done) => {
      const discovery = {
        type: 'bug',
        severity: 'critical',
        summary: 'Handler test',
      };

      const unsubscribe = bus.onDiscovery((agentId, disc) => {
        assert.equal(agentId, 'agent-01');
        assert.equal(disc.summary, 'Handler test');
        unsubscribe();
        done();
      });

      bus.record('agent-01', discovery);
    });

    it('should call handler when remote discovery arrives', (t, done) => {
      const discovery = {
        type: 'bug',
        severity: 'high',
        summary: 'Remote handler test',
      };

      const unsubscribe = bus.onDiscovery((agentId, disc) => {
        assert.equal(agentId, 'agent-remote');
        assert.equal(disc.summary, 'Remote handler test');
        unsubscribe();
        done();
      });

      setTimeout(() => {
        mockChannel.simulateIncomingDiscovery('agent-remote', discovery);
      }, 10);
    });

    it('should support multiple handlers', (t, done) => {
      const discovery = {
        type: 'bug',
        severity: 'critical',
        summary: 'Multi handler',
      };

      let handler1Called = false;
      let handler2Called = false;

      bus.onDiscovery(() => { handler1Called = true; });
      bus.onDiscovery(() => {
        handler2Called = true;
        assert.ok(handler1Called);
        assert.ok(handler2Called);
        done();
      });

      bus.record('agent-01', discovery);
    });

    it('should return unsubscribe function that removes handler', (t, done) => {
      const discovery = {
        type: 'bug',
        severity: 'critical',
        summary: 'Unsubscribe test',
      };

      let callCount = 0;
      const unsubscribe = bus.onDiscovery(() => {
        callCount++;
      });

      bus.record('agent-01', discovery);
      unsubscribe();
      bus.record('agent-02', { ...discovery, files: ['different.mjs'] });

      setTimeout(() => {
        assert.equal(callCount, 1); // Only called once before unsubscribe
        done();
      }, 10);
    });

    it('should throw if handler is not a function', () => {
      assert.throws(
        () => bus.onDiscovery('not a function'),
        /Handler must be a function/
      );
    });
  });

  describe('getContextInjection()', () => {
    beforeEach(async () => {
      bus = new DiscoveryBus(mockChannel);
      await bus.start();
    });

    it('should return empty string when no discoveries', () => {
      const context = bus.getContextInjection();
      assert.equal(context, '');
    });

    it('should return formatted discoveries for context injection', () => {
      bus.record('agent-01', {
        type: 'bug',
        severity: 'critical',
        summary: 'Test summary',
        files: ['test.mjs'],
        details: 'Test details',
      });

      const context = bus.getContextInjection();
      assert.ok(context.includes('## SHARED DISCOVERIES'));
      assert.ok(context.includes('CRITICAL'));
      assert.ok(context.includes('Test summary'));
      assert.ok(context.includes('test.mjs'));
      assert.ok(context.includes('Test details'));
    });
  });

  describe('getAll()', () => {
    beforeEach(async () => {
      bus = new DiscoveryBus(mockChannel);
      await bus.start();
    });

    it('should return empty array when no discoveries', () => {
      const all = bus.getAll();
      assert.deepEqual(all, []);
    });

    it('should return all recorded discoveries', () => {
      bus.record('agent-01', { type: 'bug', severity: 'critical', summary: 'First', files: ['first.mjs'] });
      bus.record('agent-02', { type: 'bug', severity: 'high', summary: 'Second', files: ['second.mjs'] });

      const all = bus.getAll();
      assert.equal(all.length, 2);
      assert.equal(all[0].severity, 'critical'); // Sorted by severity
      assert.equal(all[1].severity, 'high');
    });
  });

  describe('stop()', () => {
    beforeEach(async () => {
      bus = new DiscoveryBus(mockChannel);
      await bus.start();
    });

    it('should unsubscribe from discoveries.* topic', async () => {
      await bus.stop();

      assert.equal(bus._subscribed, false);
      assert.equal(mockChannel.subscriptions.has('discoveries.*'), false);
    });

    it('should be idempotent (multiple stops OK)', async () => {
      await bus.stop();
      await bus.stop();

      assert.equal(bus._subscribed, false);
    });
  });

  describe('createDiscoveryBus()', () => {
    it('should create and start bus in one call', async () => {
      const bus = await createDiscoveryBus(mockChannel, { minSeverity: 'medium' });

      assert.ok(bus instanceof DiscoveryBus);
      assert.equal(bus._subscribed, true);
      assert.equal(bus.discoveryChannel.minSeverity, 'medium');
    });
  });

  describe('severity filtering', () => {
    it('should filter by severity threshold', async () => {
      bus = new DiscoveryBus(mockChannel, { minSeverity: 'high' });
      await bus.start();

      const low = bus.record('agent-01', { type: 'info', severity: 'low', summary: 'Low', files: ['low.mjs'] });
      const medium = bus.record('agent-02', { type: 'info', severity: 'medium', summary: 'Medium', files: ['medium.mjs'] });
      const high = bus.record('agent-03', { type: 'bug', severity: 'high', summary: 'High', files: ['high.mjs'] });
      const critical = bus.record('agent-04', { type: 'bug', severity: 'critical', summary: 'Critical', files: ['critical.mjs'] });

      assert.equal(low, false);
      assert.equal(medium, false);
      assert.equal(high, true);
      assert.equal(critical, true);

      const all = bus.getAll();
      assert.equal(all.length, 2);
    });
  });

  describe('max discoveries limit', () => {
    it('should trim to maxDiscoveries', async () => {
      bus = new DiscoveryBus(mockChannel, { maxDiscoveries: 3, minSeverity: 'low' });
      await bus.start();

      for (let i = 0; i < 5; i++) {
        bus.record(`agent-${i}`, {
          type: 'bug',
          severity: 'high',
          summary: `Discovery ${i}`,
          files: [`file${i}.mjs`], // Unique files to avoid dedup
        });
      }

      const all = bus.getAll();
      assert.equal(all.length, 3); // Should be trimmed to maxDiscoveries
    });
  });
});

#!/usr/bin/env node
/**
 * Example usage of lib/ai-client.mjs
 *
 * Run with: ANTHROPIC_API_KEY=sk-... node lib/ai-client.example.mjs
 */

import { aiDecision, aiJsonDecision } from './ai-client.mjs';

// Model constants for the examples
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const OPUS_MODEL = 'claude-opus-4-6';

// ── Example 1: Basic text decision ──────────────────────────────────
async function exampleTextDecision() {
  console.log('\n=== Example 1: Basic Text Decision ===');

  try {
    const result = await aiDecision({
      model: DEFAULT_MODEL,
      system: "You are a helpful coding assistant.",
      prompt: "What is the purpose of the async/await keywords in JavaScript? Answer in 2 sentences.",
      maxTokens: 200,
    });

    console.log('Response:', result.content);
    console.log('Model:', result.model);
    console.log('Usage:', result.usage);
    console.log('Latency:', result.latencyMs, 'ms');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// ── Example 2: JSON decision with schema ────────────────────────────
async function exampleJsonDecision() {
  console.log('\n=== Example 2: JSON Decision with Schema ===');

  const schema = {
    type: "object",
    required: ["tasks", "total"],
    properties: {
      tasks: { type: "array" },
      total: { type: "number" }
    }
  };

  try {
    const result = await aiJsonDecision({
      model: DEFAULT_MODEL,
      system: "You are a task decomposer. Break down user requests into subtasks.",
      prompt: "Break down 'Build a REST API' into 3 subtasks. Return JSON with {tasks: [...], total: number}",
      schema,
    });

    console.log('Parsed JSON:', JSON.stringify(result.parsed, null, 2));
    console.log('Model:', result.model);
    console.log('Usage:', result.usage);
    console.log('Latency:', result.latencyMs, 'ms');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// ── Example 3: Using Opus for verification ──────────────────────────
async function exampleOpusVerification() {
  console.log('\n=== Example 3: Opus Verification ===');

  try {
    const result = await aiDecision({
      model: OPUS_MODEL,
      system: "You are a code reviewer. Verify the correctness of code.",
      prompt: "Review this function: function add(a, b) { return a - b; } Is it correct?",
      maxTokens: 300,
    });

    console.log('Verification result:', result.content);
    console.log('Model:', result.model);
    console.log('Latency:', result.latencyMs, 'ms');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// ── Example 4: Retry logic demonstration ────────────────────────────
async function exampleRetryLogic() {
  console.log('\n=== Example 4: Retry Logic (simulated with invalid model) ===');

  try {
    // This will fail, demonstrating error handling
    await aiDecision({
      model: "invalid-model",
      system: "Test",
      prompt: "Test",
    });
  } catch (error) {
    console.log('Expected error caught:', error.message);
  }
}

// ── Run examples ────────────────────────────────────────────────────
async function main() {
  console.log('AI Client Examples');
  console.log('==================');
  console.log('DEFAULT_MODEL:', DEFAULT_MODEL);
  console.log('OPUS_MODEL:', OPUS_MODEL);

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set. Set it to run live examples:');
    console.error('   export ANTHROPIC_API_KEY=sk-ant-...');
    console.error('\nShowing error handling only:\n');
    await exampleRetryLogic();
    return;
  }

  // Run all examples
  await exampleTextDecision();
  await exampleJsonDecision();
  await exampleOpusVerification();
  await exampleRetryLogic();
}

main().catch(console.error);

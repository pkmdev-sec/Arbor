/**
 * Lightweight Anthropic SDK wrapper for direct AI decisions.
 *
 * Used by orchestration functions (autoMode, decompose, verify) to make
 * fast API calls instead of spawning full Claude Code subprocesses.
 * Subprocesses are still used for actual code execution (workers).
 *
 * Exports:
 *   - isAiClientAvailable() — check if ANTHROPIC_API_KEY is set
 *   - aiDecision()          — single messages.create call
 *   - aiJsonDecision()      — aiDecision + JSON extraction
 */

import Anthropic from "@anthropic-ai/sdk";
import { logIpc } from "./tui/ipc-logger.mjs";

// ── Lazy-initialized client (cached at module scope) ─────────────
let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _client;
}

// ── Availability check ───────────────────────────────────────────
export function isAiClientAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ── Single AI decision call ──────────────────────────────────────
/**
 * Makes a single messages.create call for lightweight AI decisions.
 * Retries once on 529 (overloaded) after a 2s delay.
 *
 * @param {object} opts
 * @param {string} [opts.model='claude-sonnet-4-6'] - Model to use
 * @param {string} [opts.system] - System prompt
 * @param {string} opts.prompt - User prompt
 * @param {number} [opts.maxTokens=4096] - Max response tokens
 * @returns {Promise<{content: string, usage: object, model: string, latencyMs: number}>}
 */
export async function aiDecision({
  model = "claude-sonnet-4-6",
  system,
  prompt,
  maxTokens = 4096,
}) {
  const client = getClient();
  const start = Date.now();

  const messages = [{ role: "user", content: prompt }];
  const params = { model, max_tokens: maxTokens, messages };
  if (system) {
    params.system = system;
  }

  let response;
  try {
    response = await client.messages.create(params);
  } catch (err) {
    // Retry once on 529 (overloaded) after 2s delay
    if (err.status === 529) {
      await new Promise((r) => setTimeout(r, 2000));
      response = await client.messages.create(params);
    } else {
      throw err;
    }
  }

  const content = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const latencyMs = Date.now() - start;
  logIpc('ai-client', 'orchestrator', 'decision', model + ': ' + prompt.slice(0, 80), { latencyMs, tokens: response.usage.input_tokens + '+' + response.usage.output_tokens });

  return {
    content,
    usage: response.usage,
    model: response.model,
    latencyMs,
  };
}

// ── AI decision with JSON extraction ─────────────────────────────
/**
 * Calls aiDecision, then extracts JSON from the response text.
 * Tries three patterns in order:
 *   1. Fenced code blocks (```json ... ``` or ``` ... ```)
 *   2. Raw JSON array ([...])
 *   3. Raw JSON object ({...})
 *
 * Returns parsed: null if no valid JSON found (does NOT throw).
 *
 * @param {object} opts - Same as aiDecision
 * @returns {Promise<{content: string, usage: object, model: string, latencyMs: number, parsed: object|null}>}
 */
export async function aiJsonDecision(opts) {
  const result = await aiDecision(opts);

  let parsed = null;
  const text = result.content;

  try {
    // Pattern 1: Fenced code block (```json ... ``` or ``` ... ```)
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenced) {
      parsed = JSON.parse(fenced[1].trim());
    }

    // Pattern 2: Raw JSON array
    if (!parsed) {
      const arrayMatch = text.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        parsed = JSON.parse(arrayMatch[0]);
      }
    }

    // Pattern 3: Raw JSON object
    if (!parsed) {
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]);
      }
    }
  } catch {
    // JSON parse failed — parsed stays null
  }

  return { ...result, parsed };
}

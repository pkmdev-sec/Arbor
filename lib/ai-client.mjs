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
import { logIpc } from "./ipc-logger.mjs";

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
 * Retries up to 3 times on retryable errors (429, 500, 503, 529) with exponential backoff + jitter.
 *
 * @param {object} opts
 * @param {string} [opts.model='claude-sonnet-4-6'] - Model to use
 * @param {string} [opts.system] - System prompt
 * @param {string} opts.prompt - User prompt
 * @param {number} [opts.maxTokens=4096] - Max response tokens
 * @param {object} [opts.jsonSchema] - Optional JSON schema for structured output via tool_use
 * @returns {Promise<{content: string, usage: object, model: string, latencyMs: number}>}
 */
export async function aiDecision({
  model = "claude-sonnet-4-6",
  system,
  prompt,
  maxTokens = 4096,
  jsonSchema,
}) {
  const client = getClient();
  const start = Date.now();

  const messages = [{ role: "user", content: prompt }];
  const params = { model, max_tokens: maxTokens, messages };
  if (system) {
    params.system = system;
  }

  // Add tool_use for structured output if schema provided
  if (jsonSchema) {
    params.tools = [{
      name: 'structured_output',
      description: 'Structured task decomposition result',
      input_schema: jsonSchema
    }];
    params.tool_choice = { type: 'tool', name: 'structured_output' };
  }

  const maxRetries = 3;
  const retryableStatuses = [429, 500, 503, 529];

  let response;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await client.messages.create(params);
      break; // Success
    } catch (err) {
      const isRetryable = err.status && retryableStatuses.includes(err.status);
      const isLastAttempt = attempt === maxRetries;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      // Exponential backoff with jitter: base_delay * 2^attempt + random(0-1000ms)
      const baseDelay = 1000;
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 1000;
      const delay = exponentialDelay + jitter;

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Extract content based on schema usage
  let content;
  if (jsonSchema) {
    // For tool_use, extract from tool_use block and stringify
    const toolUseBlock = response.content.find((block) => block.type === "tool_use");
    content = toolUseBlock ? JSON.stringify(toolUseBlock.input) : "";
  } else {
    // For text, extract from text blocks (existing behavior)
    content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

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

// ── AI decision with schema-enforced JSON ────────────────────────
/**
 * Calls aiDecision with tool_use schema enforcement for structured output.
 * Falls back to aiJsonDecision if schema enforcement fails.
 *
 * @param {object} opts - Same as aiDecision plus:
 * @param {object} opts.schema - Required JSON schema for structured output
 * @returns {Promise<{content: string, usage: object, model: string, latencyMs: number, parsed: object|null}>}
 */
export async function aiSchemaDecision(opts) {
  const { schema, ...aiOpts } = opts;

  if (!schema) {
    throw new Error('[ai-client] aiSchemaDecision requires schema parameter');
  }

  try {
    // Call aiDecision with schema (uses tool_use)
    const result = await aiDecision({ ...aiOpts, jsonSchema: schema });

    // Parse the JSON from content (already stringified by aiDecision)
    let parsed = null;
    try {
      parsed = JSON.parse(result.content);
    } catch (parseErr) {
      console.error('[ai-client] Failed to parse schema-enforced output, falling back to regex extraction');
      // Fall back to aiJsonDecision
      return await aiJsonDecision(aiOpts);
    }

    return { ...result, parsed };
  } catch (err) {
    console.error('[ai-client] Schema enforcement failed, falling back to regex extraction:', err.message);
    // Fall back to aiJsonDecision
    return await aiJsonDecision(aiOpts);
  }
}

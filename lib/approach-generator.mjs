/**
 * F12: Approach Generator for Fork-Merge Mode
 *
 * Generates N distinct implementation approaches for a task.
 * Each approach is a self-contained instruction set that an agent
 * can execute independently in its own worktree.
 *
 * Used by swarm.mjs --mode fork-merge to produce competing approaches
 * that are executed in parallel and compared.
 */

import { aiJsonDecision, isAiClientAvailable } from "./ai-client.mjs";
import { colors, log } from "./output.mjs";
import { logIpc } from "./ipc-logger.mjs";

const APPROACH_GENERATOR_PROMPT = [
  "You are a software architecture strategist. Given a task and project context,",
  "generate N distinct implementation approaches that could each solve the task.",
  "",
  "Each approach must be:",
  "- DISTINCT: meaningfully different strategy, not just naming/style variations",
  "- COMPLETE: executable by an agent with zero prior context",
  "- SELF-CONTAINED: includes all files to modify and specific instructions",
  "- COMPARABLE: approaches should target the same acceptance criteria",
  "",
  "## Approach Differentiation Examples",
  "- Approach A: top-down refactor (extract interface first, then implement)",
  "- Approach B: bottom-up refactor (implement concrete classes, then extract interface)",
  "- Approach A: use existing library X",
  "- Approach B: implement from scratch for smaller bundle",
  "- Approach A: modify existing module inline",
  "- Approach B: create new module and redirect imports",
  "",
  "## Output Format",
  "Respond with ONLY a JSON object — no markdown fences, no explanation:",
  '{"approaches": [{"title": "2-5 word name", "strategy": "1-sentence high-level strategy",',
  '"instructions": "Detailed step-by-step instructions for the agent (3-8 sentences)",',
  '"risk": "low|medium|high", "estimated_diff_size": "small|medium|large"}]}',
].join("\n");

const APPROACH_SCHEMA = {
  type: "object",
  properties: {
    approaches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title:               { type: "string", description: "2-5 word approach name" },
          strategy:            { type: "string", description: "1-sentence high-level strategy" },
          instructions:        { type: "string", description: "Detailed step-by-step agent instructions" },
          risk:                { type: "string", enum: ["low", "medium", "high"] },
          estimated_diff_size: { type: "string", enum: ["small", "medium", "large"] },
        },
        required: ["title", "strategy", "instructions"],
        additionalProperties: false,
      },
    },
  },
  required: ["approaches"],
  additionalProperties: false,
};

/**
 * Generate N distinct approaches for a task.
 *
 * @param {string} task - Task description
 * @param {number} count - Number of approaches to generate (default: 2)
 * @param {object} options
 * @param {string} [options.projectTree] - File listing for context
 * @param {string} [options.scoutSummary] - Scout report for context
 * @returns {Promise<Array<{title, strategy, instructions, risk, estimated_diff_size}>>}
 */
export async function generateApproaches(task, count = 2, { projectTree = "", scoutSummary = "" } = {}) {
  log(`${colors.bold}${colors.cyan}[FORK-MERGE]${colors.reset} Generating ${count} competing approaches...`);
  logIpc("orchestrator", "approach-gen", "task_assign", `Generate ${count} approaches`);

  const contextParts = [];
  if (projectTree) contextParts.push(`PROJECT FILES (first 300):\n${projectTree}`);
  if (scoutSummary) contextParts.push(`PROJECT ANALYSIS:\n${scoutSummary}`);

  const userPrompt = [
    `Generate exactly ${count} distinct implementation approaches for this task:`,
    ``,
    `TASK: ${task}`,
    contextParts.length > 0 ? `\n${contextParts.join("\n\n")}` : "",
    ``,
    `Requirements:`,
    `- Approaches must be meaningfully different (not cosmetic variations)`,
    `- Each must be independently executable by a code agent`,
    `- Include specific file paths from the project when possible`,
  ].join("\n");

  // Fast path: Direct API call
  if (isAiClientAvailable()) {
    try {
      const result = await aiJsonDecision({
        model: "claude-sonnet-4-6",
        system: APPROACH_GENERATOR_PROMPT,
        prompt: userPrompt,
        maxTokens: 4096,
      });

      const parsed = result.parsed?.approaches ?? (Array.isArray(result.parsed) ? result.parsed : null);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const approaches = parsed.slice(0, count);
        log(`${colors.green}  ✓ Generated ${approaches.length} approaches (${result.latencyMs}ms)${colors.reset}`);
        for (const a of approaches) {
          log(`    ${colors.dim}→ ${a.title}: ${a.strategy?.slice(0, 60) || ""}${colors.reset}`);
        }
        logIpc("approach-gen", "orchestrator", "result",
          `${approaches.length} approaches: ${approaches.map(a => a.title).join(", ")}`,
          { latencyMs: result.latencyMs });
        return approaches;
      }
    } catch (err) {
      log(`${colors.yellow}  ⚠ Approach generation failed: ${err.message}${colors.reset}`);
    }
  }

  // Fallback: generate task-specific approaches based on keywords
  log(`${colors.yellow}  ⚠ Using task-type heuristic approaches (AI unavailable)${colors.reset}`);

  const taskLower = task.toLowerCase();
  let approaches = [];

  // Detect task type and generate relevant approaches
  if (taskLower.match(/\b(test|testing|spec|coverage)\b/)) {
    approaches = [
      {
        title: "Unit Test Approach",
        strategy: "Write focused unit tests with mocks and stubs",
        instructions: `Write unit tests for the task using mocks to isolate dependencies. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
      {
        title: "Integration Test Approach",
        strategy: "Write end-to-end integration tests with real dependencies",
        instructions: `Write integration tests that verify the full workflow. ${task}`,
        risk: "medium",
        estimated_diff_size: "medium",
      },
      {
        title: "TDD Approach",
        strategy: "Write failing tests first, then implement to make them pass",
        instructions: `Start by writing failing tests that specify expected behavior, then implement. ${task}`,
        risk: "low",
        estimated_diff_size: "medium",
      },
    ];
  } else if (taskLower.match(/\b(refactor|cleanup|reorganize|restructure)\b/)) {
    approaches = [
      {
        title: "Extract & Isolate",
        strategy: "Extract components/functions into separate modules",
        instructions: `Extract reusable pieces into new modules, update imports. ${task}`,
        risk: "medium",
        estimated_diff_size: "large",
      },
      {
        title: "In-Place Refactor",
        strategy: "Refactor within existing file structure",
        instructions: `Improve code quality within current files without moving code. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
      {
        title: "Incremental Migration",
        strategy: "Refactor in small steps with deprecation warnings",
        instructions: `Refactor incrementally, keeping old code with deprecation notices. ${task}`,
        risk: "low",
        estimated_diff_size: "large",
      },
    ];
  } else if (taskLower.match(/\b(fix|bug|issue|error|crash|broken)\b/)) {
    approaches = [
      {
        title: "Root Cause Fix",
        strategy: "Identify and fix the underlying root cause",
        instructions: `Debug to find the root cause, then fix it at the source. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
      {
        title: "Defensive Guard",
        strategy: "Add defensive checks and error handling",
        instructions: `Add validation and error handling to prevent the issue. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
      {
        title: "Architectural Fix",
        strategy: "Refactor the problematic design pattern",
        instructions: `Refactor the architecture to eliminate the class of bugs. ${task}`,
        risk: "high",
        estimated_diff_size: "large",
      },
    ];
  } else if (taskLower.match(/\b(explore|investigate|analyze|understand|find)\b/)) {
    approaches = [
      {
        title: "Code Reading Approach",
        strategy: "Read and document relevant code paths",
        instructions: `Read through the codebase and document findings. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
      {
        title: "Experimental Approach",
        strategy: "Write small experiments to test hypotheses",
        instructions: `Create minimal test cases to verify understanding. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
    ];
  } else if (taskLower.match(/\b(implement|add|create|build|develop)\b/)) {
    approaches = [
      {
        title: "Minimal Implementation",
        strategy: "Build minimal viable solution with core features only",
        instructions: `Implement only the essential features needed. ${task}`,
        risk: "low",
        estimated_diff_size: "small",
      },
      {
        title: "Robust Implementation",
        strategy: "Build complete solution with validation and error handling",
        instructions: `Implement with full error handling, validation, and edge cases. ${task}`,
        risk: "medium",
        estimated_diff_size: "large",
      },
      {
        title: "Library-Based Approach",
        strategy: "Use existing libraries/frameworks for the implementation",
        instructions: `Leverage existing libraries to implement the feature. ${task}`,
        risk: "medium",
        estimated_diff_size: "medium",
      },
    ];
  } else {
    // Default generic approaches if no keywords match
    approaches = [
      {
        title: "Direct Implementation",
        strategy: "Implement changes directly in the existing code structure",
        instructions: `Implement the task by modifying existing files in-place. ${task}`,
        risk: "low",
        estimated_diff_size: "medium",
      },
      {
        title: "Refactor-First Approach",
        strategy: "Extract and restructure before implementing the change",
        instructions: `First refactor the relevant code for clarity, then implement. ${task}`,
        risk: "medium",
        estimated_diff_size: "large",
      },
    ];
  }

  return approaches.slice(0, count);
}

export { APPROACH_SCHEMA };

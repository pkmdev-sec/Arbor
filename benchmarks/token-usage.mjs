#!/usr/bin/env node
/**
 * Benchmark: Token usage with F11 semantic context filtering
 *
 * Measures the context size reduction achieved by per-role filtering.
 * Generates realistic system prompts and measures before/after sizes.
 *
 * Usage: node benchmarks/token-usage.mjs
 */

import { filterSystemPromptForRole, filteringStats } from "../lib/context-filter.mjs";

// Simulate realistic system prompts of varying sizes
function generateRealisticPrompt(size) {
  const sections = [];

  sections.push(`[Scout Report]\n${"Project is a Node.js monorepo with TypeScript. ".repeat(Math.ceil(size * 0.1 / 50))}`);
  sections.push(`[Wave 1 Discoveries]\nagent-01: found auth module with JWT handling\nagent-02: found API routes with Express\n${"Additional discovery details. ".repeat(Math.ceil(size * 0.05 / 30))}`);
  sections.push(`CONSTRAINTS:\n- Must use TypeScript\n- No external dependencies\n- Follow existing code style\n${"- Additional constraint line\n".repeat(Math.ceil(size * 0.05 / 30))}`);
  sections.push(`KNOWN DECISIONS:\n- Use JWT for authentication\n- REST API over GraphQL\n- PostgreSQL for persistence\n${"- Additional decision\n".repeat(Math.ceil(size * 0.08 / 25))}`);
  sections.push(`FILE CONTEXT:\n- src/auth/login.ts: handles login flow with JWT\n- src/api/routes.ts: API route definitions\n- src/db/models.ts: database models\n${"- src/module/file.ts: description of file\n".repeat(Math.ceil(size * 0.15 / 45))}`);
  sections.push(`GIT DIFF:\n${"diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,5 +1,8 @@\n+import { something } from './module';\n const x = 1;\n-const y = 2;\n+const y = 3;\n".repeat(Math.ceil(size * 0.25 / 180))}`);
  sections.push(`TEST EXECUTION RESULTS:\nExit code: 0\nTests: 45 passed, 2 failed\n${"  ✓ test case description passed\n".repeat(Math.ceil(size * 0.15 / 35))}`);
  sections.push(`WORKER OUTPUTS:\n--- agent-01 ---\nImplemented auth module changes.\n${"Additional output line from worker.\n".repeat(Math.ceil(size * 0.17 / 40))}`);

  return sections.join("\n\n");
}

function estimateTokens(text) {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil((text || "").length / 4);
}

function main() {
  const sizes = [2000, 5000, 10000, 20000, 50000];
  const roles = ["worker", "verifier", "decomposer"];

  console.log("Token Usage Benchmark: F11 Semantic Context Filtering\n");
  console.log("Prompt Size".padEnd(14) + roles.map(r => r.padStart(20)).join(""));
  console.log("-".repeat(14 + roles.length * 20));

  const summaryByRole = {};
  for (const role of roles) summaryByRole[role] = [];

  for (const targetSize of sizes) {
    const prompt = generateRealisticPrompt(targetSize);
    const originalTokens = estimateTokens(prompt);
    const row = [`~${originalTokens} tokens`.padEnd(14)];

    for (const role of roles) {
      const filtered = filterSystemPromptForRole(prompt, role);
      const stats = filteringStats(prompt, filtered);
      const filteredTokens = estimateTokens(filtered);
      const saved = originalTokens - filteredTokens;

      row.push(`${stats.reductionPct}% (-${saved} tok)`.padStart(20));
      summaryByRole[role].push(stats.reductionPct);
    }

    console.log(row.join(""));
  }

  console.log("\n" + "=".repeat(14 + roles.length * 20));
  const avgRow = ["Average".padEnd(14)];
  for (const role of roles) {
    const avg = summaryByRole[role].reduce((a, b) => a + b, 0) / summaryByRole[role].length;
    avgRow.push(`${avg.toFixed(1)}% reduction`.padStart(20));
  }
  console.log(avgRow.join(""));

  // Detailed breakdown for a medium prompt
  console.log("\n\nDetailed Breakdown (medium ~5000 char prompt):");
  console.log("-".repeat(60));
  const mediumPrompt = generateRealisticPrompt(5000);
  for (const role of roles) {
    const filtered = filterSystemPromptForRole(mediumPrompt, role);
    const stats = filteringStats(mediumPrompt, filtered);
    console.log(`\n${role.toUpperCase()}:`);
    console.log(`  Original: ${stats.originalSize} chars (~${estimateTokens(mediumPrompt)} tokens)`);
    console.log(`  Filtered: ${stats.filteredSize} chars (~${estimateTokens(filtered)} tokens)`);
    console.log(`  Reduction: ${stats.reductionPct}%`);
    console.log(`  Saved: ~${estimateTokens(mediumPrompt) - estimateTokens(filtered)} tokens`);
  }
}

main();

#!/usr/bin/env node
/**
 * Benchmark: Agent spawn startup latency
 *
 * Measures the overhead of importing and initializing arbor modules
 * before any actual AI calls are made. This is the "cold start" cost.
 *
 * Usage: node benchmarks/startup-latency.mjs [iterations]
 */

const iterations = parseInt(process.argv[2]) || 5;

async function measureImport(label, importFn) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await importFn();
    times.push(performance.now() - start);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { label, avg: avg.toFixed(2), min: min.toFixed(2), max: max.toFixed(2), times };
}

async function main() {
  console.log(`Startup Latency Benchmark (${iterations} iterations)\n`);
  console.log("Module".padEnd(30) + "Avg (ms)".padStart(10) + "Min (ms)".padStart(10) + "Max (ms)".padStart(10));
  console.log("-".repeat(60));

  const results = [];

  // Core modules
  results.push(await measureImport("lib/output.mjs", () => import("../lib/output.mjs")));
  results.push(await measureImport("lib/config.mjs", () => import("../lib/config.mjs")));
  results.push(await measureImport("lib/cli.mjs", () => import("../lib/cli.mjs")));
  results.push(await measureImport("lib/ai-client.mjs", () => import("../lib/ai-client.mjs")));
  results.push(await measureImport("lib/context-bridge.mjs", () => import("../lib/context-bridge.mjs")));
  results.push(await measureImport("lib/context-filter.mjs", () => import("../lib/context-filter.mjs")));
  results.push(await measureImport("lib/ipc-logger.mjs", () => import("../lib/ipc-logger.mjs")));
  results.push(await measureImport("lib/agent-spawn.mjs", () => import("../lib/agent-spawn.mjs")));
  results.push(await measureImport("lib/orchestration.mjs", () => import("../lib/orchestration.mjs")));
  results.push(await measureImport("lib/isolation.mjs", () => import("../lib/isolation.mjs")));

  // F12 modules
  results.push(await measureImport("lib/approach-generator.mjs", () => import("../lib/approach-generator.mjs")));
  results.push(await measureImport("lib/branch-selector.mjs", () => import("../lib/branch-selector.mjs")));

  for (const r of results) {
    console.log(r.label.padEnd(30) + r.avg.padStart(10) + r.min.padStart(10) + r.max.padStart(10));
  }

  // Full entry point
  console.log("\n" + "=".repeat(60));
  const fullStart = performance.now();
  await import("../lib/cli.mjs");
  await import("../lib/config.mjs");
  await import("../lib/ai-client.mjs");
  await import("../lib/orchestration.mjs");
  await import("../lib/context-filter.mjs");
  await import("../lib/approach-generator.mjs");
  await import("../lib/branch-selector.mjs");
  const fullMs = (performance.now() - fullStart).toFixed(2);
  console.log(`Full module load (cached):     ${fullMs}ms`);

  const totalAvg = results.reduce((sum, r) => sum + parseFloat(r.avg), 0).toFixed(2);
  console.log(`Sum of averages (first load):  ${totalAvg}ms`);
}

main().catch(console.error);

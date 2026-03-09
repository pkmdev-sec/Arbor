/**
 * CLI argument parsing and help text for both entry points
 *
 * Extracted from:
 *   - agent-entry.mjs.pre-refactor: parseArgs() (~lines 192-248), showHelp() (~lines 250-286)
 *   - swarm.mjs.pre-refactor: parseArgs() (~lines 43-71), showHelp() (~lines 73-99)
 *
 * Two parsers, two help functions — one pair per entry point.
 */

import { colors, log } from "./output.mjs";

// ── agent-entry argument parsing (from agent-entry.mjs.pre-refactor lines ~192-248) ──
export function parseAgentArgs(argv) {
  const args = {
    task: null,
    model: "sonnet",
    budget: 15,
    timeout: 600,
    maxTurns: 50,
    systemPrompt: null,
    role: null,  // worker, verifier, decomposer
    bdTask: null,  // bd task ID — agent claims on start, closes on exit
    cwd: null,
    contextFile: null,
    resultFile: null,
    outputFormat: "text",
    quiet: false,
    stdin: false,
    stdinTimeout: 30,  // stdin read timeout in seconds (default: 30)
    maxRetries: 0,  // retry on non-timeout failures (default: 0, disabled)
    help: false,
    version: false,
  };

  const raw = argv.slice(2);
  let i = 0;

  while (i < raw.length) {
    const a = raw[i];
    switch (a) {
      case "-h": case "--help":    args.help = true; i++; break;
      case "--version":            args.version = true; i++; break;
      case "-m": case "--model":   args.model = raw[++i]; i++; break;
      case "-b": case "--budget":  args.budget = Number(raw[++i]); i++; break;
      case "-t": case "--timeout": args.timeout = Number(raw[++i]); i++; break;
      case "-n": case "--turns":   args.maxTurns = Number(raw[++i]); i++; break;
      case "-s": case "--system":  args.systemPrompt = raw[++i]; i++; break;
      case "--role":               args.role = raw[++i]; i++; break;
      case "--bd-task":            args.bdTask = raw[++i]; i++; break;
      case "-d": case "--dir":     args.cwd = raw[++i]; i++; break;
      case "--context-file":       args.contextFile = raw[++i]; i++; break;
      case "--result-file":        args.resultFile = raw[++i]; i++; break;
      case "--json":               args.outputFormat = "json"; i++; break;
      case "-q": case "--quiet":   args.quiet = true; i++; break;
      case "--stdin":              args.stdin = true; i++; break;
      case "--stdin-timeout":      args.stdinTimeout = Number(raw[++i]); i++; break;
      case "--max-retries":        args.maxRetries = Number(raw[++i]); i++; break;
      default:
        if (a.startsWith("-")) {
          log(`${colors.red}Unknown flag: ${a}${colors.reset}`);
          process.exit(1);
        }
        if (!args.task) args.task = a;
        i++;
    }
  }

  return args;
}

// ── agent-entry help text (from agent-entry.mjs.pre-refactor lines ~250-286) ──
export function showAgentHelp() {
  process.stdout.write(`remote-agent — Isolated Claude Code supervisor for research

USAGE:
  remote-agent [OPTIONS] "task description"
  echo "task" | remote-agent --stdin [OPTIONS]

MODES:
  Simple:       remote-agent "explore src/models/"
  Structured:   remote-agent --context-file ctx.json --result-file result.json "task"
  Piped:        git diff | remote-agent --stdin -s "review this diff"

OPTIONS:
  -m, --model MODEL        Model: sonnet (default) or opus. Both use 1M context.
  -b, --budget USD         Max budget in USD (default: 15)
  -t, --timeout SECS       Timeout in seconds (default: 600)
  -n, --turns NUM          Max tool-use turns (default: 50)
  -s, --system PROMPT      Append system prompt
  -d, --dir PATH           Working directory
  --context-file PATH      Read structured context from JSON file
  --result-file PATH       Write structured results to JSON file
  --json                   Output as JSON instead of text
  --stdin                  Read task from stdin
  --stdin-timeout SECS     Stdin read timeout in seconds (default: 30)
  --max-retries NUM        Retry on non-timeout failures (default: 0, disabled)
  -q, --quiet              Suppress status messages
  -h, --help               Show this help
  --version                Show version

EXAMPLES:
  remote-agent "explore the auth module and map all endpoints"
  remote-agent -m opus --turns 80 "security audit of src/api/"
  remote-agent -m opus --turns 80 "deep security audit of src/api/"
  remote-agent --context-file ctx.json --result-file out.json "analyze models"
  git diff HEAD~3 | remote-agent --stdin -s "review for bugs"
`);
}

// ── swarm argument parsing (from swarm.mjs.pre-refactor lines ~43-71) ──
export function parseSwarmArgs(argv) {
  const args = {
    task: null, mode: "auto", agents: 3, depth: "normal",
    resultFile: null, contextFile: null, bdTask: null, quiet: false,
    verify: null, help: false, timeout: 600,
  };
  const raw = argv.slice(2);
  let i = 0;
  while (i < raw.length) {
    switch (raw[i]) {
      case "-h": case "--help":       args.help = true; i++; break;
      case "--mode":                  args.mode = raw[++i]; i++; break;
      case "--agents":                args.agents = Math.min(Number(raw[++i]), 5); i++; break;
      case "--depth":                 args.depth = raw[++i]; i++; break;
      case "--result-file":           args.resultFile = raw[++i]; i++; break;
      case "--context-file":          args.contextFile = raw[++i]; i++; break;
      case "--bd-task":               args.bdTask = raw[++i]; i++; break;
      case "--timeout":               args.timeout = Number(raw[++i]); i++; break;
      case "--verify":                args.verify = true; i++; break;
      case "--no-verify":             args.verify = false; i++; break;
      case "-q": case "--quiet":      args.quiet = true; i++; break;
      default:
        if (raw[i].startsWith("-")) { log(`${colors.red}Unknown: ${raw[i]}${colors.reset}`); process.exit(1); }
        if (!args.task) args.task = raw[i];
        i++;
    }
  }
  return args;
}

// ── swarm help text (from swarm.mjs.pre-refactor lines ~73-99) ──
export function showSwarmHelp() {
  process.stdout.write(`swarm — Parallel remote-agent orchestrator with verification

USAGE:
  swarm [OPTIONS] "task description"

MODES:
  single     1 worker (+ verifier if --verify)
  parallel   Decompose → N parallel workers → merge results
  pipeline   Sequential: research → implement → test → review
  swarm      Decompose → N parallel workers → verify → report
  review     1 reviewer (opus) + 1 verifier cross-check
  auto       Infer mode from task (default)

OPTIONS:
  --mode MODE          single|parallel|pipeline|swarm|review|auto
  --agents N           Max parallel agents, 1-5 (default: 3)
  --depth LEVEL        shallow|normal|thorough (default: normal)
  --timeout SECS       Per-agent timeout (default: 600)
  --result-file PATH   Write structured result JSON (includes all agent outputs)
  --context-file PATH  Pass context to all agents
  --bd-task ID         Beads task ID (claimed on start, closed on completion)
  --verify / --no-verify
  -q, --quiet          Suppress status
  -h, --help           Show this help
`);
}

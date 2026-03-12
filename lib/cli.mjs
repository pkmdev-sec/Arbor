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

// ── Input validation helpers ──────────────────────────────────────
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function suggestFlag(unknown, knownFlags) {
  let best = null, bestDist = Infinity;
  for (const flag of knownFlags) {
    const d = levenshtein(unknown, flag);
    if (d < bestDist) { bestDist = d; best = flag; }
  }
  return bestDist <= 3 ? best : null;
}

const KNOWN_AGENT_FLAGS = new Set([
  '-h', '--help', '--version',
  '-m', '--model', '-b', '--budget', '-n', '--turns',
  '-s', '--system', '--role', '--bd-task', '-d', '--dir',
  '--context-file', '--result-file', '--json',
  '-q', '--quiet', '--stdin', '--stdin-timeout', '--max-retries',
]);

const KNOWN_SWARM_FLAGS = new Set([
  '-h', '--help',
  '--mode', '--agents', '--depth',
  '--result-file', '--context-file', '--bd-task',
  '--verify', '--no-verify', '-q', '--quiet',
  '--tui', '--no-tui', '--monitor',
]);

function validateAgentArgs(args) {
  const errors = [];
  if (isNaN(args.maxTurns) || args.maxTurns < 1 || args.maxTurns > 200)
    errors.push('--turns: must be 1-200, got ' + args.maxTurns);
  if (isNaN(args.budget) || args.budget < 0.01 || args.budget > 100)
    errors.push('--budget: must be 0.01-100, got ' + args.budget);
  if (isNaN(args.stdinTimeout) || args.stdinTimeout < 1 || args.stdinTimeout > 60)
    errors.push('--stdin-timeout: must be 1-60, got ' + args.stdinTimeout);
  if (errors.length > 0) {
    for (const e of errors) log(`${colors.red}Error: ${e}${colors.reset}`);
    process.exit(1);
  }
}

function validateSwarmArgs(args, seenVerify, seenNoVerify) {
  const errors = [];
  if (isNaN(args.agents) || args.agents < 1 || args.agents > 5)
    errors.push('--agents: must be 1-5, got ' + args.agents);
  if (seenVerify && seenNoVerify)
    errors.push('--verify and --no-verify are mutually exclusive');
  if (errors.length > 0) {
    for (const e of errors) log(`${colors.red}Error: ${e}${colors.reset}`);
    process.exit(1);
  }
}

// ── agent-entry argument parsing (from agent-entry.mjs.pre-refactor lines ~192-248) ──
export function parseAgentArgs(argv) {
  const args = {
    task: null,
    model: "sonnet",
    budget: 15,
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
          const suggestion = suggestFlag(a, KNOWN_AGENT_FLAGS);
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
          log(`${colors.red}Unknown flag: ${a}.${hint}${colors.reset}`);
          process.exit(1);
        }
        if (!args.task) args.task = a;
        i++;
    }
  }

  validateAgentArgs(args);
  return args;
}

// ── agent-entry help text (from agent-entry.mjs.pre-refactor lines ~250-286) ──
export function showAgentHelp() {
  process.stdout.write(`Arbor — Isolated Claude Code supervisor for research

USAGE:
  arbor [OPTIONS] "task description"
  echo "task" | arbor --stdin [OPTIONS]

MODES:
  Simple:       arbor "explore src/models/"
  Structured:   arbor --context-file ctx.json --result-file result.json "task"
  Piped:        git diff | arbor --stdin -s "review this diff"

OPTIONS:
  -m, --model MODEL        Model: sonnet (default) or opus. Both use 1M context.
  -b, --budget USD         Max budget in USD (default: 15)
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
  arbor "explore the auth module and map all endpoints"
  arbor -m opus --turns 80 "security audit of src/api/"
  arbor -m opus --turns 80 "deep security audit of src/api/"
  arbor --context-file ctx.json --result-file out.json "analyze models"
  git diff HEAD~3 | arbor --stdin -s "review for bugs"
`);
}

// ── swarm argument parsing (from swarm.mjs.pre-refactor lines ~43-71) ──
export function parseSwarmArgs(argv) {
  const args = {
    task: null, mode: "auto", agents: 3, depth: "normal",
    resultFile: null, contextFile: null, bdTask: null, quiet: false,
    verify: null, tui: false, monitor: false, help: false,
  };
  const raw = argv.slice(2);
  let i = 0;
  let seenVerify = false, seenNoVerify = false;
  while (i < raw.length) {
    switch (raw[i]) {
      case "-h": case "--help":       args.help = true; i++; break;
      case "--mode":                  args.mode = raw[++i]; i++; break;
      case "--agents":                args.agents = Math.min(Number(raw[++i]), 5); i++; break;
      case "--depth":                 args.depth = raw[++i]; i++; break;
      case "--result-file":           args.resultFile = raw[++i]; i++; break;
      case "--context-file":          args.contextFile = raw[++i]; i++; break;
      case "--bd-task":               args.bdTask = raw[++i]; i++; break;
      case "--verify":                args.verify = true; seenVerify = true; i++; break;
      case "--no-verify":             args.verify = false; seenNoVerify = true; i++; break;
      case "--tui":                   args.tui = true; i++; break;
      case "--no-tui":                args.tui = false; i++; break;
      case "--monitor":               args.monitor = true; i++; break;
      case "-q": case "--quiet":      args.quiet = true; i++; break;
      default:
        if (raw[i].startsWith("-")) {
          const suggestion = suggestFlag(raw[i], KNOWN_SWARM_FLAGS);
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
          log(`${colors.red}Unknown flag: ${raw[i]}.${hint}${colors.reset}`);
          process.exit(1);
        }
        if (!args.task) args.task = raw[i];
        i++;
    }
  }
  validateSwarmArgs(args, seenVerify, seenNoVerify);
  return args;
}

// ── swarm help text (from swarm.mjs.pre-refactor lines ~73-99) ──
export function showSwarmHelp() {
  process.stdout.write(`arbor-swarm — Parallel Arbor orchestrator with verification

USAGE:
  arbor-swarm [OPTIONS] "task description"
  arbor-swarm --monitor

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
  --result-file PATH   Write structured result JSON (includes all agent outputs)
  --context-file PATH  Pass context to all agents
  --bd-task ID         Beads task ID (claimed on start, closed on completion)
  --verify / --no-verify
  --tui / --no-tui     Show live terminal dashboard (default: off)
  --monitor            Live overview of ALL active swarm runs (read-only)
  -q, --quiet          Suppress status
  -h, --help           Show this help
`);
}

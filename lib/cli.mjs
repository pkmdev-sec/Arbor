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
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
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
  '-m', '--model', '-b', '--budget', '-t', '--timeout', '-n', '--turns',
  '-s', '--system', '--role', '--bd-task', '-d', '--dir',
  '--context-file', '--result-file', '--json',
  '-q', '--quiet', '--stdin', '--stdin-timeout', '--max-retries',
]);

const KNOWN_SWARM_FLAGS = new Set([
  '-h', '--help',
  '--mode', '--agents', '--depth', '--timeout',
  '--result-file', '--context-file', '--bd-task',
  '--verify', '--no-verify', '-q', '--quiet',
]);

function validateAgentArgs(args) {
  const errors = [];
  if (isNaN(args.maxTurns) || args.maxTurns < 1 || args.maxTurns > 200)
    errors.push('--turns: must be 1-200, got ' + args.maxTurns);
  if (isNaN(args.timeout) || args.timeout < 10 || args.timeout > 3600)
    errors.push('--timeout: must be 10-3600, got ' + args.timeout);
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
  if (isNaN(args.timeout) || args.timeout < 10 || args.timeout > 3600)
    errors.push('--timeout: must be 10-3600, got ' + args.timeout);
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
      case "--timeout":               args.timeout = Number(raw[++i]); i++; break;
      case "--verify":                args.verify = true; seenVerify = true; i++; break;
      case "--no-verify":             args.verify = false; seenNoVerify = true; i++; break;
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

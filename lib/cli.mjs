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
  '-m', '--model', '-b', '--budget', '-n', '--turns',
  '-s', '--system', '--role', '--bd-task', '-d', '--dir',
  '--context-file', '--result-file', '--json',
  '-q', '--quiet', '--stdin', '--stdin-timeout', '--max-retries',
  '--effort', '--fallback-model', '--persist-context', '--scope',
  '--prefill', '--debug',
]);

const KNOWN_SWARM_FLAGS = new Set([
  '-h', '--help', '--debug',
  '--mode', '--agents', '--depth',
  '--result-file', '--context-file', '--bd-task',
  '--verify', '--no-verify', '--smart-route','-q', '--quiet',
  '--tui', '--no-tui', '--monitor',
  '--semantic-merge', '--no-semantic-merge',
  '--hierarchy-depth', '--max-children', '--agent-budget',
  '--min-task-files', '--decompose-by', '--estimate-only',
]);

const VALID_EFFORTS = new Set(["low", "medium", "high", "max"]);

function validateAgentArgs(args) {
  const errors = [];
  if (isNaN(args.maxTurns) || args.maxTurns < 1 || args.maxTurns > 200)
    errors.push('--turns: must be 1-200, got ' + args.maxTurns);
  if (isNaN(args.budget) || args.budget < 0.01 || args.budget > 100)
    errors.push('--budget: must be 0.01-100, got ' + args.budget);
  if (isNaN(args.stdinTimeout) || args.stdinTimeout < 1 || args.stdinTimeout > 60)
    errors.push('--stdin-timeout: must be 1-60, got ' + args.stdinTimeout);
  if (args.effort && !VALID_EFFORTS.has(args.effort))
    errors.push('--effort: must be one of low, medium, high, max — got ' + args.effort);
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
    effort: null,  // low, medium, high, max — passed to Claude CLI --effort
    fallbackModel: null,  // auto-fallback model on overload (529/503)
    persistContext: false,  // write context to CLAUDE.md for compaction survival
    scope: null,  // comma-separated file/dir paths for scope enforcement via PreToolUse hook
    prefill: null,  // pre-fill assistant's first response to skip "thinking" phase
    debug: false,  // F6: pass --debug to child + set per-agent CLAUDE_CODE_DEBUG_LOGS_DIR
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
      case "--effort":             args.effort = raw[++i]; i++; break;
      case "--fallback-model":     args.fallbackModel = raw[++i]; i++; break;
      case "--persist-context":    args.persistContext = true; i++; break;
      case "--scope":              args.scope = raw[++i]; i++; break;
      case "--prefill":            args.prefill = raw[++i]; i++; break;
      case "--debug":              args.debug = true; i++; break;
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
  process.stdout.write(`arbor — Isolated Claude Code supervisor for research

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
  --effort LEVEL           Thinking effort: low, medium, high, max (max requires API key)
  --fallback-model MODEL   Auto-fallback model on overload (e.g., sonnet)
  --persist-context        Write context to CLAUDE.md (survives compaction, auto for >50 turns)
  --scope PATHS            Comma-separated file/dir paths for scope enforcement (PreToolUse hook)
  --prefill TEXT           Pre-fill assistant's first response (skips "thinking" phase, saves 1-3 turns)
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
    verify: null, tui: false, monitor: false, semanticMerge: null, help: false,
    // Hierarchical mode flags
    hierarchyDepth: 3, maxChildren: 4, agentBudget: 20,
    minTaskFiles: 3, decomposeBy: "module-boundary", estimateOnly: false,
    debug: false,  // F6: pass --debug to child agents
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
      case "--smart-route":           args.smartRoute = true; i++; break;
      case "--tui":                   args.tui = true; i++; break;
      case "--no-tui":                args.tui = false; i++; break;
      case "--monitor":               args.monitor = true; i++; break;
      case "--semantic-merge":         args.semanticMerge = true; i++; break;
      case "--no-semantic-merge":      args.semanticMerge = false; i++; break;
      case "--hierarchy-depth":        args.hierarchyDepth = Number(raw[++i]); i++; break;
      case "--max-children":           args.maxChildren = Number(raw[++i]); i++; break;
      case "--agent-budget":           args.agentBudget = Number(raw[++i]); i++; break;
      case "--min-task-files":         args.minTaskFiles = Number(raw[++i]); i++; break;
      case "--decompose-by":           args.decomposeBy = raw[++i]; i++; break;
      case "--estimate-only":          args.estimateOnly = true; i++; break;
      case "--debug":                  args.debug = true; i++; break;
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
  process.stdout.write(`swarm — Parallel arbor orchestrator with verification

USAGE:
  swarm [OPTIONS] "task description"
  swarm --monitor

MODES:
  single        1 worker (+ verifier if --verify)
  parallel      Decompose → N parallel workers → merge results
  pipeline      Sequential: research → implement → test → review
  swarm         Decompose → N parallel workers → verify → report
  hierarchical  Multi-level tree: decompose → sub-coordinators → workers
  review        1 reviewer (opus) + 1 verifier cross-check
  auto          Infer mode from task (default)

OPTIONS:
  --mode MODE          single|parallel|pipeline|swarm|hierarchical|review|auto
  --agents N           Max parallel agents, 1-5 (default: 3)
  --depth LEVEL        shallow|normal|thorough (default: normal)
  --result-file PATH   Write structured result JSON (includes all agent outputs)
  --context-file PATH  Pass context to all agents
  --bd-task ID         Beads task ID (claimed on start, closed on completion)
  --verify / --no-verify
  --semantic-merge / --no-semantic-merge
                       LLM-based semantic conflict resolution (default: on for swarm, off for parallel)
  --tui / --no-tui     Show live terminal dashboard (default: off)
  --monitor            Live overview of ALL active swarm runs (read-only)
  -q, --quiet          Suppress status
  -h, --help           Show this help

HIERARCHICAL MODE OPTIONS:
  --hierarchy-depth N    Max decomposition depth, 1-5 (default: 3)
  --max-children N       Max children per coordinator, 2-8 (default: 4)
  --agent-budget N       Max total agents across all levels (default: 20)
  --min-task-files N     Minimum files to warrant sub-decomposition (default: 3)
  --decompose-by STRAT   module-boundary (default) | directory | dependency-cluster
  --estimate-only        Show decomposition plan and cost estimate, don't execute
`);
}

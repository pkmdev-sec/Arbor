# Remote-Agent: Complete Architectural Analysis

**Version:** 2.0
**Last Updated:** 2026-03-12
**Sources:** 3-agent parallel swarm analysis + single-agent deep read

---

## OVERVIEW

The **arbor** system is a dual-implementation orchestration framework for spawning isolated Claude Code subprocesses that execute complex tasks in parallel with real-time monitoring and verification.

### Core Capabilities

- **Dual entry points**: `swarm.mjs` (multi-agent coordinator) and `agent-entry.mjs` (single-agent supervisor)
- **Six execution modes**: parallel, swarm (decompose→execute→merge), pipeline, hierarchical, single, review
- **Dual TUI implementations**: JavaScript/React/Ink (prototyping) AND Go/Bubble Tea (production) - 45+ files total
- **Real-time IPC bus**: Unix socket with JSONL fallback for inter-agent communication
- **MCP coordination layer**: JSON-RPC over stdio for agent progress reporting and context sharing
- **Git worktree isolation**: Snapshot-based escape detection and automatic cleanup
- **Verification chain**: Opus critic cross-checks all worker outputs against actual git diffs

### Architectural Philosophy

1. **Isolation-first**: Each agent runs in its own git worktree with sandboxed environment (`CLAUDE_NO_HOOKS=1`, `CLAUDE_NO_MCP=1`)
2. **Observability**: Multiple redundant data paths (IPC → JSONL → result files → worktrees) ensure monitoring works even when components fail
3. **Resilience**: Retry logic, auto-reconnect, fallback data sources, escape detection
4. **Verification**: Every worker output is validated by an opus critic reviewing actual git diff

---

## ENTRY POINTS

### 1. swarm.mjs (809 lines)

**Location:** `~/.claude/arbor/swarm.mjs`

**Purpose:** Multi-agent orchestrator with task decomposition, parallel execution, and semantic merge

#### Key Exports

```javascript
async function runSwarm(task, opts)
async function spawnWorkers(subtasks, workDir)
async function verifyResults(agents, diff)
async function semanticMerge(conflicts)
```

#### Execution Modes

1. **parallel** - Spawn N agents with same task, merge results
2. **swarm** - Decompose → parallel workers → semantic merge
3. **pipeline** - Sequential stages with context handoff
4. **hierarchical** - Recursive sub-swarms (L0 → L1 → L2)
5. **single** - One agent with retry logic
6. **review** - Opus critic reviews git diff via stdin

#### Workflow Phases

1. **Scout Phase** (optional)
   - Explores codebase with lightweight agent
   - Returns architecture context for decomposer

2. **Decomposition Phase**
   - LLM call with scout context → subtasks + dependencies
   - Build DAG from dependencies
   - Topological sort into parallel waves

3. **Execution Phase**
   - Spawn workers in git worktrees
   - Track progress via IPC + file polling
   - Collect stdout/stderr/telemetry

4. **Merge Phase**
   - Detect file conflicts (overlapping edits)
   - LLM-based semantic merge for conflicts
   - Unified result JSON

5. **Verification Phase** (if `--verify`)
   - Spawn opus critic agent
   - Critic reviews actual `git diff` (not worker claims)
   - Returns PASS/FAIL/NEEDS_REWORK verdict

#### Key Design Patterns

- **Supervisor Pattern**: Orchestrator monitors spawned workers
- **Scatter-Gather**: Parallel execution with result aggregation
- **Verification Chain**: Separate validator reviews outputs
- **DAG Execution**: Topological waves for dependency management

---

### 2. agent-entry.mjs (801 lines)

**Location:** `~/.claude/arbor/agent-entry.mjs`

**Purpose:** Single-agent supervisor with retry logic, telemetry tracking, and escape detection

#### Key Exports

```javascript
async function runAgent(task, opts)
function parseAgentTelemetry(stdout)
async function detectEscape(workDir, beforeSnapshot, afterSnapshot)
```

#### Execution Flow

1. **Pre-spawn Setup**
   - Create git worktree
   - Take filesystem snapshot
   - Write context file (if provided)

2. **Spawn Agent**
   - Execute: `claude-code --no-hooks --no-mcp --model {model} --turns {depth}`
   - Set isolated environment: `CLAUDE_CONFIG_DIR=<workDir>/.agent-config`
   - Stream stdout/stderr to parent

3. **Monitoring**
   - Parse tool calls from stdout XML blocks
   - Track sparkline (tool calls per 10s bucket)
   - Write `.progress.json` every 30s
   - Detect quality signals (drift, truncation, errors)

4. **Post-execution**
   - Take final snapshot
   - Compare snapshots → detect escape (writes outside worktree)
   - Extract telemetry (tokens, cost, tool breakdown)
   - Write `<agentId>-result.json`

5. **Retry Logic** (max 3 attempts)
   - Retry on non-zero exit codes
   - Exponential backoff: 5s → 10s → 20s
   - Preserve previous outputs

#### Quality Signal Detection

```javascript
{
  has_checklist: bool,           // Found ```checklist blocks
  high_token_low_tools: bool,    // >160s runtime with 0 tool calls
  ai_analysis: {
    issue: string,               // Idle drift, hallucination, etc.
    severity: "low"|"medium"|"high"
  }
}
```

#### Escape Detection Algorithm

1. Before: `{ files: Set, diff: string }`
2. After: `{ files: Set, diff: string }`
3. Compare: Files created outside worktree path → ESCAPE

---

## CORE LIBRARIES (10 modules)

### 1. cli.mjs

**Location:** `~/.claude/arbor/lib/cli.mjs`

**Purpose:** Argument parser with typo suggestions and flag validation

#### Key Exports

```javascript
function parseArgs(argv)
function suggestFlag(input) // Levenshtein distance matching
```

#### Supported Flags

- `--mode` (parallel|swarm|pipeline|hierarchical|single|review)
- `--depth` (shallow|normal|thorough)
- `--agents` (1-10, default 3)
- `--timeout` (60-3600s, default 1800)
- `--model` (sonnet|opus)
- `--verify` (enable verification phase)
- `--result-file` (output JSON path)
- `--context-file` (input context from parent)
- `--stdin` (read task from stdin)
- `--quiet` (suppress logs)
- `--bus-address` (IPC socket path)

#### Design Pattern

**Command-line DSL** with fuzzy matching for typo tolerance

---

### 2. config.mjs

**Location:** `~/.claude/arbor/lib/config.mjs`

**Purpose:** Centralized configuration registry for roles, depths, models, and constants

#### Key Exports

```javascript
const ROLE_PROMPTS = {
  SCOUT: "Explore codebase and identify...",
  DECOMPOSER: "Break task into subtasks with dependencies...",
  WORKER: "Execute assigned subtask thoroughly...",
  CRITIC: "Review worker output against actual diff...",
  MERGER: "Resolve semantic conflicts between workers..."
}

const DEPTH_PRESETS = {
  shallow: { turns: 5, timeout: 300 },
  normal: { turns: 15, timeout: 1800 },
  thorough: { turns: 30, timeout: 3600 }
}

const MODELS = {
  sonnet: 'claude-sonnet-4-5-20250929[1m]',
  opus: 'claude-opus-4-6[1m]'
}

const CONSTANTS = {
  MAX_CONCURRENT_AGENTS: 10,
  SCOUT_TIMEOUT_MS: 180000,
  HEARTBEAT_INTERVAL_MS: 5000,
  PROGRESS_WRITE_INTERVAL_MS: 30000,
  IPC_REQUEST_TIMEOUT_MS: 30000,
  MAX_MESSAGE_SIZE_MB: 10,
  MAX_MESSAGES_PER_SECOND: 100
}
```

#### Design Pattern

**Configuration as Code** - centralized constants prevent magic numbers

---

### 3. agent-spawn.mjs

**Location:** `~/.claude/arbor/lib/agent-spawn.mjs`

**Purpose:** Subprocess spawning with environment sandboxing and stream management

#### Key Exports

```javascript
async function spawnAgent(subtask, agentId, workDir, opts)
function buildAgentEnv(workDir, agentId, opts)
```

#### Isolation Strategy

```javascript
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: `${workDir}/.agent-config`,
  CLAUDE_NO_HOOKS: '1',
  CLAUDE_NO_MCP: '1',  // Unless MCP coordinator is needed
  SWARM_AGENT_ID: agentId,
  SWARM_WORK_DIR: workDir,
  SWARM_TASK: subtask.description,
  SWARM_CONTEXT_FILE: contextPath
}
```

#### Spawn Command

```bash
claude-code \
  --model ${model} \
  --turns ${depth} \
  --mcp-config ${mcpConfigPath}  # If coordination enabled
```

#### Stream Handling

- Stdout: Parsed for tool calls, telemetry, quality signals
- Stderr: Logged to `<agentId>-stderr.log`
- Both: Written to ring buffer for TUI display

#### Design Pattern

**Process Isolation** with environment variable sandboxing

---

### 4. orchestration.mjs

**Location:** `~/.claude/arbor/lib/orchestration.mjs`

**Purpose:** Task decomposition, dependency graph analysis, and parallel execution scheduling

#### Key Exports

```javascript
async function decomposeTask(task, codebaseContext, opts)
function buildDependencyGraph(subtasks)
function topologicalWaves(graph)
async function executeWave(agents, wave, workDir)
async function waitForWave(agents)
```

#### Decomposition Algorithm

1. **Scout Phase** (if enabled)
   ```javascript
   const scout = await spawnAgent({
     task: "Explore codebase for: " + task,
     role: "scout",
     depth: "shallow"
   })
   const context = parseScoutOutput(scout.stdout)
   ```

2. **Decomposer LLM Call**
   ```javascript
   const prompt = `${ROLE_PROMPTS.DECOMPOSER}

   Task: ${task}
   Codebase Context: ${context}

   Return JSON: {
     subtasks: [{ id, description, files, dependencies: [id], priority }]
   }`

   const decomposition = await aiClient.createMessage(prompt, 'opus')
   ```

3. **Dependency Graph**
   ```javascript
   // Adjacency list representation
   const graph = {
     "subtask-1": { deps: [], rdeps: ["subtask-2", "subtask-3"] },
     "subtask-2": { deps: ["subtask-1"], rdeps: [] },
     "subtask-3": { deps: ["subtask-1"], rdeps: [] }
   }
   ```

4. **Topological Sort**
   ```javascript
   const waves = [
     ["subtask-1"],           // Wave 0: No dependencies
     ["subtask-2", "subtask-3"]  // Wave 1: Depends on Wave 0
   ]
   ```

#### Execution Strategy

```javascript
for (const wave of waves) {
  const agents = wave.map(subtask =>
    spawnAgent(subtask, `agent-${idx}`, workDir)
  )
  await Promise.all(agents.map(a => a.completion))

  // Check for failures before next wave
  if (agents.some(a => a.exitCode !== 0)) {
    throw new Error('Wave failed, aborting remaining waves')
  }
}
```

#### Design Patterns

- **DAG Scheduling**: Topological sort into parallel waves
- **Fail-Fast**: Abort remaining waves on failure
- **Context Handoff**: Results from Wave N → context for Wave N+1

---

### 5. ai-client.mjs

**Location:** `~/.claude/arbor/lib/ai-client.mjs`

**Purpose:** Direct Anthropic SDK calls for orchestrator LLM operations (decomposition, merging, verification)

#### Key Exports

```javascript
async function createMessage(prompt, model, opts)
async function streamMessage(prompt, model, onChunk)
```

#### Usage Context

- **Decomposer**: Opus call to break down task
- **Merger**: Opus call to resolve conflicts
- **Critic**: Opus call to verify worker outputs
- **NOT used by workers**: Workers use `claude-code` CLI

#### Retry Logic

```javascript
async function createMessage(prompt, model, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: MODELS[model],
        max_tokens: opts.maxTokens || 4096,
        messages: [{ role: 'user', content: prompt }]
      })
      return response.content[0].text
    } catch (err) {
      if (attempt === 3) throw err
      await sleep(5000 * Math.pow(2, attempt - 1)) // Exponential backoff
    }
  }
}
```

#### Design Pattern

**Retry Decorator** with exponential backoff (5s → 10s → 20s)

---

### 6. lifecycle.mjs

**Location:** `~/.claude/arbor/lib/lifecycle.mjs`

**Purpose:** Beads task integration and cleanup handlers

#### Key Exports

```javascript
async function createParentTask(task, mode)
async function updateTaskProgress(taskId, percent, step)
async function closeTask(taskId, reason)
function registerCleanupHandlers(workDir)
```

#### Beads Integration

```javascript
// On swarm start
const taskId = await createParentTask(task, 'swarm')
// Returns: MKLY-100

// During execution
await updateTaskProgress('MKLY-100', 50, 'Executing wave 2 of 3')

// On completion
await closeTask('MKLY-100', 'completed: 3 agents finished, 15 files modified')
```

#### Cleanup Handlers

```javascript
function registerCleanupHandlers(workDir) {
  const cleanup = async () => {
    // Kill spawned agents
    for (const agent of activeAgents) {
      agent.process.kill('SIGTERM')
    }

    // Remove worktrees with no changes
    for (const worktree of worktrees) {
      const hasChanges = await isolation.hasChanges(worktree)
      if (!hasChanges) {
        await isolation.cleanupWorktree(worktree)
      }
    }
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)
}
```

#### Design Pattern

**External Task System Integration** - bridges swarm orchestration with persistent task tracking

---

### 7. isolation.mjs

**Location:** `~/.claude/arbor/lib/isolation.mjs`

**Purpose:** Git worktree management with snapshot-based escape detection

#### Key Exports

```javascript
async function createWorktree(baseRef, targetPath)
async function snapshotWorktree(path)
async function detectEscape(beforeSnapshot, afterSnapshot, worktreePath)
async function cleanupWorktree(path)
async function hasChanges(path)
```

#### Worktree Creation

```bash
git worktree add --detach <targetPath> <baseRef>
cd <targetPath>
git checkout -b agent-<id>-<timestamp>
```

#### Snapshot Format

```javascript
{
  timestamp: Date.now(),
  files: new Set(['/abs/path/to/file1', '/abs/path/to/file2']),
  diff: 'git diff output',
  gitStatus: 'git status --porcelain output'
}
```

#### Escape Detection Algorithm

```javascript
function detectEscape(before, after, worktreePath) {
  const escapedFiles = []

  for (const file of after.files) {
    if (!file.startsWith(worktreePath)) {
      escapedFiles.push(file)
    }
  }

  return {
    escaped: escapedFiles.length > 0,
    files: escapedFiles,
    severity: escapedFiles.length > 5 ? 'high' : 'medium'
  }
}
```

#### Cleanup Strategy

```javascript
async function cleanupWorktree(path) {
  const changes = await hasChanges(path)

  if (!changes) {
    // Safe to delete
    await exec(`git worktree remove ${path} --force`)
  } else {
    // Preserve for manual review
    console.warn(`Worktree ${path} has uncommitted changes, skipping cleanup`)
    return { preserved: true, reason: 'uncommitted changes' }
  }
}
```

#### Design Pattern

**Snapshot-Based Change Detection** - compares filesystem state before/after agent execution

---

### 8. output.mjs

**Location:** `~/.claude/arbor/lib/output.mjs`

**Purpose:** TTY-aware colored logging facade

#### Key Exports

```javascript
function log(msg, level = 'info')
function warn(msg)
function error(msg)
function isQuiet()
function isTTY()
```

#### Color Codes

```javascript
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}
```

#### TTY Detection

```javascript
function log(msg, level) {
  if (isQuiet()) return

  const prefix = isTTY()
    ? `${COLORS[level]}●${COLORS.reset}`
    : `[${level.toUpperCase()}]`

  console.log(`${prefix} ${msg}`)
}
```

#### Design Pattern

**Facade Pattern** - abstracts console with TTY awareness

---

### 9. context-bridge.mjs

**Location:** `~/.claude/arbor/lib/context-bridge.mjs`

**Purpose:** Parent→child context serialization for hierarchical swarms

#### Key Exports

```javascript
async function writeContextFile(priorResults, scope, targetPath)
async function readContextFile(path)
function serializeContext(data)
function deserializeContext(json)
```

#### Context Format

```json
{
  "version": 1,
  "parent_task": "Implement authentication system",
  "prior_results": {
    "agent-01": {
      "subtask": "Design database schema",
      "files_modified": ["schema.sql"],
      "summary": "Created users, sessions, tokens tables",
      "exit_code": 0
    }
  },
  "scope": {
    "files": ["src/auth/*", "db/migrations/*"],
    "constraints": ["Use bcrypt for passwords", "JWT tokens expire in 1h"],
    "architecture_notes": "Follow existing service pattern in src/services/"
  },
  "level": 1
}
```

#### Injection Strategy

Context file is read by child agent and injected into system prompt:

```javascript
const context = await readContextFile(process.env.SWARM_CONTEXT_FILE)

const systemPrompt = `${BASE_SYSTEM_PROMPT}

# Parent Context

You are working on a subtask within a larger swarm:
- Parent task: ${context.parent_task}
- Your scope: ${context.scope}

Previous agents completed:
${context.prior_results.map(r => `- ${r.subtask}: ${r.summary}`).join('\n')}

Build on their work and stay within your scope.
`
```

#### Design Pattern

**Serialization Bridge** - crosses process boundaries with JSON

---

### 10. telemetry.mjs

**Location:** `~/.claude/arbor/lib/telemetry.mjs`

**Purpose:** Incremental stdout/stderr parsing for tool calls and quality signals

#### Key Exports

```javascript
function parseTelemetry(stdout)
function trackMemory(tools)
function estimateCost(tokens, model)
function createSparklineTracker()
```

#### Tool Call Extraction

Parses XML blocks from Claude Code stdout:

```javascript
function parseTelemetry(stdout) {
  const tools = []
  const regex = /<invoke name="([^"]+)">/g

  let match
  while ((match = regex.exec(stdout)) !== null) {
    tools.push({
      name: match[1],
      timestamp: Date.now()
    })
  }

  return {
    tool_calls: tools,
    breakdown: tools.reduce((acc, t) => {
      acc[t.name] = (acc[t.name] || 0) + 1
      return acc
    }, {})
  }
}
```

#### Memory Heuristics

```javascript
function trackMemory(tools) {
  let memoryMB = 0

  for (const tool of tools) {
    if (tool.name === 'Read') memoryMB += 0.5  // Avg 500KB per read
    if (tool.name === 'Grep') memoryMB += 0.1  // Avg 100KB per grep
    if (tool.name === 'Glob') memoryMB += 0.05 // Minimal memory
  }

  return Math.min(memoryMB, 500) // Cap at 500MB estimate
}
```

#### Sparkline Tracking

```javascript
function createSparklineTracker(bucketSizeMs = 10000, maxBuckets = 20) {
  const buckets = new Array(maxBuckets).fill(0)
  let currentBucket = 0

  return {
    record(count) {
      buckets[currentBucket] += count
    },
    tick() {
      currentBucket = (currentBucket + 1) % maxBuckets
      buckets[currentBucket] = 0
    },
    render() {
      const chars = '▁▂▃▄▅▆▇█'
      const max = Math.max(...buckets, 1)
      return buckets.map(v => chars[Math.floor(v / max * 7)]).join('')
    }
  }
}
```

#### Design Pattern

**Streaming Parser** - incremental parsing with bounded state (ring buffer)

---

### 11. buffer.mjs

**Location:** `~/.claude/arbor/lib/buffer.mjs`

**Purpose:** Ring buffer with disk overflow for agent stdout/stderr storage

#### Key Exports

```javascript
class RingBuffer {
  constructor(maxSize)
  push(data)
  get()
  flush()
}
```

#### Implementation

```javascript
class RingBuffer {
  constructor(maxSize = 10 * 1024 * 1024) { // 10MB default
    this.maxSize = maxSize
    this.buffer = []
    this.currentSize = 0
    this.overflowPath = null
  }

  push(data) {
    this.currentSize += data.length

    if (this.currentSize > this.maxSize) {
      // Overflow to disk
      if (!this.overflowPath) {
        this.overflowPath = `/tmp/buffer-${Date.now()}.log`
      }
      fs.appendFileSync(this.overflowPath, data)
    } else {
      this.buffer.push(data)
    }
  }

  get() {
    if (this.overflowPath) {
      // Read from disk
      return fs.readFileSync(this.overflowPath, 'utf-8')
    }
    return this.buffer.join('')
  }
}
```

#### Design Pattern

**Ring Buffer with Persistence Fallback** - bounded memory with disk overflow

---

## IPC LAYER (9 modules)

### 1. protocol.mjs

**Location:** `~/.claude/arbor/lib/ipc/protocol.mjs`

**Purpose:** Wire protocol definition with length-prefixed framing and streaming parser

#### Message Types

```javascript
const MessageType = {
  PUBLISH: 'publish',           // Broadcast to topic subscribers
  DIRECT_SEND: 'direct',        // Point-to-point
  REQUEST: 'request',           // RPC-style request
  RESPONSE: 'response',         // RPC response
  REGISTER: 'register',         // Agent registration
  SUBSCRIBE: 'subscribe',       // Topic subscription
  HEARTBEAT: 'heartbeat'        // Liveness ping
}
```

#### Wire Format

```
┌────────────────┬────────────────────────┐
│  Length (4B)   │  JSON Payload (NB)     │
│  Big Endian    │  UTF-8 Encoded         │
└────────────────┴────────────────────────┘
```

#### Message Envelope

```javascript
{
  id: 'msg-uuid',                    // Unique message ID
  type: 'publish|direct|request|response|register|subscribe|heartbeat',
  from: 'agent-01',                  // Sender ID
  to: 'agent-02',                    // Target (for direct/request)
  topic: 'progress.agent-01',        // Topic (for publish/subscribe)
  timestamp: 1678900000000,          // Unix ms
  correlationId: 'req-uuid',         // Request ID (for response)
  priority: 0,                       // 0=normal, 1=high
  payload: { /* message content */ }
}
```

#### MessageParser Class

```javascript
class MessageParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages = []

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)

      if (this.buffer.length < 4 + length) {
        break // Incomplete message
      }

      const payload = this.buffer.slice(4, 4 + length)
      messages.push(JSON.parse(payload.toString('utf-8')))

      this.buffer = this.buffer.slice(4 + length)
    }

    return messages
  }
}
```

#### Key Exports

```javascript
const MessageType = { ... }
function createMessage(type, from, payload, opts)
class MessageParser
```

#### Design Pattern

**Length-Prefixed Framing** - self-delimiting binary protocol with streaming parser

---

### 2. message-bus.mjs

**Location:** `~/.claude/arbor/lib/ipc/message-bus.mjs`

**Purpose:** Central broker with pub/sub, request/response, orchestrator hooks, and rate limiting

#### MessageBus Class

```javascript
class MessageBus {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.server = null
    this.clients = new Map() // clientId → socket
    this.subscriptions = new Map() // topic → Set<clientId>
    this.pendingRequests = new Map() // correlationId → { resolve, reject, timeout }
    this.hooks = [] // Orchestrator interceptor hooks
    this.rateLimiters = new Map() // clientId → RateLimiter
  }

  async start()
  async publish(from, topic, payload)
  async subscribe(clientId, topic)
  async request(from, to, payload, timeoutMs = 30000)
  async response(correlationId, payload)
  registerHook(hook)
}
```

#### Pub/Sub Implementation

```javascript
async function publish(from, topic, payload) {
  const message = createMessage('publish', from, payload, { topic })

  // Apply hooks (filtering, monitoring, injection)
  for (const hook of this.hooks) {
    const result = await hook.onPublish(message)
    if (result === false) return // Filtered
    if (result?.modified) message = result.modified
  }

  const subscribers = this.subscriptions.get(topic) || new Set()

  for (const clientId of subscribers) {
    const socket = this.clients.get(clientId)
    if (socket) {
      this.sendMessage(socket, message)
    }
  }
}
```

#### Request/Response Pattern

```javascript
async function request(from, to, payload, timeoutMs) {
  const correlationId = `req-${Date.now()}-${Math.random()}`
  const message = createMessage('request', from, payload, { to, correlationId })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingRequests.delete(correlationId)
      reject(new Error(`Request timeout: ${correlationId}`))
    }, timeoutMs)

    this.pendingRequests.set(correlationId, { resolve, reject, timeout })

    const targetSocket = this.clients.get(to)
    if (!targetSocket) {
      reject(new Error(`Target not connected: ${to}`))
      return
    }

    this.sendMessage(targetSocket, message)
  })
}

function handleResponse(message) {
  const pending = this.pendingRequests.get(message.correlationId)
  if (pending) {
    clearTimeout(pending.timeout)
    pending.resolve(message.payload)
    this.pendingRequests.delete(message.correlationId)
  }
}
```

#### Orchestrator Hooks

```javascript
const hook = {
  onPublish: async (message) => {
    // Filter: Block certain messages
    if (message.topic.startsWith('internal.')) {
      return false // Drop message
    }

    // Monitor: Log all progress updates
    if (message.topic.startsWith('progress.')) {
      console.log(`Agent ${message.from}: ${message.payload.step}`)
    }

    // Inject: Modify message
    if (message.topic === 'status') {
      return {
        modified: {
          ...message,
          payload: { ...message.payload, enriched: true }
        }
      }
    }

    return true // Allow
  }
}

messageBus.registerHook(hook)
```

#### Rate Limiting

```javascript
class RateLimiter {
  constructor(maxPerSecond) {
    this.max = maxPerSecond
    this.tokens = maxPerSecond
    this.lastRefill = Date.now()
  }

  tryConsume() {
    this.refill()
    if (this.tokens > 0) {
      this.tokens--
      return true
    }
    return false
  }

  refill() {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.max, this.tokens + elapsed * this.max)
    this.lastRefill = now
  }
}

// In MessageBus
async function publish(from, topic, payload) {
  const limiter = this.rateLimiters.get(from)
  if (!limiter.tryConsume()) {
    throw new Error(`Rate limit exceeded for ${from}`)
  }
  // ... rest of publish logic
}
```

#### Design Patterns

- **Broker Pattern**: Centralized message routing
- **Pub/Sub**: Topic-based multicast
- **Request/Response**: Correlation ID-based RPC
- **Interceptor Chain**: Hook-based message processing
- **Token Bucket**: Rate limiting algorithm

---

### 3. registry.mjs

**Location:** `~/.claude/arbor/lib/ipc/registry.mjs`

**Purpose:** Agent directory with metadata and secondary indexes

#### AgentRegistry Class

```javascript
class AgentRegistry {
  constructor() {
    this.agents = new Map() // agentId → AgentInfo
    this.byRole = new Map() // role → Set<agentId>
    this.byCapability = new Map() // capability → Set<agentId>
    this.byStatus = new Map() // status → Set<agentId>
  }

  register(agentId, metadata)
  update(agentId, metadata)
  lookup(agentId)
  findByRole(role)
  findByCapability(capability)
  findByStatus(status)
  markStale(agentId)
  pruneStale()
}
```

#### AgentInfo Schema

```javascript
{
  id: 'agent-01',
  role: 'worker',
  model: 'sonnet',
  status: 'running|completed|failed|stale',
  capabilities: ['read', 'write', 'bash'],
  metadata: {
    subtask: 'Implement auth endpoints',
    level: 1,
    parentId: 'agent-00',
    worktreePath: '/tmp/swarm/abc/worktrees/agent-01'
  },
  registeredAt: 1678900000000,
  lastSeen: 1678900030000
}
```

#### Heartbeat & Stale Detection

```javascript
function updateHeartbeat(agentId) {
  const agent = this.agents.get(agentId)
  if (agent) {
    agent.lastSeen = Date.now()
  }
}

function pruneStale(staleTimeoutMs = 10000) {
  const now = Date.now()
  for (const [agentId, agent] of this.agents) {
    if (now - agent.lastSeen > staleTimeoutMs) {
      this.markStale(agentId)
    }
  }
}
```

#### Secondary Indexes

```javascript
function register(agentId, metadata) {
  const info = { ...metadata, id: agentId, registeredAt: Date.now(), lastSeen: Date.now() }
  this.agents.set(agentId, info)

  // Update indexes
  this.byRole.get(info.role)?.add(agentId) || this.byRole.set(info.role, new Set([agentId]))

  for (const cap of info.capabilities || []) {
    this.byCapability.get(cap)?.add(agentId) || this.byCapability.set(cap, new Set([agentId]))
  }

  this.byStatus.get(info.status)?.add(agentId) || this.byStatus.set(info.status, new Set([agentId]))
}
```

#### Design Pattern

**Service Registry** with secondary indexes for fast lookups

---

### 4. agent-channel.mjs

**Location:** `~/.claude/arbor/lib/ipc/agent-channel.mjs`

**Purpose:** IPC client for worker agents with auto-reconnect and buffered send queue

#### AgentChannel Class

```javascript
class AgentChannel extends EventEmitter {
  constructor(agentId, socketPath) {
    super()
    this.agentId = agentId
    this.socketPath = socketPath
    this.socket = null
    this.connected = false
    this.sendQueue = []
    this.heartbeatInterval = null
    this.parser = new MessageParser()
  }

  async connect()
  async disconnect()
  async publish(topic, payload)
  async request(targetId, payload, timeoutMs)
  subscribe(topic, handler)
}
```

#### Auto-Reconnect

```javascript
async function connect() {
  try {
    this.socket = net.connect(this.socketPath)

    this.socket.on('connect', () => {
      this.connected = true
      this.emit('connected')

      // Send registration
      this.sendMessage(createMessage('register', this.agentId, {
        role: 'worker',
        capabilities: ['read', 'write', 'bash']
      }))

      // Flush queued messages
      for (const msg of this.sendQueue) {
        this.sendMessage(msg)
      }
      this.sendQueue = []

      // Start heartbeat
      this.heartbeatInterval = setInterval(() => {
        this.sendMessage(createMessage('heartbeat', this.agentId, {}))
      }, 5000)
    })

    this.socket.on('data', chunk => {
      const messages = this.parser.feed(chunk)
      for (const msg of messages) {
        this.emit('message', msg)
      }
    })

    this.socket.on('close', () => {
      this.connected = false
      this.emit('disconnected')

      // Auto-reconnect after 2s
      setTimeout(() => this.connect(), 2000)
    })

    this.socket.on('error', err => {
      this.emit('error', err)
    })

  } catch (err) {
    this.emit('error', err)
    setTimeout(() => this.connect(), 2000)
  }
}
```

#### Buffered Send Queue

```javascript
function sendMessage(message) {
  if (!this.connected) {
    this.sendQueue.push(message)
    return
  }

  const json = JSON.stringify(message)
  const length = Buffer.byteLength(json)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(length, 0)

  this.socket.write(Buffer.concat([header, Buffer.from(json)]))
}
```

#### Design Pattern

**Resilient Client** - auto-reconnect, heartbeat, buffered queue during disconnection

---

### 5. orchestrator-control.mjs

**Location:** `~/.claude/arbor/lib/ipc/orchestrator-control.mjs`

**Purpose:** Privileged control plane for swarm orchestrator

#### OrchestratorControl Class

```javascript
class OrchestratorControl {
  constructor(messageBus, registry) {
    this.bus = messageBus
    this.registry = registry
    this.role = 'orchestrator'
  }

  async pauseAgent(agentId)
  async resumeAgent(agentId)
  async injectMessage(targetId, topic, payload)
  async filterMessages(filterFn)
  async broadcast(topic, payload)
  async forceDisconnect(agentId)
}
```

#### Privileged Operations

```javascript
async function pauseAgent(agentId) {
  // Verify orchestrator role
  if (!this.hasPrivilege()) {
    throw new Error('Unauthorized: orchestrator role required')
  }

  // Send control message
  await this.bus.publish('orchestrator', `control.${agentId}`, {
    action: 'pause',
    timestamp: Date.now()
  })

  // Update registry
  this.registry.update(agentId, { status: 'paused' })
}

async function injectMessage(targetId, topic, payload) {
  if (!this.hasPrivilege()) throw new Error('Unauthorized')

  // Bypass normal pub/sub - inject directly
  const message = createMessage('publish', 'orchestrator', payload, { topic })

  const targetSocket = this.bus.clients.get(targetId)
  if (targetSocket) {
    this.bus.sendMessage(targetSocket, message)
  }
}

async function filterMessages(filterFn) {
  if (!this.hasPrivilege()) throw new Error('Unauthorized')

  // Register hook to filter messages
  this.bus.registerHook({
    onPublish: async (msg) => {
      const result = await filterFn(msg)
      return result // true=allow, false=drop, {modified}=transform
    }
  })
}
```

#### RBAC Validation

```javascript
function hasPrivilege() {
  // Check if this control instance has orchestrator role
  return this.role === 'orchestrator'
}
```

#### Design Pattern

**Privileged Control Plane** with role-based access control (RBAC)

---

### 6. bridge.mjs

**Location:** `~/.claude/arbor/lib/ipc/bridge.mjs`

**Purpose:** Bidirectional IPC bridge for Python hooks/tools

#### IPCBridge Class

```javascript
class IPCBridge {
  constructor(pythonScriptPath, messageBus) {
    this.scriptPath = pythonScriptPath
    this.bus = messageBus
    this.process = null
  }

  async start()
  async stop()
  sendToPython(message)
  receiveFromPython(line)
}
```

#### Bridge Startup

```javascript
async function start() {
  this.process = spawn('python3', ['-u', this.scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    }
  })

  // Stdin: Node.js → Python
  // Stdout: Python → Node.js
  // Stderr: Python errors

  const readline = require('readline')
  const rl = readline.createInterface({
    input: this.process.stdout,
    crlfDelay: Infinity
  })

  rl.on('line', line => {
    this.receiveFromPython(line)
  })

  this.process.stderr.on('data', chunk => {
    console.error('Python bridge error:', chunk.toString())
  })

  // Forward IPC messages to Python
  this.bus.subscribe('bridge.*', msg => {
    this.sendToPython(msg)
  })
}
```

#### Message Forwarding

```javascript
function sendToPython(message) {
  const json = JSON.stringify(message)
  this.process.stdin.write(json + '\n')
}

function receiveFromPython(line) {
  try {
    const message = JSON.parse(line)

    // Publish to IPC bus
    this.bus.publish('python-bridge', message.topic, message.payload)
  } catch (err) {
    console.error('Invalid JSON from Python:', line)
  }
}
```

#### Design Pattern

**Stdio Bridge** - line-delimited JSON for inter-language communication

---

### 7. telemetry-channel.mjs

**Location:** `~/.claude/arbor/lib/ipc/telemetry-channel.mjs`

**Purpose:** High-volume telemetry with batching and ring buffer

#### TelemetryChannel Class

```javascript
class TelemetryChannel {
  constructor(agentId, messageBus) {
    this.agentId = agentId
    this.bus = messageBus
    this.buffer = new RingBuffer(1000)
    this.batchInterval = null
  }

  start()
  record(event)
  flush()
}
```

#### Batching Strategy

```javascript
function start() {
  // Flush every 5s
  this.batchInterval = setInterval(() => {
    this.flush()
  }, 5000)
}

function record(event) {
  this.buffer.push({
    agentId: this.agentId,
    timestamp: Date.now(),
    ...event
  })
}

function flush() {
  const events = this.buffer.get()
  if (events.length === 0) return

  // Batch publish
  this.bus.publish(this.agentId, 'telemetry.batch', {
    count: events.length,
    events
  })

  this.buffer.clear()
}
```

#### Design Pattern

**Buffered Channel** - batching reduces message overhead for high-frequency events

---

### 8. python-bridge/bus_client.py

**Location:** `~/.claude/arbor/lib/ipc/python-bridge/bus_client.py`

**Purpose:** Stdlib-only Python client for IPC bus

#### BusClient Class

```python
import json
import struct
import socket
import sys

class BusClient:
    def __init__(self, socket_path='/tmp/swarm-ipc.sock', agent_id='python-client'):
        self.socket_path = socket_path
        self.agent_id = agent_id
        self.socket = None
        self.subscriptions = {}

    def connect(self):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.connect(self.socket_path)

        # Send registration
        self.send_message({
            'type': 'register',
            'from': self.agent_id,
            'payload': {'role': 'python-hook'}
        })

    def send_message(self, message):
        json_bytes = json.dumps(message).encode('utf-8')
        length = struct.pack('>I', len(json_bytes))
        self.socket.sendall(length + json_bytes)

    def receive_message(self):
        # Read length header (4 bytes, big-endian)
        length_bytes = self.socket.recv(4)
        if not length_bytes:
            return None

        length = struct.unpack('>I', length_bytes)[0]

        # Read payload
        payload = b''
        while len(payload) < length:
            chunk = self.socket.recv(length - len(payload))
            if not chunk:
                break
            payload += chunk

        return json.loads(payload.decode('utf-8'))

    def subscribe(self, topic, handler):
        self.subscriptions[topic] = handler

        self.send_message({
            'type': 'subscribe',
            'from': self.agent_id,
            'payload': {'topic': topic}
        })

    def publish(self, topic, payload):
        self.send_message({
            'type': 'publish',
            'from': self.agent_id,
            'topic': topic,
            'payload': payload
        })

    def listen(self):
        while True:
            msg = self.receive_message()
            if not msg:
                break

            if msg.get('topic') in self.subscriptions:
                handler = self.subscriptions[msg['topic']]
                handler(msg['payload'])
```

#### Usage Example

```python
from bus_client import BusClient

client = BusClient(agent_id='acontext-hook')
client.connect()

def on_progress(payload):
    print(f"Agent progress: {payload['step']}")

client.subscribe('progress.*', on_progress)
client.publish('status', {'message': 'Python hook initialized'})
client.listen()
```

#### Design Pattern

**Minimal Implementation** - stdlib-only for maximum portability (no deps)

---

### 9. index.mjs

**Location:** `~/.claude/arbor/lib/ipc/index.mjs`

**Purpose:** Barrel export for IPC modules

```javascript
export { MessageType, createMessage, MessageParser } from './protocol.mjs'
export { MessageBus } from './message-bus.mjs'
export { AgentRegistry } from './registry.mjs'
export { AgentChannel } from './agent-channel.mjs'
export { OrchestratorControl } from './orchestrator-control.mjs'
export { IPCBridge } from './bridge.mjs'
export { TelemetryChannel } from './telemetry-channel.mjs'
```

---

## HIERARCHY LAYER (6 modules)

### 1. decomposer.mjs

**Location:** `~/.claude/arbor/lib/hierarchy/decomposer.mjs`

**Purpose:** LLM-guided task decomposition with dependency graph analysis

#### Key Exports

```javascript
async function decompose(task, codebaseContext, opts)
function buildGraph(subtasks)
function assignWaves(graph)
function detectModuleBoundaries(subtasks, codebaseContext)
```

#### Decomposition Algorithm

```javascript
async function decompose(task, codebaseContext, opts) {
  // 1. Prepare prompt
  const prompt = `${ROLE_PROMPTS.DECOMPOSER}

Task: ${task}

Codebase Context:
${codebaseContext.architecture}
${codebaseContext.recentChanges}

Break this task into 3-7 subtasks with clear boundaries.
For each subtask, specify:
- id (subtask-1, subtask-2, ...)
- description (clear, actionable)
- files (file paths this subtask will modify)
- dependencies (array of subtask IDs this depends on)
- priority (1=high, 2=medium, 3=low)
- estimatedComplexity (1-10)

Return JSON:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "description": "...",
      "files": ["path/to/file.js"],
      "dependencies": [],
      "priority": 1,
      "estimatedComplexity": 5
    }
  ]
}
`

  // 2. LLM call
  const response = await aiClient.createMessage(prompt, 'opus', {
    maxTokens: 8192
  })

  const decomposition = JSON.parse(response)

  // 3. Validate & build graph
  const graph = buildGraph(decomposition.subtasks)

  // 4. Detect cycles
  if (hasCycle(graph)) {
    throw new Error('Cyclic dependencies detected')
  }

  // 5. Module boundary analysis
  const boundaries = detectModuleBoundaries(decomposition.subtasks, codebaseContext)

  // 6. Wave assignment
  const waves = assignWaves(graph)

  return {
    subtasks: decomposition.subtasks,
    graph,
    boundaries,
    waves
  }
}
```

#### Dependency Graph Construction

```javascript
function buildGraph(subtasks) {
  const graph = {}

  for (const subtask of subtasks) {
    graph[subtask.id] = {
      subtask,
      deps: [...subtask.dependencies],
      rdeps: [] // Reverse dependencies (computed)
    }
  }

  // Compute reverse deps
  for (const [id, node] of Object.entries(graph)) {
    for (const depId of node.deps) {
      graph[depId].rdeps.push(id)
    }
  }

  return graph
}
```

#### Topological Sort into Waves

```javascript
function assignWaves(graph) {
  const waves = []
  const completed = new Set()

  while (completed.size < Object.keys(graph).length) {
    const wave = []

    for (const [id, node] of Object.entries(graph)) {
      if (completed.has(id)) continue

      // Check if all dependencies are completed
      const ready = node.deps.every(depId => completed.has(depId))

      if (ready) {
        wave.push(id)
      }
    }

    if (wave.length === 0) {
      throw new Error('Deadlock detected: no tasks are ready')
    }

    waves.push(wave)
    wave.forEach(id => completed.add(id))
  }

  return waves
}
```

#### Module Boundary Detection

```javascript
function detectModuleBoundaries(subtasks, codebaseContext) {
  const fileToSubtask = new Map()

  for (const subtask of subtasks) {
    for (const file of subtask.files) {
      if (!fileToSubtask.has(file)) {
        fileToSubtask.set(file, [])
      }
      fileToSubtask.get(file).push(subtask.id)
    }
  }

  const conflicts = []

  for (const [file, subtaskIds] of fileToSubtask) {
    if (subtaskIds.length > 1) {
      conflicts.push({
        file,
        subtasks: subtaskIds,
        severity: 'high',
        recommendation: 'Consider splitting file or serializing subtasks'
      })
    }
  }

  return {
    crossFileEdits: conflicts,
    moduleIsolation: conflicts.length === 0 ? 'high' : 'low'
  }
}
```

#### Design Patterns

- **LLM-Guided Decomposition**: Uses AI to break down work
- **DAG Analysis**: Topological sort for parallel scheduling
- **Static Analysis**: Module boundary detection for conflict prevention

---

### 2. sub-coordinator.mjs

**Location:** `~/.claude/arbor/lib/hierarchy/sub-coordinator.mjs`

**Purpose:** Manage recursive sub-swarms (L0 → L1 → L2)

#### Key Exports

```javascript
async function spawnSubSwarm(subtask, level, parentContext, opts)
async function aggregateResults(children)
function buildScopedBus(level, scope)
```

#### Sub-Swarm Spawning

```javascript
async function spawnSubSwarm(subtask, level, parentContext, opts) {
  if (level >= 3) {
    throw new Error('Max hierarchy depth (3 levels) exceeded')
  }

  // 1. Allocate budget
  const childBudget = opts.budget / opts.expectedChildren

  // 2. Prepare context
  const contextFile = await writeContextFile({
    parent_task: parentContext.task,
    prior_results: parentContext.results,
    scope: {
      files: subtask.files,
      constraints: subtask.constraints
    },
    level: level + 1
  }, `/tmp/swarm-L${level}-${subtask.id}-context.json`)

  // 3. Spawn swarm subprocess
  const swarmProcess = spawn('swarm', [
    '--mode', 'swarm',
    '--level', String(level + 1),
    '--budget', String(childBudget),
    '--context-file', contextFile,
    '--result-file', `/tmp/swarm-L${level}-${subtask.id}-result.json`
  ], {
    env: {
      ...process.env,
      SWARM_PARENT_ID: parentContext.swarmId,
      SWARM_LEVEL: String(level + 1)
    }
  })

  // 4. Create scoped IPC bus
  const scopedBus = buildScopedBus(level + 1, subtask.id)

  // 5. Forward scoped messages to parent
  scopedBus.subscribe(`swarm.L${level+1}.${subtask.id}.*`, msg => {
    parentContext.bus.publish('sub-swarm', `swarm.L${level}.child`, {
      childId: subtask.id,
      message: msg
    })
  })

  // 6. Wait for completion
  await new Promise((resolve, reject) => {
    swarmProcess.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`Sub-swarm failed: exit ${code}`))
    })
  })

  // 7. Read result
  const result = JSON.parse(fs.readFileSync(`/tmp/swarm-L${level}-${subtask.id}-result.json`))

  return result
}
```

#### Result Aggregation

```javascript
async function aggregateResults(children) {
  const aggregated = {
    subtasks: children.map(c => c.subtask),
    results: children.map(c => c.result),
    conflicts: [],
    merged: null
  }

  // Detect file conflicts
  const fileToChildren = new Map()

  for (const child of children) {
    for (const file of child.result.files_modified) {
      if (!fileToChildren.has(file)) {
        fileToChildren.set(file, [])
      }
      fileToChildren.get(file).push(child.id)
    }
  }

  for (const [file, childIds] of fileToChildren) {
    if (childIds.length > 1) {
      aggregated.conflicts.push({ file, children: childIds })
    }
  }

  // Semantic merge if conflicts
  if (aggregated.conflicts.length > 0) {
    aggregated.merged = await semanticMerge(aggregated.conflicts, children)
  }

  return aggregated
}
```

#### Scoped Bus Implementation

```javascript
function buildScopedBus(level, scope) {
  const bus = new MessageBus(`/tmp/swarm-L${level}-${scope}.sock`)

  // Override publish to add scope prefix
  const originalPublish = bus.publish.bind(bus)
  bus.publish = async (from, topic, payload) => {
    const scopedTopic = `swarm.L${level}.${scope}.${topic}`
    return originalPublish(from, scopedTopic, payload)
  }

  return bus
}
```

#### Design Patterns

- **Recursive Process Spawning**: Swarms spawn child swarms
- **Scoped Communication**: Hierarchical topic namespacing
- **Budget Propagation**: Parent budget divided among children
- **Bottom-Up Aggregation**: Child results merged into parent context

---

### 3. governor.mjs

**Location:** `~/.claude/arbor/lib/hierarchy/governor.mjs`

**Purpose:** Resource enforcement with budget limits and concurrency control

#### ResourceGovernor Class

```javascript
class ResourceGovernor {
  constructor(opts) {
    this.maxConcurrentAgents = opts.maxAgents || 10
    this.maxCostPerRun = opts.budget || 5.0 // USD
    this.maxDepth = opts.maxDepth || 3
    this.currentAgents = 0
    this.totalCost = 0
    this.agentCosts = new Map()
  }

  canSpawn(level, agentId)
  recordCost(agentId, cost)
  release(agentId)
  getUtilization()
}
```

#### Spawn Permission Check

```javascript
function canSpawn(level, agentId) {
  // Check depth limit
  if (level >= this.maxDepth) {
    return {
      allowed: false,
      reason: `Max hierarchy depth (${this.maxDepth}) exceeded`
    }
  }

  // Check concurrency limit
  if (this.currentAgents >= this.maxConcurrentAgents) {
    return {
      allowed: false,
      reason: `Max concurrent agents (${this.maxConcurrentAgents}) reached`
    }
  }

  // Check budget limit
  if (this.totalCost >= this.maxCostPerRun) {
    return {
      allowed: false,
      reason: `Budget exhausted (${this.totalCost.toFixed(2)}/${this.maxCostPerRun})`
    }
  }

  // Approved
  this.currentAgents++
  return { allowed: true }
}
```

#### Cost Tracking

```javascript
function recordCost(agentId, cost) {
  this.totalCost += cost
  this.agentCosts.set(agentId, cost)

  // Emit warning at 80%
  if (this.totalCost / this.maxCostPerRun >= 0.8) {
    console.warn(`Budget warning: ${(this.totalCost / this.maxCostPerRun * 100).toFixed(0)}% used`)
  }

  // Block new spawns at 100%
  if (this.totalCost >= this.maxCostPerRun) {
    console.error('Budget exhausted, blocking new agent spawns')
  }
}

function release(agentId) {
  this.currentAgents--
}
```

#### Utilization Metrics

```javascript
function getUtilization() {
  return {
    agents: {
      current: this.currentAgents,
      max: this.maxConcurrentAgents,
      percent: (this.currentAgents / this.maxConcurrentAgents * 100).toFixed(0)
    },
    budget: {
      spent: this.totalCost,
      limit: this.maxCostPerRun,
      percent: (this.totalCost / this.maxCostPerRun * 100).toFixed(0)
    },
    topSpenders: Array.from(this.agentCosts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  }
}
```

#### Design Pattern

**Resource Governor** - policy enforcement with admission control

---

### 4. scoped-bus.mjs

**Location:** `~/.claude/arbor/lib/hierarchy/scoped-bus.mjs`

**Purpose:** Hierarchical topic scoping for nested swarms

#### Topic Naming Convention

```
swarm.L{level}.{scope}.{event}
│     │       │        └─ Event name (progress, status, result)
│     │       └────────── Scope ID (subtask-1, decompose, etc.)
│     └────────────────── Level (0=root, 1=child, 2=grandchild)
└──────────────────────── Namespace prefix
```

Examples:
- `swarm.L0.root.progress` - Root orchestrator progress
- `swarm.L1.subtask-1.status` - Child worker status
- `swarm.L2.impl-auth.tool_call` - Grandchild tool call

#### ScopedBus Class

```javascript
class ScopedBus {
  constructor(messageBus, level, scope) {
    this.bus = messageBus
    this.level = level
    this.scope = scope
  }

  publish(topic, payload)
  subscribe(pattern, handler)
  buildTopic(topic)
}
```

#### Automatic Scope Injection

```javascript
function publish(topic, payload) {
  const scopedTopic = this.buildTopic(topic)
  return this.bus.publish('agent', scopedTopic, payload)
}

function buildTopic(topic) {
  return `swarm.L${this.level}.${this.scope}.${topic}`
}
```

#### Level-Based Filtering

```javascript
function subscribe(pattern, handler) {
  // L0 sees all levels
  if (this.level === 0) {
    return this.bus.subscribe(pattern, handler)
  }

  // L1+ only see own scope and children
  const levelFilter = `swarm.L${this.level}.${this.scope}.*`
  return this.bus.subscribe(levelFilter, handler)
}
```

#### Design Pattern

**Hierarchical Namespacing** - prevents cross-swarm message leakage

---

### 5. aggregator.mjs

**Location:** `~/.claude/arbor/lib/hierarchy/aggregator.mjs`

**Purpose:** Bottom-up result collection with conflict resolution

#### Key Exports

```javascript
async function aggregate(children, opts)
function detectConflicts(results)
async function semanticMerge(conflicts, results)
```

#### Aggregation Algorithm

```javascript
async function aggregate(children, opts) {
  // 1. Wait for all children to complete
  await Promise.all(children.map(c => c.completion))

  // 2. Collect results
  const results = children.map(c => ({
    agentId: c.id,
    subtask: c.subtask,
    files_modified: c.result.files_modified,
    summary: c.result.summary,
    exit_code: c.result.exit_code,
    cost: c.result.cost
  }))

  // 3. Detect conflicts
  const conflicts = detectConflicts(results)

  // 4. Semantic merge if needed
  let merged = null
  if (conflicts.length > 0) {
    merged = await semanticMerge(conflicts, results)
  }

  // 5. Build aggregated result
  return {
    children: results,
    conflicts,
    merged,
    totalCost: results.reduce((sum, r) => sum + r.cost, 0),
    allSucceeded: results.every(r => r.exit_code === 0)
  }
}
```

#### Conflict Detection

```javascript
function detectConflicts(results) {
  const fileToAgents = new Map()

  for (const result of results) {
    for (const file of result.files_modified) {
      if (!fileToAgents.has(file)) {
        fileToAgents.set(file, [])
      }
      fileToAgents.get(file).push(result.agentId)
    }
  }

  const conflicts = []

  for (const [file, agentIds] of fileToAgents) {
    if (agentIds.length > 1) {
      conflicts.push({
        file,
        agents: agentIds,
        severity: agentIds.length > 2 ? 'high' : 'medium'
      })
    }
  }

  return conflicts
}
```

#### Semantic Merge

```javascript
async function semanticMerge(conflicts, results) {
  const mergePrompt = `You are resolving conflicts between ${results.length} agents.

${conflicts.map(c => `
File: ${c.file}
Agents: ${c.agents.join(', ')}

${c.agents.map(agentId => {
  const result = results.find(r => r.agentId === agentId)
  return `Agent ${agentId} intent:
  Subtask: ${result.subtask}
  Changes: git diff ${c.file}`
}).join('\n\n')}
`).join('\n\n')}

Resolve these conflicts by:
1. Understanding each agent's intent
2. Merging changes semantically (not just textual merge)
3. Ensuring all intents are preserved
4. Returning unified diff

Return JSON:
{
  "resolutions": [
    {
      "file": "...",
      "unified_diff": "...",
      "confidence": 0.9,
      "rationale": "..."
    }
  ]
}
`

  const response = await aiClient.createMessage(mergePrompt, 'opus', {
    maxTokens: 16384
  })

  return JSON.parse(response)
}
```

#### Design Pattern

**Bottom-Up Aggregation** - child results merge into parent context with LLM-based conflict resolution

---

### 6. index.mjs

**Location:** `~/.claude/arbor/lib/hierarchy/index.mjs`

**Purpose:** Barrel export for hierarchy modules

```javascript
export { decompose, buildGraph, assignWaves } from './decomposer.mjs'
export { spawnSubSwarm, aggregateResults } from './sub-coordinator.mjs'
export { ResourceGovernor } from './governor.mjs'
export { ScopedBus } from './scoped-bus.mjs'
export { aggregate, detectConflicts, semanticMerge } from './aggregator.mjs'
```

---

## TUI LAYER

The arbor implements **two complete TUI systems** sharing the same data sources:

### JavaScript/React/Ink (20 modules in `lib/tui/`)

**Purpose:** Rapid prototyping with React ecosystem

#### Core Components

1. **dashboard.mjs** - Single-run command center with 6 panels
2. **monitor.mjs** - Multi-run observer (scans `/tmp/swarm/`)
3. **agent-card.mjs** - Compact list items + full detail panels
4. **chat-panel.mjs** - IPC message stream with ring buffer
5. **hierarchy-panel.mjs** - Collapsible tree with Unicode connectors
6. **control-panel.mjs** - Bottom command bar (`:pause`, `:theme`)
7. **governor-panel.mjs** - Resource gauges (agents, memory, cost)
8. **merge-panel.mjs** - Conflict visualizer with resolution log
9. **log-viewer.mjs** - Scrollable output (vim-style navigation)

#### Data Layer

10. **ipc-monitor-client.mjs** - Unix socket subscriber with auto-reconnect
11. **ipc-stream.mjs** - JSONL file reader (fallback)
12. **data-poller.mjs** - Filesystem aggregator (worktrees + results)
13. **progress-reader.mjs** - Polls `.progress.json` files (1s interval)

#### Utilities

14. **theme.mjs** - Multi-theme system with Proxy delegation
15. **layout.mjs** - Responsive breakpoints (full/compact/minimal)
16. **sparkline.mjs** - Block character time-series (▁▂▃▄▅▆▇█)
17. **bar-chart.mjs** - Horizontal tool call distribution
18. **cost-tracker.mjs** - Heuristic cost estimation
19. **help-overlay.mjs** - Keyboard shortcut table
20. **index.mjs** - Barrel export

---

### Go/Bubble Tea (22 modules in `tui/`)

**Purpose:** Production performance, single binary, lower memory

#### Core Framework

1. **main.go** - Entry point with crash recovery, memory limits (128MB)
2. **model.go** - Bubble Tea Model (MVC core) with 9 tabs
3. **keys.go** - Keybinding registry (vim-style, global, tab-specific)
4. **theme.go** - Lipgloss themes (Dark, Catppuccin, Dracula, Neon)

#### Data Management

5. **agent.go** - Rich agent model (30+ fields)
6. **poller.go** - Background filesystem polling
7. **ipc.go** - Unix socket client with length-prefixed protocol

#### Panel Renderers

8. **chat.go** - Message feed with ring buffer (500 capacity)
9. **hierarchy.go** - Tree builder with wave progress bars
10. **resources.go** - Extended dashboard (gauges, tool distribution, top 5 expensive)
11. **internals.go** - Quality signal log inspector
12. **network.go** - IPC request inspector (Chrome DevTools clone)

#### Supporting Components

13. **launcher.go** - Interactive swarm launch form
14. **confirm.go** - Modal Y/N dialog
15. **taskgraph.go** - DAG visualizer with topological waves
16. **cost.go** - Cost analytics with burn rate projection
17. **conflicts.go** - Conflict parser from swarm results
18. **notifications.go** - Toast notification system
19. **chatsend.go** - Message composer with target cycling
20. **cmdpalette.go** - Fuzzy command launcher (VS Code style)

---

### TUI Architecture Insights

#### Dual Implementation Strategy

```
JS/Ink: Rapid prototyping → React ecosystem → Easier debugging
   ↓ (share data contract)
Go/Bubble Tea: Production → Single binary → Lower memory
```

#### Data Source Hierarchy (Redundancy)

```
Primary:    IPC Bus (Unix socket, real-time)
     ↓ (3s timeout)
Fallback 1: JSONL files (ipc.jsonl, 500ms polling)
     ↓
Fallback 2: Result files (/tmp/*.json, 2s polling)
     ↓
Fallback 3: Git worktrees + ps aux (2s polling)
```

#### Shared Data Contract

Both TUIs read identical JSON files:
- `decompose.json` - Subtasks + dependencies
- `*-result.json` - Agent completion data
- `.progress.json` - Real-time progress
- `ipc.jsonl` - IPC event log

Both implement identical IPC protocol:
- Length-prefixed frames (4-byte BigEndian + JSON)
- Same message types (PUBLISH, DIRECT_SEND, etc.)
- Same topic namespacing

#### No Direct Interaction

JS and Go TUIs **never communicate**. They are alternative implementations:
- User runs ONE of them, not both simultaneously
- Both connect to same IPC bus as monitors
- Both poll same filesystem locations
- Both normalize protocol messages identically

---

## SUPPORT MODULES

### semantic-merge.mjs

**Location:** `~/.claude/arbor/lib/semantic-merge.mjs`

**Purpose:** LLM-based conflict resolution for overlapping agent edits

#### Key Algorithm

```javascript
async function semanticMerge(conflicts, agentResults, opts) {
  const resolutions = []

  for (const conflict of conflicts) {
    const { file, agents } = conflict

    // Collect intents
    const intents = agents.map(agentId => {
      const result = agentResults.find(r => r.agentId === agentId)
      return {
        agentId,
        subtask: result.subtask,
        diff: execSync(`git diff ${file}`, { cwd: result.worktreePath }).toString()
      }
    })

    // LLM merge
    const prompt = `Resolve semantic conflict in ${file}:

${intents.map(i => `
Agent ${i.agentId} (${i.subtask}):
\`\`\`diff
${i.diff}
\`\`\`
`).join('\n')}

Return unified diff that preserves all intents.
`

    const unifiedDiff = await aiClient.createMessage(prompt, 'opus')

    resolutions.push({
      file,
      agents,
      resolution: unifiedDiff,
      confidence: 0.85 // Placeholder
    })
  }

  return resolutions
}
```

---

## MCP LAYER (2 modules)

### 1. tools.mjs

**Location:** `~/.claude/arbor/lib/mcp/tools.mjs`

**Purpose:** MCP tool schema definitions for swarm coordination

#### Tool Definitions

```javascript
const SWARM_TOOLS = [
  {
    name: 'swarm_report_progress',
    description: 'Report execution progress to orchestrator',
    inputSchema: {
      type: 'object',
      properties: {
        percent: { type: 'number', minimum: 0, maximum: 100 },
        step: { type: 'string', description: 'Current step description' },
        files_touched: { type: 'array', items: { type: 'string' } }
      },
      required: ['percent', 'step']
    }
  },

  {
    name: 'swarm_report_result',
    description: 'Report final execution result',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'failed', 'partial'] },
        summary: { type: 'string' },
        files_modified: { type: 'array', items: { type: 'string' } },
        issues: { type: 'array', items: { type: 'string' } }
      },
      required: ['status', 'summary']
    }
  },

  {
    name: 'swarm_get_context',
    description: 'Read shared context from orchestrator',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['task', 'scope', 'prior_results', 'config'] }
      },
      required: ['key']
    }
  },

  {
    name: 'swarm_log',
    description: 'Send structured log message',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warn', 'error'] },
        message: { type: 'string' }
      },
      required: ['level', 'message']
    }
  }
]
```

---

### 2. coordinator-server.mjs

**Location:** `~/.claude/arbor/lib/mcp/coordinator-server.mjs`

**Purpose:** Stdio MCP server (JSON-RPC 2.0) for agent coordination

#### Execution Model

One server process per agent, spawned by Claude Code:

```bash
node coordinator-server.mjs < agent-stdin > agent-stdout 2> agent-stderr
```

Configured via `--mcp-config`:

```json
{
  "mcpServers": {
    "swarm-coordinator": {
      "command": "node",
      "args": ["lib/mcp/coordinator-server.mjs"],
      "env": {
        "SWARM_AGENT_ID": "agent-01",
        "SWARM_WORK_DIR": "/tmp/swarm/abc",
        "SWARM_TASK": "Implement auth endpoints",
        "SWARM_CONTEXT_FILE": "/tmp/swarm/abc/agent-01-context.json"
      }
    }
  }
}
```

#### State Management

```javascript
const state = {
  agentId: process.env.SWARM_AGENT_ID,
  workDir: process.env.SWARM_WORK_DIR,
  lastUpdate: Date.now(),
  progress: { percent: 0, step: 'Starting' },
  result: null,
  files_touched: [],
  logs: []
}
```

#### Dual Persistence

1. **Memory**: Fast access for API calls
2. **Disk**: Atomic writes to `<workDir>/<agentId>-mcp-state.json`
3. **IPC Log**: Append to `<workDir>/ipc.jsonl` (TUI backward compat)

#### JSON-RPC Protocol

```javascript
process.stdin.on('line', async line => {
  const request = JSON.parse(line)

  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'swarm-coordinator', version: '1.0.0' }
    })
  }

  else if (request.method === 'tools/list') {
    respond(request.id, { tools: SWARM_TOOLS })
  }

  else if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params

    if (name === 'swarm_report_progress') {
      handleReportProgress(args)
      respond(request.id, { content: [{ type: 'text', text: 'Progress recorded' }] })
    }

    else if (name === 'swarm_report_result') {
      handleReportResult(args)
      respond(request.id, { content: [{ type: 'text', text: 'Result recorded' }] })
    }

    else if (name === 'swarm_get_context') {
      const context = await loadContext(args.key)
      respond(request.id, { content: [{ type: 'text', text: JSON.stringify(context) }] })
    }

    else if (name === 'swarm_log') {
      handleLog(args)
      respond(request.id, { content: [{ type: 'text', text: 'Log recorded' }] })
    }
  }
})

function respond(id, result) {
  const response = { jsonrpc: '2.0', id, result }
  console.log(JSON.stringify(response))
}
```

#### Tool Handlers

```javascript
function handleReportProgress(args) {
  state.progress = {
    percent: args.percent,
    step: args.step,
    files_touched: args.files_touched || []
  }
  state.lastUpdate = Date.now()

  // Persist to disk
  saveState()

  // Append to IPC log
  logEvent('progress', state.progress)
}

function handleReportResult(args) {
  state.result = {
    status: args.status,
    summary: args.summary,
    files_modified: args.files_modified || [],
    issues: args.issues || []
  }

  saveState()
  logEvent('result', state.result)
}

async function loadContext(key) {
  const contextFile = process.env.SWARM_CONTEXT_FILE
  if (!contextFile) return null

  const context = JSON.parse(fs.readFileSync(contextFile, 'utf-8'))
  return context[key]
}

function handleLog(args) {
  state.logs.push({ level: args.level, message: args.message, timestamp: Date.now() })
  logEvent('log', args)
}
```

#### Atomic State Persistence

```javascript
function saveState() {
  const path = `${state.workDir}/${state.agentId}-mcp-state.json`
  const tmpPath = `${path}.tmp`

  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2))
  fs.renameSync(tmpPath, path) // Atomic rename
}

function logEvent(type, data) {
  const event = {
    timestamp: Date.now(),
    agentId: state.agentId,
    type,
    data
  }

  fs.appendFileSync(
    `${state.workDir}/ipc.jsonl`,
    JSON.stringify(event) + '\n'
  )
}
```

#### Design Pattern

**Stdio JSON-RPC Server** with file-based persistence and dual-channel output (MCP + IPC log)

---

## DEPENDENCIES

### package.json

```json
{
  "name": "arbor",
  "version": "2.0.0",
  "type": "module",
  "dependencies": {
    "@anthropic-ai/sdk": "^1.1.0",
    "chalk": "^5.3.0",
    "ink": "^4.4.1",
    "react": "^18.2.0",
    "ws": "^8.16.0"
  }
}
```

### Dependency Analysis

1. **@anthropic-ai/sdk** (`^1.1.0`)
   - **Purpose**: Direct API calls for orchestrator LLM operations
   - **Used by**: `ai-client.mjs` (decomposer, merger, critic)
   - **Why NOT workers**: Workers use `claude-code` CLI, not SDK

2. **chalk** (`^5.3.0`)
   - **Purpose**: Terminal colors
   - **Used by**: `output.mjs` for colored logging
   - **Alternative**: Could use ANSI codes directly

3. **ink** (`^4.4.1`)
   - **Purpose**: React for terminal UIs
   - **Used by**: All `lib/tui/*.mjs` components
   - **Note**: JS TUI only, not used by Go TUI

4. **react** (`^18.2.0`)
   - **Purpose**: JS TUI framework (required by Ink)
   - **Used by**: All JS TUI components
   - **Note**: Zero browser usage

5. **ws** (`^8.16.0`)
   - **Purpose**: WebSocket library
   - **Status**: **UNUSED** - can be removed
   - **Note**: IPC uses Unix sockets (net module), not WebSockets

### Go Dependencies (tui/go.mod)

```go
module github.com/example/arbor-tui

go 1.21

require (
	github.com/charmbracelet/bubbletea v0.25.0
	github.com/charmbracelet/bubbles v0.18.0
	github.com/charmbracelet/lipgloss v0.10.0
)
```

---

## DATA FLOW DIAGRAM (ASCII)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERACTION                               │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  swarm CLI                                                                  │
│  ├─ parseArgs(argv) → mode, depth, agents, budget                          │
│  ├─ createParentTask() → beads task MKLY-100                               │
│  └─ runSwarm(task, opts)                                                   │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  ORCHESTRATION LAYER                                                        │
│                                                                             │
│  Scout Phase (optional):                                                   │
│  ├─ spawnAgent({ task: "Explore codebase", role: "scout" })                │
│  └─ Extract codebase context                                               │
│                                                                             │
│  Decomposition Phase:                                                      │
│  ├─ aiClient.createMessage(decomposerPrompt, 'opus')                       │
│  ├─ buildGraph(subtasks) → DAG                                             │
│  └─ assignWaves(graph) → [[task1], [task2, task3], [task4]]                │
│                                                                             │
│  Execution Phase:                                                          │
│  ├─ For each wave:                                                         │
│  │   ├─ spawnAgent(subtask, agentId, workDir) → N workers in parallel      │
│  │   ├─ Track progress via IPC + file polling                              │
│  │   └─ Wait for wave completion                                           │
│  │                                                                          │
│  Merge Phase:                                                              │
│  ├─ detectConflicts(results) → file → [agent1, agent2]                     │
│  └─ semanticMerge(conflicts) → LLM-based resolution                        │
│                                                                             │
│  Verification Phase (if --verify):                                         │
│  ├─ git diff > /tmp/diff.txt                                               │
│  ├─ spawnAgent({ task: "Review diff", role: "critic", model: "opus" })     │
│  └─ Parse verdict: PASS | FAIL | NEEDS_REWORK                              │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  AGENT SPAWN (per worker)                                                   │
│                                                                             │
│  1. Git Worktree Creation:                                                 │
│     ├─ git worktree add <path> HEAD                                        │
│     ├─ Take snapshot (files, diff)                                         │
│     └─ cd <path>                                                           │
│                                                                             │
│  2. Environment Setup:                                                     │
│     ├─ CLAUDE_CONFIG_DIR=<workDir>/.agent-config                           │
│     ├─ CLAUDE_NO_HOOKS=1                                                   │
│     ├─ CLAUDE_NO_MCP=1 (unless coordination needed)                        │
│     ├─ SWARM_AGENT_ID, SWARM_WORK_DIR, SWARM_TASK                          │
│     └─ SWARM_CONTEXT_FILE (for hierarchical swarms)                        │
│                                                                             │
│  3. MCP Server Spawn (if coordination enabled):                            │
│     └─ node lib/mcp/coordinator-server.mjs (stdio JSON-RPC)                │
│                                                                             │
│  4. Claude Code Subprocess:                                                │
│     └─ claude-code --model sonnet --turns 15 --mcp-config ...              │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  AGENT EXECUTION                                                            │
│                                                                             │
│  Agent makes tool calls:                                                   │
│  ├─ Read, Grep, Glob, Edit, Write, Bash                                    │
│  └─ swarm_report_progress(percent=50, step="Implementing endpoints")       │
│                                                                             │
│  MCP Server handles tools:                                                 │
│  ├─ Update in-memory state                                                 │
│  ├─ Write <agentId>-mcp-state.json (atomic)                                │
│  └─ Append to ipc.jsonl                                                    │
│                                                                             │
│  Agent completes:                                                          │
│  ├─ swarm_report_result(status="completed", summary="...", files=[...])    │
│  ├─ Exit with code 0                                                       │
│  └─ Orchestrator detects completion                                        │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  MONITORING & IPC                                                           │
│                                                                             │
│  IPC Message Bus (Unix socket):                                            │
│  ├─ MessageBus listening on /tmp/swarm-ipc.sock                            │
│  ├─ Agents publish: progress, status, tool_call, result                    │
│  ├─ TUIs subscribe: progress.*, status.*, control.*, merge.*               │
│  └─ Orchestrator hooks: filter, inject, monitor                            │
│                                                                             │
│  Data Sources (redundant paths):                                           │
│  1. IPC Bus (real-time, primary)                                           │
│  2. ipc.jsonl (500ms polling, fallback)                                    │
│  3. <agentId>-result.json (2s polling)                                     │
│  4. .progress.json (1s polling)                                            │
│  5. git worktree list + ps aux (2s polling, last resort)                   │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  TUI RENDERING                                                              │
│                                                                             │
│  JavaScript/Ink TUI:                                                       │
│  ├─ IpcMonitorClient connects to socket                                    │
│  ├─ Dashboard renders 6 panels (agents, chat, hierarchy, resources, ...)   │
│  ├─ Ring buffer for messages (1000 capacity)                               │
│  └─ React/Ink rendering loop (60fps)                                       │
│                                                                             │
│  Go/Bubble Tea TUI:                                                        │
│  ├─ IPCConn connects to socket                                             │
│  ├─ Model.Update(ipcMsg) handles messages                                  │
│  ├─ Background poller supplements with filesystem data                     │
│  ├─ 9 tabs rendered (Overview, Agents, Chat, Hierarchy, Resources, ...)    │
│  └─ Bubble Tea rendering loop                                              │
│                                                                             │
│  Display:                                                                  │
│  ├─ Agent cards (status, sparkline, model badge)                           │
│  ├─ Chat feed (IPC messages with type colors)                              │
│  ├─ Hierarchy tree (Unicode connectors, progress bars)                     │
│  ├─ Resource gauges (agents, memory, cost)                                 │
│  ├─ Conflict inspector (merge confidence, resolution log)                  │
│  └─ Network inspector (IPC requests with latency bars)                     │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  RESULT AGGREGATION                                                         │
│                                                                             │
│  1. Collect worker results:                                                │
│     ├─ Read <agentId>-result.json for each agent                           │
│     └─ Merge telemetry (tokens, tools, cost)                               │
│                                                                             │
│  2. Detect conflicts:                                                      │
│     ├─ file1.js → [agent-01, agent-02]                                     │
│     └─ Severity: high (>2 agents), medium (2 agents)                       │
│                                                                             │
│  3. Semantic merge (if conflicts):                                         │
│     ├─ Extract intents from each agent's diff                              │
│     ├─ LLM call: "Resolve conflicts preserving all intents"                │
│     └─ Apply unified diff                                                  │
│                                                                             │
│  4. Verification (if enabled):                                             │
│     ├─ git diff > /tmp/final-diff.txt                                      │
│     ├─ Spawn opus critic agent                                             │
│     ├─ Critic reviews: completeness, correctness, edge cases               │
│     └─ Verdict: PASS (ship) | FAIL (abort) | NEEDS_REWORK (iterate)        │
│                                                                             │
│  5. Write final result:                                                    │
│     ├─ swarm-<id>-result.json                                              │
│     ├─ Contains: agents, conflicts, merged, verification, tests            │
│     └─ Update beads task: bd close MKLY-100 --reason "completed"           │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  CLEANUP                                                                    │
│                                                                             │
│  For each worktree:                                                        │
│  ├─ hasChanges() → git status --porcelain                                  │
│  ├─ If NO changes: git worktree remove --force                             │
│  └─ If changes: preserve for manual review                                 │
│                                                                             │
│  Escape detection:                                                         │
│  ├─ Compare before/after snapshots                                         │
│  ├─ Detect files outside worktree path                                     │
│  └─ Warn if escape detected                                                │
│                                                                             │
│  Final output:                                                             │
│  └─ Exit code 0 (success) | 1 (failure)                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## KEY ARCHITECTURAL INSIGHTS

`★ Insight ─────────────────────────────────────`

**1. Dual TUI Strategy**
The system maintains two complete TUI implementations (JS/Ink + Go/Bubble Tea) that share a data contract but never directly interact. This enables:
- **Rapid prototyping** in JavaScript with React's ecosystem
- **Production deployment** in Go with single-binary distribution and lower memory
- **Independent evolution** without coupling concerns
- **Graceful fallback** if one implementation breaks

**2. Redundant Data Paths**
The system works completely offline (no IPC bus) by polling files, demonstrating exceptional resilience:
- IPC socket → JSONL → result files → worktrees + processes
- Each layer can fail independently without breaking monitoring
- TUI always shows *something*, even if stale
- Critical for debugging when IPC bus is down

**3. MCP as Coordination Glue**
Each agent runs a stdio MCP server that writes progress to both memory (for API) and disk (for TUI polling). This dual persistence ensures:
- **Real-time updates** when MCP is available
- **Fallback monitoring** when MCP isn't available
- **Backward compatibility** with pre-MCP TUI code
- **Structured tool calling** via JSON-RPC instead of stdout parsing

**4. Verification Chain**
The critic agent reviews *actual git diff*, not worker claims. This catches:
- **Hallucinated completions** (agent claims success but made no changes)
- **Scope creep** (agent modified files outside scope)
- **Incomplete work** (agent exited early without finishing)
- **Quality issues** (tests missing, edge cases ignored)

**5. Isolation-First Design**
Every agent runs in a git worktree with sandboxed environment, preventing:
- **Crosstalk** between agents (no shared state)
- **Main branch pollution** (changes isolated until verified)
- **Hook interference** (CLAUDE_NO_HOOKS=1)
- **MCP conflicts** (separate config dirs per agent)

**6. Bottom-Up Aggregation**
Results flow from children → parent → root, enabling:
- **Hierarchical decomposition** (L0 → L1 → L2)
- **Scoped communication** (swarm.L1.scope.event)
- **Budget propagation** (parent allocates to children)
- **Semantic conflict resolution** at each merge point

`─────────────────────────────────────────────────`

---

## SUMMARY

The arbor system is a **production-grade AI agent orchestration framework** with:

- **45+ source files** (20 JS TUI + 22 Go TUI + core libs + IPC + hierarchy + MCP)
- **9 execution modes** (parallel, swarm, pipeline, hierarchical, single, review + 3 depth presets)
- **4 redundant data paths** (IPC → JSONL → results → worktrees)
- **2 complete TUI implementations** (React/Ink for prototyping, Go/Bubble Tea for production)
- **Full verification chain** (opus critic reviews actual git diff)
- **Semantic conflict resolution** (LLM-based merge preserving all agent intents)
- **Resource governance** (budget limits, concurrency control, cost tracking)
- **MCP coordination** (stdio JSON-RPC for progress reporting)
- **Git worktree isolation** (snapshot-based escape detection)

The architecture prioritizes **isolation** (worktrees, sandboxed envs), **observability** (dual TUI, IPC bus, telemetry), and **resilience** (retry logic, fallback data sources, escape detection).

All components work together to enable **reliable parallel AI agent orchestration with full real-time monitoring and verification**.

---

**End of Complete Architecture Analysis**

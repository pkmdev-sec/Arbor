# Hierarchical Multi-Level Decomposition Design

> Design document for recursive task decomposition in the swarm orchestrator.
> Status: DRAFT — awaiting review before implementation.
> Date: 2026-03-10

---

## SECTION 1: CURRENT STATE ANALYSIS

### 1.1 How `swarm.mjs` Currently Decomposes Tasks

The current decomposition is **single-level and flat**. Here's the exact algorithm:

1. **Entry**: `swarm.mjs:main()` receives a task string and mode.
2. **Mode selection**: `autoMode()` in `orchestration.mjs:674` classifies the task via AI (Sonnet API call) or regex fallback into: `single | parallel | pipeline | swarm | review`.
3. **Project scanning**: `scoutProject()` in `swarm.mjs:32` runs in parallel with decomposition — produces a 1-paragraph project structure summary (via Sonnet API direct call or subprocess fallback).
4. **Decomposition**: `decompose()` in `orchestration.mjs:82` takes the task + `maxAgents` count (from CLI `--agents` flag) and calls Sonnet with `ROLE_PROMPTS.decomposer`:
   - Feeds up to 300 filenames from `git ls-files`
   - Asks for exactly N subtasks with **non-overlapping file scopes**
   - Each subtask gets: `title`, `task`, `scope[]`, `turns`, `model`, `depends_on[]`
   - Falls back to subprocess if API call fails; falls back to **single agent** if all methods fail
5. **Execution**: `executeParallel()` in `orchestration.mjs:198` spawns all N agents simultaneously via `spawnAgent()`.
6. **Conflict resolution**: Post-execution, `executeParallel()` detects overlapping file modifications via `git diff --name-only` and runs git 3-way merge (lines 283-385). The new `semantic-merge.mjs` module adds LLM-based semantic conflict resolution on top.
7. **Verification**: `verify()` in `orchestration.mjs:480` runs an Opus verifier that cross-checks worker outputs against `git diff`.

**Key observation**: Decomposition happens exactly once — there's no recursion, no sub-coordination, no ability for a sub-task to further split itself.

### 1.2 Maximum Practical Fan-out Before Quality Degrades

| Constraint | Current Value | Source |
|---|---|---|
| `POLICY_LIMITS_SCHEMA.maxAgents.max` | **10** | `config.mjs:211` |
| CLI default `--agents` | **3** | `cli.mjs` (parseSwarmArgs) |
| Worktree creation | **Sequential** (git worktree lock) | `orchestration.mjs:211` |
| Per-agent cost budget | `DEPTH[depth].budget` (5/15/25 USD) | `config.mjs:168` |

**Practical limits observed**:
- At **3-5 agents**: Decomposition quality is good. Scopes are clean, overlap is rare.
- At **6-8 agents**: Scope overlap increases. Decomposer struggles to keep scopes disjoint on complex tasks. Conflict resolution overhead grows linearly.
- At **9-10 agents**: Quality degrades significantly. Subtasks become too thin, decomposer produces overlapping scopes, merge conflicts increase non-linearly. Verification becomes unreliable because the verifier can't hold 10 agent outputs + git diff in context.

**Bottleneck**: The decomposer AI call receives ~300 filenames and must split into N disjoint scopes in a single pass. It has no recursive ability to "zoom in" on a module it doesn't understand well.

### 1.3 How Scope Overlap Is Currently Handled

Overlap handling is **reactive, not preventive**:

1. **Decomposer prompt** says "NO TWO subtasks may have overlapping file scopes" — but this is a soft constraint that the AI frequently violates at higher agent counts.
2. **Post-execution detection** (`orchestration.mjs:283-306`):
   - For each agent with a worktree, runs `git diff --name-only HEAD` to get modified files
   - Builds a `fileToAgents` map; any file in >1 agent triggers conflict handling
3. **Three-way merge** (`orchestration.mjs:309-385`): Iteratively merges using `git merge-file`
4. **Semantic merge** (`semantic-merge.mjs`): LLM-based merge that understands intent — classifies changes structurally, detects semantic conflicts, produces merged output with confidence scoring
5. **Unresolved conflicts**: Files that fail both merge paths are added to `unresolvedConflicts` set and flagged for manual review

**Gap**: There's no mechanism to **prevent** overlaps by organizing work hierarchically along module boundaries before spawning agents.

### 1.4 Resource Constraints

| Resource | Management Strategy | Location |
|---|---|---|
| **Worktrees** | One per agent; created sequentially (git worktree lock); cleaned up after validation | `isolation.mjs` |
| **Processes** | All spawned simultaneously via `spawn()` → Node subprocesses | `agent-spawn.mjs:79` |
| **Context windows** | Fresh 1M per agent (isolated Claude Code instance) | By design |
| **Disk** | `/tmp/swarm/<runId>/` per run; cleaned after 24h (`SWARM_TTL_HOURS`) | `lifecycle.mjs:305` |
| **API cost** | Per-agent budget via `DEPTH[depth].budget`; no aggregate budget tracking | `config.mjs:168` |
| **Snapshot cache** | Module-scope `_snapshotCache` — one snapshot per swarm run, shared across agents | `isolation.mjs:28` |
| **Backup files** | Parallel backup of mainCwd files before agent execution | `isolation.mjs` (backupFilesAsync) |

### 1.5 Where the Bottleneck Is

The fundamental bottleneck is the **flat decomposition model**:

```
         ┌─────────┐
         │  TASK    │
         └────┬────┘
              │ decompose() — single AI call
    ┌─────┬──┴──┬─────┐
    │     │     │     │
   A1    A2    A3    A4    ← all workers, no hierarchy
```

Problems:
1. **Decomposer context limit**: The decomposer sees 300 filenames but cannot deeply analyze module boundaries — it makes surface-level splits.
2. **No recursive refinement**: A subtask like "refactor the authentication module" (touching 15 files) cannot be further split.
3. **Flat conflict resolution**: All N agents' changes merge against the same base, creating O(N²) pairwise conflict potential.
4. **No coordination between sub-groups**: Agents working on related modules can't share intermediate results.
5. **Verification bottleneck**: A single verifier must cross-check all N agents' outputs simultaneously.

---

## SECTION 2: HIERARCHICAL DECOMPOSITION DESIGN

### 2.1 B-tree Analogy: How Levels Work

The hierarchical model introduces **sub-coordinators** — agents that can decompose and manage their own sub-swarms, creating a tree of work:

```
Level 0          ┌──────────────────────┐
(Top)            │   TOP COORDINATOR    │
                 │ Receives full task,  │
                 │ splits by MODULE     │
                 └──────┬───────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
Level 1  ▼              ▼              ▼
(Sub)  ┌────────┐  ┌────────┐  ┌────────┐
       │ SUB-C  │  │ SUB-C  │  │ SUB-C  │
       │ auth/  │  │ api/   │  │ tui/   │
       │ module │  │ module │  │ module │
       └───┬────┘  └───┬────┘  └───┬────┘
           │           │           │
      ┌────┼────┐  ┌───┼────┐  ┌──┴───┐
      │    │    │  │   │    │  │      │
Level 2    ▼    ▼  ▼   ▼    ▼  ▼      ▼
(Leaf)   W1   W2  W3  W4  W5  W6    W7
         (focused sub-task within module)
```

**Level 0 — Top Coordinator**:
- Receives the full task + project structure
- Analyzes the codebase at the **module boundary** level (directories, package boundaries, import graphs)
- Splits into 2-5 sub-coordinator tasks, each owning a coherent module scope
- Does NOT do implementation work — only orchestration
- Waits for all sub-coordinators to complete, then aggregates results

**Level 1 — Sub-Coordinators**:
- Each receives a scoped task + the files/directories they own
- Optionally further decomposes into 2-4 worker agents (or executes directly if task is small enough)
- Manages its own worktree isolation and conflict resolution within its scope
- Reports results up to Level 0

**Level 2 — Worker Agents**:
- Focused, single-file or few-file tasks
- Executes implementation work
- Reports checklist up to its sub-coordinator

**Level N — Configurable depth**:
- Max depth is configurable (default: 3, practical max: 4)
- Each level follows the same protocol: analyze → split-or-execute → aggregate

### 2.2 Decomposition Algorithm

#### Step 1: Task Analysis (Top Coordinator)

```
Input:  task_description, project_tree, max_depth, agent_budget
Output: DecompositionTree { nodes: TaskNode[], edges: DependencyEdge[] }
```

The top coordinator performs a **two-phase analysis**:

**Phase A — Module Boundary Detection**:
```javascript
// AI call to identify module boundaries
const boundaries = await aiJsonDecision({
  model: "claude-sonnet-4-6",
  system: ROLE_PROMPTS.hierarchical_decomposer,
  prompt: `
    Project structure: ${projectTree}
    Task: ${task}

    Identify independent MODULE BOUNDARIES suitable for parallel work.
    A module boundary is a directory or set of files that:
    1. Can be modified independently (minimal cross-module imports)
    2. Has a coherent responsibility (auth, API, UI, tests, etc.)
    3. Contains enough work for 2-4 sub-tasks

    Output: JSON array of modules, each with:
    - name: Module identifier (e.g., "auth", "api-routes", "ui-components")
    - paths: File paths or directory prefixes this module contains
    - estimated_complexity: "small" | "medium" | "large"
    - cross_dependencies: Other module names this one imports from
  `,
  maxTokens: 4096,
});
```

**Phase B — Decision: Split or Execute**:

For each module boundary, apply the **decomposition threshold**:

```
IF estimated_complexity == "small" OR file_count <= 3:
    → Assign directly to a WORKER agent (leaf node)
ELSE IF estimated_complexity == "medium" OR file_count <= 8:
    → Assign to a SUB-COORDINATOR with fan-out 2-3
ELSE IF estimated_complexity == "large" AND current_depth < max_depth:
    → Assign to a SUB-COORDINATOR with fan-out 3-5
ELSE:
    → Force single-agent execution (depth limit hit)
```

#### Step 2: Sub-Coordinator Decomposition

Each sub-coordinator receives:
- A scoped task description
- The file list within its module boundary
- A budget (turns, cost, max children)
- The parent coordinator's context (scout summary, cross-dependencies)

The sub-coordinator runs the same decomposer prompt but **scoped to its module**:
- It sees only its own files (not the full project tree)
- It can make finer-grained splits (function-level, file-level)
- It decides independently whether to spawn children or execute itself

#### Step 3: When Decomposition Stops

Decomposition terminates when ANY of these conditions hold:

1. **Task is small enough**: `estimated_file_count <= 3` AND `estimated_turns <= 15`
2. **Max depth reached**: `current_depth >= max_depth` (configurable, default 3)
3. **Agent budget exhausted**: `remaining_agent_budget < 2` (can't split + verify)
4. **Diminishing returns**: Sub-coordinator determines further splitting would increase coordination overhead without meaningful parallelism gain
5. **Tight coupling**: Module's files are too interdependent to split (detected by import/dependency analysis)

### 2.3 Fan-out Control

#### Max Children Per Node (configurable)

```javascript
const HIERARCHY_CONFIG = {
  maxChildrenPerNode: 5,     // Default: no node has >5 children
  maxDepth: 3,               // Default: 3 levels (L0, L1, L2)
  minChildrenForSplit: 2,    // Don't split if fewer than 2 children
  totalAgentBudget: 15,      // Max agents across entire hierarchy

  // Per-depth overrides
  depthOverrides: {
    0: { maxChildren: 5, model: "sonnet" },   // Top coordinator
    1: { maxChildren: 4, model: "sonnet" },   // Sub-coordinators
    2: { maxChildren: 3, model: "sonnet" },   // Deep workers
  },
};
```

#### Total Agent Budget (prevents exponential blowup)

The budget is **top-down allocated**:

```
Total budget: 15 agents

L0 top coordinator: 1 agent (always)
L0 verifier: 1 agent (if verify=true)
Remaining: 13 agents

L0 splits into 3 sub-coordinators:
  Sub-C "auth": gets budget of 4 (= 1 coordinator + 3 workers)
  Sub-C "api":  gets budget of 5 (= 1 coordinator + 4 workers)
  Sub-C "tui":  gets budget of 4 (= 1 coordinator + 3 workers)
  Total: 13 ✓

Budget allocation formula:
  sub_budget = floor(remaining_budget * module_complexity_weight / total_weight)
```

If a sub-coordinator determines it doesn't need all its budget, unused slots are NOT redistributed (simplicity over optimality).

#### Dynamic Depth Based on Task Size

```javascript
function computeMaxDepth(taskAnalysis) {
  const { totalFiles, estimatedTurns, moduleCount } = taskAnalysis;

  if (totalFiles <= 5 || estimatedTurns <= 20) return 1;   // Flat
  if (totalFiles <= 20 || moduleCount <= 3) return 2;       // Two-level
  if (totalFiles <= 50 || moduleCount <= 6) return 3;       // Three-level
  return 3; // Cap at 3 even for huge tasks (diminishing returns)
}
```

---

## SECTION 3: COORDINATION MODEL

### 3.1 How Sub-Coordinators Manage Their Sub-Swarms

Each sub-coordinator is a **mini-orchestrator** that follows the same protocol as the top-level swarm:

```
SubCoordinator(scope, task, budget):
  1. Scout: Analyze files within scope
  2. Decide: Execute directly OR decompose further
  3. If decomposing:
     a. Create worktrees for children
     b. Spawn children via spawnAgent()
     c. Await all children (Promise.all)
     d. Detect conflicts within scope
     e. Run semantic merge for overlaps
     f. Validate and apply changes
  4. Report: Send result upstream (files changed, checklist, errors)
```

**Critical distinction**: Sub-coordinators are **Claude Code subprocesses** (spawned via `agent-entry.mjs`), not API-only calls. They need tool access to:
- Read files in their worktree
- Spawn child agents (nested `spawnAgent()` calls)
- Run `git diff` for conflict detection
- Apply merged results to their worktree

This means sub-coordinators use the full Claude Code execution environment, not just the Anthropic API.

### 3.2 Result Aggregation: Leaf → Sub-Coordinator → Top Coordinator

Results flow bottom-up through the tree:

```
Leaf agent writes → result-file.json (existing format)
  ↓
Sub-coordinator reads all child result files
  → Merges outputs (semantic merge for overlapping files)
  → Validates syntax
  → Produces aggregate result-file with:
    - Combined checklist (all children)
    - Conflict report (within module)
    - Files applied to module worktree
  ↓
Top coordinator reads all sub-coordinator result files
  → Cross-module conflict detection
  → Cross-module semantic merge
  → Final verification (single Opus verifier)
  → Produces top-level contract (existing buildContract format)
```

The **result contract** at each level extends the existing format:

```javascript
{
  version: 3,  // Bump from v2
  task,
  mode: "hierarchical",
  hierarchy: {
    depth: 2,
    total_agents: 12,
    tree: {
      id: "L0-root",
      children: [
        {
          id: "L1-auth",
          scope: ["src/auth/"],
          children: [
            { id: "L2-auth-middleware", scope: ["src/auth/middleware.mjs"] },
            { id: "L2-auth-session", scope: ["src/auth/session.mjs", "src/auth/store.mjs"] },
          ],
        },
        // ...
      ],
    },
  },
  agents: [...],  // Flat list of all agents (existing format)
  merged_output,
  verification,
  conflict_report,
  summary,
}
```

### 3.3 Semantic Merge at Each Level

The existing `semantic-merge.mjs` is reused at every level:

- **Level 2 (within sub-coordinator)**: Merge conflicts between sibling leaf agents in the same module. These are typically fine-grained (same-function conflicts) and benefit most from LLM semantic merge.
- **Level 1 (within top coordinator)**: Merge conflicts between sub-coordinators. These are typically coarser (cross-module interface mismatches, shared config files) and may require more context in the merge prompt.
- **Level 0 (final)**: Any remaining conflicts after sub-coordinators have resolved their internal conflicts.

**Enhancement needed**: The merge prompt should include **hierarchy context** — which level the merge is happening at, what the parent task was, and what sibling tasks are doing.

### 3.4 IPC Message Bus Topology: Hierarchical Topics

The existing `MessageBus` (Unix domain socket pub/sub) naturally supports hierarchical topics. The naming convention:

```
Topic hierarchy:
  swarm.status                     ← Top-level status (all sub-coordinators)
  swarm.L0.lifecycle               ← L0 lifecycle events
  swarm.L1.auth.lifecycle          ← L1 "auth" sub-coordinator lifecycle
  swarm.L1.auth.progress           ← L1 "auth" progress reports
  swarm.L1.auth.L2.middleware.status  ← L2 worker within auth
  swarm.L1.api.lifecycle           ← L1 "api" sub-coordinator lifecycle
  swarm.merge.started              ← Merge events (any level)
  swarm.merge.conflict             ← Conflict events (any level, includes level metadata)
  swarm.merge.completed            ← Merge completion (includes level metadata)
  swarm.budget                     ← Agent budget consumption events
```

**Subscription patterns**:
- Top coordinator subscribes to `swarm.L1.*.lifecycle` for status of all sub-coordinators
- Each sub-coordinator subscribes to `swarm.L1.<name>.L2.*.status` for its workers
- Monitor mode (`OrchestratorControl.monitorAll()`) sees everything

**IPC flow example**:
```
L2-auth-middleware → publishes "task_complete" to swarm.L1.auth.L2.middleware.status
L1-auth sub-coordinator → receives via subscription, updates progress
L1-auth → publishes "subtask_complete 1/3" to swarm.L1.auth.progress
L0 top coordinator → receives via subscription, updates overall progress
L0 → publishes "module_progress auth: 33%" to swarm.status
```

### 3.5 Error Propagation

Errors bubble up with increasing severity and decreasing detail:

```
Level 2 (leaf agent fails):
  Worker reports: { exitCode: 1, error: "syntax error in auth/session.mjs:42" }

Level 1 (sub-coordinator handles):
  IF other sibling agents succeeded AND failed agent's scope is non-critical:
    → Mark subtask as PARTIAL, continue with other results
    → Include failure in aggregate report
  ELSE IF failed agent's scope blocks other subtasks:
    → Retry once with different approach (adjust prompt)
    → If still fails, propagate FAIL up with context

Level 0 (top coordinator handles):
  IF sub-coordinator reports PARTIAL:
    → Include partial results, flag in verification
  IF sub-coordinator reports FAIL:
    → Check if other sub-coordinators cover the gap
    → If critical module failed, mark entire swarm as NEEDS_REWORK
```

**Retry policy per level**:
- Level 2 (leaf): No retries (cost management). Report failure honestly.
- Level 1 (sub-coordinator): One retry with adjusted prompt if budget allows.
- Level 0 (top coordinator): Can re-decompose the failed module as a single agent.

### 3.6 Progress Tracking

Top coordinator maintains an **aggregate progress model**:

```javascript
class HierarchicalProgress {
  constructor(tree) {
    this.nodes = new Map(); // nodeId → { status, progress, children }
    this.buildFromTree(tree);
  }

  updateNode(nodeId, status) {
    const node = this.nodes.get(nodeId);
    node.status = status;

    // Propagate: parent progress = avg(children progress)
    this.recalculateParent(node.parentId);
  }

  getOverallProgress() {
    // Weighted by subtree size
    return this.nodes.get("L0-root").computedProgress;
  }
}
```

The TUI dashboard (existing `lib/tui/dashboard.mjs`) would display:
```
┌──────────────────────────────────────────────┐
│ HIERARCHICAL SWARM — 67% complete            │
│                                              │
│ ├─ auth/    [████████░░] 80%  (3/3 workers)  │
│ │  ├─ middleware   ✓ done (12.3s)            │
│ │  ├─ session      ✓ done (18.7s)            │
│ │  └─ tests        ▶ running (8.2s)          │
│ ├─ api/     [████░░░░░░] 40%  (2/4 workers)  │
│ │  ├─ routes       ✓ done (15.1s)            │
│ │  ├─ handlers     ▶ running (22.4s)         │
│ │  ├─ validation   ○ queued                  │
│ │  └─ tests        ○ queued                  │
│ └─ tui/     [██████████] 100% (2/2 workers)  │
│    ├─ components   ✓ done (9.8s)             │
│    └─ layout       ✓ done (11.2s)            │
│                                              │
│ Budget: 8/15 agents used  Cost: $2.47        │
└──────────────────────────────────────────────┘
```

---

## SECTION 4: RESOURCE MANAGEMENT

### 4.1 Worktree Strategy

**One worktree per leaf agent** (not per sub-coordinator):

```
Worktree tree:
  /tmp/swarm/<runId>/
    worktrees/
      L1-auth/             ← Sub-coordinator worktree (for merge staging)
        L2-auth-mw/        ← Leaf agent worktree
        L2-auth-session/   ← Leaf agent worktree
        L2-auth-tests/     ← Leaf agent worktree
      L1-api/              ← Sub-coordinator worktree
        L2-api-routes/     ← Leaf agent worktree
        ...
```

**Why not shared worktrees?** Git worktrees are per-branch. Two agents writing to the same worktree would cause data races. Each leaf agent needs its own worktree for isolation.

**Sub-coordinator worktrees**: Sub-coordinators get a worktree for **merge staging**. After their children complete, they merge child results into their own worktree, validate, then report the aggregate diff upstream.

**Worktree creation optimization**:
- Git worktree creation is sequential (git worktree lock)
- At Level 0: Create sub-coordinator worktrees sequentially (typically 2-5, fast)
- At Level 1: Each sub-coordinator creates its children's worktrees (parallel across sub-coordinators, sequential within each)
- Snapshot cache (`isolation.mjs:28`) shared within each sub-coordinator's scope

### 4.2 Context Window Budget

Each agent (at any level) gets a **fresh 1M context window** — this is a fundamental property of arbor isolation. No budget sharing needed.

However, the **prompt size** varies by level:

| Level | Prompt Size Budget | Content |
|---|---|---|
| L0 Top Coordinator | ~20K tokens | Full task + project tree + hierarchy config |
| L1 Sub-Coordinator | ~15K tokens | Scoped task + module file list + parent context |
| L2 Worker | ~10K tokens | Focused task + specific files + scout summary |
| Verifier | ~30K tokens | All outputs + git diff + test results |

### 4.3 Process Limits

```javascript
const PROCESS_LIMITS = {
  // Max concurrent processes at any point in time
  maxConcurrentAgents: 10,       // OS/system limit

  // Per-level concurrency
  maxL1Concurrent: 5,            // Max sub-coordinators running simultaneously
  maxL2PerSubCoordinator: 4,     // Max workers per sub-coordinator

  // Total across hierarchy
  totalAgentBudget: 15,          // Max agents spawned across entire hierarchy

  // Stagger spawn to avoid thundering herd
  spawnDelayMs: 200,             // Delay between agent spawns at same level
};
```

**Concurrency model**: Sub-coordinators at Level 1 run in parallel. Within each sub-coordinator, leaf agents run in parallel. The maximum concurrent processes at any instant is:

```
max_concurrent = min(
  maxConcurrentAgents,
  sum(min(sub_coordinator.childCount, maxL2PerSubCoordinator) for each running sub-coordinator)
)
```

### 4.4 Memory Management and Cleanup

Cleanup follows the **tree structure** bottom-up:

```
1. Leaf agent completes → sub-coordinator validates + applies → leaf worktree deleted
2. All children done → sub-coordinator reports → sub-coordinator worktree deleted
3. All sub-coordinators done → top coordinator aggregates → run directory cleaned
```

**Eager cleanup**: Each sub-coordinator cleans up its children's worktrees as soon as their changes are applied. This prevents N worktrees from accumulating.

**Stale cleanup**: The existing `cleanOldRuns()` in `lifecycle.mjs:305` handles orphaned run directories (24h TTL).

### 4.5 Cost Estimation

Given a task, predict agent count and API cost:

```javascript
async function estimateHierarchyCost(task, projectTree, config) {
  // Phase 1: Top-level decomposition analysis (1 API call)
  const analysis = await aiJsonDecision({
    model: "claude-sonnet-4-6",
    prompt: `Estimate complexity: ${task}\nFiles: ${projectTree.slice(0, 1000)}`,
    // Returns: { modules: [...], estimatedDepth, estimatedAgents }
  });

  const apiCallCost = 0.015;  // ~$0.015 per Sonnet API call
  const subprocessCost = 0.25; // ~$0.25 per 25-turn Sonnet subprocess
  const opusCost = 0.75;       // ~$0.75 per 15-turn Opus subprocess

  const coordinatorCalls = analysis.estimatedDepth; // API calls for decomposition
  const workerCount = analysis.estimatedAgents;
  const verifierCount = config.verify ? 1 : 0;

  return {
    estimatedAgents: workerCount + coordinatorCalls + verifierCount,
    estimatedCost: (
      coordinatorCalls * apiCallCost +          // Decomposition API calls
      workerCount * subprocessCost +            // Worker subprocesses
      verifierCount * opusCost +                // Opus verification
      analysis.modules.length * apiCallCost     // Scout + merge calls
    ),
    estimatedDuration: `${(workerCount * 30 / analysis.modules.length / 60).toFixed(0)}-${(workerCount * 60 / analysis.modules.length / 60).toFixed(0)} min`,
    breakdown: {
      decomposition: coordinatorCalls * apiCallCost,
      workers: workerCount * subprocessCost,
      verification: verifierCount * opusCost,
      overhead: analysis.modules.length * apiCallCost,
    },
  };
}
```

---

## SECTION 5: IMPLEMENTATION PLAN

### Phase 1: Core Decomposition Engine

**Goal**: Build the recursive task analysis → tree of sub-tasks algorithm.

**Files to create**:
- `lib/hierarchical-decompose.mjs` — New module (~300 LOC)
  - `analyzeModuleBoundaries(task, projectTree)` → module list
  - `buildDecompositionTree(task, modules, config)` → TaskTree
  - `shouldDecomposeModule(module, depth, budget)` → boolean
  - `allocateBudget(modules, totalBudget)` → per-module budgets

**Files to modify**:
- `lib/config.mjs` — Add `HIERARCHY_CONFIG` defaults and `ROLE_PROMPTS.hierarchical_decomposer`
- `lib/ai-client.mjs` — No changes (existing `aiJsonDecision` is sufficient)

**Dependencies**: None (uses existing AI client)
**Estimated complexity**: Medium (main challenge is the decomposition prompt engineering)

### Phase 2: Sub-Coordinator Agent

**Goal**: Create a sub-coordinator that can decompose and manage its own sub-swarm.

**Files to create**:
- `lib/sub-coordinator.mjs` — New module (~400 LOC)
  - `runSubCoordinator(scope, task, budget, config)` → SubCoordinatorResult
  - Internally calls `decompose()` scoped to its module
  - Spawns children via existing `spawnAgent()`
  - Runs semantic merge within its scope
  - Reports aggregate result

**Files to modify**:
- `lib/agent-spawn.mjs` — Add `role: "sub-coordinator"` support with nested spawning capability
- `lib/config.mjs` — Add `ROLE_PROMPTS.sub_coordinator`

**Dependencies**: Phase 1 (decomposition tree)
**Estimated complexity**: High (nesting agent spawns within agents is the novel challenge)

### Phase 3: Hierarchical IPC

**Goal**: Extend IPC message bus with hierarchical topic conventions and progress aggregation.

**Files to create**:
- `lib/ipc/hierarchy-topics.mjs` — New module (~150 LOC)
  - Topic naming helpers: `buildTopic(level, moduleName, eventType)`
  - Subscription pattern builders: `subscribeToChildren(parentId)`
  - Progress aggregation: `HierarchicalProgress` class

**Files to modify**:
- `lib/ipc/message-bus.mjs` — Add wildcard topic matching (e.g., `swarm.L1.*.lifecycle`)
- `lib/ipc/orchestrator-control.mjs` — Add hierarchy-aware monitoring methods

**Dependencies**: None (can be developed in parallel with Phase 1-2)
**Estimated complexity**: Low-Medium (topic naming is straightforward; wildcard matching is the main addition)

### Phase 4: Result Aggregation (Bottom-Up Merge)

**Goal**: Build the multi-level result aggregation pipeline.

**Files to create**:
- `lib/hierarchy-aggregate.mjs` — New module (~250 LOC)
  - `aggregateSubCoordinatorResults(childResults, scope)` → AggregatedResult
  - `crossModuleConflictDetection(subCoordinatorResults)` → ConflictReport
  - `buildHierarchicalContract(tree, results, verification)` → Contract v3

**Files to modify**:
- `lib/semantic-merge.mjs` — Add `mergeLevel` parameter to `performSemanticMerge()` for level-aware merge prompts
- `lib/orchestration.mjs` — Import and use hierarchy aggregation in new `executeHierarchical()` function

**Dependencies**: Phase 2 (sub-coordinator results), Phase 1 (tree structure)
**Estimated complexity**: Medium (extends existing patterns)

### Phase 5: Integration with Existing swarm.mjs (Backward Compatible)

**Goal**: Add `mode: "hierarchical"` alongside existing modes without breaking them.

**Files to modify**:
- `swarm.mjs` — Add `hierarchical` mode handler in main() (alongside single, parallel, pipeline, etc.)
- `lib/cli.mjs` — Add `--hierarchy-depth`, `--hierarchy-max-children` CLI flags
- `lib/orchestration.mjs` — Add `autoMode()` classification for hierarchical (when task is clearly multi-module + complex)
- `lib/config.mjs` — Add `DEPTH[depth].hierarchy` config per depth preset

**New entry flow**:
```javascript
} else if (mode === "hierarchical") {
  // Phase 1: Build decomposition tree
  const tree = await buildDecompositionTree(args.task, projectTree, {
    maxDepth: args.hierarchyDepth,
    maxChildren: args.hierarchyMaxChildren,
    agentBudget: args.agents,
  });

  // Phase 2: Execute tree (sub-coordinators spawn their own workers)
  workerResults = await executeHierarchical(tree, depth, args.contextFile, workDir);

  // Phase 3: Results already aggregated by sub-coordinators
}
```

**Backward compatibility**: All existing modes (single, parallel, pipeline, swarm, review) continue to work unchanged. `hierarchical` is a new mode opt-in via `--mode hierarchical` or auto-detected.

**Dependencies**: Phases 1-4
**Estimated complexity**: Low (wiring existing components)

### Phase 6: Resource Governor

**Goal**: Enforce budget limits, prevent runaway resource consumption, provide cost estimation.

**Files to create**:
- `lib/resource-governor.mjs` — New module (~200 LOC)
  - `ResourceGovernor` class with:
    - `reserveAgents(count)` → boolean (checks budget)
    - `releaseAgents(count)` → void
    - `getRemaining()` → { agents, estimatedCost }
    - `estimateCost(tree)` → CostEstimate
  - Singleton pattern — one governor per swarm run

**Files to modify**:
- `swarm.mjs` — Initialize resource governor at startup, pass to hierarchical execution
- `lib/sub-coordinator.mjs` — Check governor before spawning children

**Dependencies**: Phase 2 (sub-coordinator), Phase 5 (integration)
**Estimated complexity**: Low (bookkeeping, no complex logic)

### Phase Summary

| Phase | New Files | Modified Files | LOC (est.) | Dependencies |
|---|---|---|---|---|
| 1. Decomposition Engine | 1 | 1 | ~300 | None |
| 2. Sub-Coordinator | 1 | 2 | ~400 | Phase 1 |
| 3. Hierarchical IPC | 1 | 2 | ~150 | None (parallel) |
| 4. Result Aggregation | 1 | 2 | ~250 | Phase 1, 2 |
| 5. Integration | 0 | 4 | ~100 | Phase 1-4 |
| 6. Resource Governor | 1 | 2 | ~200 | Phase 2, 5 |
| **Total** | **5 new** | **~10 modified** | **~1400** | |

---

## SECTION 6: EDGE CASES AND FAILURE MODES

### 6.1 What If Decomposition Produces an Unbalanced Tree?

**Scenario**: Module "auth" has 2 files, module "api" has 30 files. The tree is heavily unbalanced — "auth" finishes in 15s while "api" takes 5 minutes.

**Mitigation**:
1. **Budget rebalancing at decomposition time**: The `allocateBudget()` function weights by `estimated_complexity`, so "api" gets more agents.
2. **Early completion signaling**: When "auth" sub-coordinator finishes early, its worktree is cleaned up immediately (freeing resources). Its result is available for cross-module merge as soon as "api" finishes.
3. **No work stealing**: Intentionally avoided. Work stealing across sub-coordinators would require shared state and break isolation. The cost of idle agents (waiting on slow siblings) is low compared to the coordination complexity.

### 6.2 What If a Sub-Coordinator Crashes Mid-Swarm?

**Scenario**: L1 sub-coordinator "api" spawned 4 workers. Workers 1-2 completed, worker 3 is running, then the sub-coordinator process crashes (OOM, timeout, uncaught exception).

**Impact**: Workers 1-2 have result files on disk. Worker 3 may still be running but its parent is gone. Worker 4 was never spawned.

**Recovery strategy**:
1. **Orphan detection**: Top coordinator monitors sub-coordinator lifecycle via IPC. If heartbeat stops, mark sub-coordinator as FAILED.
2. **Result recovery**: Top coordinator reads result files from the sub-coordinator's work directory. Completed workers' results are still usable.
3. **Orphan cleanup**: Worker 3 will eventually timeout. Its worktree is cleaned up by the existing `cleanOldRuns()` mechanism.
4. **Partial result**: Top coordinator includes completed workers' results, marks the failed module as PARTIAL, flags in verification.
5. **No automatic retry** at this level (cost management). The verifier will flag missing work and the user can re-run.

### 6.3 What If Total Agent Count Exceeds Budget?

**Scenario**: Tree decomposition estimates 20 agents needed, but budget is 15.

**Prevention**:
1. `buildDecompositionTree()` receives `totalAgentBudget` and constrains the tree at construction time.
2. `allocateBudget()` distributes slots top-down. If a module needs 6 agents but only gets 4, it runs with 4 (sub-coordinator adjusts its internal decomposition).
3. `ResourceGovernor.reserveAgents()` is the runtime enforcement — if a sub-coordinator tries to spawn beyond its allocation, the call returns `false` and the sub-coordinator falls back to sequential execution.

**If prevention fails** (bug or race condition):
- The `ResourceGovernor` hard-caps at `PROCESS_LIMITS.maxConcurrentAgents` regardless of budget
- Excess `spawnAgent()` calls will queue rather than spawn (future enhancement)
- Cost monitoring logs a warning but does not kill running agents

### 6.4 What If Module Boundaries Are Unclear (Tightly Coupled Code)?

**Scenario**: A monolithic codebase where everything imports from everything.

**Detection**: The decomposer's `cross_dependencies` analysis reveals high coupling:
```javascript
// If >50% of modules have cross-dependencies with >2 other modules
if (crossDependencyDensity > 0.5) {
  // Fall back to flat decomposition (existing parallel mode)
  return { mode: "parallel", reason: "high coupling — hierarchical decomposition not beneficial" };
}
```

**Graceful degradation**:
1. If the top coordinator detects high coupling, it falls back to `mode: "parallel"` (existing flat decomposition).
2. If coupling is moderate (some modules independent, some coupled), it:
   - Groups coupled modules into a single sub-coordinator scope
   - Keeps independent modules as separate sub-coordinators
   - Reduces tree depth to avoid over-fragmentation

### 6.5 What If Leaf Agents Produce Conflicting Changes Across Sub-Swarms?

**Scenario**: L1-auth worker modifies `src/shared/types.ts` (which is in its scope), and L1-api worker also modifies `src/shared/types.ts` (which leaked outside its scope).

**Prevention**:
1. The decomposer assigns shared files (like `src/shared/types.ts`) to exactly one sub-coordinator.
2. The worker prompt says "DO NOT modify files outside your assigned scope."
3. Post-execution validation in `validateAndApply()` already checks for out-of-scope modifications via the isolation snapshot.

**Resolution if it happens anyway**:
1. Top coordinator's cross-module conflict detection (Phase 4) catches the overlap.
2. Semantic merge runs at Level 0, with context about both sub-coordinators' intents.
3. If merge fails, the file is flagged for manual review.
4. The verifier (Opus) explicitly checks for cross-module scope violations.

### 6.6 Rollback Strategy: Undoing a Partially Completed Hierarchy

**Scenario**: 3 sub-coordinators completed. Their changes are applied. Verification reveals a critical issue. Need to undo.

**Current rollback mechanism** (extends existing):
1. Each sub-coordinator's `validateAndApply()` creates backups in `<workDir>/backups/`.
2. If verification returns FAIL:
   ```javascript
   if (verifyResult.verdict === "FAIL") {
     // Rollback all applied changes
     for (const backup of backups.reverse()) {
       restoreFromBackup(backup.backupDir, mainCwd);
     }
     log("ROLLBACK: All hierarchical changes reverted");
   }
   ```
3. Backups are ordered by application time, reversed for rollback.
4. Git-based rollback alternative: `git stash` before applying, `git stash pop` to rollback.

**Limitations**:
- If a sub-coordinator's changes triggered side effects (npm install, database migration), those are NOT automatically rolled back.
- File-level rollback is reliable; system-level rollback is best-effort.

---

## APPENDIX A: Key Data Structures

### TaskTree

```typescript
interface TaskNode {
  id: string;                     // e.g., "L1-auth", "L2-auth-middleware"
  level: number;                  // 0 = top, 1 = sub-coordinator, 2+ = worker
  type: "coordinator" | "worker";
  task: string;                   // Task description
  scope: string[];                // File paths/directories owned
  budget: {
    agents: number;               // Max agents this node can spawn
    turns: number;                // Max turns per agent
    costUsd: number;              // Max cost in USD
  };
  model: "sonnet" | "opus";
  children: TaskNode[];           // Sub-tasks (empty for workers)
  dependencies: string[];         // IDs of nodes that must complete first
  status: "pending" | "running" | "completed" | "failed" | "partial";
  result?: AgentResult;           // Populated after completion
}

interface TaskTree {
  root: TaskNode;
  config: HierarchyConfig;
  budget: ResourceBudget;
}
```

### HierarchyConfig

```typescript
interface HierarchyConfig {
  maxDepth: number;               // Max tree depth (default: 3)
  maxChildrenPerNode: number;     // Max fan-out (default: 5)
  totalAgentBudget: number;       // Max agents across hierarchy
  minChildrenForSplit: number;    // Don't split if fewer than this
  depthOverrides: Record<number, {
    maxChildren: number;
    model: "sonnet" | "opus";
  }>;
  verify: boolean;                // Run verification pass
  fallbackMode: "parallel" | "single"; // Fallback if hierarchy not applicable
}
```

---

## APPENDIX B: Interaction with Existing System

### What Changes
- New `mode: "hierarchical"` in `swarm.mjs`
- New decomposition engine (`lib/hierarchical-decompose.mjs`)
- New sub-coordinator logic (`lib/sub-coordinator.mjs`)
- New result aggregation (`lib/hierarchy-aggregate.mjs`)
- New resource governor (`lib/resource-governor.mjs`)
- Extended IPC topics (`lib/ipc/hierarchy-topics.mjs`)
- Extended config (`lib/config.mjs` — new prompts and defaults)
- Extended CLI (`lib/cli.mjs` — new flags)

### What Stays the Same
- All existing modes (single, parallel, pipeline, swarm, review) — untouched
- `spawnAgent()` API — unchanged (sub-coordinators use it to spawn children)
- `semantic-merge.mjs` — reused at every level (minor parameter extension)
- `isolation.mjs` — worktree creation/validation/cleanup — unchanged
- `lifecycle.mjs` — bd task management, cleanup — unchanged
- `ai-client.mjs` — API wrapper — unchanged
- `ipc/message-bus.mjs` — core bus — unchanged (wildcard matching is additive)
- `ipc/registry.mjs` — agent registry — unchanged
- `ipc/orchestrator-control.mjs` — control plane — unchanged
- Result contract format — backward compatible (v3 extends v2)

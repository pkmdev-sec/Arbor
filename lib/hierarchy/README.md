# Hierarchical Agent Coordination

Provides multi-level hierarchical decomposition and coordination for distributed agent swarms.

## Architecture

```
Level 0          ┌──────────────────────┐
(Top)            │   TOP COORDINATOR    │
                 │ analyzeModuleBoundaries()
                 └──────┬───────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
Level 1  ▼              ▼              ▼
(Sub)  ┌────────┐  ┌────────┐  ┌────────┐
       │ SUB-C  │  │ SUB-C  │  │ WORKER │
       │ auth/  │  │ api/   │  │ tui/   │
       └───┬────┘  └───┬────┘  └────────┘
           │           │
      ┌────┼────┐  ┌───┼────┐
Level 2    ▼    ▼  ▼   ▼    ▼
(Leaf)   W1   W2  W3  W4  W5
```

## Components

### ScopedBus (`scoped-bus.mjs`)

Hierarchical IPC message bus with topic scoping:
- Topic naming: `swarm.L{level}.{scope}.{event}`
- Parent-child communication via `publishUp()` / `subscribeDown()`
- Wildcard topic subscriptions
- Progress aggregation across levels

**Example:**
```javascript
import { ScopedBus, HierarchicalTopics } from './hierarchy/scoped-bus.mjs';

const bus = new ScopedBus("agent-01", { level: 1, scope: "auth" });
await bus.connect();

// Publish to current scope: swarm.L1.auth.progress
await bus.publish(HierarchicalTopics.PROGRESS, { percent: 0.5 });

// Publish to parent (L0)
await bus.publishUp(HierarchicalTopics.STATUS, { status: "completed" });
```

### SubCoordinator (`sub-coordinator.mjs`)

Agent that manages a sub-swarm within a hierarchical system:
- Recursive task decomposition
- Child agent spawning (workers or sub-coordinators)
- Heartbeat monitoring with crash recovery
- Semantic conflict resolution
- Budget enforcement

**Example:**
```javascript
import { spawnSubCoordinator } from './hierarchy/sub-coordinator.mjs';

const coordinator = await spawnSubCoordinator({
  id: "sub-coord-01",
  level: 1,
  scope: "auth",
  task: "Refactor authentication module",
  files: ["src/auth/login.js", "src/auth/session.js"],
  busAddress: "/tmp/claude-ipc-bus.sock",
  worktreeBase: "/tmp/swarm/abc/worktrees",
  agentBudget: 5,
  maxDepth: 3,
});

const decomposition = await coordinator.decompose();
if (decomposition.strategy === "split") {
  await coordinator.spawnChildren(decomposition.subtasks);
  const childResults = await coordinator.waitForChildren();
  const aggregated = await coordinator.aggregateResults(childResults);
  await coordinator.reportUp(aggregated);
}
await coordinator.shutdown();
```

## Key Features

### 1. Recursive Decomposition
- B-tree structure with configurable depth (default: 3 levels)
- Dynamic split-or-execute decisions based on:
  - File count in scope
  - Available agent budget
  - Current hierarchy level

### 2. Heartbeat Monitoring
- Configurable timeout (default: 45s)
- Automatic crash detection
- Single retry with exponential backoff

### 3. Semantic Merge
- Integrates with `semantic-merge.mjs`
- Level-aware conflict resolution
- Cross-module conflict detection at L0

### 4. Budget Enforcement
- Top-down budget allocation
- Weighted distribution (coordinators: 3x, workers: 1x)
- Hard caps to prevent exponential blowup

## Configuration

Default configuration in `sub-coordinator.mjs`:
```javascript
{
  maxChildren: 5,              // Max children per coordinator
  minFilesForSplit: 4,         // Min files to warrant splitting
  heartbeatTimeout: 45000,     // Heartbeat timeout (ms)
  maxChildRetries: 1,          // Retry attempts for crashed children
  workerTimeout: 600,          // Worker execution timeout (sec)
  budgetStrategy: "weighted",  // "equal" | "weighted"
  enableSemanticMerge: true,   // Enable semantic conflict resolution
}
```

## Integration Points

### With Existing Infrastructure
- `agent-spawn.mjs` - Spawns worker agents and sub-coordinators
- `semantic-merge.mjs` - Resolves file conflicts across agents
- `isolation.mjs` - Worktree creation and validation
- `ipc/agent-channel.mjs` - Underlying IPC transport
- `ai-client.mjs` - AI-based decomposition decisions

### IPC Topics
Hierarchical topics follow the pattern: `swarm.L{level}.{scope}.{event}`

Predefined events:
- `.status` - Lifecycle (online, offline, crash)
- `.progress` - Progress updates (percent, step)
- `.merge` - Merge operations
- `.error` - Error notifications
- `.control` - Control commands
- `.heartbeat` - Health checks
- `.result` - Result delivery

## Error Handling

All methods include comprehensive error handling:
- Try/catch blocks throughout
- Structured JSON logging
- Graceful degradation (fallback to direct execution)
- Partial result recovery on child crashes
- Non-fatal semantic merge failures

## Testing

To verify installation:
```bash
cd ~/.claude/arbor
node -e "import * as h from './lib/hierarchy/index.mjs'; console.log(Object.keys(h));"
```

Expected output:
```
[
  'HierarchicalTopics',
  'ScopedBus',
  'SubCoordinator',
  'aggregateProgress',
  'createChildScope',
  'createScopedBus',
  'createWorkerTask',
  'spawnSubCoordinator'
]
```

## Files

- `scoped-bus.mjs` (515 lines, 16KB) - Hierarchical IPC bus
- `sub-coordinator.mjs` (1161 lines, 37KB) - Sub-coordinator agent
- `index.mjs` - Module exports
- `README.md` - This file

## Next Steps

To integrate with the main swarm orchestrator:
1. Add `mode: "hierarchical"` to `swarm.mjs`
2. Update `orchestration.mjs` with `executeHierarchical()`
3. Extend `config.mjs` with hierarchy defaults
4. Add CLI flags for hierarchy depth and max children

# Observability

Monitoring, debugging, and event tracking in Arbor.

## IPC Event Log

Every swarm run writes an NDJSON event log to `{workDir}/ipc.ndjson`:

```json
{"ts":"2025-01-15T10:30:00.000Z","from":"orchestrator","to":"agent-01","type":"task_assign","msg":"Implement auth module","meta":{}}
{"ts":"2025-01-15T10:30:45.000Z","from":"agent-01","to":"orchestrator","type":"result","msg":"exit 0 in 42.3s","meta":{"exitCode":0,"durationMs":42300}}
```

### Event Types

| Type | Description |
|------|-------------|
| `lifecycle` | Start/stop events, mode transitions |
| `task_assign` | Orchestrator assigns task to agent |
| `result` | Agent reports completion |
| `error` | Agent or system error |
| `decision` | Mode selection, approach selection |
| `verdict` | Verifier PASS/FAIL/NEEDS_REWORK |
| `warning` | Non-fatal issues (conflicts, fallbacks) |
| `merge.completed` | Conflict detection results |

### Reading Logs

```bash
# All events
cat /tmp/swarm/<run-id>/ipc.ndjson | jq .

# Filter by agent
cat /tmp/swarm/<run-id>/ipc.ndjson | jq 'select(.from == "agent-01")'

# Only errors
cat /tmp/swarm/<run-id>/ipc.ndjson | jq 'select(.type == "error")'

# Timeline view
cat /tmp/swarm/<run-id>/ipc.ndjson | jq -r '"\(.ts) [\(.from) → \(.to)] \(.type): \(.msg)"'
```

## TUI Dashboard

Live terminal dashboard for monitoring active swarm runs:

```bash
# Dashboard attached to current run
swarm --tui "implement feature X"

# Monitor all active swarm runs (read-only)
swarm --monitor
```

The TUI shows:
- Agent status (running/done/failed)
- Real-time progress via PostToolUse hooks
- IPC event stream
- Resource usage (when governor is active)

## Debug Mode

Per-agent debug logging:

```bash
arbor --debug "explore auth module"
swarm --debug "implement caching"
```

Sets `CLAUDE_CODE_DEBUG_LOGS_DIR` per agent to `{workDir}/debug/{agentId}/`. Claude Code writes detailed internal logs there.

## PostToolUse Progress (F9)

When `ARBOR_TUI=1` is set (automatically by `--tui`), agents emit structured progress after each tool use:

```json
{
  "phase": "implementation",
  "files_read": 12,
  "files_written": 3,
  "tool_calls": 15,
  "current_file": "src/auth/login.ts"
}
```

## Work Directory Structure

```
/tmp/swarm/<run-id>/
  ipc.ndjson           # Event log
  scout.json           # Scout analysis result
  agent-01-result.json # Per-agent structured results
  agent-02-result.json
  conflicts.json       # File-level conflict report
  debug/               # Debug logs (--debug only)
    agent-01/
    agent-02/
  worktrees/           # Git worktrees (cleaned up after run)
  backups/             # Pre-change snapshots (cleaned up after run)
```

## Hierarchical Observability

For hierarchical mode, additional metadata:

- **ResourceGovernor reports**: total spawned, completed, failed, cost
- **Decomposition tree**: depth, node count, leaf count
- **Aggregation confidence**: 0-100% confidence in merged result
- **Conflict detection**: file-level conflicts with severity (high/medium/low)
- **Per-level breakdown**: agents and timing per hierarchy level

## Cost Tracking

Structured result contract includes:
- `summary.total_agents` — agents spawned
- `summary.completed` / `summary.failed` — success rate
- `summary.total_duration_ms` — wall clock time
- Per-agent duration and exit codes in `agents[]`

For hierarchical mode, `governor_report` adds:
- `totalCost` — estimated USD cost
- `totalSpawned` / `totalCompleted` / `totalFailed`

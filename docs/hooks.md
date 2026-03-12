# Hooks

Arbor uses Claude Code's hook system to intercept and route tasks from your main session. Four hooks ship with Arbor, installed into `~/.claude/hooks/` by the installer.

## Hook overview

| Hook | Trigger | Purpose |
|------|---------|---------|
| `auto_orchestrator.py` | `UserPromptSubmit` | Classifies prompts and decides routing |
| `block_agent_tool.py` | `PreToolUse` (Agent, Read, Glob, Grep) | Prevents raw agent spawning |
| `fulfill_delegate.py` | `PostToolUse` (Bash) | Detects delegated command completion |
| `block_task_tools.py` | `PreToolUse` (Task*, TodoWrite) | Redirects task tools to `bd` CLI |

## State machine

The hooks coordinate through a shared state file at `~/.claude/hooks/.acontext_state/delegate_mode.json`. The state machine has three modes:

```
DIRECT ──── prompt classified ────→ DELEGATE
   ▲                                    │
   │                                    │
   └──── command completes ─────── FULFILLED
```

**DIRECT** — Normal operation. The main Claude Code session handles prompts directly. This is the default state.

**DELEGATE** — The auto_orchestrator has decided to route a task to Arbor. The main session constructs and runs an `arbor` or `swarm` command. While in this state, `block_agent_tool.py` prevents the session from spawning its own agents (it should be using the orchestrator instead).

**FULFILLED** — The delegated command has finished. `fulfill_delegate.py` detects this by monitoring Bash tool outputs for the completion of `arbor` or `swarm` commands. The state resets to DIRECT.

## auto_orchestrator.py

Runs on every `UserPromptSubmit` event — before the main session starts processing your prompt.

**Classification logic:**

The orchestrator examines the prompt text and decides one of three actions:

- **DIRECT** — Simple questions, explanations, or tasks that don't involve code changes. The prompt passes through normally.
- **DELEGATE** — The task should be routed to a single `arbor` agent. Used for focused tasks that benefit from isolation but don't need parallel execution.
- **ORCHESTRATE** — The task should be routed to `swarm` for multi-agent execution. Used for complex tasks that can be decomposed.

The classifier uses keyword matching and prompt structure analysis. It's intentionally conservative — ambiguous tasks default to DIRECT rather than triggering unnecessary orchestration.

**Configuration:**

The orchestrator reads its classification thresholds from the prompt context. You can influence routing by being explicit:

```
# These will likely trigger ORCHESTRATE
"implement X, Y, and Z across the codebase"
"refactor all error handling in every module"

# These will likely stay DIRECT
"explain how the auth module works"
"what does this function do?"
```

## block_agent_tool.py

Runs on `PreToolUse` events for Agent, Read, Glob, and Grep tools.

When the state is DELEGATE, this hook prevents the main session from spawning its own agents. Instead, it returns a message directing the session to use the `arbor` or `swarm` command. This ensures all agent work goes through the orchestrator's isolation and validation pipeline.

The hook also enforces an allowlist of bash commands. The `arbor` and `swarm` commands are always allowed. Other commands are checked against a configurable list.

## fulfill_delegate.py

Runs on `PostToolUse` events for the Bash tool.

After a delegated `arbor` or `swarm` command finishes, this hook detects the completion by inspecting the Bash tool's output. When it sees a command matching `arbor` or `swarm` has completed, it transitions the state from DELEGATE back to DIRECT (via FULFILLED).

The detection uses fail-closed logic: if the hook encounters an error reading state or parsing output, it assumes the command has NOT completed and leaves the state unchanged. This prevents premature state transitions.

## block_task_tools.py

Runs on `PreToolUse` events for TaskCreate, TaskUpdate, TaskGet, TaskList, and TodoWrite tools.

This hook redirects Claude Code's built-in task management tools to the `bd` (beads) CLI. When the main session tries to use a task tool, the hook returns a message explaining that task tracking should go through `bd` instead.

This keeps task state in a single system rather than split between Claude Code's internal task store and the external `bd` tracker.

## Installation and registration

The installer (`install.sh`) handles hook setup:

1. Copies hook scripts to `~/.claude/hooks/`
2. Makes them executable
3. Registers them in `~/.claude/settings.json` under the `hooks` key
4. Creates the state directory at `~/.claude/hooks/.acontext_state/`

To verify hooks are registered:

```bash
cat ~/.claude/settings.json | python3 -c "
import json, sys
hooks = json.load(sys.stdin).get('hooks', {})
for event, matchers in hooks.items():
    for m in matchers:
        print(f'{event}: {m.get(\"matcher\", \"*\")}')
"
```

## Disabling hooks

To temporarily disable orchestration without uninstalling:

```bash
# Set state to DIRECT
echo '{"mode":"DIRECT"}' > ~/.claude/hooks/.acontext_state/delegate_mode.json
```

To permanently remove:

```bash
# Remove hook files
rm ~/.claude/hooks/auto_orchestrator.py
rm ~/.claude/hooks/block_agent_tool.py
rm ~/.claude/hooks/fulfill_delegate.py
rm ~/.claude/hooks/block_task_tools.py

# Remove registrations from settings.json (manual edit)
```

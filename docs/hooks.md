# Hooks

Four hooks installed into `~/.claude/hooks/` intercept and route tasks to Arbor.

## Overview

| Hook | Trigger | Purpose |
|------|---------|---------|
| `auto_orchestrator.py` | `UserPromptSubmit` | Classifies prompts → DIRECT / DELEGATE / ORCHESTRATE |
| `block_agent_tool.py` | `PreToolUse` | Prevents raw agent spawning during delegation |
| `fulfill_delegate.py` | `PostToolUse` (Bash) | Detects delegated command completion |
| `block_task_tools.py` | `PreToolUse` | Redirects task tools to `bd` CLI |

## State machine

<img src="../assets/hooks-state.svg" width="600" alt="Hook State Machine">

Hooks coordinate through `~/.claude/hooks/.acontext_state/delegate_mode.json`:

| State | Meaning |
|-------|---------|
| **DIRECT** | Normal operation. Main session handles prompts directly. |
| **DELEGATE** | Task routed to Arbor. `block_agent_tool.py` enforces orchestrated routing. |
| **FULFILLED** | Delegated command finished. Resets to DIRECT. |

## auto_orchestrator.py

Runs on every `UserPromptSubmit`. Classifies prompts using keyword matching and structure analysis:

| Classification | Action |
|---------------|--------|
| DIRECT | Pass through — simple questions, explanations |
| DELEGATE | Route to `arbor` — focused tasks needing isolation |
| ORCHESTRATE | Route to `arbor-swarm` — complex tasks that decompose |

Conservative: ambiguous tasks default to DIRECT.

## block_agent_tool.py

During DELEGATE state, prevents the main session from spawning its own agents. Returns a message directing to `arbor` or `arbor-swarm`. Also enforces a bash command allowlist.

## fulfill_delegate.py

After a delegated command finishes, inspects Bash output for `arbor`/`arbor-swarm` completion. Transitions DELEGATE → FULFILLED → DIRECT. Fail-closed: errors leave state unchanged.

## block_task_tools.py

Redirects Claude Code's built-in task tools (TaskCreate, TaskUpdate, TodoWrite, etc.) to the `bd` CLI. Keeps task state in a single system.

## Installation

The installer handles setup:
1. Copies hooks to `~/.claude/hooks/`
2. Registers in `~/.claude/settings.json`
3. Creates state directory at `~/.claude/hooks/.acontext_state/`

```bash
# Verify hooks are registered
cat ~/.claude/settings.json | python3 -m json.tool | grep -A2 "auto_orchestrator"
```

## Disabling

```bash
# Temporary — force DIRECT mode
echo '{"mode":"DIRECT"}' > ~/.claude/hooks/.acontext_state/delegate_mode.json

# Permanent — remove hook files
rm ~/.claude/hooks/auto_orchestrator.py ~/.claude/hooks/block_agent_tool.py
rm ~/.claude/hooks/fulfill_delegate.py ~/.claude/hooks/block_task_tools.py
```

#!/usr/bin/env python3
"""PreToolUse hook: Block Claude's internal task tools → redirect to bd CLI.

Blocks: TaskCreate, TaskUpdate, TaskGet, TaskList, TodoWrite
Reason: All task management goes through `bd` (beads) for persistent,
dependency-aware tracking. Internal tasks are ephemeral and session-scoped.

bd provides: persistent storage (Dolt), cross-session state, dependency graphs,
ready-work detection, and integration with arbor/arbor-swarm.
"""

from __future__ import annotations

import json
import sys

BLOCKED_TOOLS = {"TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TodoWrite"}

BD_REDIRECT = {
    "TaskCreate": "bd create \"<title>\" --description \"<desc>\" --priority 1",
    "TaskUpdate": "bd update <id> --status in_progress  OR  bd close <id> --reason \"completed: <summary>\"",
    "TaskGet": "bd show <id> --json",
    "TaskList": "bd ready  OR  bd list --status open",
    "TodoWrite": "bd create \"<title>\" --description \"<desc>\"",
}


def main() -> None:
    try:
        event_json = sys.stdin.read().strip()
        if not event_json:
            return

        event = json.loads(event_json)
        tool_name = event.get("tool_name", "")

        if tool_name not in BLOCKED_TOOLS:
            return

        redirect = BD_REDIRECT.get(tool_name, "bd --help")

        result = {
            "decision": "block",
            "reason": (
                f"[Orchestrator] {tool_name} blocked — use bd CLI for task management.\n"
                f"bd provides persistent, cross-session task tracking with dependencies.\n"
                f"Use Bash tool to run: {redirect}\n"
                f"Key commands: bd create, bd ready, bd show, bd close, bd update"
            ),
        }
        print(json.dumps(result), flush=True)

    except Exception:
        pass  # Fail open


if __name__ == "__main__":
    main()

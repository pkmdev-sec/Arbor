#!/usr/bin/env python3
"""PreToolUse hook: Enforce remote-agent delegation by blocking fallback paths.

When orchestrator sets DELEGATE mode, Claude must use Bash with remote-agent/swarm.
But Claude has multiple fallback paths when Agent is blocked:
  1. Agent tool → BLOCKED (original)
  2. Read/Glob/Grep directly → ALSO BLOCKED (this fix)

This hook blocks ALL exploration/read tools during DELEGATE mode.
Once remote-agent/swarm runs via Bash (FULFILLED state), everything unblocks.

State lifecycle:
  DELEGATE  → Agent, Read, Glob, Grep BLOCKED. Only Bash allowed.
  FULFILLED → All tools allowed (remote-agent was invoked)
  DIRECT    → All tools allowed (non-delegated task)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

STATE_FILE = Path.home() / ".claude" / "hooks" / ".acontext_state" / "delegate_mode.json"

MAX_AGE_SEC = 300

# Tools to block during DELEGATE mode (forces Bash with remote-agent)
BLOCKED_DURING_DELEGATE = {"Agent", "Read", "Glob", "Grep"}

# Tools that are always allowed (never blocked)
ALWAYS_ALLOWED = {"Bash", "Write", "Edit", "WebSearch", "WebFetch", "AskUserQuestion",
                  "EnterPlanMode", "ExitPlanMode", "Skill", "NotebookEdit"}


LOG = Path.home() / ".claude" / "hooks" / ".acontext_state" / "blocker.log"

def _blog(msg: str) -> None:
    try:
        with LOG.open("a") as f:
            from datetime import datetime, timezone
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass

def main() -> None:
    try:
        event_json = sys.stdin.read().strip()
        if not event_json:
            _blog("NO INPUT")
            return

        event = json.loads(event_json)
        tool_name = event.get("tool_name", "")
        _blog(f"CALLED tool={tool_name}")

        # Never block when working on our own orchestrator config
        cwd = event.get("cwd", "")
        if "/.claude" in cwd and "/remote-agent" not in cwd:
            _blog(f"ALLOW tool={tool_name} (self-config: {cwd})")
            return

        # Only gate specific tools
        if tool_name not in BLOCKED_DURING_DELEGATE:
            _blog(f"SKIP tool={tool_name} (not in blocked set)")
            return

        # Read delegation state
        if not STATE_FILE.exists():
            return

        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        mode = state.get("mode", "DIRECT")

        # DIRECT or FULFILLED — allow everything
        if mode != "DELEGATE":
            _blog(f"ALLOW tool={tool_name} mode={mode}")
            return

        # Check staleness
        from datetime import datetime, timezone
        ts = state.get("timestamp", "")
        if ts:
            try:
                state_time = datetime.fromisoformat(ts)
                age = (datetime.now(timezone.utc) - state_time).total_seconds()
                if age > MAX_AGE_SEC:
                    return  # Stale — allow
            except (ValueError, TypeError):
                pass

        # BLOCK — redirect to Bash with remote-agent/swarm
        command = state.get("command", "remote-agent <task>")

        if tool_name == "Agent":
            reason = (
                f"[Orchestrator] Agent tool blocked — use remote-agent via Bash.\n"
                f"RUN: {command}"
            )
        else:
            reason = (
                f"[Orchestrator] {tool_name} blocked during delegation — use remote-agent instead.\n"
                f"Do NOT read files directly. Delegate to remote-agent which has its own fresh context.\n"
                f"RUN via Bash: {command}\n"
                f"Then read the result file for findings."
            )

        _blog(f"BLOCK tool={tool_name} task_type={state.get('task_type')}")
        result = {"decision": "block", "reason": reason}
        print(json.dumps(result), flush=True)

    except json.JSONDecodeError:
        pass
    except Exception:
        pass  # Fail open


if __name__ == "__main__":
    main()

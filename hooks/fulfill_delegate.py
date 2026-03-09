#!/usr/bin/env python3
"""PostToolUse hook: Transition DELEGATE → FULFILLED when remote-agent or swarm runs.

When Claude successfully invokes remote-agent or swarm via Bash, this hook
transitions the delegation state from DELEGATE to FULFILLED. This allows
subsequent Agent tool calls (e.g., for follow-up exploration) to proceed.

Watches for Bash commands containing 'remote-agent' or 'swarm'.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

STATE_FILE = Path.home() / ".claude" / "hooks" / ".acontext_state" / "delegate_mode.json"


def main() -> None:
    try:
        event_json = sys.stdin.read().strip()
        if not event_json:
            return

        event = json.loads(event_json)
        tool_name = event.get("tool_name", "")

        if tool_name != "Bash":
            return

        # Check if the Bash command invoked remote-agent or swarm
        tool_input = event.get("tool_input", {})
        command = tool_input.get("command", "")

        if "remote-agent" not in command and "swarm" not in command:
            return

        # Read current state
        if not STATE_FILE.exists():
            return

        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))

        if state.get("mode") != "DELEGATE":
            return

        # Transition: DELEGATE → FULFILLED
        import datetime as dt
        state["mode"] = "FULFILLED"
        state["fulfilled_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")

    except Exception:
        pass  # Fail silent — don't interfere with Bash execution


if __name__ == "__main__":
    main()

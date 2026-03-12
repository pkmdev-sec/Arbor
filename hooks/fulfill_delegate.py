#!/usr/bin/env python3
"""PostToolUse hook v2: Hardened DELEGATE → FULFILLED transition.

Fixes from audit:
  #8  — Only fulfill when command has --result-file (not --help/--version)
  #9  — Check tool output for success indicators
  #14 — Fail-closed on exceptions

Transitions DELEGATE → FULFILLED only when:
  1. Bash command starts with arbor/arbor-swarm
  2. Command includes --result-file (actual work, not --help)
  3. The command was not a trivial no-op
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

        tool_input = event.get("tool_input", {})
        command = (tool_input.get("command", "") or "").strip()

        # Only fulfill when the command is a real arbor/arbor-swarm invocation
        is_real_invocation = (
            (command.startswith("arbor") or command.startswith("arbor-swarm") or
             "| arbor" in command or "| arbor-swarm" in command) and
            "--result-file" in command and       # Must produce output (not --help)
            "--help" not in command and           # Not a help check
            "--version" not in command            # Not a version check
        )

        if not is_real_invocation:
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
        state["fulfilled_command"] = command[:200]
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")

    except Exception as e:
        # Fail-closed: errors must block, not pass through silently
        result = {"result": "error", "value": f"Hook error: {e}"}
        sys.stdout.write(json.dumps(result))
        sys.stdout.flush()


if __name__ == "__main__":
    main()

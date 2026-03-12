#!/usr/bin/env python3
"""PostToolUse Progress Reporter — sends tool events to IPC for TUI display.

Fires after every tool call. Writes structured events to the IPC JSONL log
so the TUI can show real-time tool-level progress per agent.

Only activated when ARBOR_PROGRESS_IPC_DIR is set (i.e., --tui mode).

Event format written to ipc.jsonl:
  {"ts": ..., "from": "agent-01", "to": "tui", "type": "tool_event",
   "content": "Edit src/foo.ts", "meta": {"tool": "Edit", "duration_ms": 123, ...}}
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def _write_ipc_event(ipc_dir: str, agent_id: str, tool_name: str, meta: dict) -> None:
    """Append a tool_event to the IPC JSONL log."""
    ipc_path = Path(ipc_dir) / "ipc.jsonl"
    event = {
        "ts": int(time.time() * 1000),
        "t": time.strftime("%H:%M:%S"),
        "from": agent_id,
        "to": "tui",
        "type": "tool_event",
        "content": f"{tool_name} {meta.get('target', '')}".strip(),
        "meta": meta,
    }
    try:
        with open(ipc_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except OSError:
        pass  # Non-fatal — TUI will miss this event


def _extract_target(tool_name: str, tool_input: dict) -> str:
    """Extract the primary target (file path, command, etc.) from tool input."""
    if tool_name in ("Read", "Write", "Edit"):
        return tool_input.get("file_path", "")
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        return cmd[:80] if len(cmd) > 80 else cmd
    if tool_name in ("Grep", "Glob"):
        return tool_input.get("pattern", tool_input.get("glob", ""))
    if tool_name == "Agent":
        return tool_input.get("description", "")
    return ""


def _extract_result_summary(tool_name: str, tool_result: dict | str) -> str:
    """Extract a brief summary from the tool result."""
    if isinstance(tool_result, str):
        return tool_result[:120] if len(tool_result) > 120 else tool_result
    if isinstance(tool_result, dict):
        # Common patterns
        if "error" in tool_result:
            return f"ERROR: {str(tool_result['error'])[:100]}"
        if "output" in tool_result:
            out = str(tool_result["output"])
            return out[:120] if len(out) > 120 else out
    return ""


def main() -> None:
    """Read PostToolUse event from stdin, write IPC event, output empty JSON."""
    try:
        ipc_dir = os.getenv("ARBOR_PROGRESS_IPC_DIR", "")
        agent_id = os.getenv("SWARM_AGENT_ID", os.getenv("ARBOR_AGENT_ID", "agent"))

        if not ipc_dir:
            # Not in TUI mode — no-op
            print("{}")
            return

        event_json = sys.stdin.read().strip()
        if not event_json:
            print("{}")
            return

        event = json.loads(event_json)
        tool_name = event.get("tool_name", "unknown")
        tool_input = event.get("tool_input", {})
        tool_result = event.get("tool_result", "")

        target = _extract_target(tool_name, tool_input)
        result_summary = _extract_result_summary(tool_name, tool_result)

        meta = {
            "tool": tool_name,
            "target": target,
            "result_preview": result_summary,
        }

        _write_ipc_event(ipc_dir, agent_id, tool_name, meta)

        # PostToolUse hooks return empty JSON (no blocking behavior)
        print("{}")

    except (json.JSONDecodeError, KeyError, TypeError):
        print("{}")
    except Exception:
        # Fail open — never block tool execution
        print("{}")


if __name__ == "__main__":
    main()

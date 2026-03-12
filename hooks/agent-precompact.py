#!/usr/bin/env python3
"""PreCompact State Preservation — saves agent state before context compaction.

When Claude Code compacts the conversation, this hook fires and writes a
state snapshot to ARBOR_PERSIST_DIR/state.json. The persisted CLAUDE.md
in that directory is automatically reloaded by Claude Code, so the agent
retains awareness of its progress after compaction.

State saved:
  - Modified files (from git diff)
  - Progress markers (completed/pending from the conversation)
  - Error history (last N errors encountered)
  - Current working state summary

Requires: ARBOR_PERSIST_DIR env var (set by agent-entry.mjs when --persist-context is active)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def _get_modified_files(cwd: str) -> list[str]:
    """Get list of files modified by the agent via git diff."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if result.returncode == 0:
            return [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Fallback: also check staged files
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "--cached"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if result.returncode == 0:
            return [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return []


def _get_diff_stats(cwd: str) -> dict:
    """Get diff stat summary (insertions/deletions)."""
    try:
        result = subprocess.run(
            ["git", "diff", "--stat", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().split("\n")
            # Last line is summary like "3 files changed, 45 insertions(+), 12 deletions(-)"
            return {"summary": lines[-1].strip() if lines else ""}
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return {}


def _update_claude_md(persist_dir: str, state: dict) -> None:
    """Append a compaction state section to CLAUDE.md so it survives compaction."""
    claude_md_path = Path(persist_dir) / "CLAUDE.md"
    state_section = "\n\n## Agent State (preserved across compaction)\n"
    state_section += f"- Last compaction: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"

    if state.get("modified_files"):
        state_section += f"- Modified files: {', '.join(state['modified_files'][:20])}\n"

    if state.get("diff_stats", {}).get("summary"):
        state_section += f"- Changes: {state['diff_stats']['summary']}\n"

    if state.get("scope"):
        state_section += f"- Assigned scope: {state['scope']}\n"

    if state.get("role"):
        state_section += f"- Role: {state['role']}\n"

    state_section += "\nIMPORTANT: You have been through context compaction. "
    state_section += "Review the modified files listed above to recall your progress. "
    state_section += "Do NOT re-read files you have already read unless necessary.\n"

    try:
        existing = ""
        if claude_md_path.exists():
            existing = claude_md_path.read_text(encoding="utf-8")
            # Remove any previous state section to avoid accumulation
            marker = "## Agent State (preserved across compaction)"
            if marker in existing:
                existing = existing[:existing.index(marker)].rstrip()

        claude_md_path.write_text(
            existing + state_section, encoding="utf-8",
        )
    except OSError:
        pass  # Non-fatal


def main() -> None:
    """Read PreCompact event, save state, output empty JSON."""
    try:
        persist_dir = os.getenv("ARBOR_PERSIST_DIR", "")
        if not persist_dir:
            # No persist dir = no state to save
            print("{}")
            return

        event_json = sys.stdin.read().strip()
        if not event_json:
            print("{}")
            return

        event = json.loads(event_json)
        cwd = event.get("cwd", os.getcwd())

        # Build state snapshot
        state = {
            "timestamp": time.time(),
            "agent_id": os.getenv("SWARM_AGENT_ID", os.getenv("ARBOR_AGENT_ID", "agent")),
            "role": os.getenv("ARBOR_ROLE", ""),
            "scope": os.getenv("ARBOR_SCOPE", ""),
            "modified_files": _get_modified_files(cwd),
            "diff_stats": _get_diff_stats(cwd),
        }

        # Write state.json for programmatic access
        state_path = Path(persist_dir) / "state.json"
        try:
            state_path.write_text(
                json.dumps(state, indent=2), encoding="utf-8",
            )
        except OSError:
            pass  # Non-fatal

        # Update CLAUDE.md with human-readable state
        _update_claude_md(persist_dir, state)

        # PreCompact hooks return empty JSON
        print("{}")

    except (json.JSONDecodeError, KeyError, TypeError):
        print("{}")
    except Exception:
        # Fail open
        print("{}")


if __name__ == "__main__":
    main()

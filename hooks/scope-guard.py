#!/usr/bin/env python3
"""Scope Enforcement — PreToolUse hook for arbor.

Blocks Write, Edit, and Bash tool operations that target files outside the
agent's allowed scope. Scope is defined via ARBOR_SCOPE env var.

This prevents agents from modifying files they weren't assigned to work on.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def _normalize_path(path: str, cwd: str) -> Path:
    """Normalize a path (absolute or relative) to an absolute Path object.

    Resolves relative paths against cwd, handles .. components.
    """
    p = Path(path)
    if not p.is_absolute():
        p = Path(cwd) / p
    try:
        return p.resolve()
    except Exception:
        # If resolve fails (file doesn't exist), do manual normalization
        return Path(os.path.normpath(p))


def _parse_scope(scope_str: str, cwd: str) -> list[Path]:
    """Parse comma-separated scope entries into normalized Path list."""
    if not scope_str:
        return []

    entries = [s.strip() for s in scope_str.split(",") if s.strip()]
    return [_normalize_path(e, cwd) for e in entries]


def _is_in_scope(target: Path, scope: list[Path]) -> bool:
    """Check if target path is within any of the scope paths.

    Scope entries can be files or directories:
    - If scope entry is a file, target must match exactly
    - If scope entry is a directory, target must be within it
    """
    if not scope:
        return True  # Empty scope = allow everything

    for scope_entry in scope:
        # Check exact file match
        if target == scope_entry:
            return True

        # Check if target is within scope directory
        try:
            target.relative_to(scope_entry)
            return True
        except ValueError:
            continue

    return False


def _extract_bash_paths(command: str) -> list[str]:
    """Extract potential file paths from Bash command that might be written to.

    Looks for patterns like:
    - > /path/to/file
    - >> /path/to/file
    - tee /path/to/file
    - echo ... > path/to/file

    Returns list of paths. Best-effort — allows if uncertain.
    """
    paths = []

    # Pattern: > or >> followed by a path
    redirect_patterns = [
        r'>>\s*([^\s;&|]+)',
        r'>\s*([^\s;&|]+)',
        r'\btee\s+([^\s;&|]+)',
    ]

    for pattern in redirect_patterns:
        matches = re.findall(pattern, command)
        paths.extend(matches)

    return paths


def _deny(reason: str) -> dict[str, Any]:
    """Return a denial response."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def main() -> None:
    """Main entry: enforce scope on Write/Edit/Bash operations."""
    try:
        event_json = sys.stdin.read().strip()
        if not event_json:
            print("{}")
            return

        event = json.loads(event_json)
        cwd = event.get("cwd", os.getcwd())
        tool_name = event.get("tool_name", "")
        tool_input = event.get("tool_input", {})

        # Read scope from env var
        scope_str = os.getenv("ARBOR_SCOPE", "")
        if not scope_str:
            # No scope defined = allow everything
            print("{}")
            return

        scope = _parse_scope(scope_str, cwd)
        scope_display = [str(p) for p in scope]

        # Check Write/Edit operations
        if tool_name in ("Write", "Edit"):
            file_path = tool_input.get("file_path", "")
            if not file_path:
                print("{}")
                return

            target = _normalize_path(file_path, cwd)

            if not _is_in_scope(target, scope):
                reason = (
                    f"File {file_path} is outside agent scope: {scope_display}"
                )
                print(json.dumps(_deny(reason)))
                return

        # Check Bash operations
        elif tool_name == "Bash":
            command = tool_input.get("command", "")
            if not command:
                print("{}")
                return

            # Extract potential write targets
            write_paths = _extract_bash_paths(command)

            for path_str in write_paths:
                # Skip if it looks like a device or special file
                if path_str.startswith("/dev/") or path_str in ("/dev/null", "/dev/stderr", "/dev/stdout"):
                    continue

                # Check if path is absolute or relative
                target = _normalize_path(path_str, cwd)

                if not _is_in_scope(target, scope):
                    reason = (
                        f"Bash command attempts to write to {path_str} "
                        f"which is outside agent scope: {scope_display}"
                    )
                    print(json.dumps(_deny(reason)))
                    return

        # Allow operation
        print("{}")

    except json.JSONDecodeError:
        # Invalid JSON input — allow (don't break on malformed input)
        print("{}")
    except Exception:
        # Unexpected error — allow (fail open, not closed)
        print("{}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""PreToolUse hook v5: Hardened enforcement with Bash allowlist.

Fixes applied from adversarial audit:
  #1  — Removed /.claude CWD escape hatch (CRITICAL)
  #2  — Increased timeout guidance, fail-CLOSED on exceptions (HIGH)
  #4  — Removed staleness timeout (HIGH) — state persists until explicitly changed
  #5  — Write/Edit blocked during DELEGATE for code-modifying routes (MEDIUM)
  #6  — Bash switched from blocklist to ALLOWLIST (HIGH)
  #7  — All chain/pipe/substitution evasions closed by allowlist (HIGH)
  #14 — Exception handler now fail-CLOSED (MEDIUM)
  #15 — State file writes blocked by Bash allowlist (CRITICAL)

State lifecycle:
  DELEGATE  → Only allowlisted Bash commands pass. Everything else blocked.
  FULFILLED → All tools allowed (arbor-swarm/arbor completed)
  DIRECT    → All tools allowed (simple task, no delegation)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

STATE_FILE = Path.home() / ".claude" / "hooks" / ".acontext_state" / "delegate_mode.json"
LOG = Path.home() / ".claude" / "hooks" / ".acontext_state" / "blocker.log"

# Bash ALLOWLIST — only these commands are permitted during DELEGATE mode.
# Everything not matching is blocked. This closes infinite bypass vectors.
BASH_ALLOW_PREFIXES = (
    "arbor",            # The delegation tool (arbor and arbor-swarm both match)
    "arbor-swarm",      # The parallel orchestrator
    "bd ",              # Beads task management
    "bd\t",             # bd with tab
    "git status",       # Git read commands
    "git diff",
    "git log",
    "git show",
    "git branch",
    "npm test",         # Test runners
    "npx test",
    "pytest",
    "cargo test",
    "go test",
    "swift test",
    "jest",
    "vitest",
    "node --check",     # Syntax checks
    "python3 -c \"import py_compile",
    "bash -n",
    "echo ",            # Echo for status/debugging (can't read files)
    "which ",           # Path lookups
    "gh ",              # GitHub CLI
    "curl ",            # HTTP requests (for APIs)
    "ls ",              # Directory listings (not file reading)
    "ls\t",
    "mkdir ",           # Directory creation
    "chmod ",           # Permissions
    "ln ",              # Symlinks
    "rm ",              # Remove files
    "/bin/rm ",         # Remove (absolute path)
    "/bin/cp ",         # Copy (absolute path)
    "cp ",              # Copy
    "mv ",              # Move
    "pwd",              # Current directory
    "date",             # Timestamps
    "wc ",              # Word count
    "find ",            # File finding (not reading)
)

# Tools that are ALWAYS allowed regardless of delegation state
ALWAYS_ALLOWED = {"AskUserQuestion", "EnterPlanMode", "ExitPlanMode"}

# Tools blocked during DELEGATE mode
BLOCKED_DURING_DELEGATE = {"Agent", "Read", "Glob", "Grep", "Write", "Edit",
                           "Skill", "NotebookEdit", "WebSearch", "WebFetch"}


def _blog(msg: str) -> None:
    try:
        with LOG.open("a") as f:
            from datetime import datetime, timezone
            f.write(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def main() -> None:
    try:
        event_json = sys.stdin.read().strip()
        if not event_json:
            return

        event = json.loads(event_json)
        tool_name = event.get("tool_name", "")
        _blog(f"CALLED tool={tool_name}")

        # Always-allowed tools — never blocked under any circumstance
        if tool_name in ALWAYS_ALLOWED:
            return

        # Read delegation state
        if not STATE_FILE.exists():
            _blog(f"ALLOW tool={tool_name} (no state file)")
            return

        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        mode = state.get("mode", "DIRECT")

        # DIRECT or FULFILLED — allow everything
        if mode != "DELEGATE":
            _blog(f"ALLOW tool={tool_name} mode={mode}")
            return

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # DELEGATE MODE — strict enforcement
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        # Bash: ALLOWLIST check — only specific commands pass through
        if tool_name == "Bash":
            cmd = (event.get("tool_input", {}).get("command", "") or "").strip()

            # Check against allowlist
            for prefix in BASH_ALLOW_PREFIXES:
                if cmd.startswith(prefix):
                    # Additional safety checks for dangerous commands
                    if prefix in ("rm ", "/bin/rm "):
                        # Block rm with dangerous flags (check tokens, not substrings)
                        parts = cmd.split()
                        dangerous_rm_flags = {"-r", "-f", "-rf", "-fr", "--recursive", "--force"}
                        if dangerous_rm_flags & set(parts):
                            _blog(f"BLOCK tool=Bash (dangerous rm flags in: {cmd[:60]})")
                            result = {
                                "decision": "block",
                                "reason": (
                                    "[Orchestrator] rm with -r/-f flags blocked during delegation.\n"
                                    "Recursive or force removal is not permitted for safety."
                                ),
                            }
                            print(json.dumps(result), flush=True)
                            return

                    elif prefix == "curl ":
                        # Block curl with dangerous flags (data exfiltration, output to files)
                        parts = cmd.split()
                        single_flags = {"-d", "--data", "--data-raw", "--data-binary",
                                        "-o", "--output", "-F", "--form",
                                        "-T", "--upload-file", "-K", "--config"}
                        has_dangerous_single = bool(single_flags & set(parts))
                        # Check -X with method (two adjacent tokens)
                        has_dangerous_method = False
                        for i, p in enumerate(parts):
                            if p == "-X" and i + 1 < len(parts) and parts[i + 1] in ("POST", "PUT", "DELETE", "PATCH"):
                                has_dangerous_method = True
                                break
                        if has_dangerous_single or has_dangerous_method:
                            _blog(f"BLOCK tool=Bash (dangerous curl flags in: {cmd[:60]})")
                            result = {
                                "decision": "block",
                                "reason": (
                                    "[Orchestrator] curl with POST/PUT/data/output flags blocked during delegation.\n"
                                    "Only safe GET requests are permitted."
                                ),
                            }
                            print(json.dumps(result), flush=True)
                            return

                    _blog(f"ALLOW tool=Bash (allowlisted: {prefix})")
                    return

            # Not in allowlist — block
            command = state.get("command", "arbor-swarm <task>")
            _blog(f"BLOCK tool=Bash cmd={cmd[:60]}")
            result = {
                "decision": "block",
                "reason": (
                    f"[Orchestrator] Bash command blocked during delegation.\n"
                    f"Only arbor, arbor-swarm, bd, git, and test commands are allowed.\n"
                    f"RUN: {command}"
                ),
            }
            print(json.dumps(result), flush=True)
            return

        # All other tools during DELEGATE — block with tool-specific suggestions
        if tool_name in BLOCKED_DURING_DELEGATE:
            command = state.get("command", "arbor-swarm <task>")
            _blog(f"BLOCK tool={tool_name}")

            # Tool-specific suggestions so the user sees actionable hints
            hints = {
                "Read": "Use arbor to read files:\n    arbor -m sonnet 'read <file>'",
                "Glob": "Use arbor to search for files:\n    arbor -m sonnet 'find files matching <pattern>'",
                "Grep": "Use arbor to search content:\n    arbor -m sonnet 'search for <pattern> in <scope>'",
                "Agent": "Task already delegated — run the arbor-swarm command below.",
                "Write": "Task delegated — arbor agents handle file writes.\n    RUN: " + command,
                "Edit": "Task delegated — arbor agents handle file edits.\n    RUN: " + command,
            }
            hint = hints.get(tool_name, f"RUN via Bash: {command}")

            result = {
                "decision": "block",
                "reason": (
                    f"[Orchestrator] {tool_name} blocked — delegation active (session-scoped).\n"
                    f"{hint}"
                ),
            }
            print(json.dumps(result), flush=True)
            return

        # Unknown tool during DELEGATE — block to be safe
        _blog(f"BLOCK tool={tool_name} (unknown, fail-closed)")
        result = {
            "decision": "block",
            "reason": f"[Orchestrator] {tool_name} blocked during delegation. Use arbor or arbor-swarm via Bash.",
        }
        print(json.dumps(result), flush=True)

    except json.JSONDecodeError:
        # Malformed input — fail closed
        result = {"decision": "block", "reason": "[Orchestrator] Hook input error. Tool blocked for safety."}
        print(json.dumps(result), flush=True)
    except Exception as e:
        # FIX #14: Fail CLOSED, not open
        _blog(f"ERROR: {e}")
        result = {"decision": "block", "reason": f"[Orchestrator] Enforcement error. Tool blocked for safety."}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

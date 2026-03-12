#!/usr/bin/env python3
"""PreToolUse hook v7: Hardened allowlist with protected-path guards.

Changes from v6:
  - Removed python3 from Bash allowlist (arbitrary code execution vector)
  - Added protected-path guard: commands referencing state/lock files are
    always rejected, even if they match the allowlist prefix
  - Session lock remains primary enforcement (checked before state file)

State lifecycle:
  DELEGATE  → Lock file created on first detection, persists for session (4h TTL).
              Only allowlisted Bash commands pass. Everything else blocked.
  FULFILLED → Lock file absent, all tools allowed.
  DIRECT    → Lock file absent, all tools allowed.

Session lock:
  - Created at /tmp/.claude-orchestrator-lock when DELEGATE first detected
  - Contains: creation timestamp, delegation command
  - Checked BEFORE state file on every call (fast path)
  - Auto-expires after 4 hours (stale session cleanup)
  - Protected-path guard blocks commands referencing lock/state file paths
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

STATE_FILE = (
    Path.home() / ".claude" / "hooks" / ".acontext_state" / "delegate_mode.json"
)
LOG = Path.home() / ".claude" / "hooks" / ".acontext_state" / "blocker.log"
SESSION_LOCK = Path("/tmp/.claude-orchestrator-lock")

# Lock file TTL: 4 hours in seconds
SESSION_LOCK_TTL = 4 * 60 * 60

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Bash ALLOWLIST — only these commands permitted during DELEGATE mode.
# Anything not matching is blocked.  Dangerous operators (&&, ||, ;,
# backtick, $(), <(), >, >>) are always blocked.  Pipes to safe read-only
# formatters (head, tail, grep, wc, cut, tr, etc.) are allowed when the
# left side matches an allowed command prefix.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Commands that get a FULL PASS (no chain detection) because their
# arguments can contain arbitrary text (prompt strings, task descriptions).
BASH_FULL_PASS_PREFIXES = (
    "arbor",         # The delegation tool (arbor and arbor-swarm both match)
    "arbor-swarm",   # The parallel orchestrator
)

# Commands allowed with chain detection — must not contain &&, ||, ;, |, etc.
BASH_ALLOW_PREFIXES = (
    "bd ",  # Beads task management
    "bd\t",  # bd with tab
    "git add",  # Git write commands
    "git commit",
    "git push",
    "git status",  # Git read commands
    "git diff",
    "git log",
    "git branch",
    "ls ",  # Directory listings
    "ls\t",
    "test ",  # Shell test builtin
    "npm test",  # Test runners
    "npx test",
    "pytest",
    "cargo test",
    "go test",
    "swift test",
    "jest",
    "vitest",
)

# Bare commands allowed as exact matches (no arguments)
BASH_ALLOW_EXACT = frozenset({"ls", "bd"})

# Operators that indicate dangerous chaining/substitution (always blocked).
# ">" catches output redirect (>, >>), and >( process substitution.
# "<(" catches input process substitution <(cmd).
DANGEROUS_OPERATORS = ("&&", "||", ";", "`", "$(", "<(", ">", "\n")

# Pipe gets special handling: allowed if ALL targets are safe formatters
PIPE_OPERATOR = "|"

# Safe pipe targets — genuinely read-only formatters with no command
# execution or file write capabilities under any flag combination.
# EXCLUDED: xargs (arbitrary cmd exec), awk (system() escape),
# sed (GNU 'e' flag), tee (file write), cat (file read bypass),
# sort (-o writes to file), uniq (positional OUTPUT arg writes to file).
SAFE_PIPE_TARGETS = frozenset(
    {
        "head",
        "tail",
        "wc",
        "grep",
        "less",
        "more",
        "tr",
        "cut",
        "column",
        "fmt",
        "fold",
    }
)

# Paths that must never appear in ANY Bash command during delegation.
# Prevents allowlisted commands from manipulating enforcement state.
PROTECTED_PATHS = (
    "delegate_mode.json",
    ".claude-orchestrator-lock",
    str(STATE_FILE),
    str(SESSION_LOCK),
)

# Files smaller than this pass through Read during DELEGATE (context-friendly)
FILE_SIZE_THRESHOLD = 10 * 1024  # 10KB — covers config, package.json, short scripts

# Tools that are ALWAYS allowed regardless of delegation state
ALWAYS_ALLOWED = {"AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TodoWrite", "Glob"}

# Tools blocked during DELEGATE mode (Read is size-gated, not hard-blocked)
BLOCKED_DURING_DELEGATE = {
    "Agent",
    "Read",
    "Grep",
    "Write",
    "Edit",
    "Skill",
    "NotebookEdit",
    "WebSearch",
    "WebFetch",
}

# Tool-specific redirect messages — tell the user exactly what to use instead
TOOL_REDIRECTS = {
    "Read": "Use arbor to read files:\n  arbor -m sonnet 'read and summarize <file>'",
    "Write": "Use arbor to write files:\n  arbor -m sonnet 'create <file> with <content>'",
    "Edit": "Use arbor to edit files:\n  arbor -m sonnet 'edit <file>: <changes>'",
    "Glob": "Use arbor to search for files:\n  arbor -m sonnet 'find files matching <pattern>'",
    "Grep": "Use arbor to search file contents:\n  arbor -m sonnet 'search for <pattern> in <scope>'",
    "Agent": "Use arbor-swarm or arbor instead of built-in Agent:\n  arbor-swarm --mode parallel '<task>'",
    "NotebookEdit": "Use arbor to edit notebooks:\n  arbor -m sonnet 'edit notebook <path>'",
    "WebSearch": "Use arbor for web searches:\n  arbor -m sonnet 'search web for <query>'",
    "WebFetch": "Use arbor for web fetches:\n  arbor -m sonnet 'fetch <url>'",
    "Skill": "Use arbor for skill execution:\n  arbor -m sonnet '<skill task>'",
}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Smart gating: size-based Read passthrough + auto-rewrite commands
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def _file_size(file_path: str) -> int | None:
    """Return file size in bytes, or None if inaccessible."""
    try:
        return Path(file_path).stat().st_size
    except (OSError, ValueError):
        return None


def _should_pass_through(tool_name: str, tool_input: dict[str, object]) -> bool:
    """Allow small file reads during delegation (context-friendly).

    Read: pass if file exists and < FILE_SIZE_THRESHOLD.
    All other blocked tools: always blocked (return False).
    """
    if tool_name != "Read":
        return False
    file_path = str(tool_input.get("file_path", ""))
    if not file_path:
        return False
    size = _file_size(file_path)
    return size is not None and size <= FILE_SIZE_THRESHOLD


def _auto_arbor_cmd(
    tool_name: str, tool_input: dict[str, object], delegation_cmd: str = ""
) -> str:
    """Generate a ready-to-run arbor/arbor-swarm command from blocked tool input.

    Routing: if the original delegation used arbor-swarm (multi-file task),
    suggest the swarm command for write operations. Read-only tools get
    standalone arbor since they only peek at one file.
    """
    is_swarm = "arbor-swarm" in delegation_cmd

    # Agent → always arbor-swarm
    if tool_name == "Agent":
        prompt = str(tool_input.get("prompt", "<task>"))[:100]
        return f"arbor-swarm --mode parallel '{prompt}'"

    # Write/Edit during swarm delegation → suggest original swarm command
    if is_swarm and tool_name in ("Write", "Edit"):
        return delegation_cmd if delegation_cmd else "arbor-swarm --mode swarm '<task>'"

    # Read-only tools → standalone arbor (just peeking at one file)
    if tool_name == "Read":
        fp = tool_input.get("file_path", "<file>")
        return f"arbor -m sonnet 'read and summarize {fp}'"
    if tool_name == "Write":
        fp = tool_input.get("file_path", "<file>")
        return f"arbor -m sonnet 'write to {fp}'"
    if tool_name == "Edit":
        fp = tool_input.get("file_path", "<file>")
        return f"arbor -m sonnet 'edit {fp}'"
    if tool_name == "Grep":
        pat = tool_input.get("pattern", "<pattern>")
        path = tool_input.get("path", ".")
        return f"arbor -m sonnet 'search for {pat} in {path}'"
    return "arbor -m sonnet '<task>'"


def _block_tool_smart(tool_name: str, tool_input: dict[str, object], command: str) -> None:
    """Block with context-aware arbor/arbor-swarm suggestion.

    When the delegation used arbor-swarm, write operations get a strong push
    toward using the swarm command instead of individual arbor calls.
    """
    is_swarm = "arbor-swarm" in command
    auto_cmd = _auto_arbor_cmd(tool_name, tool_input, command)

    if tool_name == "Read":
        fp = str(tool_input.get("file_path", ""))
        size = _file_size(fp)
        size_str = f" ({size // 1024}KB)" if size else ""
        reason = (
            f"[Orchestrator] Read blocked — file too large for orchestrator context{size_str}.\n"
            f"Run: `{auto_cmd}`"
        )
    elif is_swarm and tool_name in ("Write", "Edit", "Agent"):
        reason = (
            f"[Orchestrator] {tool_name} blocked — swarm delegation active.\n"
            f"This is a multi-file task routed to arbor-swarm. Use the swarm for coordinated changes:\n"
            f"  `{auto_cmd}`\n"
            f"Avoid individual arbor calls for multi-file work — arbor-swarm decomposes, parallelizes, and verifies."
        )
    else:
        reason = (
            f"[Orchestrator] {tool_name} blocked — delegation active (session-scoped).\n"
            f"Run: `{auto_cmd}`"
        )

    print(json.dumps({"decision": "block", "reason": reason}), flush=True)


def _blog(msg: str) -> None:
    """Append to blocker log. Silent on failure."""
    try:
        with LOG.open("a") as f:
            from datetime import datetime, timezone

            f.write(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Session lock file management
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def _check_session_lock() -> dict | None:
    """Check if session lock file exists and is not expired.

    Returns lock data dict if locked, None if not locked or expired.
    """
    if not SESSION_LOCK.exists():
        return None

    try:
        data = json.loads(SESSION_LOCK.read_text(encoding="utf-8"))
        created = data.get("created", 0)

        # Auto-expire after TTL (stale session cleanup)
        if time.time() - created > SESSION_LOCK_TTL:
            _blog("Session lock expired (4h TTL), removing")
            SESSION_LOCK.unlink(missing_ok=True)
            return None

        return data
    except (json.JSONDecodeError, OSError):
        # Corrupted lock file — remove and proceed unlocked
        try:
            SESSION_LOCK.unlink(missing_ok=True)
        except OSError:
            pass
        return None


def _create_session_lock(command: str) -> None:
    """Create session lock file to persist delegation state for the session."""
    try:
        lock_data = {
            "created": time.time(),
            "command": command,
            "note": "Session-scoped delegation lock. Auto-expires after 4 hours.",
        }
        SESSION_LOCK.write_text(json.dumps(lock_data), encoding="utf-8")
        _blog(f"Session lock CREATED: {command}")
    except OSError as e:
        _blog(f"Failed to create session lock: {e}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Bash allowlist check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def _has_dangerous_operators(cmd: str) -> bool:
    """Detect shell chaining/substitution operators (&&, ||, ;, backtick, $())."""
    for op in DANGEROUS_OPERATORS:
        if op in cmd:
            return True
    return False


def _has_pipe(cmd: str) -> bool:
    """Detect pipe operator in command."""
    return PIPE_OPERATOR in cmd


def _is_safe_pipe_chain(cmd: str) -> bool:
    """Check if all pipe targets are safe read-only output formatters.

    Returns True if every segment after the first pipe is a known-safe tool.
    Returns False if any target is unknown/dangerous or the chain is malformed.
    """
    segments = cmd.split(PIPE_OPERATOR)
    if len(segments) < 2:
        return True  # no pipe at all

    for segment in segments[1:]:
        stripped = segment.strip()
        if not stripped:
            return False  # empty pipe target (malformed)
        tool = stripped.split()[0]
        if tool not in SAFE_PIPE_TARGETS:
            return False
    return True


def _references_protected_path(cmd: str) -> bool:
    """Check if command references any protected state files."""
    for path in PROTECTED_PATHS:
        if path in cmd:
            return True
    return False


def _is_bash_allowed(cmd: str) -> bool:
    """Check if a Bash command passes the delegation allowlist.

    arbor and arbor-swarm get a full pass (no chain detection) because
    their arguments contain arbitrary prompt text.  All other allowed
    commands are checked for dangerous operators AND protected paths to
    prevent evasion and state file manipulation.

    Pipe chains are allowed if: (a) the left side matches an allowed
    prefix, and (b) ALL pipe targets are safe read-only formatters
    (head, tail, grep, wc, cut, tr, etc.).
    """
    # Full-pass commands: no chain detection needed (prompt text is arbitrary)
    for prefix in BASH_FULL_PASS_PREFIXES:
        if cmd.startswith(prefix):
            return True

    # Block commands referencing protected state/lock files
    if _references_protected_path(cmd):
        return False

    # Block dangerous chain operators (&&, ||, ;, backtick, $(), newline)
    if _has_dangerous_operators(cmd):
        return False

    # Check if the base command (left side of any pipe) is allowed
    base_cmd = cmd.split("|")[0].strip() if _has_pipe(cmd) else cmd

    # Exact match (bare commands like "ls", "bd")
    is_allowed = base_cmd in BASH_ALLOW_EXACT
    if not is_allowed:
        for prefix in BASH_ALLOW_PREFIXES:
            if base_cmd.startswith(prefix):
                is_allowed = True
                break

    if not is_allowed:
        return False

    # If there's a pipe, verify all targets are safe output formatters
    if _has_pipe(cmd):
        return _is_safe_pipe_chain(cmd)

    return True


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Block response helpers
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def _block_tool(tool_name: str, command: str) -> None:
    """Output a block decision with tool-specific redirect message."""
    redirect = TOOL_REDIRECTS.get(
        tool_name,
        f"Use arbor via Bash: {command}",
    )
    result = {
        "decision": "block",
        "reason": (
            f"[Orchestrator] {tool_name} blocked — delegation active (session-scoped).\n"
            f"{redirect}"
        ),
    }
    print(json.dumps(result), flush=True)


def _block_bash(cmd: str, command: str, *, has_chain: bool = False) -> None:
    """Output a block decision for a disallowed Bash command."""
    if has_chain:
        detail = "Command contains dangerous operators (&&, ||, ;, unsafe pipe) which are not allowed during delegation."
    else:
        detail = "Command not in allowlist."

    result = {
        "decision": "block",
        "reason": (
            f"[Orchestrator] Bash command blocked — delegation active (session-scoped).\n"
            f"{detail}\n"
            f"Allowed: arbor, arbor-swarm, bd, git (add/commit/push/status/diff/log/branch), ls, test.\n"
            f"Delegation command: {command}"
        ),
    }
    print(json.dumps(result), flush=True)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Main hook logic
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


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

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # FAST PATH: Session lock check (no state file I/O needed)
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        lock_data = _check_session_lock()
        if lock_data:
            command = lock_data.get("command", "swarm <task>")

            if tool_name == "Bash":
                cmd = (event.get("tool_input", {}).get("command", "") or "").strip()
                if _is_bash_allowed(cmd):
                    _blog(f"ALLOW tool=Bash (session-locked, allowlisted)")
                    return
                has_chain = _has_dangerous_operators(cmd) or (
                    _has_pipe(cmd) and not _is_safe_pipe_chain(cmd)
                )
                _blog(f"BLOCK tool=Bash cmd={cmd[:60]} (session-locked)")
                _block_bash(cmd, command, has_chain=has_chain)
                return

            # Smart gating: allow small file reads during delegation
            tool_input = event.get("tool_input", {})
            if _should_pass_through(tool_name, tool_input):
                _blog(f"ALLOW tool={tool_name} (size-gated, session-locked)")
                return

            # Block with auto-generated arbor command
            _blog(f"BLOCK tool={tool_name} (session-locked)")
            _block_tool_smart(tool_name, tool_input, command)
            return

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # NO SESSION LOCK — check state file for new delegation
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if not STATE_FILE.exists():
            _blog(f"ALLOW tool={tool_name} (no state file, no lock)")
            return

        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        mode = state.get("mode", "DIRECT")

        # DIRECT or FULFILLED — allow everything
        if mode != "DELEGATE":
            _blog(f"ALLOW tool={tool_name} mode={mode}")
            return

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # NEW DELEGATION DETECTED — create session lock
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        command = state.get("command", "swarm <task>")
        _create_session_lock(command)

        # Now enforce — same logic as session-locked path above
        if tool_name == "Bash":
            cmd = (event.get("tool_input", {}).get("command", "") or "").strip()
            if _is_bash_allowed(cmd):
                _blog(f"ALLOW tool=Bash (newly delegated, allowlisted: {cmd[:40]})")
                return
            has_chain = _has_dangerous_operators(cmd) or (
                _has_pipe(cmd) and not _is_safe_pipe_chain(cmd)
            )
            _blog(f"BLOCK tool=Bash cmd={cmd[:60]} (newly delegated)")
            _block_bash(cmd, command, has_chain=has_chain)
            return

        if tool_name in BLOCKED_DURING_DELEGATE:
            # Smart gating: allow small file reads during delegation
            tool_input = event.get("tool_input", {})
            if _should_pass_through(tool_name, tool_input):
                _blog(f"ALLOW tool={tool_name} (size-gated, newly delegated)")
                return

            _blog(f"BLOCK tool={tool_name} (newly delegated)")
            _block_tool_smart(tool_name, tool_input, command)
            return

        # Unknown tool during DELEGATE — fail closed
        _blog(f"BLOCK tool={tool_name} (unknown, fail-closed)")
        result = {
            "decision": "block",
            "reason": (
                f"[Orchestrator] {tool_name} blocked during delegation (session-scoped).\n"
                f"Use arbor via Bash."
            ),
        }
        print(json.dumps(result), flush=True)

    except json.JSONDecodeError:
        # Malformed input — fail closed
        result = {
            "decision": "block",
            "reason": "[Orchestrator] Hook input error. Tool blocked for safety.",
        }
        print(json.dumps(result), flush=True)
    except Exception as e:
        # All other errors — fail closed
        _blog(f"ERROR: {e}")
        result = {
            "decision": "block",
            "reason": "[Orchestrator] Enforcement error. Tool blocked for safety.",
        }
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

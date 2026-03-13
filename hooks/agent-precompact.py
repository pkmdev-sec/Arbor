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
  - Key decisions made during the conversation
  - File summaries from the context
  - API design notes
  - Current task state

Requires: ARBOR_PERSIST_DIR env var (set by agent-entry.mjs when --persist-context is active)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


def _extract_decisions(text: str) -> list[str]:
    """Extract key decisions from conversation text.

    Scans for patterns like 'decision:', 'decided:', 'chose:', 'approach:', 'strategy:'.
    Returns up to 20 unique decisions.
    """
    if not text:
        return []

    decisions = []
    seen = set()

    # Pattern matches lines containing decision keywords (case-insensitive)
    decision_pattern = re.compile(
        r'^\s*[-•*]?\s*(?:decision|decided|chose|approach|strategy)\s*:\s*(.+)$',
        re.IGNORECASE | re.MULTILINE
    )

    for match in decision_pattern.finditer(text):
        decision = match.group(1).strip()
        # Deduplicate
        if decision and decision not in seen:
            decisions.append(decision)
            seen.add(decision)
            if len(decisions) >= 20:
                break

    return decisions


def _extract_file_summaries(text: str) -> dict[str, str]:
    """Extract file summaries from conversation text.

    Matches patterns like:
      - path/to/file.ext: description
      - path/to/file.ext — description

    Returns up to 30 filepath -> description mappings.
    """
    if not text:
        return {}

    summaries = {}

    # Pattern: filepath (containing / or .) followed by : or — and description
    file_pattern = re.compile(
        r'^\s*[-•*]?\s*([a-zA-Z0-9_\-./]+[/.][a-zA-Z0-9_\-./]*)\s*[:\u2014]\s*(.+)$',
        re.MULTILINE
    )

    for match in file_pattern.finditer(text):
        filepath = match.group(1).strip()
        description = match.group(2).strip()

        # Validate filepath (must have at least one / or .)
        if ('/' in filepath or '.' in filepath) and description:
            summaries[filepath] = description
            if len(summaries) >= 30:
                break

    return summaries


def _extract_api_design(text: str) -> list[str]:
    """Extract API design notes from conversation text.

    Finds sections starting with 'API:', 'interface:', 'schema:', 'endpoint:'.
    Extracts content until the next section break or blank line.
    Returns up to 10 design notes.
    """
    if not text:
        return []

    design_notes = []

    # Split text into lines for section extraction
    lines = text.split('\n')
    section_pattern = re.compile(
        r'^\s*(?:API|interface|schema|endpoint)\s*:\s*(.*)$',
        re.IGNORECASE
    )

    i = 0
    while i < len(lines) and len(design_notes) < 10:
        match = section_pattern.match(lines[i])
        if match:
            # Start of a section - collect lines until next section or blank line
            section_content = [match.group(1).strip()] if match.group(1).strip() else []
            i += 1

            # Collect continuation lines until blank line or next section
            while i < len(lines):
                line = lines[i].strip()

                # Stop at blank line (end of section)
                if not line:
                    break

                # Stop at next section keyword
                if section_pattern.match(lines[i]):
                    break

                section_content.append(line)
                i += 1

            # Add the complete section
            if section_content:
                design_notes.append(' '.join(section_content))
        else:
            i += 1

    return design_notes


def _extract_task_state(text: str) -> str:
    """Extract current task state from conversation text.

    Looks for TodoWrite items or task-like patterns.
    Falls back to last substantial paragraph.
    Returns summary (max 200 chars).
    """
    if not text:
        return ""

    # Look for TodoWrite patterns with "content": "..." in JSON
    todo_content_pattern = re.compile(
        r'["\']?content["\']?\s*:\s*["\']([^"\']+)["\']',
        re.IGNORECASE
    )

    # Also look for in_progress status nearby to confirm it's a TodoWrite
    in_progress_pattern = re.compile(
        r'["\']?status["\']?\s*:\s*["\']in_progress["\']',
        re.IGNORECASE
    )

    # Search for TodoWrite sections
    lines = text.split('\n')
    for i, line in enumerate(lines):
        if in_progress_pattern.search(line):
            # Look for content in the same line or nearby lines
            search_window = '\n'.join(lines[max(0, i-2):min(len(lines), i+3)])
            content_match = todo_content_pattern.search(search_window)
            if content_match:
                task = content_match.group(1).strip()
                return task[:200] if len(task) > 200 else task

    # Fallback: extract last substantial paragraph (> 50 chars)
    paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]

    for para in reversed(paragraphs):
        # Skip code blocks and very short paragraphs
        if len(para) > 50 and not para.startswith('```'):
            # Take first sentence or up to 200 chars
            sentences = para.split('. ')
            task = sentences[0]
            return task[:200] if len(task) > 200 else task

    return ""


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
    """Append a compaction state section to CLAUDE.md so it survives compaction.

    Includes decisions, file summaries, API design, and task state.
    Implements size guard (max 4000 chars) with truncation priority:
    decisions > file_summaries > api_design > task_state.
    """
    claude_md_path = Path(persist_dir) / "CLAUDE.md"

    # Build the state section
    sections = []

    # Header
    header = f"## Agent State (preserved across compaction)\n"
    header += f"- Last compaction: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"

    if state.get("modified_files"):
        header += f"- Modified files: {', '.join(state['modified_files'][:20])}\n"

    if state.get("diff_stats", {}).get("summary"):
        header += f"- Changes: {state['diff_stats']['summary']}\n"

    if state.get("scope"):
        header += f"- Assigned scope: {state['scope']}\n"

    if state.get("role"):
        header += f"- Role: {state['role']}\n"

    sections.append(("header", header))

    # Decisions (highest priority)
    if state.get("decisions"):
        decisions_text = "\n### Key Decisions\n"
        for decision in state["decisions"][:20]:
            decisions_text += f"- {decision}\n"
        sections.append(("decisions", decisions_text))

    # File summaries (second priority)
    if state.get("file_summaries"):
        summaries_text = "\n### File Summaries\n"
        for filepath, description in list(state["file_summaries"].items())[:30]:
            summaries_text += f"- {filepath}: {description}\n"
        sections.append(("file_summaries", summaries_text))

    # API design (third priority)
    if state.get("api_design"):
        api_text = "\n### API Design Notes\n"
        for note in state["api_design"][:10]:
            api_text += f"- {note}\n"
        sections.append(("api_design", api_text))

    # Task state (lowest priority)
    if state.get("task_state"):
        task_text = f"\n### Current Task\n{state['task_state']}\n"
        sections.append(("task_state", task_text))

    # Footer instruction
    footer = "\nIMPORTANT: You have been through context compaction. "
    footer += "Resume from this state. "
    if state.get("file_summaries"):
        footer += "Do NOT re-read files listed in file_summaries unless the task requires changes to them. "
    footer += "Review the modified files above to recall your progress.\n"
    sections.append(("footer", footer))

    # Assemble state section with size guard (max 4000 chars)
    state_section = ""
    total_size = 0

    # Always include header and footer
    state_section = sections[0][1]  # header
    total_size = len(state_section)

    # Add sections in priority order until we hit size limit
    for name, text in sections[1:-1]:  # Skip header and footer
        if total_size + len(text) + len(sections[-1][1]) <= 4000:
            state_section += text
            total_size += len(text)
        else:
            # Size limit reached - log truncation to stderr
            sys.stderr.write(f"PreCompact: State section truncated (removing {name}, size={total_size})\n")
            break

    # Always add footer
    state_section += sections[-1][1]

    try:
        existing = ""
        if claude_md_path.exists():
            existing = claude_md_path.read_text(encoding="utf-8")
            # Remove any previous state section to avoid accumulation
            marker = "## Agent State (preserved across compaction)"
            if marker in existing:
                existing = existing[:existing.index(marker)].rstrip()

        claude_md_path.write_text(
            existing + "\n\n" + state_section, encoding="utf-8",
        )
    except OSError as e:
        sys.stderr.write(f"PreCompact: Failed to write CLAUDE.md: {e}\n")


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

        # Extract conversation text from event
        # PreCompact event may have 'conversation_summary' or 'text' field
        conversation_text = event.get("conversation_summary", event.get("text", ""))

        # Build state snapshot
        state = {
            "timestamp": time.time(),
            "agent_id": os.getenv("SWARM_AGENT_ID", os.getenv("ARBOR_AGENT_ID", "agent")),
            "role": os.getenv("ARBOR_ROLE", ""),
            "scope": os.getenv("ARBOR_SCOPE", ""),
            "modified_files": _get_modified_files(cwd),
            "diff_stats": _get_diff_stats(cwd),
        }

        # Extract rich context from conversation if available
        if conversation_text:
            state["decisions"] = _extract_decisions(conversation_text)
            state["file_summaries"] = _extract_file_summaries(conversation_text)
            state["api_design"] = _extract_api_design(conversation_text)
            state["task_state"] = _extract_task_state(conversation_text)

        # Write state.json for programmatic access
        state_path = Path(persist_dir) / "state.json"
        try:
            state_path.write_text(
                json.dumps(state, indent=2), encoding="utf-8",
            )
        except OSError as e:
            sys.stderr.write(f"PreCompact: Failed to write state.json: {e}\n")

        # Update CLAUDE.md with human-readable state
        _update_claude_md(persist_dir, state)

        # PreCompact hooks return empty JSON
        print("{}")

    except (json.JSONDecodeError, KeyError, TypeError) as e:
        sys.stderr.write(f"PreCompact: Parse error: {e}\n")
        print("{}")
    except Exception as e:
        # Fail open
        sys.stderr.write(f"PreCompact: Unexpected error: {e}\n")
        print("{}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Auto-Orchestrator v4: AI-powered routing with Arbor enforcement.

Fires at UserPromptSubmit. Uses Claude API (sonnet) for semantic task classification
instead of regex heuristics. Produces pre-computed arbor-swarm/arbor commands
with bd task tickets.

Flow:
  1. AI classifies task (Claude API call, ~1-2s)
  2. Estimate context pressure (budget.db, ~5ms)
  3. Create bd task with full spec
  4. Pre-compute swarm command with bd task ID embedded
  5. Write DELEGATE state for PreToolUse enforcement
  6. Emit directive with ready-to-run command

Fallback: if API call fails (network, timeout), uses fast regex heuristic.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shlex
import sqlite3
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any


# ── Paths ──────────────────────────────────────────────────────────
STATE_DIR = Path.home() / ".claude" / "hooks" / ".acontext_state"
BUDGET_DB = STATE_DIR / "budget.db"
ROUTING_HISTORY = STATE_DIR / "routing_history.json"
LOG_FILE = STATE_DIR / "bridge.log"

EFFECTIVE_CONTEXT = 200_000
SWARM = "arbor-swarm"
DELEGATE_STATE = STATE_DIR / "delegate_mode.json"

# AI classifier model — sonnet for quality classification (~2s)
CLASSIFIER_MODEL = "claude-sonnet-4-20250514"
API_TIMEOUT_SEC = 12  # Sonnet needs slightly more headroom (hook timeout 25s)

# ── AI Classifier ──────────────────────────────────────────────────

CLASSIFIER_PROMPT = """You are a development task router. Classify the user's request and determine the optimal execution strategy.

Return ONLY valid JSON — no markdown, no explanation, just the JSON object.

{
  "execution": "DELEGATE" or "DIRECT",
  "task_type": "RESEARCH" or "IMPLEMENTATION" or "DEBUG" or "REVIEW" or "REFACTOR" or "QUESTION" or "FOLLOWUP",
  "mode": "parallel" or "swarm" or "pipeline" or "single" or "review" or "hierarchical",
  "agents": 1 to 5,
  "depth": "shallow" or "normal" or "thorough",
  "model": "sonnet" or "opus",
  "verify": true or false,
  "task_summary": "concise 1-line description of what the agents should do",
  "reasoning": "1-line explanation of why this routing"
}

Rules for "execution":
- DELEGATE: any task that involves reading multiple files, writing code, debugging, reviewing, refactoring, exploring, or analyzing. This is the DEFAULT for any development work.
- DIRECT: ONLY for simple factual questions ("what does X mean?"), short follow-ups ("yes", "go ahead", "looks good"), or trivial single-line edits that touch 1 file.

Rules for "mode":
- parallel: research/exploration tasks — decompose by directory/module, agents work independently
- swarm: large implementations — decompose into subtasks, parallel execution, verification
- pipeline: refactoring — sequential stages: research → implement → test → review
- single: debugging/focused fixes — one agent investigates and fixes
- review: code review — opus reviewer + verifier cross-check
- hierarchical: large multi-module tasks that span 5+ files across multiple directories, have deep dependency trees, or require >5 distinct subtasks with ordering constraints. Uses a governor for resource budgeting and sub-coordinators for scoped sub-swarms. Prefer this over swarm when the task has natural module boundaries or tiered dependencies.

Rules for "agents": more agents for broader scope, fewer for focused tasks. Hierarchical mode uses 4-5 agents.
Rules for "depth": thorough for production-critical work, normal for standard tasks, shallow for quick scans
Rules for "model": opus for reviews, deep analysis, and hierarchical coordination. Sonnet for everything else.
Rules for "verify": true for any task that modifies code, false for read-only research"""


def _classify_with_ai(prompt: str) -> dict[str, Any] | None:
    """Call Claude API for semantic task classification. Returns parsed JSON or None."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    body = json.dumps(
        {
            "model": CLASSIFIER_MODEL,
            "max_tokens": 300,
            "messages": [
                {
                    "role": "user",
                    "content": f"{CLASSIFIER_PROMPT}\n\nUser request:\n{prompt[:2000]}",
                }
            ],
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read())
            text = data.get("content", [{}])[0].get("text", "")
            # Parse JSON from response (may be wrapped in markdown)
            json_match = re.search(r"\{[\s\S]*\}", text)
            if json_match:
                return json.loads(json_match.group(0))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError) as e:
        _log(f"AI classifier failed: {e}")
    except Exception as e:
        _log(f"AI classifier error: {e}")

    return None


# ── Regex fallback (fast, used when AI is unavailable) ─────────────

_FOLLOWUP = re.compile(
    r"^(yes|no|ok|sure|go\s+ahead|do\s+it|proceed|continue|looks\s+good|lgtm|"
    r"that's\s+right|correct|exactly|perfect|thanks|great|approved|accepted)\b",
    re.I,
)
_QUESTION = re.compile(
    r"^(what|how|why|when|where|which|can\s+you|is\s+it|does|do\s+you|could)\b", re.I
)

_HIERARCHICAL_SIGNALS = re.compile(
    r"(across\s+(all|every|multiple)\s+(modules?|packages?|services?|directories|folders)|"
    r"entire\s+(codebase|project|repo)|"
    r"end.to.end|full.stack|"
    r"refactor.*(everything|all\s+\w+)|"
    r"migrate\s|"
    r"(\d+)\s+(files?|modules?|components?|services?))",
    re.I | re.MULTILINE,
)


def _classify_with_regex(prompt: str) -> dict[str, Any]:
    """Fast regex fallback when AI classifier is unavailable."""
    text = prompt.strip()

    if len(text) < 80 and _FOLLOWUP.search(text):
        return {
            "execution": "DIRECT",
            "task_type": "FOLLOWUP",
            "mode": "single",
            "agents": 1,
            "depth": "shallow",
            "model": "sonnet",
            "verify": False,
            "task_summary": text,
            "reasoning": "short followup",
        }

    if _QUESTION.match(text) and len(text) < 200:
        return {
            "execution": "DIRECT",
            "task_type": "QUESTION",
            "mode": "single",
            "agents": 1,
            "depth": "shallow",
            "model": "sonnet",
            "verify": False,
            "task_summary": text,
            "reasoning": "question",
        }

    # Detect very large tasks that warrant hierarchical mode
    hier_match = _HIERARCHICAL_SIGNALS.search(text)
    if hier_match:
        # Check if a numeric file/module count was captured (group 6)
        count_str = hier_match.group(6)
        count = int(count_str) if count_str and count_str.isdigit() else 0
        # Route to hierarchical if explicit large count or strong cross-module signal
        if count >= 5 or len(text) > 500 or not count_str:
            return {
                "execution": "DELEGATE",
                "task_type": "IMPLEMENTATION",
                "mode": "hierarchical",
                "agents": 4,
                "depth": "thorough",
                "model": "opus",
                "verify": True,
                "task_summary": text[:200],
                "reasoning": "regex fallback — large multi-module task, hierarchical mode",
            }

    # Default: delegate everything substantial
    return {
        "execution": "DELEGATE",
        "task_type": "IMPLEMENTATION",
        "mode": "swarm",
        "agents": 3,
        "depth": "normal",
        "model": "sonnet",
        "verify": True,
        "task_summary": text[:200],
        "reasoning": "regex fallback — delegating to be safe",
    }


def classify_task(prompt: str) -> dict[str, Any]:
    """Classify task using AI with regex fallback.

    Returns a full routing decision dict, not just a type string.
    Marks the result with 'classification_method' to track which method was used.
    """
    # Try AI first
    result = _classify_with_ai(prompt)
    if result and "execution" in result:
        _log(
            f"AI classified: {result.get('task_type')} mode={result.get('mode')} agents={result.get('agents')}"
        )
        result["classification_method"] = "ai"
        return result

    # Fallback to regex
    _log("WARN: AI classification failed or timed out, falling back to regex heuristics")
    result = _classify_with_regex(prompt)
    _log(f"Regex fallback: {result.get('task_type')} mode={result.get('mode')}")
    result["classification_method"] = "regex"
    return result


# ── Helpers ────────────────────────────────────────────────────────


def _log(msg: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ts = (
            dt.datetime.now(dt.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}][orchestrator] {msg[:500]}\n")
    except Exception:
        pass


def _get_session_tokens(session_id: str) -> tuple[int, int]:
    try:
        if not BUDGET_DB.exists():
            return 0, 0
        conn = sqlite3.connect(str(BUDGET_DB), timeout=3.0)
        cursor = conn.execute(
            "SELECT total_tokens, tool_count FROM session_summary WHERE session_id = ?",
            (session_id,),
        )
        row = cursor.fetchone()
        conn.close()
        return (row[0], row[1]) if row else (0, 0)
    except Exception:
        return 0, 0


def _get_last_routing(session_id: str) -> dict[str, Any] | None:
    try:
        if not ROUTING_HISTORY.exists():
            return None
        data = json.loads(ROUTING_HISTORY.read_text(encoding="utf-8"))
        return data.get(session_id)
    except Exception:
        return None


def _save_routing(session_id: str, routing: dict[str, Any]) -> None:
    try:
        data = {}
        if ROUTING_HISTORY.exists():
            data = json.loads(ROUTING_HISTORY.read_text(encoding="utf-8"))
        data[session_id] = routing
        if len(data) > 20:
            for old_key in sorted(data.keys())[:-20]:
                del data[old_key]
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ROUTING_HISTORY.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def _safe_task(prompt: str, max_len: int = 500) -> str:
    text = prompt.strip().replace("\n", " ").replace("\r", "")
    if len(text) > max_len:
        text = text[:max_len] + "..."
    return text


def _swarm_cmd(
    task: str,
    mode: str = "auto",
    agents: int = 3,
    depth: str = "normal",
    result_file: str | None = None,
    context_file: str | None = None,
    verify: bool = True,
    stdin_pipe: str | None = None,
    bd_task: str | None = None,
    model: str | None = None,
) -> str:
    parts: list[str] = []
    if stdin_pipe:
        parts.append(f"{stdin_pipe} |")
    parts.append(SWARM)
    if stdin_pipe:
        parts.append("--stdin")
    parts.extend(["--mode", mode, "--agents", str(agents), "--depth", depth])
    if result_file:
        parts.extend(["--result-file", result_file])
    if context_file:
        parts.extend(["--context-file", context_file])
    if bd_task is not None:
        parts.extend(["--bd-task", bd_task])
    if verify:
        parts.append("--verify")
    else:
        parts.append("--no-verify")
    if not stdin_pipe:
        parts.append(shlex.quote(task))
    return " ".join(parts)


def estimate_pressure(tokens: int) -> str:
    pct = (tokens / EFFECTIVE_CONTEXT) * 100
    if pct < 30:
        return "LOW"
    elif pct < 50:
        return "MODERATE"
    elif pct < 70:
        return "HIGH"
    else:
        return "CRITICAL"


# ── BD Task Creation ───────────────────────────────────────────────


def _create_bd_task(
    classification: dict[str, Any],
    prompt: str,
    cwd: str,
) -> str | None:
    """Create a bd task with AI-determined spec. Returns task ID or None."""
    task_type = classification.get("task_type", "IMPLEMENTATION")
    task_summary = classification.get("task_summary", prompt[:80])
    short_title = task_summary[:80].replace('"', "'").replace("\n", " ").strip()
    if not short_title:
        return None

    type_map = {
        "IMPLEMENTATION": ("feature", "1"),
        "RESEARCH": ("task", "2"),
        "DEBUG": ("bug", "1"),
        "REFACTOR": ("task", "2"),
        "REVIEW": ("task", "2"),
    }
    bd_type, priority = type_map.get(task_type, ("task", "2"))

    desc_lines = [
        "## User Request",
        prompt[:1000],
        "",
        "## AI Routing Decision",
        f"- Task type: {task_type}",
        f"- Mode: {classification.get('mode', 'swarm')}",
        f"- Agents: {classification.get('agents', 3)}",
        f"- Depth: {classification.get('depth', 'normal')}",
        f"- Model: {classification.get('model', 'sonnet')}[1m]",
        f"- Verify: {classification.get('verify', True)}",
        f"- Reasoning: {classification.get('reasoning', 'n/a')}",
        "",
        "## Execution Context",
        f"- Working directory: {cwd}",
        "",
        "## Quality Requirements (Non-Negotiable)",
        "- Read all relevant files before making any changes",
        "- Run tests after implementation to verify correctness",
        "- Produce a completion checklist: every assigned item with PASS/FAIL/SKIP",
        "- Flag edge cases explicitly — do not assume they are handled",
        "- If uncertain, document the uncertainty rather than guessing",
        "- No silent omissions — every requirement must be addressed or explicitly deferred",
    ]

    description = "\n".join(desc_lines)

    try:
        import subprocess

        result = subprocess.run(
            [
                "bd",
                "create",
                short_title,
                "--description",
                description,
                "--priority",
                priority,
                "--type",
                bd_type,
                "--labels",
                f"{task_type.lower()},arbor",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=cwd,
        )
        if result.returncode != 0:
            _log(
                f"bd create failed: returncode={result.returncode} stderr={result.stderr[:200]}"
            )
            return None

        match = re.search(r"Created issue:\s+(\S+)", result.stdout)
        if match:
            return match.group(1)
        else:
            _log(
                f"bd create succeeded but regex failed to match stdout: {result.stdout[:200]}"
            )
            return None
    except subprocess.TimeoutExpired:
        _log(f"bd create timed out after 10s")
        return None
    except Exception as e:
        _log(f"bd create exception: {e}")
        return None


# ── Directive Generator ────────────────────────────────────────────


def generate_directive(
    classification: dict[str, Any],
    pressure: str,
    tokens: int,
    last_routing: dict[str, Any] | None,
    prompt: str = "",
    cwd: str = "",
) -> str | None:
    """Generate the [AUTO-ROUTE] directive from AI classification."""
    pct = (tokens / EFFECTIVE_CONTEXT) * 100 if EFFECTIVE_CONTEXT > 0 else 0
    lines: list[str] = []
    task = _safe_task(prompt)
    execution = classification.get("execution", "DELEGATE")
    task_type = classification.get("task_type", "IMPLEMENTATION")

    # ── Helper: persist delegation state ──
    def _set_delegate_mode(mode: str, command: str = "") -> None:
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            DELEGATE_STATE.write_text(
                json.dumps(
                    {
                        "mode": mode,
                        "command": command,
                        "task_type": task_type,
                        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
        except Exception:
            pass

    # ── DIRECT execution (questions, follow-ups, trivial) ──
    if execution == "DIRECT":
        # FIX #17: FOLLOWUP inherits parent DELEGATE mode — don't clear state
        if (
            task_type == "FOLLOWUP"
            and last_routing
            and last_routing.get("execution") == "DELEGATE"
        ):
            # Keep DELEGATE active — the follow-up is continuing delegated work
            _log("FOLLOWUP inherits DELEGATE from parent")
            return None  # No directive needed — DELEGATE state already active

        _set_delegate_mode("DIRECT")
        if task_type == "FOLLOWUP":
            if pressure in ("HIGH", "CRITICAL"):
                return f"[AUTO-ROUTE] type=FOLLOWUP pressure={pressure}\nContext at {pct:.0f}%. Run /compact before continuing."
            return None
        if task_type == "QUESTION":
            if pressure == "CRITICAL":
                return f"[AUTO-ROUTE] type=QUESTION pressure=CRITICAL\nContext at {pct:.0f}%. Run /compact before answering."
            return None
        # Small/direct tasks
        if pressure in ("HIGH", "CRITICAL"):
            return f"[AUTO-ROUTE] type=DIRECT pressure={pressure}\nContext at {pct:.0f}%. Consider /compact."
        return None

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # DELEGATE — all substantial work goes to arbor-swarm/arbor
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    # Create bd task with full spec
    task_id = _create_bd_task(classification, prompt, cwd)
    if task_id is None:
        _log(
            f"WARN: bd task creation failed for {task_type} — directive will lack task tracking"
        )

    # Build swarm command from AI classification
    mode = classification.get("mode", "swarm")
    agents = min(classification.get("agents", 3), 5)
    depth = classification.get("depth", "normal")
    verify = classification.get("verify", True)
    model = classification.get("model", "sonnet")
    task_summary = classification.get("task_summary", task)

    # Use task_summary from AI (more focused than raw prompt)
    effective_task = _safe_task(task_summary) if task_summary != task else task

    if mode == "review":
        cmd = _swarm_cmd(
            effective_task,
            mode="review",
            agents=agents,
            depth=depth,
            result_file="/tmp/arbor-swarm-result.json",
            verify=verify,
            stdin_pipe="git diff HEAD~1",
            bd_task=task_id,
        )
    else:
        cmd = _swarm_cmd(
            effective_task,
            mode=mode,
            agents=agents,
            depth=depth,
            result_file="/tmp/arbor-swarm-result.json",
            verify=verify,
            bd_task=task_id,
        )

    _set_delegate_mode("DELEGATE", cmd)

    # Enforcement header
    classification_method = classification.get("classification_method", "unknown")
    lines.append(f"[AUTO-ROUTE] type={task_type} mode=DELEGATE pressure={pressure}")
    if classification_method == "regex":
        lines.append(
            f"Routing (regex fallback): {mode} mode, {agents} agents, depth={depth}, verify={verify}"
        )
        lines.append(
            f"NOTE: AI classification unavailable, using regex heuristics (may be less accurate)"
        )
    else:
        lines.append(
            f"AI routing: {mode} mode, {agents} agents, depth={depth}, verify={verify}"
        )
    lines.append(f"Reasoning: {classification.get('reasoning', 'n/a')}")
    lines.append("")
    lines.append(
        "YOUR FIRST AND ONLY ACTION: Run this Bash command. All other tools are blocked."
    )
    lines.append(f"RUN: `{cmd}`")
    lines.append("")
    lines.append(
        "THEN: Read /tmp/arbor-swarm-result.json → present findings/results to user."
    )

    if pressure in ("HIGH", "CRITICAL"):
        lines.append(f"NOTE: Context at {pct:.0f}%. Run /compact FIRST.")

    if task_id:
        lines.append(f"BD TASK: {task_id} (auto-created, arbor-swarm will claim+close)")

    return "\n".join(lines)


# ── Main ───────────────────────────────────────────────────────────


def main() -> None:
    try:
        event_json = sys.stdin.read().strip()
        if not event_json:
            return

        event = json.loads(event_json)
        session_id = event.get("session_id", "")
        prompt = event.get("prompt", "")

        if not session_id or not prompt:
            return

        # Use a lock file to prevent race conditions during classification + state write
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        lock_file_path = STATE_DIR / ".orchestrator.lock"
        lock_file = None

        try:
            import fcntl

            # Acquire lock before classification to prevent concurrent modifications
            lock_file = open(lock_file_path, "a")
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)

            # Classify FIRST, then set state based on result.
            # Previous approach wrote DELEGATE before classification, which blocked
            # all tools even when the task was DIRECT — causing a catch-22 where
            # investigation/debugging tasks couldn't read files.
            classification = classify_task(prompt)

            # Classification done — don't write DELEGATE state yet.
            # Wait until directive generation succeeds to avoid deadlock
            # if generate_directive() fails/times out.
        finally:
            # Release lock
            if lock_file:
                try:
                    import fcntl

                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                    lock_file.close()
                except Exception:
                    pass

        # Context pressure
        tokens, tool_count = _get_session_tokens(session_id)
        pressure = estimate_pressure(tokens)
        last_routing = _get_last_routing(session_id)

        # Generate directive
        cwd = event.get("cwd", os.getcwd())
        directive = generate_directive(
            classification,
            pressure,
            tokens,
            last_routing,
            prompt=prompt,
            cwd=cwd,
        )

        # Write DELEGATE state AFTER directive generation succeeds.
        # This prevents deadlock: if generate_directive() fails, no
        # DELEGATE state is written and tools remain unblocked.
        if classification.get("execution") == "DELEGATE" and directive:
            try:
                DELEGATE_STATE.write_text(
                    json.dumps(
                        {
                            "mode": "DELEGATE",
                            "command": directive.split("\n")[0][:200] if directive else "arbor-swarm",
                            "task_type": classification.get("task_type", "PENDING"),
                            "delegation_mode": classification.get("mode", ""),
                            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
                        }
                    ),
                    encoding="utf-8",
                )
            except Exception:
                pass

        # Persist routing
        _save_routing(
            session_id,
            {
                "task_type": classification.get("task_type"),
                "execution": classification.get("execution"),
                "mode": classification.get("mode"),
                "pressure": pressure,
                "tokens": tokens,
                "tool_count": tool_count,
                "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
            },
        )

        if directive:
            print(directive, flush=True)
            _log(
                f"ROUTE type={classification.get('task_type')} exec={classification.get('execution')} mode={classification.get('mode')} agents={classification.get('agents')}"
            )
        else:
            _log(f"PASS type={classification.get('task_type')} exec=DIRECT")

    except json.JSONDecodeError:
        pass
    except Exception as e:
        _log(f"ERR: {e}")


if __name__ == "__main__":
    main()

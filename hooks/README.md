# Remote Agent Hooks

Hooks for Claude Code that enforce constraints on arbor operations.

## scope-guard.py

**Type:** PreToolUse hook
**Purpose:** Enforce file scope restrictions on remote agents

### How It Works

The scope guard blocks `Write`, `Edit`, and `Bash` tool operations that target files outside the agent's allowed scope. Scope is defined via the `ARBOR_SCOPE` environment variable.

### Configuration

Set the `ARBOR_SCOPE` environment variable to a comma-separated list of allowed paths:

```bash
export ARBOR_SCOPE="lib/config.mjs,lib/output.mjs,test/"
```

Paths can be:
- **Absolute:** `~/.claude/lib/config.mjs`
- **Relative:** `lib/config.mjs` (resolved against CWD)
- **Files:** Exact file match only
- **Directories:** Any file within the directory

### Behavior

**Allowed operations:**
- Read, Grep, Glob tools (always allowed)
- Write/Edit within scope
- Bash commands writing to scope paths
- Bash commands to `/dev/null`, `/dev/stderr`, etc.
- Any operation when `ARBOR_SCOPE` is unset (no restrictions)

**Blocked operations:**
- Write/Edit to files outside scope
- Bash redirects (`>`, `>>`) outside scope
- Bash `tee` commands outside scope

**Path resolution:**
- Handles `..` components (resolves before checking)
- Normalizes relative paths against CWD
- Matches exact files or directory prefixes

### Examples

```bash
# Allow agent to modify only lib/ files
ARBOR_SCOPE="lib/" arbor "refactor config loader"

# Allow specific files
ARBOR_SCOPE="lib/config.mjs,lib/output.mjs" arbor "update config"

# Multiple directories
ARBOR_SCOPE="lib/,test/,docs/" arbor "add feature"

# No restrictions
arbor "explore codebase"
```

### Integration

The hook is automatically loaded by arbor when configured in `.claude.json`:

```json
{
  "hooks": {
    "preToolUse": [
      {
        "name": "scope-guard",
        "path": "~/.claude/arbor/hooks/scope-guard.py",
        "toolMatchers": ["Write", "Edit", "Bash"]
      }
    ]
  }
}
```

### Performance

- **Execution time:** ~0.25ms average (excluding Python startup)
- **Total latency:** ~180ms including subprocess spawn
- **No heavy imports:** stdlib only, fast startup

### Error Handling

The hook fails open (allows operation) on:
- Malformed JSON input
- Missing required fields
- Unexpected errors

This ensures agents aren't blocked by hook bugs.

### Testing

Run tests:

```bash
python3 << 'EOF'
import json, subprocess, os

def test(event, scope):
    proc = subprocess.run(
        ["python3", "~/.claude/arbor/hooks/scope-guard.py"],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        env={**os.environ, "ARBOR_SCOPE": scope}
    )
    return json.loads(proc.stdout.strip()) if proc.stdout.strip() else {}

# Test: allow within scope
event = {"cwd": "/tmp", "tool_name": "Write", "tool_input": {"file_path": "/tmp/lib/config.js"}}
assert test(event, "/tmp/lib") == {}

# Test: deny outside scope
event = {"cwd": "/tmp", "tool_name": "Write", "tool_input": {"file_path": "/tmp/outside/file.js"}}
assert "hookSpecificOutput" in test(event, "/tmp/lib")

print("✓ Tests passed")
EOF
```

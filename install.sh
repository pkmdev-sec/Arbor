#!/usr/bin/env bash
# remote-agent installer — sets up everything from scratch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"

echo "=== remote-agent installer ==="
echo ""

# 1. Check prerequisites
echo "[1/6] Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "Error: Node.js 18+ required. Install: https://nodejs.org"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: Claude Code required. Install: curl -fsSL https://claude.ai/install.sh | bash"; exit 1; }

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "Error: Node.js 18+ required (you have v${NODE_VER})"
  exit 1
fi

echo "  Node.js: $(node -v)"
echo "  Claude: $(claude --version 2>/dev/null | head -1)"

# 2. Install npm dependencies
echo ""
echo "[2/6] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent

# 3. Symlink binaries to PATH
echo ""
echo "[3/6] Creating symlinks..."
LOCAL_BIN="${HOME}/.local/bin"
mkdir -p "$LOCAL_BIN"
ln -sf "${SCRIPT_DIR}/agent-entry.mjs" "${LOCAL_BIN}/remote-agent"
ln -sf "${SCRIPT_DIR}/swarm.mjs" "${LOCAL_BIN}/swarm"
echo "  ${LOCAL_BIN}/remote-agent → agent-entry.mjs"
echo "  ${LOCAL_BIN}/swarm → swarm.mjs"

# 4. Install hooks into Claude Code settings
echo ""
echo "[4/6] Installing hooks into Claude Code..."
SETTINGS="${CLAUDE_DIR}/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo "  No settings.json found. Creating minimal one..."
  mkdir -p "$CLAUDE_DIR"
  cat > "$SETTINGS" << 'SETTINGSEOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": { "allow": ["*"], "defaultMode": "dontAsk" }
}
SETTINGSEOF
fi

# Copy hooks to Claude Code hooks directory
HOOKS_DIR="${CLAUDE_DIR}/hooks"
mkdir -p "$HOOKS_DIR"
cp "${SCRIPT_DIR}/hooks/auto_orchestrator.py" "$HOOKS_DIR/"
cp "${SCRIPT_DIR}/hooks/block_agent_tool.py" "$HOOKS_DIR/"
cp "${SCRIPT_DIR}/hooks/fulfill_delegate.py" "$HOOKS_DIR/"
cp "${SCRIPT_DIR}/hooks/block_task_tools.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR"/*.py
echo "  Hooks copied to ${HOOKS_DIR}/"

# Create isolated config for remote-agent subprocess
REMOTE_CONFIG="${SCRIPT_DIR}/config"
mkdir -p "$REMOTE_CONFIG"
if [ ! -f "${REMOTE_CONFIG}/settings.json" ]; then
  cat > "${REMOTE_CONFIG}/settings.json" << 'CONFIGEOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": { "allow": ["*"], "deny": [], "defaultMode": "dontAsk" },
  "disableAllHooks": true,
  "includeCoAuthoredBy": false
}
CONFIGEOF
fi

# 5. Inject hook registrations into settings.json
echo ""
echo "[5/6] Registering hooks in settings.json..."
python3 << 'PYEOF'
import json, sys

settings_path = sys.argv[1] if len(sys.argv) > 1 else f"{__import__('os').environ['HOME']}/.claude/settings.json"
hooks_dir = sys.argv[2] if len(sys.argv) > 2 else f"{__import__('os').environ['HOME']}/.claude/hooks"

with open(settings_path, 'r') as f:
    settings = json.load(f)

hooks = settings.setdefault("hooks", {})

# PreToolUse hooks for enforcement
pre = hooks.setdefault("PreToolUse", [])
# Check if already registered
existing_matchers = {h.get("matcher", "") for h in pre}

new_hooks = [
    {"matcher": "Agent", "hooks": [{"type": "command", "command": f"python3 {hooks_dir}/block_agent_tool.py", "timeout": 3, "statusMessage": "Orchestrator: routing check"}]},
    {"matcher": "Read", "hooks": [{"type": "command", "command": f"python3 {hooks_dir}/block_agent_tool.py", "timeout": 3}]},
    {"matcher": "Glob", "hooks": [{"type": "command", "command": f"python3 {hooks_dir}/block_agent_tool.py", "timeout": 3}]},
    {"matcher": "Grep", "hooks": [{"type": "command", "command": f"python3 {hooks_dir}/block_agent_tool.py", "timeout": 3}]},
    {"matcher": "{TaskCreate,TaskUpdate,TaskGet,TaskList,TodoWrite}", "hooks": [{"type": "command", "command": f"python3 {hooks_dir}/block_task_tools.py", "timeout": 3, "statusMessage": "Orchestrator: use bd CLI"}]},
]

for nh in new_hooks:
    if nh["matcher"] not in existing_matchers:
        pre.insert(0, nh)
        print(f"  Added PreToolUse matcher: {nh['matcher']}")

# PostToolUse hook for DELEGATE → FULFILLED transition
post = hooks.setdefault("PostToolUse", [])
fulfill_registered = any("fulfill_delegate" in str(h) for h in post)
if not fulfill_registered:
    post.insert(0, {"matcher": "Bash", "hooks": [{"type": "command", "command": f"python3 {hooks_dir}/fulfill_delegate.py", "timeout": 3}]})
    print("  Added PostToolUse: fulfill_delegate.py")

# UserPromptSubmit hook for orchestrator
user_sub = hooks.setdefault("UserPromptSubmit", [])
orch_registered = any("auto_orchestrator" in str(h) for h in user_sub)
if not orch_registered:
    user_sub.insert(0, {"hooks": [{"type": "command", "command": f"python3 {hooks_dir}/auto_orchestrator.py", "timeout": 20, "statusMessage": "Orchestrator: classifying task"}]})
    print("  Added UserPromptSubmit: auto_orchestrator.py")

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)

print("  settings.json updated")
PYEOF

# 6. Create state directory
echo ""
echo "[6/6] Creating state directory..."
mkdir -p "${CLAUDE_DIR}/hooks/.acontext_state"
echo '{"mode":"DIRECT"}' > "${CLAUDE_DIR}/hooks/.acontext_state/delegate_mode.json"

# Verify
echo ""
echo "=== Installation complete ==="
echo ""
remote-agent --version 2>/dev/null || echo "Warning: remote-agent not on PATH. Add ~/.local/bin to PATH."
echo ""
echo "Quick test:"
echo "  remote-agent --help"
echo "  swarm --help"
echo ""
echo "Usage from Claude Code session:"
echo '  remote-agent -m sonnet "explore this codebase"'
echo '  swarm --mode parallel --agents 3 "analyze the project"'

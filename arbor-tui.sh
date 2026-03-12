#!/bin/sh
# Wrapper script for arbor-tui

# Resolve the actual script location (follow symlinks)
SCRIPT="$0"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"

while [ -L "$SCRIPT_DIR/$(basename "$SCRIPT")" ]; do
  LINK="$(readlink "$SCRIPT_DIR/$(basename "$SCRIPT")")"
  case "$LINK" in
    /*)
      # Absolute path - use as-is
      SCRIPT="$LINK"
      ;;
    *)
      # Relative path - prepend SCRIPT_DIR
      SCRIPT="$SCRIPT_DIR/$LINK"
      ;;
  esac
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
done

# Get the directory where the actual script is located
DIR="$SCRIPT_DIR"

# Execute the Go binary with all arguments
exec "$DIR/tui/arbor-tui" "$@"

#!/bin/bash
# PostToolUse hook: Auto-format edited files with Prettier
# Receives JSON via stdin with tool_input.file_path

# Read JSON from stdin
INPUT=$(cat)

# Extract file path using jq (fallback to grep if jq unavailable)
if command -v jq &> /dev/null; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
else
  FILE_PATH=$(echo "$INPUT" | grep -oP '"file_path"\s*:\s*"\K[^"]+')
fi

# Exit if no file path
[ -z "$FILE_PATH" ] && exit 0

# Exit if file doesn't exist
[ ! -f "$FILE_PATH" ] && exit 0

# Only format supported extensions
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.md|*.css|*.scss|*.html|*.yml|*.yaml)
    # Run prettier (suppress errors - non-fatal)
    npx prettier --write "$FILE_PATH" 2>/dev/null || true
    ;;
esac

exit 0

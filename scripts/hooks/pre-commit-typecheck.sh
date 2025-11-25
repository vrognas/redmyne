#!/bin/bash
# PreToolUse hook: Run typecheck before git commits
# Receives JSON via stdin, exits 2 to block on failure

# Read JSON from stdin
INPUT=$(cat)

# Extract command using jq (fallback to grep)
if command -v jq &> /dev/null; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
else
  COMMAND=$(echo "$INPUT" | grep -oP '"command"\s*:\s*"\K[^"]+')
fi

# Only check git commit commands
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Run typecheck
echo "Running typecheck before commit..."
if npm run typecheck 2>&1; then
  echo "Typecheck passed"
  exit 0
else
  echo "Typecheck failed - commit blocked" >&2
  exit 2  # Exit 2 = blocking error
fi

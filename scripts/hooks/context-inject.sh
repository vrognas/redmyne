#!/bin/bash
# UserPromptSubmit hook: Inject git context into every prompt
# Output is added as context for Claude

# Get git branch (fallback if not in repo)
BRANCH=$(git branch --show-current 2>/dev/null || echo "N/A")

# Count uncommitted changes
CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Output context (stdout goes to Claude)
echo "Branch: $BRANCH | Uncommitted: $CHANGES"

exit 0

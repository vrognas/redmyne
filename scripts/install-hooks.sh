#!/usr/bin/env bash
#
# Install git hooks for the repository

set -e

# Get the repository root
REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts"

# Check if .git directory exists
if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "ERROR: Not a git repository"
  exit 1
fi

# Install commit-msg hook
echo "Installing commit-msg hook..."
cp "$SCRIPTS_DIR/commit-msg" "$HOOKS_DIR/commit-msg"
chmod +x "$HOOKS_DIR/commit-msg"

echo "✓ Hooks installed successfully"
echo ""
echo "Installed hooks:"
echo "  - commit-msg: Validates commit message format"
echo "    • Subject line ≤ 50 chars"
echo "    • Blank line between subject and body"
echo "    • Body lines ≤ 72 chars"
echo "    • Exceptions: merge commits, revert commits"

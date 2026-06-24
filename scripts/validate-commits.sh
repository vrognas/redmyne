#!/bin/bash
set -e

# Validate every commit message in a PR range by delegating to the commit-msg
# hook — the single owner of the rules (subject <= 50, body lines <= 72, blank
# line between subject/body, merge/revert exceptions). Keeps CI and the local
# hook from drifting.

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <base-sha> <head-sha>"
  exit 1
fi

BASE_SHA="$1"
HEAD_SHA="$2"
HOOK="$(dirname "$0")/commit-msg"

echo "Validating commit messages from $BASE_SHA to $HEAD_SHA"

FAILED=0

# Get all commits in range - use process substitution to avoid subshell
while read -r commit; do
  echo "Checking commit: $commit"

  msg_file=$(mktemp)
  git log --format="%B" -n 1 "$commit" > "$msg_file"
  if bash "$HOOK" "$msg_file"; then
    echo "✅ $commit OK"
  else
    echo "❌ $commit failed validation"
    FAILED=1
  fi
  rm -f "$msg_file"
done < <(git log --format="%H" "$BASE_SHA..$HEAD_SHA")

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Commit message validation failed!"
  echo "Rules (see scripts/commit-msg):"
  echo "  - Subject line: max 50 chars"
  echo "  - Body lines: max 72 chars"
  echo "  - Blank line between subject and body"
  exit 1
fi

echo "✅ All commit messages valid"

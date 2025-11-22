#!/bin/bash
set -e

# Validate commit messages in PR
# - Subject line <= 50 chars
# - Body lines <= 72 chars

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <base-sha> <head-sha>"
  exit 1
fi

BASE_SHA="$1"
HEAD_SHA="$2"

echo "Validating commit messages from $BASE_SHA to $HEAD_SHA"

FAILED=0

# Get all commits in range
git log --format="%H" "$BASE_SHA..$HEAD_SHA" | while read -r commit; do
  echo "Checking commit: $commit"

  # Get commit message
  SUBJECT=$(git log --format=%s -n 1 "$commit")
  BODY=$(git log --format=%b -n 1 "$commit")

  # Check subject line length
  SUBJECT_LEN=${#SUBJECT}
  if [ "$SUBJECT_LEN" -gt 50 ]; then
    echo "❌ Subject line too long ($SUBJECT_LEN > 50 chars): $SUBJECT"
    FAILED=1
  else
    echo "✅ Subject line OK ($SUBJECT_LEN chars)"
  fi

  # Check body line lengths (if body exists)
  if [ -n "$BODY" ]; then
    while IFS= read -r line; do
      LINE_LEN=${#line}
      if [ "$LINE_LEN" -gt 72 ]; then
        echo "❌ Body line too long ($LINE_LEN > 72 chars): $line"
        FAILED=1
      fi
    done <<< "$BODY"
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Commit message validation failed!"
  echo "Rules:"
  echo "  - Subject line: max 50 chars"
  echo "  - Body lines: max 72 chars"
  exit 1
fi

echo "✅ All commit messages valid"

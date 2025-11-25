#!/bin/bash
# PreCompact hook: Log context compaction events
# Helps audit/debug context loss issues

# Allow custom log directory (for testing)
LOG_DIR="${CLAUDE_LOG_DIR:-$HOME/.claude}"

# Ensure directory exists
mkdir -p "$LOG_DIR"

# Append timestamp to log
echo "$(date '+%Y-%m-%d %H:%M:%S'): Context compaction triggered" >> "$LOG_DIR/compaction-log.txt"

exit 0

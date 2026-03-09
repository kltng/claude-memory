#!/bin/bash
# Claude Code SessionEnd hook — captures session transcript to memory repo.
# Reads hook input from stdin (JSON with session_id, transcript_path, cwd, etc.)

MEMORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Capture session to markdown
cat | CLAUDE_MEMORY_ROOT="$MEMORY_ROOT" npx --prefix "$MEMORY_ROOT" tsx "$MEMORY_ROOT/src/capture.ts" 2>/dev/null

# Git sync: add + commit + push
cd "$MEMORY_ROOT"
git add sessions/ summaries/ INDEX.md 2>/dev/null
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -m "memory: auto-capture $(date '+%Y-%m-%d %H:%M')" --no-gpg-sign 2>/dev/null
  git push 2>/dev/null || true
fi

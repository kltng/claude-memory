#!/bin/bash
# Claude Code SessionStart hook — pulls latest memory from git remote.

MEMORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MEMORY_ROOT"

# Pull latest, silently
git pull --rebase --autostash 2>/dev/null || true

# Rebuild search index if markdown files changed
CHANGED=$(git diff HEAD@{1} --name-only -- sessions/ summaries/ 2>/dev/null | head -1)
if [ -n "$CHANGED" ]; then
  CLAUDE_MEMORY_ROOT="$MEMORY_ROOT" npx --prefix "$MEMORY_ROOT" tsx "$MEMORY_ROOT/src/rebuild-index.ts" 2>/dev/null
fi

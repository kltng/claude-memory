#!/bin/bash
#
# Claude Memory — Update from upstream (public repo)
#
# Pulls latest code changes from the public template repo,
# merges them into your private memory store, and reinstalls dependencies.
#
# Usage: ./update.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Claude Memory Updater ==="
echo ""

# ─── Ensure upstream remote exists ─────────────────────────────────

UPSTREAM_URL="https://github.com/kltng/claude-memory.git"

if ! git remote get-url upstream &>/dev/null; then
  echo "Adding upstream remote ($UPSTREAM_URL)..."
  git remote add upstream "$UPSTREAM_URL"
fi

# ─── Fetch and merge upstream changes ──────────────────────────────

echo "Fetching upstream changes..."
git fetch upstream 2>&1

CURRENT=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/main 2>/dev/null || echo "")

if [ -z "$UPSTREAM" ]; then
  echo "Warning: could not find upstream/main. Skipping code update."
elif [ "$CURRENT" = "$UPSTREAM" ]; then
  echo "Already up to date with upstream."
else
  echo "Merging upstream changes..."
  # Use --no-edit to auto-accept merge commit message
  # Strategy: keep our sessions/summaries, take upstream's code changes
  git merge upstream/main --no-edit --strategy-option theirs 2>&1 || {
    echo ""
    echo "Merge conflict detected. Resolving by keeping your session data..."
    # Keep our versions of session/summary files, take theirs for code
    git checkout --ours sessions/ summaries/ 2>/dev/null || true
    git checkout --theirs src/ hooks/ install.sh update.sh package.json tsconfig.json 2>/dev/null || true
    git add -A
    git commit --no-edit 2>/dev/null || true
  }
  echo "Code updated from upstream."
fi

echo ""

# ─── Reinstall dependencies (in case package.json changed) ────────

echo "Updating npm dependencies..."
npm install 2>&1
echo ""

# ─── Rebuild search indexes ───────────────────────────────────────

echo "Rebuilding search index..."
npx tsx src/rebuild-index.ts 2>&1
echo ""

# ─── Push to your private remote ──────────────────────────────────

echo "Pushing to origin..."
git push origin main 2>/dev/null || echo "  (push skipped — check remote config)"
echo ""

echo "=== Update complete ==="

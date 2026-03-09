#!/bin/bash
#
# Claude Memory — Automated Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/USER/claude-memory/main/install.sh | bash
#   ./install.sh [--repo <github-url>] [--dir <install-dir>]
#
# This script is idempotent — safe to run multiple times.
#

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────

DEFAULT_REPO="https://github.com/kltng/claude-memory.git"
DEFAULT_DIR="$HOME/codebases/claude-memory"

REPO=""
INSTALL_DIR=""

# ─── Parse arguments ──────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./install.sh [--repo <github-url>] [--dir <install-dir>]"
      echo ""
      echo "Options:"
      echo "  --repo <url>   GitHub repo URL (default: $DEFAULT_REPO)"
      echo "  --dir  <path>  Installation directory (default: $DEFAULT_DIR)"
      echo "  --help          Show this help"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# Apply defaults
REPO="${REPO:-$DEFAULT_REPO}"
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"

# ─── Dependency checks ───────────────────────────────────────────────

echo "=== Claude Memory Installer ==="
echo ""

check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' is not installed or not in PATH."
    echo ""
    echo "Please install $1 first:"
    case "$1" in
      node)
        echo "  macOS:  brew install node"
        echo "  Linux:  https://nodejs.org/en/download/"
        ;;
      npm)
        echo "  npm is bundled with Node.js — install Node first."
        echo "  macOS:  brew install node"
        echo "  Linux:  https://nodejs.org/en/download/"
        ;;
      npx)
        echo "  npx is bundled with npm/Node.js — install Node first."
        echo "  macOS:  brew install node"
        echo "  Linux:  https://nodejs.org/en/download/"
        ;;
      git)
        echo "  macOS:  xcode-select --install  OR  brew install git"
        echo "  Linux:  sudo apt install git  OR  sudo yum install git"
        ;;
    esac
    exit 1
  fi
}

check_command git
check_command node
check_command npm
check_command npx

echo "Dependencies OK: git, node ($(node -v)), npm ($(npm -v))"
echo ""

# ─── Clone or update repo ────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Repository already exists at $INSTALL_DIR"
  echo "Pulling latest changes..."
  cd "$INSTALL_DIR"
  git pull --rebase --autostash || echo "Warning: git pull failed, continuing with existing files"
else
  echo "Cloning $REPO to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
echo ""

# ─── Install npm dependencies ────────────────────────────────────────

echo "Installing npm dependencies..."
cd "$INSTALL_DIR"
npm install
echo ""

# ─── Import existing local sessions ──────────────────────────────────

CLAUDE_PROJECTS="$HOME/.claude/projects"
if [ -d "$CLAUDE_PROJECTS" ]; then
  JSONL_COUNT=$(find "$CLAUDE_PROJECTS" -name "*.jsonl" -size +5k 2>/dev/null | wc -l | tr -d ' ')
  if [ "$JSONL_COUNT" -gt 0 ]; then
    echo "Found $JSONL_COUNT existing sessions in ~/.claude/projects/"
    echo "Importing into memory repo..."
    cd "$INSTALL_DIR"
    npx tsx src/import-all.ts 2>&1
    echo ""

    # Commit imported sessions if any new files
    if ! git diff --quiet HEAD -- sessions/ 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard sessions/)" ]; then
      git add sessions/
      git commit -m "memory: import local sessions from $(hostname -s)" --no-gpg-sign 2>/dev/null || true
      git push 2>/dev/null || echo "  (push skipped — configure git remote first)"
    fi
    echo ""
  fi
fi

# ─── Build search index ──────────────────────────────────────────────

echo "Building search index..."
cd "$INSTALL_DIR"
npx tsx src/rebuild-index.ts 2>&1 || echo "Warning: index rebuild failed (may be OK on fresh install with no sessions)"
echo ""

# ─── Configure Claude Code (hooks + MCP server) ──────────────────────

echo "Configuring Claude Code..."
cd "$INSTALL_DIR"
npx tsx src/install-config.ts --install-dir "$INSTALL_DIR"
echo ""

# ─── Make hook scripts executable ─────────────────────────────────────

chmod +x "$INSTALL_DIR/hooks/session-start.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/hooks/session-end.sh" 2>/dev/null || true

# ─── Success ──────────────────────────────────────────────────────────

echo "============================================"
echo "  Claude Memory installed successfully!"
echo "============================================"
echo ""
echo "  Install dir:  $INSTALL_DIR"
echo "  Hooks:        ~/.claude/settings.json"
echo "  MCP server:   ~/.claude.json"
echo ""
echo "  Next steps:"
echo "    1. Restart Claude Code (quit and reopen)"
echo "    2. The memory system will activate automatically"
echo "    3. Use search_memory tool to search past sessions"
echo ""
echo "  To verify, start Claude Code and say:"
echo '    "Search my memory for recent sessions"'
echo ""

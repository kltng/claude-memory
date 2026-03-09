# Setup Guide — Cross-Machine Claude Memory

## Quick Install (One-Liner)

On a new machine, run:
```bash
curl -fsSL https://raw.githubusercontent.com/kltng/claude-memory/main/install.sh | bash
```

Or clone first and run locally:
```bash
git clone git@github.com:kltng/claude-memory.git ~/codebases/claude-memory
cd ~/codebases/claude-memory
./install.sh
```

### Custom install location
```bash
./install.sh --dir /path/to/claude-memory
```

### Custom repo URL
```bash
curl -fsSL https://raw.githubusercontent.com/kltng/claude-memory/main/install.sh | bash -s -- --repo https://github.com/kltng/claude-memory.git --dir ~/codebases/claude-memory
```

### Agent-Assisted Install

Tell Claude Code:
> "Help me install this memory system: https://github.com/kltng/claude-memory"

Claude Code can clone the repo and run `./install.sh` to set everything up automatically.

## What the Installer Does

1. Checks that `git`, `node`, `npm`, and `npx` are available
2. Clones the repo (or pulls if already cloned)
3. Runs `npm install`
4. Builds the search index (`npx tsx src/rebuild-index.ts`)
5. Adds SessionStart and SessionEnd hooks to `~/.claude/settings.json`
6. Adds the MCP server to `~/.claude.json`
7. Makes hook scripts executable

The installer is idempotent — safe to run multiple times. It will skip any configuration that already exists.

After installation, restart Claude Code for changes to take effect.

## Manual Setup (if preferred)

### 1. Clone the repo
```bash
git clone git@github.com:kltng/claude-memory.git ~/codebases/claude-memory
cd ~/codebases/claude-memory
npm install
```

### 2. Build the search index
```bash
npx tsx src/rebuild-index.ts
```

### 3. Add hooks to `~/.claude/settings.json`
Add this to your existing settings (merge with any existing hooks):
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "~/codebases/claude-memory/hooks/session-start.sh",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/codebases/claude-memory/hooks/session-end.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 4. Add MCP server to `~/.claude.json`
Add to the `mcpServers` object:
```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["--prefix", "~/codebases/claude-memory", "tsx", "~/codebases/claude-memory/src/server.ts"],
      "env": {
        "CLAUDE_MEMORY_ROOT": "~/codebases/claude-memory"
      }
    }
  }
}
```

### 5. Restart Claude Code
The MCP server and hooks activate on next session start.

## How It Works

### Auto-Capture Flow
```
SessionEnd → hooks/session-end.sh
  → src/capture.ts reads JSONL transcript from stdin
  → Converts to markdown → sessions/<project>/<date>/<id>.md
  → git add + commit + push
```

### Search Flow
```
Agent calls search_memory("query") via MCP
  → MiniSearch full-text search over 18K+ chunks
  → Returns ranked results with project, date, heading, score
```

### Sync Flow
```
SessionStart → hooks/session-start.sh
  → git pull --rebase --autostash
  → Rebuild index if markdown files changed
```

## MCP Tools Available

| Tool | Description |
|------|-------------|
| `search_memory` | Full-text search across all sessions and summaries |
| `list_sessions` | List sessions filtered by project/date |
| `get_session` | Retrieve full session transcript |
| `save_insight` | Save curated insight to summaries/ |
| `rebuild_index` | Rebuild search index from markdown files |

## Phase 3 (Future): Vector Search
- Add LanceDB for semantic/vector search
- Use Ollama + nomic-embed-text for local embeddings
- Hybrid search (vector + FTS) for better recall

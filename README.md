# claude-memory

Cross-machine memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Records every session as searchable markdown, syncs across machines via Git, and exposes full-text search through an MCP server.

## The Problem

Claude Code stores session transcripts and memory locally in `~/.claude/projects/`. If you work on the same projects across multiple machines, each machine has its own isolated memory. Agents on Machine B can't recall what you discussed on Machine A.

## What This Does

```
Machine A                        Machine B
┌──────────────┐                ┌──────────────┐
│ Claude Code  │                │ Claude Code  │
│  SessionEnd  │──capture──┐    │  SessionEnd  │──capture──┐
└──────────────┘           │    └──────────────┘           │
                           ▼                               ▼
                   ┌──────────────┐                ┌──────────────┐
                   │ sessions/    │                │ sessions/    │
                   │   project/   │                │   project/   │
                   │     date/    │                │     date/    │
                   │       id.md  │                │       id.md  │
                   └──────┬───────┘                └──────┬───────┘
                          │ git push                      │ git push
                          ▼                               ▼
                   ┌──────────────────────────────────────────┐
                   │         GitHub (private repo)            │
                   │  Markdown files = source of truth        │
                   └──────────────────────────────────────────┘
                          │ git pull (SessionStart)
                          ▼
                   ┌──────────────┐
                   │  MCP Server  │
                   │  MiniSearch  │──── search_memory("query")
                   │  (local FTS) │──── list_sessions(project)
                   └──────────────┘──── get_session(filepath)
```

**On every session end:** the JSONL transcript is converted to clean markdown, committed, and pushed to GitHub.

**On every session start:** git pulls the latest sessions from all machines and rebuilds the search index.

**During any session:** agents can call `search_memory` to recall past conversations, patterns, and decisions across all machines and projects.

## Quick Start

### One-liner install

```bash
git clone https://github.com/kltng/claude-memory.git ~/codebases/claude-memory
cd ~/codebases/claude-memory
./install.sh
```

The installer:
1. Installs npm dependencies
2. Imports all existing sessions from `~/.claude/projects/` into the memory repo
3. Builds the full-text search index
4. Adds `SessionStart` and `SessionEnd` hooks to `~/.claude/settings.json`
5. Registers the MCP server in `~/.claude.json`
6. Is idempotent — safe to run multiple times

After installation, **restart Claude Code** for changes to take effect.

### On a second machine

```bash
git clone https://github.com/kltng/claude-memory.git ~/codebases/claude-memory
cd ~/codebases/claude-memory
./install.sh
```

Same command. The installer detects the existing repo, imports any local sessions not already present, commits and pushes them, and sets up hooks + MCP server.

### Agent-assisted install

Tell Claude Code on any machine:

> "Help me install this memory system: https://github.com/kltng/claude-memory — clone it and run ./install.sh"

### Custom install location

```bash
./install.sh --dir /path/to/claude-memory
```

## How It Works

### Session Capture

When a Claude Code session ends, the `SessionEnd` hook fires:

1. **`hooks/session-end.sh`** receives hook input (JSON via stdin) containing `transcript_path`, `session_id`, and `cwd`
2. **`src/capture.ts`** reads the `.jsonl` transcript, parses each message, strips system tags, and converts to clean markdown
3. The markdown is saved to `sessions/<project>/<date>/<session-id>.md`
4. Changes are committed and pushed to the remote

The resulting markdown looks like:

```markdown
# Session: abc123-def456

| Field | Value |
|-------|-------|
| **Project** | my-app |
| **Date** | 2026-03-09 |
| **Branch** | main |
| **Messages** | 42 |

---

## User <sub>14:30:05</sub>

How do I fix the database connection timeout?

## Assistant <sub>14:30:12</sub>

The timeout is caused by...

**Tool: Bash**
` ``
{"command":"grep -r 'timeout' src/db/","description":"Search for timeout config"}
` ``
```

### Git Sync

- **SessionStart hook:** `git pull --rebase --autostash` to get sessions from other machines, then rebuilds the search index if new markdown was pulled
- **SessionEnd hook:** `git add sessions/ summaries/` → `git commit` → `git push`
- **Conflict strategy:** Session files have unique UUIDs, so they never conflict. Only summaries could theoretically conflict, handled by git merge.

### Search

Full-text search powered by [MiniSearch](https://github.com/lucaong/minisearch):

- Markdown files are chunked by headings (`##` / `###`)
- Each chunk is indexed with project name, date, session ID, and heading
- Fuzzy matching and prefix search enabled
- Search index stored locally as `search-index.json` (gitignored — rebuilt from markdown)

## MCP Tools

The MCP server exposes 5 tools to Claude Code agents:

### `search_memory`

Search across all recorded sessions and saved insights.

```
query: "database timeout fix"
project: "my-app"        (optional — filter by project)
limit: 10                (optional — default 20)
```

Returns ranked results with project, date, heading, session ID, and relevance score.

### `list_sessions`

List recorded sessions with optional filters.

```
project: "my-app"        (optional)
date: "2026-03"          (optional — prefix match)
limit: 20                (optional — default 50)
```

### `get_session`

Retrieve the full markdown transcript of a session.

```
filepath: "sessions/my-app/2026-03-09/abc123.md"
```

Truncated at 50,000 characters to stay within context limits.

### `save_insight`

Save a curated insight to the summaries collection.

```
project: "my-app"
topic: "database-patterns"
content: "## Connection Pooling\n\nAlways use..."
append: true             (optional — default true)
```

Saved to `summaries/<project>/<topic>.md`. Useful for distilling recurring patterns from raw sessions.

### `rebuild_index`

Manually rebuild the search index from all markdown files.

## Project Structure

```
claude-memory/
├── sessions/                    # Auto-captured transcripts (git tracked)
│   ├── my-app/
│   │   └── 2026-03-09/
│   │       └── abc123.md
│   └── other-project/
│       └── ...
├── summaries/                   # Curated insights (git tracked)
│   └── my-app/
│       └── database-patterns.md
├── src/
│   ├── server.ts                # MCP server (5 tools)
│   ├── capture.ts               # JSONL → markdown converter
│   ├── search.ts                # MiniSearch wrapper
│   ├── rebuild-index.ts         # Index rebuild script
│   ├── import-all.ts            # Bulk import from ~/.claude/projects/
│   ├── install-config.ts        # Installer config helper
│   ├── sync.ts                  # Git pull/push helper
│   └── __tests__/               # 70 tests
│       ├── capture.test.ts
│       ├── search.test.ts
│       ├── server.test.ts
│       └── fixtures/
├── hooks/
│   ├── session-start.sh         # git pull + rebuild index
│   └── session-end.sh           # capture + git push
├── install.sh                   # Automated installer
├── search-index.json            # Full-text index (gitignored)
├── package.json
└── tsconfig.json
```

## Configuration

### Hooks (added to `~/.claude/settings.json`)

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

### MCP Server (added to `~/.claude.json`)

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

## Token Overhead

| Component | Tokens | When |
|-----------|--------|------|
| Tool definitions (5 tools) | ~700 | Every session (constant) |
| `search_memory` result | ~300–500 | Per search call |
| `list_sessions` result | ~200–1,000 | Per list call |
| `get_session` result | ~500–12,500 | Per retrieval (capped) |
| `save_insight` confirmation | ~50 | Per save call |
| Hooks | 0 | Run outside context window |

**Constant overhead: ~700 tokens per session (+10–13% of typical baseline).** Claude Code's MCP Tool Search defers tool loading, so the actual overhead is near-zero until a memory tool is invoked.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (v2.1+)
- Node.js 18+
- Git
- A GitHub account (for cross-machine sync)

## Development

```bash
# Run tests
npm test

# Rebuild search index manually
npx tsx src/rebuild-index.ts

# Import all local sessions
npx tsx src/import-all.ts
```

## Roadmap

- [ ] **Vector search** — Add LanceDB + Ollama (`nomic-embed-text`) for semantic search alongside full-text
- [ ] **Session summarization** — Auto-summarize sessions into topic-level summaries using Claude
- [ ] **Cross-project knowledge graph** — Track relationships between concepts across projects

## License

MIT

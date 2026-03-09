# claude-memory

Cross-machine memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Records every session as searchable markdown, syncs across machines via Git, and exposes full-text search, semantic search, session summarization, and a knowledge graph through an MCP server.

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
                   ┌──────────────────────────────────────┐
                   │            MCP Server                │
                   │  ┌────────────┐  ┌────────────────┐  │
                   │  │ MiniSearch │  │ Transformers.js │  │
                   │  │  (FTS)     │  │ (vectors)       │  │
                   │  └────────────┘  └────────────────┘  │
                   │  ┌────────────┐  ┌────────────────┐  │
                   │  │ Summaries  │  │ Knowledge      │  │
                   │  │ (digests)  │  │ Graph          │  │
                   │  └────────────┘  └────────────────┘  │
                   └──────────────────────────────────────┘
```

**On every session end:** the JSONL transcript is converted to clean markdown, committed, and pushed to GitHub.

**On every session start:** git pulls the latest sessions from all machines and rebuilds the search index.

**During any session:** agents can search memory (keyword or semantic), summarize past sessions, and build a knowledge graph of concepts, tools, and patterns across all projects.

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

#### Full-Text Search (MiniSearch)

- Markdown files are chunked by headings (`##` / `###`)
- Each chunk is indexed with project name, date, session ID, and heading
- Fuzzy matching and prefix search enabled
- Search index stored locally as `search-index.json` (gitignored — rebuilt from markdown)

#### Semantic / Vector Search (Transformers.js)

- Uses [`all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2) for 384-dimensional embeddings
- Runs entirely locally via [@huggingface/transformers](https://github.com/huggingface/transformers.js) — no external APIs or Ollama required
- First run downloads the model (~80MB), cached locally afterwards
- **Hybrid search** combines vector + keyword results using Reciprocal Rank Fusion (RRF)
- Vector index stored locally as `vector-index.json` (gitignored — rebuilt from markdown)

### Session Summarization

Agents can summarize sessions into concise digests:

1. Call `get_unsummarized_sessions` to find sessions needing summaries
2. Read each session with `get_session`
3. Call `save_session_summary` with a title, summary, tags, and extracted entities/relations

Summaries are stored at `summaries/<project>/digests/<session-id>.md` and automatically indexed for search. The `save_session_summary` tool can simultaneously populate the knowledge graph with extracted entities and relations.

### Knowledge Graph

A lightweight entity–relation graph that tracks concepts, tools, patterns, and their connections across all projects:

- **Entity types:** project, file, concept, tool, library, pattern, error, person, service
- **Relation types:** uses, depends_on, implements, fixes, related_to, part_of, alternative_to, caused_by, learned_from, configured_with, deployed_to
- **Provenance:** every entity/relation tracks which sessions and projects it was mentioned in
- **Queries:** search entities, explore connections, find paths between concepts, identify hub entities
- Stored as `knowledge-graph.json` (git-tracked — shared across machines)

## MCP Tools

The MCP server exposes 15 tools:

### Search

| Tool | Description |
|------|-------------|
| `search_memory` | Full-text keyword search across all sessions and insights |
| `semantic_search` | Vector similarity search, with hybrid mode (FTS + vectors via RRF). Falls back to FTS if vector index not built |
| `rebuild_index` | Rebuild the full-text search index |
| `rebuild_vector_index` | Rebuild the vector index (downloads model on first run) |

### Sessions

| Tool | Description |
|------|-------------|
| `list_sessions` | List sessions filtered by project and/or date |
| `get_session` | Retrieve full markdown transcript (truncated at 50K chars) |
| `save_insight` | Save a curated insight to `summaries/<project>/<topic>.md` |

### Summarization

| Tool | Description |
|------|-------------|
| `get_unsummarized_sessions` | List sessions that don't have a summary digest yet |
| `save_session_summary` | Save a session summary with title, tags, and optional KG entities/relations |
| `list_summaries` | List all summaries and insights across projects |

### Knowledge Graph

| Tool | Description |
|------|-------------|
| `kg_add` | Add entities and relations (auto-creates missing entities, deduplicates by name) |
| `kg_search` | Search entities by name, type, or project |
| `kg_query` | Explore entity connections, find paths between entities, list hubs, or view stats |
| `kg_remove` | Remove an entity (and its relations) or a specific relation |

## Updating

To pull new features from the public template into your installed copy:

```bash
cd ~/codebases/claude-memory
./update.sh
```

This fetches upstream changes, merges them (keeping your session data, taking upstream code), reinstalls dependencies, rebuilds the search index, and pushes to your private repo.

## Project Structure

```
claude-memory/
├── sessions/                    # Auto-captured transcripts (git tracked)
│   ├── my-app/
│   │   └── 2026-03-09/
│   │       └── abc123.md
│   └── other-project/
│       └── ...
├── summaries/                   # Curated insights + session digests (git tracked)
│   └── my-app/
│       ├── database-patterns.md
│       └── digests/
│           └── abc123.md
├── src/
│   ├── server.ts                # MCP server (15 tools)
│   ├── capture.ts               # JSONL → markdown converter
│   ├── search.ts                # MiniSearch wrapper (FTS)
│   ├── vector-search.ts         # Transformers.js embeddings + cosine similarity
│   ├── knowledge-graph.ts       # Entity–relation graph with BFS path finding
│   ├── rebuild-index.ts         # FTS index rebuild script
│   ├── rebuild-vector-index.ts  # Vector index rebuild script
│   ├── import-all.ts            # Bulk import from ~/.claude/projects/
│   ├── install-config.ts        # Installer config helper
│   ├── sync.ts                  # Git pull/push helper
│   └── __tests__/               # 81 tests
│       ├── capture.test.ts
│       ├── search.test.ts
│       ├── server.test.ts
│       └── knowledge-graph.test.ts
├── hooks/
│   ├── session-start.sh         # git pull + rebuild index
│   └── session-end.sh           # capture + git push
├── install.sh                   # Automated installer
├── update.sh                    # Pull upstream code updates
├── search-index.json            # FTS index (gitignored)
├── vector-index.json            # Vector index (gitignored)
├── knowledge-graph.json         # Knowledge graph (git tracked)
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
| Tool definitions (15 tools) | ~2,000 | Every session (constant, deferred) |
| `search_memory` result | ~300–500 | Per search call |
| `semantic_search` result | ~400–800 | Per search call |
| `list_sessions` result | ~200–1,000 | Per list call |
| `get_session` result | ~500–12,500 | Per retrieval (capped) |
| `kg_query` result | ~200–1,000 | Per query call |
| `save_*` confirmations | ~50 | Per save call |
| Hooks | 0 | Run outside context window |

Claude Code's MCP Tool Search defers tool loading, so the actual overhead is near-zero until a memory tool is invoked.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (v2.1+)
- Node.js 18+
- Git
- A GitHub account (for cross-machine sync)

## Development

```bash
# Run all tests (81 tests)
npm test

# Rebuild full-text search index
npx tsx src/rebuild-index.ts

# Rebuild vector search index (downloads model on first run)
npx tsx src/rebuild-vector-index.ts

# Import all local sessions
npx tsx src/import-all.ts
```

## License

MIT

# Claude Memory — Cross-Machine Memory System

## Overview
Centralized memory system that records all Claude Code sessions across machines,
indexes them for full-text search, and exposes search via an MCP server.

## Architecture
- **sessions/** — Auto-captured session transcripts (markdown), organized by `project/date/session-id.md`
- **summaries/** — Curated insights and patterns, organized by `project/topic.md`
- **src/server.ts** — MCP server exposing `search_memory`, `list_sessions`, `get_session`, `save_insight`, `rebuild_index`
- **src/capture.ts** — SessionEnd hook script: converts JSONL transcript → markdown
- **src/search.ts** — MiniSearch wrapper for full-text indexing
- **src/sync.ts** — Git pull/push helper
- **src/import-all.ts** — One-time bulk import of all existing sessions
- **hooks/** — Shell scripts called by Claude Code hooks

## Search Index
- MiniSearch-based full-text search over all markdown
- Index stored in `search-index.json` (gitignored, rebuilt locally)
- Rebuild: `npx tsx src/rebuild-index.ts`

## Git Sync
- Markdown files are the source of truth (git tracked)
- Search index is a build artifact (gitignored)
- SessionStart hook: `git pull` + rebuild index if changed
- SessionEnd hook: capture session + `git commit` + `git push`

## Setup on New Machine
1. `git clone <repo-url> ~/codebases/claude-memory`
2. `cd ~/codebases/claude-memory && npm install`
3. Add hooks to `~/.claude/settings.json` (see hooks/ directory)
4. Add MCP server to `~/.claude.json` (mcpServers.claude-memory)
5. `npx tsx src/rebuild-index.ts`

## Tech Stack
- TypeScript + tsx
- MiniSearch for full-text search
- MCP SDK (@modelcontextprotocol/sdk)
- Git/GitHub for sync

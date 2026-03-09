/**
 * MCP Server for Claude Memory — exposes search tools to Claude Code agents.
 * Tools: search_memory, list_sessions, get_session, save_insight
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { MemorySearch } from "./search.js";

const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");
const search = new MemorySearch(MEMORY_ROOT);

// Load or rebuild index on startup
if (!search.load()) {
  const count = search.rebuild(MEMORY_ROOT);
  search.save();
  process.stderr.write(`claude-memory: built index with ${count} chunks\n`);
} else {
  process.stderr.write(`claude-memory: loaded index with ${search.documentCount} chunks\n`);
}

const server = new McpServer({
  name: "claude-memory",
  version: "0.1.0",
});

// ─── Tool: search_memory ────────────────────────────────────────────

server.tool(
  "search_memory",
  "Search across all recorded Claude Code sessions and saved insights. Use this to recall past conversations, decisions, code patterns, and debugging solutions.",
  {
    query: z.string().describe("Search query — keywords, phrases, or questions"),
    project: z.string().optional().describe("Filter by project name (e.g., 'lcsh', 'calendar-converter')"),
    limit: z.number().optional().describe("Max results to return (default 20)"),
  },
  async ({ query, project, limit }) => {
    const results = search.search(query, { project, limit: limit || 20 });

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${query}".` }],
      };
    }

    const formatted = results.map((r, i) => {
      return `### ${i + 1}. [${r.project}] ${r.heading} (score: ${r.score.toFixed(1)})\n- **Session:** ${r.sessionId}\n- **Date:** ${r.date}\n- **File:** ${r.filepath}`;
    });

    return {
      content: [{
        type: "text" as const,
        text: `Found ${results.length} results for "${query}":\n\n${formatted.join("\n\n")}`,
      }],
    };
  }
);

// ─── Tool: list_sessions ────────────────────────────────────────────

server.tool(
  "list_sessions",
  "List recorded sessions, optionally filtered by project or date range.",
  {
    project: z.string().optional().describe("Filter by project name"),
    date: z.string().optional().describe("Filter by date (YYYY-MM-DD) or date prefix (YYYY-MM)"),
    limit: z.number().optional().describe("Max sessions to return (default 50)"),
  },
  async ({ project, date, limit }) => {
    const sessionsDir = join(MEMORY_ROOT, "sessions");
    if (!existsSync(sessionsDir)) {
      return { content: [{ type: "text" as const, text: "No sessions recorded yet." }] };
    }

    const sessions: { project: string; date: string; sessionId: string; filepath: string; size: number }[] = [];

    for (const proj of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      if (project && proj.name !== project) continue;

      const projDir = join(sessionsDir, proj.name);
      for (const dateDir of readdirSync(projDir, { withFileTypes: true })) {
        if (!dateDir.isDirectory()) continue;
        if (date && !dateDir.name.startsWith(date)) continue;

        const datePath = join(projDir, dateDir.name);
        for (const file of readdirSync(datePath)) {
          if (!file.endsWith(".md")) continue;
          const filepath = join("sessions", proj.name, dateDir.name, file);
          const fullPath = join(MEMORY_ROOT, filepath);
          const stat = statSync(fullPath);
          sessions.push({
            project: proj.name,
            date: dateDir.name,
            sessionId: file.replace(".md", ""),
            filepath,
            size: stat.size,
          });
        }
      }
    }

    // Sort by date descending
    sessions.sort((a, b) => b.date.localeCompare(a.date));
    const limited = sessions.slice(0, limit || 50);

    if (limited.length === 0) {
      return { content: [{ type: "text" as const, text: "No sessions match the filter." }] };
    }

    const lines = limited.map(
      (s) => `- **${s.date}** | ${s.project} | ${s.sessionId} (${(s.size / 1024).toFixed(1)}KB)`
    );

    return {
      content: [{
        type: "text" as const,
        text: `${sessions.length} sessions found:\n\n${lines.join("\n")}`,
      }],
    };
  }
);

// ─── Tool: get_session ──────────────────────────────────────────────

server.tool(
  "get_session",
  "Retrieve the full markdown transcript of a specific session.",
  {
    filepath: z.string().describe("Relative path to the session file (e.g., 'sessions/lcsh/2026-03-09/abc123.md')"),
  },
  async ({ filepath }) => {
    const fullPath = join(MEMORY_ROOT, filepath);
    if (!existsSync(fullPath)) {
      return { content: [{ type: "text" as const, text: `Session file not found: ${filepath}` }] };
    }

    const content = readFileSync(fullPath, "utf-8");
    // Truncate if too large
    const maxLen = 50000;
    const truncated = content.length > maxLen
      ? content.slice(0, maxLen) + "\n\n…[truncated, total " + content.length + " chars]"
      : content;

    return {
      content: [{ type: "text" as const, text: truncated }],
    };
  }
);

// ─── Tool: save_insight ─────────────────────────────────────────────

server.tool(
  "save_insight",
  "Save a curated insight, pattern, or decision to the summaries collection. Use this to record important learnings that should persist across sessions.",
  {
    project: z.string().describe("Project name (e.g., 'lcsh')"),
    topic: z.string().describe("Topic filename without extension (e.g., 'api-patterns', 'debugging-notes')"),
    content: z.string().describe("Markdown content to save"),
    append: z.boolean().optional().describe("Append to existing file instead of overwriting (default true)"),
  },
  async ({ project, topic, content, append }) => {
    const dir = join(MEMORY_ROOT, "summaries", project);
    mkdirSync(dir, { recursive: true });

    const filepath = join(dir, `${topic}.md`);
    const shouldAppend = append !== false;

    if (shouldAppend && existsSync(filepath)) {
      const existing = readFileSync(filepath, "utf-8");
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      writeFileSync(filepath, `${existing}\n\n---\n_Added: ${timestamp}_\n\n${content}`, "utf-8");
    } else {
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      writeFileSync(filepath, `# ${topic}\n\n_Created: ${timestamp}_\n\n${content}`, "utf-8");
    }

    // Rebuild index to include new content
    const count = search.rebuild(MEMORY_ROOT);
    search.save();

    return {
      content: [{
        type: "text" as const,
        text: `Saved insight to summaries/${project}/${topic}.md (index: ${count} chunks)`,
      }],
    };
  }
);

// ─── Tool: rebuild_index ────────────────────────────────────────────

server.tool(
  "rebuild_index",
  "Rebuild the search index from all markdown files. Run this after pulling new sessions from git.",
  {},
  async () => {
    const count = search.rebuild(MEMORY_ROOT);
    search.save();
    return {
      content: [{ type: "text" as const, text: `Index rebuilt: ${count} chunks indexed.` }],
    };
  }
);

// ─── Start server ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("claude-memory MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`server error: ${err}\n`);
  process.exit(1);
});

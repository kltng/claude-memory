/**
 * MCP Server for Claude Memory — exposes search, summarization, and knowledge graph tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { MemorySearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { KnowledgeGraph } from "./knowledge-graph.js";
import type { EntityType, RelationType } from "./knowledge-graph.js";

const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");
const search = new MemorySearch(MEMORY_ROOT);
const vectorSearch = new VectorSearch(MEMORY_ROOT);
const kg = new KnowledgeGraph(MEMORY_ROOT);

// Load or rebuild FTS index on startup
if (!search.load()) {
  const count = search.rebuild(MEMORY_ROOT);
  search.save();
  process.stderr.write(`claude-memory: built FTS index with ${count} chunks\n`);
} else {
  process.stderr.write(`claude-memory: loaded FTS index with ${search.documentCount} chunks\n`);
}

// Load vector index if available (don't rebuild on startup — it's slow)
if (vectorSearch.load()) {
  process.stderr.write(`claude-memory: loaded vector index with ${vectorSearch.documentCount} chunks\n`);
} else {
  process.stderr.write(`claude-memory: no vector index found — run rebuild_vector_index to build it\n`);
}

// Load knowledge graph
if (kg.load()) {
  process.stderr.write(`claude-memory: loaded knowledge graph (${kg.entityCount} entities, ${kg.relationCount} relations)\n`);
} else {
  process.stderr.write(`claude-memory: no knowledge graph found — use kg_add to start building it\n`);
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

// ─── Tool: semantic_search ──────────────────────────────────────────

server.tool(
  "semantic_search",
  "Semantic search across sessions using vector embeddings. Better than keyword search for finding conceptually similar content (e.g., 'how to fix timeouts' finds discussions about connection pooling). Falls back to keyword search if vector index is not built yet.",
  {
    query: z.string().describe("Natural language search query"),
    project: z.string().optional().describe("Filter by project name"),
    limit: z.number().optional().describe("Max results to return (default 10)"),
    hybrid: z.boolean().optional().describe("Combine vector + keyword search using RRF (default true)"),
  },
  async ({ query, project, limit, hybrid }) => {
    const useHybrid = hybrid !== false;
    const maxResults = limit || 10;

    if (vectorSearch.documentCount === 0) {
      // Fallback to FTS
      const results = search.search(query, { project, limit: maxResults });
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No results found for "${query}". Vector index not built — run rebuild_vector_index first for semantic search.` }] };
      }
      const formatted = results.map((r, i) =>
        `### ${i + 1}. [${r.project}] ${r.heading} (FTS score: ${r.score.toFixed(1)})\n- **Session:** ${r.sessionId}\n- **Date:** ${r.date}\n- **File:** ${r.filepath}`
      );
      return {
        content: [{ type: "text" as const, text: `No vector index — falling back to keyword search.\nFound ${results.length} results:\n\n${formatted.join("\n\n")}` }],
      };
    }

    let results;
    if (useHybrid) {
      const ftsResults = search.search(query, { project, limit: 50 }).map((r) => ({ id: r.id, score: r.score }));
      results = await vectorSearch.hybridSearch(query, ftsResults, { project, limit: maxResults });
    } else {
      results = await vectorSearch.search(query, { project, limit: maxResults });
    }

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: `No results found for "${query}".` }] };
    }

    const formatted = results.map((r, i) =>
      `### ${i + 1}. [${r.project}] ${r.heading} (similarity: ${r.similarity.toFixed(3)})\n- **Session:** ${r.sessionId}\n- **Date:** ${r.date}\n- **File:** ${r.filepath}\n- **Snippet:** ${r.snippet}…`
    );

    const mode = useHybrid ? "hybrid (vector + keyword)" : "vector";
    return {
      content: [{
        type: "text" as const,
        text: `Found ${results.length} results via ${mode} search for "${query}":\n\n${formatted.join("\n\n")}`,
      }],
    };
  }
);

// ─── Tool: rebuild_index ────────────────────────────────────────────

server.tool(
  "rebuild_index",
  "Rebuild the full-text search index from all markdown files. Run this after pulling new sessions from git.",
  {},
  async () => {
    const count = search.rebuild(MEMORY_ROOT);
    search.save();
    return {
      content: [{ type: "text" as const, text: `FTS index rebuilt: ${count} chunks indexed.` }],
    };
  }
);

// ─── Tool: rebuild_vector_index ─────────────────────────────────────

server.tool(
  "rebuild_vector_index",
  "Rebuild the vector/semantic search index. Downloads the embedding model on first run (~80MB). Embeds all markdown chunks — may take a few minutes for large collections.",
  {},
  async () => {
    try {
      const count = await vectorSearch.rebuild(MEMORY_ROOT);
      vectorSearch.save();
      return {
        content: [{ type: "text" as const, text: `Vector index rebuilt: ${count} chunks embedded and indexed.` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Vector index rebuild failed: ${err}` }],
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// SESSION SUMMARIZATION TOOLS
// ═══════════════════════════════════════════════════════════════════

// ─── Tool: get_unsummarized_sessions ────────────────────────────────

server.tool(
  "get_unsummarized_sessions",
  "List sessions that don't have a summary yet. Use this to find sessions that need summarization, then read each one and call save_session_summary.",
  {
    project: z.string().optional().describe("Filter by project name"),
    limit: z.number().optional().describe("Max sessions to return (default 20)"),
  },
  async ({ project, limit }) => {
    const sessionsDir = join(MEMORY_ROOT, "sessions");
    if (!existsSync(sessionsDir)) {
      return { content: [{ type: "text" as const, text: "No sessions recorded yet." }] };
    }

    const unsummarized: { project: string; date: string; sessionId: string; filepath: string; size: number }[] = [];

    for (const proj of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      if (project && proj.name !== project) continue;

      const projDir = join(sessionsDir, proj.name);
      for (const dateDir of readdirSync(projDir, { withFileTypes: true })) {
        if (!dateDir.isDirectory()) continue;

        const datePath = join(projDir, dateDir.name);
        for (const file of readdirSync(datePath)) {
          if (!file.endsWith(".md")) continue;
          const sessionId = file.replace(".md", "");
          const filepath = join("sessions", proj.name, dateDir.name, file);

          // Check if summary already exists
          const summaryPath = join(MEMORY_ROOT, "summaries", proj.name, "digests", `${sessionId}.md`);
          if (existsSync(summaryPath)) continue;

          const fullPath = join(MEMORY_ROOT, filepath);
          const stat = statSync(fullPath);
          unsummarized.push({
            project: proj.name,
            date: dateDir.name,
            sessionId,
            filepath,
            size: stat.size,
          });
        }
      }
    }

    unsummarized.sort((a, b) => b.date.localeCompare(a.date));
    const limited = unsummarized.slice(0, limit || 20);

    if (limited.length === 0) {
      return { content: [{ type: "text" as const, text: "All sessions have been summarized!" }] };
    }

    const lines = limited.map(
      (s) => `- **${s.date}** | ${s.project} | ${s.sessionId} (${(s.size / 1024).toFixed(1)}KB) → \`${s.filepath}\``
    );

    return {
      content: [{
        type: "text" as const,
        text: `${unsummarized.length} unsummarized sessions (showing ${limited.length}):\n\n${lines.join("\n")}\n\nWorkflow: call get_session for each, then save_session_summary with your summary.`,
      }],
    };
  }
);

// ─── Tool: save_session_summary ─────────────────────────────────────

server.tool(
  "save_session_summary",
  "Save a summary for a specific session. The summary should capture: what was done, key decisions, problems solved, tools/patterns used, and any insights worth remembering.",
  {
    project: z.string().describe("Project name"),
    session_id: z.string().describe("Session ID being summarized"),
    date: z.string().describe("Session date (YYYY-MM-DD)"),
    title: z.string().describe("Short title describing the session (e.g., 'Fixed auth timeout bug')"),
    summary: z.string().describe("Markdown summary of the session"),
    tags: z.array(z.string()).optional().describe("Tags for categorization (e.g., ['bugfix', 'auth', 'timeout'])"),
    entities: z.array(z.object({
      name: z.string(),
      type: z.string().describe("Entity type: project, file, concept, tool, library, pattern, error, person, service"),
      description: z.string().optional(),
    })).optional().describe("Key entities to add to the knowledge graph"),
    relations: z.array(z.object({
      source: z.string(),
      target: z.string(),
      type: z.string().describe("Relation type: uses, depends_on, implements, fixes, related_to, part_of, alternative_to, caused_by, learned_from, configured_with, deployed_to"),
      description: z.string().optional(),
    })).optional().describe("Relations between entities to add to the knowledge graph"),
  },
  async ({ project, session_id, date, title, summary, tags, entities, relations }) => {
    // Save the summary
    const dir = join(MEMORY_ROOT, "summaries", project, "digests");
    mkdirSync(dir, { recursive: true });

    const filepath = join(dir, `${session_id}.md`);
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const tagLine = tags && tags.length > 0 ? `\n**Tags:** ${tags.map(t => `\`${t}\``).join(", ")}\n` : "";

    const content = `# ${title}

| Field | Value |
|-------|-------|
| **Project** | ${project} |
| **Session** | ${session_id} |
| **Date** | ${date} |
| **Summarized** | ${timestamp} |
${tagLine}
---

${summary}
`;

    writeFileSync(filepath, content, "utf-8");

    // Add entities and relations to KG if provided
    const mention = { sessionId: session_id, project, date };
    let kgUpdated = false;

    if (entities && entities.length > 0) {
      for (const e of entities) {
        kg.addEntity(e.name, e.type as EntityType, e.description || "", mention);
      }
      kgUpdated = true;
    }

    if (relations && relations.length > 0) {
      for (const r of relations) {
        kg.addRelation(r.source, r.target, r.type as RelationType, r.description || "", mention);
      }
      kgUpdated = true;
    }

    if (kgUpdated) {
      kg.save();
    }

    // Rebuild FTS index to include the summary
    const count = search.rebuild(MEMORY_ROOT);
    search.save();

    const kgMsg = kgUpdated
      ? ` | KG: +${entities?.length || 0} entities, +${relations?.length || 0} relations`
      : "";

    return {
      content: [{
        type: "text" as const,
        text: `Summary saved: summaries/${project}/digests/${session_id}.md (index: ${count} chunks${kgMsg})`,
      }],
    };
  }
);

// ─── Tool: list_summaries ───────────────────────────────────────────

server.tool(
  "list_summaries",
  "List all session summaries and insights, optionally filtered by project.",
  {
    project: z.string().optional().describe("Filter by project name"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ project, limit }) => {
    const summariesDir = join(MEMORY_ROOT, "summaries");
    if (!existsSync(summariesDir)) {
      return { content: [{ type: "text" as const, text: "No summaries yet." }] };
    }

    const summaries: { project: string; file: string; title: string; filepath: string }[] = [];

    for (const proj of readdirSync(summariesDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      if (project && proj.name !== project) continue;

      const projDir = join(summariesDir, proj.name);
      const walkDir = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walkDir(join(dir, entry.name));
          } else if (entry.name.endsWith(".md")) {
            const fullPath = join(dir, entry.name);
            const content = readFileSync(fullPath, "utf-8");
            const titleMatch = content.match(/^#\s+(.+)/m);
            const relPath = fullPath.replace(MEMORY_ROOT + "/", "");
            summaries.push({
              project: proj.name,
              file: entry.name,
              title: titleMatch ? titleMatch[1] : entry.name.replace(".md", ""),
              filepath: relPath,
            });
          }
        }
      };
      walkDir(projDir);
    }

    const limited = summaries.slice(0, limit || 50);

    if (limited.length === 0) {
      return { content: [{ type: "text" as const, text: "No summaries match the filter." }] };
    }

    const lines = limited.map(
      (s) => `- **[${s.project}]** ${s.title} → \`${s.filepath}\``
    );

    return {
      content: [{
        type: "text" as const,
        text: `${summaries.length} summaries found:\n\n${lines.join("\n")}`,
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH TOOLS
// ═══════════════════════════════════════════════════════════════════

const ENTITY_TYPES = ["project", "file", "concept", "tool", "library", "pattern", "error", "person", "service", "other"] as const;
const RELATION_TYPES = ["uses", "depends_on", "implements", "fixes", "related_to", "part_of", "alternative_to", "caused_by", "learned_from", "configured_with", "deployed_to", "other"] as const;

// ─── Tool: kg_add ───────────────────────────────────────────────────

server.tool(
  "kg_add",
  "Add entities and relations to the knowledge graph. Entities are deduplicated by normalized name — adding an existing entity merges the new info. Use this to record concepts, tools, patterns, and their relationships as you discover them.",
  {
    entities: z.array(z.object({
      name: z.string().describe("Entity name (e.g., 'MiniSearch', 'react-query', 'session timeout bug')"),
      type: z.enum(ENTITY_TYPES).describe("Entity type"),
      description: z.string().optional().describe("Short description"),
      properties: z.record(z.string()).optional().describe("Arbitrary key-value properties"),
    })).optional().describe("Entities to add"),
    relations: z.array(z.object({
      source: z.string().describe("Source entity name"),
      target: z.string().describe("Target entity name"),
      type: z.enum(RELATION_TYPES).describe("Relation type"),
      description: z.string().optional().describe("Description of the relation"),
    })).optional().describe("Relations to add"),
    project: z.string().optional().describe("Project context for provenance tracking"),
    session_id: z.string().optional().describe("Session ID for provenance tracking"),
    date: z.string().optional().describe("Date for provenance (YYYY-MM-DD)"),
  },
  async ({ entities, relations, project, session_id, date }) => {
    const mention = (project || session_id)
      ? { sessionId: session_id || "manual", project: project || "unknown", date: date || new Date().toISOString().slice(0, 10) }
      : undefined;

    let entitiesAdded = 0;
    let relationsAdded = 0;

    if (entities) {
      for (const e of entities) {
        kg.addEntity(e.name, e.type, e.description || "", mention, e.properties);
        entitiesAdded++;
      }
    }

    if (relations) {
      for (const r of relations) {
        // Auto-create entities if they don't exist
        if (!kg.getEntity(r.source)) {
          kg.addEntity(r.source, "other", "", mention);
        }
        if (!kg.getEntity(r.target)) {
          kg.addEntity(r.target, "other", "", mention);
        }
        kg.addRelation(r.source, r.target, r.type, r.description || "", mention);
        relationsAdded++;
      }
    }

    kg.save();

    return {
      content: [{
        type: "text" as const,
        text: `Knowledge graph updated: +${entitiesAdded} entities, +${relationsAdded} relations (total: ${kg.entityCount} entities, ${kg.relationCount} relations)`,
      }],
    };
  }
);

// ─── Tool: kg_search ────────────────────────────────────────────────

server.tool(
  "kg_search",
  "Search the knowledge graph for entities by name, type, or project. Returns matching entities with their descriptions and connection counts.",
  {
    query: z.string().optional().describe("Search in entity names and descriptions"),
    type: z.enum(ENTITY_TYPES).optional().describe("Filter by entity type"),
    project: z.string().optional().describe("Filter by project where entity was mentioned"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, type, project, limit }) => {
    const results = kg.searchEntities({ query, type, project, limit: limit || 20 });

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No entities found." }] };
    }

    const formatted = results.map((e) => {
      const rels = kg.getRelationsFor(e.id);
      const connCount = rels.outgoing.length + rels.incoming.length;
      const projects = [...new Set(e.mentions.map((m) => m.project))].join(", ");
      return `- **${e.name}** (${e.type}) — ${e.description || "no description"}\n  Mentions: ${e.mentions.length} | Connections: ${connCount} | Projects: ${projects}`;
    });

    return {
      content: [{
        type: "text" as const,
        text: `Found ${results.length} entities:\n\n${formatted.join("\n")}`,
      }],
    };
  }
);

// ─── Tool: kg_query ─────────────────────────────────────────────────

server.tool(
  "kg_query",
  "Query the knowledge graph for an entity's connections, find paths between entities, or explore the graph structure.",
  {
    entity: z.string().optional().describe("Entity name to explore (shows all connections)"),
    from: z.string().optional().describe("Find path FROM this entity (use with 'to')"),
    to: z.string().optional().describe("Find path TO this entity (use with 'from')"),
    hubs: z.boolean().optional().describe("Return the most connected entities"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ entity, from, to, hubs, limit }) => {
    // Mode 1: explore an entity's connections
    if (entity) {
      const e = kg.getEntity(entity);
      if (!e) {
        return { content: [{ type: "text" as const, text: `Entity not found: "${entity}"` }] };
      }

      const rels = kg.getRelationsFor(entity);
      const lines: string[] = [];
      lines.push(`## ${e.name} (${e.type})`);
      if (e.description) lines.push(e.description);
      lines.push("");

      if (rels.outgoing.length > 0) {
        lines.push("**Outgoing relations:**");
        for (const r of rels.outgoing) {
          const target = r.targetEntity ? r.targetEntity.name : r.target;
          lines.push(`- —[${r.type}]→ **${target}**${r.description ? `: ${r.description}` : ""}`);
        }
        lines.push("");
      }

      if (rels.incoming.length > 0) {
        lines.push("**Incoming relations:**");
        for (const r of rels.incoming) {
          const source = r.sourceEntity ? r.sourceEntity.name : r.source;
          lines.push(`- ←[${r.type}]— **${source}**${r.description ? `: ${r.description}` : ""}`);
        }
        lines.push("");
      }

      if (rels.outgoing.length === 0 && rels.incoming.length === 0) {
        lines.push("_No relations found._");
      }

      const projects = [...new Set(e.mentions.map((m) => m.project))].join(", ");
      lines.push(`\n**Mentioned in:** ${e.mentions.length} sessions | **Projects:** ${projects}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    // Mode 2: find path between entities
    if (from && to) {
      const path = kg.findPath(from, to);
      if (!path) {
        return { content: [{ type: "text" as const, text: `No path found between "${from}" and "${to}".` }] };
      }

      const pathStr = path.map((e) => `**${e.name}** (${e.type})`).join(" → ");
      return { content: [{ type: "text" as const, text: `Path: ${pathStr}` }] };
    }

    // Mode 3: show hubs
    if (hubs) {
      const hubList = kg.getHubs(limit || 20);
      if (hubList.length === 0) {
        return { content: [{ type: "text" as const, text: "Knowledge graph is empty." }] };
      }

      const lines = hubList.map(
        (h) => `- **${h.entity.name}** (${h.entity.type}) — ${h.connectionCount} connections`
      );
      return {
        content: [{ type: "text" as const, text: `Most connected entities:\n\n${lines.join("\n")}` }],
      };
    }

    // Default: show stats
    const stats = kg.stats();
    const typeLines = Object.entries(stats.entityTypes)
      .sort(([, a], [, b]) => b - a)
      .map(([t, c]) => `  ${t}: ${c}`);
    const relLines = Object.entries(stats.relationTypes)
      .sort(([, a], [, b]) => b - a)
      .map(([t, c]) => `  ${t}: ${c}`);
    const projLines = stats.topProjects.map((p) => `  ${p.project}: ${p.entityCount} entities`);

    return {
      content: [{
        type: "text" as const,
        text: `Knowledge Graph Stats:\n- **Entities:** ${stats.entityCount}\n- **Relations:** ${stats.relationCount}\n\nEntity types:\n${typeLines.join("\n")}\n\nRelation types:\n${relLines.join("\n")}\n\nTop projects:\n${projLines.join("\n")}`,
      }],
    };
  }
);

// ─── Tool: kg_remove ────────────────────────────────────────────────

server.tool(
  "kg_remove",
  "Remove an entity (and all its relations) or a specific relation from the knowledge graph.",
  {
    entity: z.string().optional().describe("Entity name to remove (removes all its relations too)"),
    source: z.string().optional().describe("Source entity of relation to remove"),
    target: z.string().optional().describe("Target entity of relation to remove"),
    relation_type: z.enum(RELATION_TYPES).optional().describe("Type of relation to remove"),
  },
  async ({ entity, source, target, relation_type }) => {
    if (entity) {
      const removed = kg.removeEntity(entity);
      if (!removed) {
        return { content: [{ type: "text" as const, text: `Entity not found: "${entity}"` }] };
      }
      kg.save();
      return { content: [{ type: "text" as const, text: `Removed entity "${entity}" and all its relations.` }] };
    }

    if (source && target && relation_type) {
      const removed = kg.removeRelation(source, target, relation_type);
      if (!removed) {
        return { content: [{ type: "text" as const, text: `Relation not found: ${source} —[${relation_type}]→ ${target}` }] };
      }
      kg.save();
      return { content: [{ type: "text" as const, text: `Removed relation: ${source} —[${relation_type}]→ ${target}` }] };
    }

    return { content: [{ type: "text" as const, text: "Provide either 'entity' or 'source'+'target'+'relation_type'." }] };
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

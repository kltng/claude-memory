/**
 * Search engine wrapping MiniSearch for full-text search over session markdown.
 * Supports building, saving, loading, and querying the index.
 */

import MiniSearch from "minisearch";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export interface SearchDocument {
  id: string;
  project: string;
  date: string;
  sessionId: string;
  heading: string;
  content: string;
  filepath: string;
}

export interface SearchResult {
  id: string;
  project: string;
  date: string;
  sessionId: string;
  heading: string;
  snippet: string;
  filepath: string;
  score: number;
}

const FIELDS = ["heading", "content", "project"];
const STORE_FIELDS = ["project", "date", "sessionId", "heading", "filepath", "content"];

export class MemorySearch {
  private index: MiniSearch<SearchDocument>;
  private indexPath: string;

  constructor(memoryRoot: string) {
    this.indexPath = join(memoryRoot, "search-index.json");
    this.index = new MiniSearch<SearchDocument>({
      fields: FIELDS,
      storeFields: STORE_FIELDS,
      searchOptions: {
        boost: { heading: 2, project: 1.5 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /**
   * Rebuild the entire index from markdown files in sessions/ and summaries/
   */
  rebuild(memoryRoot: string): number {
    const docs: SearchDocument[] = [];

    for (const dir of ["sessions", "summaries"]) {
      const base = join(memoryRoot, dir);
      if (!existsSync(base)) continue;
      this.walkMarkdown(base, memoryRoot, docs);
    }

    // Recreate index
    this.index = new MiniSearch<SearchDocument>({
      fields: FIELDS,
      storeFields: STORE_FIELDS,
      searchOptions: {
        boost: { heading: 2, project: 1.5 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    if (docs.length > 0) {
      this.index.addAll(docs);
    }
    return docs.length;
  }

  /**
   * Recursively find .md files and chunk them by headings
   */
  private walkMarkdown(dir: string, memoryRoot: string, docs: SearchDocument[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkMarkdown(fullPath, memoryRoot, docs);
      } else if (entry.name.endsWith(".md")) {
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(memoryRoot, fullPath);
        const chunks = this.chunkByHeadings(content);

        // Derive project and session info from path
        // sessions/lcsh/2026-03-09/abc123.md
        const parts = relPath.split("/");
        const project = parts[1] || "unknown";
        const date = parts[2] || "unknown";
        const sessionId = parts[3]?.replace(".md", "") || entry.name.replace(".md", "");

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const id = `${relPath}#${i}_${chunk.heading}`.replace(/[^a-zA-Z0-9\-_#/.]/g, "_");
          docs.push({
            id,
            project,
            date,
            sessionId,
            heading: chunk.heading,
            content: chunk.content,
            filepath: relPath,
          });
        }
      }
    }
  }

  /**
   * Split markdown into chunks at ## headings
   */
  private chunkByHeadings(content: string): { heading: string; content: string }[] {
    const chunks: { heading: string; content: string }[] = [];
    const lines = content.split("\n");
    let currentHeading = "top";
    let currentLines: string[] = [];

    for (const line of lines) {
      const match = line.match(/^#{1,3}\s+(.+)/);
      if (match) {
        if (currentLines.length > 0) {
          chunks.push({
            heading: currentHeading,
            content: currentLines.join("\n").trim(),
          });
        }
        currentHeading = match[1];
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0) {
      chunks.push({
        heading: currentHeading,
        content: currentLines.join("\n").trim(),
      });
    }

    return chunks.filter((c) => c.content.length > 10);
  }

  /**
   * Search the index
   */
  search(query: string, options?: { project?: string; limit?: number }): SearchResult[] {
    const limit = options?.limit || 20;

    const filter = options?.project
      ? (result: { project: string }) => result.project === options.project
      : undefined;

    const results = this.index.search(query, { filter });

    return results.slice(0, limit).map((r) => ({
      id: r.id as string,
      project: (r as Record<string, unknown>).project as string,
      date: (r as Record<string, unknown>).date as string,
      sessionId: (r as Record<string, unknown>).sessionId as string,
      heading: (r as Record<string, unknown>).heading as string,
      snippet: this.extractSnippet((r as Record<string, unknown>).content as string || "", query),
      filepath: (r as Record<string, unknown>).filepath as string,
      score: r.score,
    }));
  }

  /**
   * Extract a relevant snippet around the query match
   */
  private extractSnippet(content: string, query: string, maxLen = 300): string {
    if (!content) return "";
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const lines = content.split("\n");

    // Find the line with the best match
    let bestIdx = 0;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (lower.includes(term)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    // Extract surrounding context
    const start = Math.max(0, bestIdx - 1);
    const end = Math.min(lines.length, bestIdx + 3);
    let snippet = lines.slice(start, end).join("\n").trim();
    if (snippet.length > maxLen) snippet = snippet.slice(0, maxLen) + "…";
    return snippet;
  }

  /**
   * Save index to disk
   */
  save(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index), "utf-8");
  }

  /**
   * Load index from disk
   */
  load(): boolean {
    if (!existsSync(this.indexPath)) return false;
    try {
      const data = readFileSync(this.indexPath, "utf-8");
      this.index = MiniSearch.loadJSON<SearchDocument>(data, {
        fields: FIELDS,
        storeFields: STORE_FIELDS,
      });
      return true;
    } catch {
      return false;
    }
  }

  get documentCount(): number {
    return this.index.documentCount;
  }
}

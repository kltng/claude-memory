/**
 * Vector search using Transformers.js for local embeddings + flat file storage.
 * No external services required — runs entirely in Node.js.
 *
 * Embeddings are stored as a JSON file (gitignored, rebuilt locally).
 * Uses cosine similarity for nearest-neighbor search.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, relative } from "path";

// Lazy-load the pipeline to avoid slowing down MCP server startup
let embedder: any = null;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

interface VectorDocument {
  id: string;
  project: string;
  date: string;
  sessionId: string;
  heading: string;
  content: string;
  filepath: string;
  embedding: number[];
}

export interface VectorSearchResult {
  id: string;
  project: string;
  date: string;
  sessionId: string;
  heading: string;
  filepath: string;
  similarity: number;
  snippet: string;
}

interface VectorIndex {
  model: string;
  dimension: number;
  documents: VectorDocument[];
  builtAt: string;
}

async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import("@huggingface/transformers");
    process.stderr.write("claude-memory: loading embedding model (first time may download ~80MB)...\n");
    embedder = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32",
    });
    process.stderr.write("claude-memory: embedding model ready\n");
  }
  return embedder;
}

async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIM);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Vectors are already normalized, so dot product = cosine similarity
  return dot;
}

export class VectorSearch {
  private documents: VectorDocument[] = [];
  private indexPath: string;

  constructor(memoryRoot: string) {
    this.indexPath = join(memoryRoot, "vector-index.json");
  }

  /**
   * Rebuild the vector index from all markdown files.
   * This is slow (embeds every chunk) — run once, then incrementally.
   */
  async rebuild(memoryRoot: string): Promise<number> {
    const chunks = this.collectChunks(memoryRoot);

    process.stderr.write(`claude-memory: embedding ${chunks.length} chunks...\n`);

    const batchSize = 20;
    this.documents = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embeddings = await Promise.all(
        batch.map((c) => embed(`${c.heading}\n\n${c.content.slice(0, 500)}`))
      );

      for (let j = 0; j < batch.length; j++) {
        this.documents.push({
          ...batch[j],
          embedding: embeddings[j],
        });
      }

      if ((i + batchSize) % 200 === 0 || i + batchSize >= chunks.length) {
        process.stderr.write(`  ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks embedded\n`);
      }
    }

    return this.documents.length;
  }

  /**
   * Semantic search — returns chunks most similar to the query.
   */
  async search(query: string, options?: { project?: string; limit?: number }): Promise<VectorSearchResult[]> {
    if (this.documents.length === 0) return [];

    const limit = options?.limit || 10;
    const queryEmbedding = await embed(query);

    let candidates = this.documents;
    if (options?.project) {
      candidates = candidates.filter((d) => d.project === options.project);
    }

    const scored = candidates.map((doc) => ({
      doc,
      similarity: cosineSimilarity(queryEmbedding, doc.embedding),
    }));

    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit).map((s) => ({
      id: s.doc.id,
      project: s.doc.project,
      date: s.doc.date,
      sessionId: s.doc.sessionId,
      heading: s.doc.heading,
      filepath: s.doc.filepath,
      similarity: s.similarity,
      snippet: s.doc.content.slice(0, 200),
    }));
  }

  /**
   * Hybrid search — combines FTS results with vector results using RRF.
   */
  async hybridSearch(
    query: string,
    ftsResults: { id: string; score: number }[],
    options?: { project?: string; limit?: number }
  ): Promise<VectorSearchResult[]> {
    const limit = options?.limit || 10;
    const k = 60; // RRF constant

    // Get vector results
    const vectorResults = await this.search(query, { project: options?.project, limit: 50 });

    // Build RRF score map
    const scores = new Map<string, { score: number; doc: VectorSearchResult }>();

    // Score from FTS
    ftsResults.forEach((r, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.score += rrf;
      } else {
        // We'll fill doc from vector results if available
        scores.set(r.id, { score: rrf, doc: null as any });
      }
    });

    // Score from vector
    vectorResults.forEach((r, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.score += rrf;
        if (!existing.doc) existing.doc = r;
      } else {
        scores.set(r.id, { score: rrf, doc: r });
      }
    });

    // Sort by combined RRF score
    const merged = Array.from(scores.values())
      .filter((s) => s.doc != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return merged.map((s) => ({
      ...s.doc,
      similarity: s.score,
    }));
  }

  save(): void {
    const index: VectorIndex = {
      model: MODEL_NAME,
      dimension: EMBEDDING_DIM,
      documents: this.documents,
      builtAt: new Date().toISOString(),
    };
    writeFileSync(this.indexPath, JSON.stringify(index), "utf-8");
  }

  load(): boolean {
    if (!existsSync(this.indexPath)) return false;
    try {
      const data = JSON.parse(readFileSync(this.indexPath, "utf-8")) as VectorIndex;
      if (data.model !== MODEL_NAME) {
        process.stderr.write(`claude-memory: vector index model mismatch (${data.model} vs ${MODEL_NAME}), rebuild needed\n`);
        return false;
      }
      this.documents = data.documents;
      return true;
    } catch {
      return false;
    }
  }

  get documentCount(): number {
    return this.documents.length;
  }

  /**
   * Collect all markdown chunks (same logic as MemorySearch).
   */
  private collectChunks(memoryRoot: string): Omit<VectorDocument, "embedding">[] {
    const chunks: Omit<VectorDocument, "embedding">[] = [];

    for (const dir of ["sessions", "summaries"]) {
      const base = join(memoryRoot, dir);
      if (!existsSync(base)) continue;
      this.walkMarkdown(base, memoryRoot, chunks);
    }

    return chunks;
  }

  private walkMarkdown(dir: string, memoryRoot: string, docs: Omit<VectorDocument, "embedding">[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkMarkdown(fullPath, memoryRoot, docs);
      } else if (entry.name.endsWith(".md")) {
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(memoryRoot, fullPath);
        const chunks = this.chunkByHeadings(content);

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

  private chunkByHeadings(content: string): { heading: string; content: string }[] {
    const chunks: { heading: string; content: string }[] = [];
    const lines = content.split("\n");
    let currentHeading = "top";
    let currentLines: string[] = [];

    for (const line of lines) {
      const match = line.match(/^#{1,3}\s+(.+)/);
      if (match) {
        if (currentLines.length > 0) {
          chunks.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
        }
        currentHeading = match[1];
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0) {
      chunks.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
    }

    return chunks.filter((c) => c.content.length > 10);
  }
}

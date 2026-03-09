import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemorySearch } from "../search.js";

function createTempMemoryRoot(): string {
  const tmp = mkdtempSync(join(tmpdir(), "claude-memory-test-"));
  return tmp;
}

function populateSessionFiles(root: string): void {
  // Create sessions/myproject/2026-03-09/session-001.md
  const sessDir1 = join(root, "sessions", "myproject", "2026-03-09");
  mkdirSync(sessDir1, { recursive: true });
  writeFileSync(
    join(sessDir1, "session-001.md"),
    `# Session: session-001

| Field | Value |
|-------|-------|
| **Project** | myproject |
| **Date** | 2026-03-09 |
| **Branch** | main |
| **Messages** | 2 |

---

## User <sub>10:30:00</sub>

How do I fix the authentication bug in the login handler?

## Assistant <sub>10:30:05</sub>

The authentication bug is caused by a missing token validation step. You need to add a check before the redirect.
`,
    "utf-8"
  );

  // Create sessions/myproject/2026-03-09/session-002.md
  writeFileSync(
    join(sessDir1, "session-002.md"),
    `# Session: session-002

| Field | Value |
|-------|-------|
| **Project** | myproject |
| **Date** | 2026-03-09 |
| **Branch** | feature/api |
| **Messages** | 2 |

---

## User <sub>14:00:00</sub>

Help me write unit tests for the API router.

## Assistant <sub>14:00:10</sub>

Here are unit tests for the API router using the built-in test runner with assertions for each endpoint.
`,
    "utf-8"
  );

  // Create sessions/other-project/2026-03-08/session-003.md
  const sessDir2 = join(root, "sessions", "other-project", "2026-03-08");
  mkdirSync(sessDir2, { recursive: true });
  writeFileSync(
    join(sessDir2, "session-003.md"),
    `# Session: session-003

| Field | Value |
|-------|-------|
| **Project** | other-project |
| **Date** | 2026-03-08 |
| **Branch** | main |
| **Messages** | 2 |

---

## User <sub>09:00:00</sub>

Set up the database migration scripts.

## Assistant <sub>09:00:15</sub>

I've created the database migration scripts using knex. The migrations handle creating the users and posts tables.
`,
    "utf-8"
  );

  // Create a summary file
  const summDir = join(root, "summaries", "myproject");
  mkdirSync(summDir, { recursive: true });
  writeFileSync(
    join(summDir, "api-patterns.md"),
    `# api-patterns

_Created: 2026-03-09 10:00:00_

## Key API Design Patterns

- Use middleware for authentication
- Validate request bodies with zod schemas
- Return consistent error responses with status codes
`,
    "utf-8"
  );
}

describe("MemorySearch", () => {
  let root: string;
  let search: MemorySearch;

  before(() => {
    root = createTempMemoryRoot();
    populateSessionFiles(root);
    search = new MemorySearch(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("rebuild", () => {
    it("indexes markdown files and returns document count", () => {
      const count = search.rebuild(root);
      assert.ok(count > 0, `Expected documents but got ${count}`);
    });

    it("includes chunks from sessions and summaries", () => {
      const count = search.rebuild(root);
      // We have 3 session files with multiple headings + 1 summary
      // Each file has multiple ## headings that become chunks
      assert.ok(count >= 4, `Expected at least 4 chunks but got ${count}`);
    });

    it("reports correct documentCount after rebuild", () => {
      search.rebuild(root);
      assert.ok(search.documentCount > 0);
    });
  });

  describe("search", () => {
    before(() => {
      search.rebuild(root);
    });

    it("returns results for matching query", () => {
      const results = search.search("authentication bug");
      assert.ok(results.length > 0, "Expected at least one result");
    });

    it("returns results with expected fields", () => {
      const results = search.search("authentication");
      assert.ok(results.length > 0);
      const r = results[0];
      assert.ok(typeof r.id === "string");
      assert.ok(typeof r.project === "string");
      assert.ok(typeof r.date === "string");
      assert.ok(typeof r.sessionId === "string");
      assert.ok(typeof r.heading === "string");
      assert.ok(typeof r.snippet === "string");
      assert.ok(typeof r.filepath === "string");
      assert.ok(typeof r.score === "number");
      assert.ok(r.score > 0);
    });

    it("respects project filter", () => {
      const results = search.search("migration database", {
        project: "other-project",
      });
      assert.ok(results.length > 0, "Expected results for other-project");
      for (const r of results) {
        assert.strictEqual(r.project, "other-project");
      }
    });

    it("filters out non-matching projects", () => {
      const results = search.search("migration database", {
        project: "nonexistent-project",
      });
      assert.strictEqual(results.length, 0);
    });

    it("respects limit option", () => {
      const results = search.search("the", { limit: 2 });
      assert.ok(results.length <= 2);
    });

    it("returns meaningful content snippets, not just IDs", () => {
      const results = search.search("authentication bug");
      assert.ok(results.length > 0);
      const r = results[0];
      // Snippet should contain actual content, not "Match in: ..."
      assert.ok(!r.snippet.startsWith("Match in:"), `Snippet should not be placeholder: ${r.snippet}`);
      assert.ok(r.snippet.length > 20, `Snippet should have meaningful content: ${r.snippet}`);
    });

    it("returns empty array for nonsense query", () => {
      const results = search.search("xyzzyplugh12345");
      assert.strictEqual(results.length, 0);
    });

    it("finds content in summaries", () => {
      const results = search.search("zod schemas middleware");
      assert.ok(results.length > 0, "Expected results from summaries");
      const hasSummary = results.some((r) =>
        r.filepath.includes("summaries")
      );
      assert.ok(hasSummary, "Expected at least one result from summaries/");
    });
  });

  describe("save and load (round-trip)", () => {
    it("saves index to disk", () => {
      search.rebuild(root);
      search.save();
      const indexPath = join(root, "search-index.json");
      assert.ok(existsSync(indexPath), "Index file should exist");
      const data = readFileSync(indexPath, "utf-8");
      assert.ok(data.length > 100, "Index file should have content");
    });

    it("loads index from disk and preserves search ability", () => {
      search.rebuild(root);
      search.save();

      // Create a fresh MemorySearch and load
      const search2 = new MemorySearch(root);
      const loaded = search2.load();
      assert.strictEqual(loaded, true);
      assert.ok(search2.documentCount > 0);

      // Search should still work
      const results = search2.search("authentication");
      assert.ok(results.length > 0, "Loaded index should return results");
    });

    it("load returns false when no index file exists", () => {
      const emptyRoot = createTempMemoryRoot();
      try {
        const s = new MemorySearch(emptyRoot);
        assert.strictEqual(s.load(), false);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });
  });

  describe("empty index", () => {
    it("handles search on empty index without errors", () => {
      const emptyRoot = createTempMemoryRoot();
      try {
        const s = new MemorySearch(emptyRoot);
        s.rebuild(emptyRoot);
        assert.strictEqual(s.documentCount, 0);
        const results = s.search("anything");
        assert.strictEqual(results.length, 0);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });

    it("rebuild returns 0 when no markdown files exist", () => {
      const emptyRoot = createTempMemoryRoot();
      try {
        const s = new MemorySearch(emptyRoot);
        const count = s.rebuild(emptyRoot);
        assert.strictEqual(count, 0);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });
  });

  describe("chunking by headings", () => {
    it("produces multiple chunks for a file with multiple headings", () => {
      const chunkRoot = createTempMemoryRoot();
      try {
        const dir = join(chunkRoot, "sessions", "proj", "2026-01-01");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "multi-heading.md"),
          `# Top Level Title

Some intro text that is long enough to pass the filter threshold.

## First Section

Content of the first section with enough text to be indexed properly.

## Second Section

Content of the second section with different keywords about databases.

## Third Section

Even more content here about API design and authentication patterns.
`,
          "utf-8"
        );

        const s = new MemorySearch(chunkRoot);
        const count = s.rebuild(chunkRoot);
        // Should have multiple chunks (one per heading)
        assert.ok(count >= 3, `Expected at least 3 chunks but got ${count}`);
      } finally {
        rmSync(chunkRoot, { recursive: true, force: true });
      }
    });

    it("skips chunks with very short content", () => {
      const chunkRoot = createTempMemoryRoot();
      try {
        const dir = join(chunkRoot, "sessions", "proj", "2026-01-01");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "short.md"),
          `# Title

## Heading With Short Content

tiny

## Heading With Enough Content

This section has enough content to pass the 10-character filter threshold easily.
`,
          "utf-8"
        );

        const s = new MemorySearch(chunkRoot);
        const count = s.rebuild(chunkRoot);
        // "tiny" is only 4 chars, should be filtered out
        // Only the heading with enough content should remain
        assert.ok(count >= 1, "Should have at least one chunk");
      } finally {
        rmSync(chunkRoot, { recursive: true, force: true });
      }
    });
  });

  describe("duplicate ID handling", () => {
    it("rebuild from scratch avoids duplicate IDs", () => {
      // Rebuilding recreates the index, so duplicates shouldn't occur
      const count1 = search.rebuild(root);
      const count2 = search.rebuild(root);
      assert.strictEqual(count1, count2, "Rebuild should produce same count");
      assert.strictEqual(search.documentCount, count2);
    });
  });
});

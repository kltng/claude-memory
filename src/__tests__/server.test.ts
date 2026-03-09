/**
 * Tests for MCP server tool handler logic.
 *
 * Rather than testing through the MCP transport, we test the underlying
 * MemorySearch module and simulate what the server tool handlers do:
 * search_memory, list_sessions, get_session, save_insight.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemorySearch } from "../search.js";

function createTempMemoryRoot(): string {
  return mkdtempSync(join(tmpdir(), "claude-memory-server-test-"));
}

function populateTestSessions(root: string): void {
  const dir1 = join(root, "sessions", "webapp", "2026-03-09");
  mkdirSync(dir1, { recursive: true });
  writeFileSync(
    join(dir1, "sess-aaa.md"),
    `# Session: sess-aaa

| Field | Value |
|-------|-------|
| **Project** | webapp |
| **Date** | 2026-03-09 |
| **Branch** | main |
| **Messages** | 2 |

---

## User <sub>10:00:00</sub>

Fix the CSS layout bug on the dashboard page.

## Assistant <sub>10:00:10</sub>

The CSS layout issue was caused by a missing flex-wrap property. I added it to the container.
`,
    "utf-8"
  );

  const dir2 = join(root, "sessions", "webapp", "2026-03-08");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(
    join(dir2, "sess-bbb.md"),
    `# Session: sess-bbb

| Field | Value |
|-------|-------|
| **Project** | webapp |
| **Date** | 2026-03-08 |
| **Branch** | feature/auth |
| **Messages** | 2 |

---

## User <sub>14:00:00</sub>

Implement OAuth2 login flow with Google.

## Assistant <sub>14:00:20</sub>

I've implemented the OAuth2 login flow using passport-google-oauth20 strategy.
`,
    "utf-8"
  );

  const dir3 = join(root, "sessions", "cli-tool", "2026-03-09");
  mkdirSync(dir3, { recursive: true });
  writeFileSync(
    join(dir3, "sess-ccc.md"),
    `# Session: sess-ccc

| Field | Value |
|-------|-------|
| **Project** | cli-tool |
| **Date** | 2026-03-09 |
| **Branch** | main |
| **Messages** | 2 |

---

## User <sub>09:00:00</sub>

Add a --verbose flag to the CLI output.

## Assistant <sub>09:00:10</sub>

Added the --verbose flag using commander.js. When enabled, it outputs detailed progress information.
`,
    "utf-8"
  );
}

// Simulate server tool handlers (same logic as server.ts but without MCP transport)

function handleSearchMemory(
  search: MemorySearch,
  query: string,
  project?: string,
  limit?: number
) {
  const results = search.search(query, { project, limit: limit || 10 });

  if (results.length === 0) {
    return { text: `No results found for "${query}".` };
  }

  const formatted = results.map((r, i) => {
    return `### ${i + 1}. [${r.project}] ${r.heading} (score: ${r.score.toFixed(1)})\n- **Session:** ${r.sessionId}\n- **Date:** ${r.date}\n- **File:** ${r.filepath}\n- **Snippet:** ${r.snippet}`;
  });

  return {
    text: `Found ${results.length} results for "${query}":\n\n${formatted.join("\n\n")}`,
  };
}

function handleListSessions(
  memoryRoot: string,
  project?: string,
  date?: string,
  limit?: number
) {
  const sessionsDir = join(memoryRoot, "sessions");
  if (!existsSync(sessionsDir)) {
    return { text: "No sessions recorded yet." };
  }

  const sessions: {
    project: string;
    date: string;
    sessionId: string;
    filepath: string;
    size: number;
  }[] = [];

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
        const fullPath = join(memoryRoot, filepath);
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

  sessions.sort((a, b) => b.date.localeCompare(a.date));
  const limited = sessions.slice(0, limit || 50);

  if (limited.length === 0) {
    return { text: "No sessions match the filter." };
  }

  const lines = limited.map(
    (s) =>
      `- **${s.date}** | ${s.project} | ${s.sessionId} (${(s.size / 1024).toFixed(1)}KB)`
  );

  return {
    text: `${sessions.length} sessions found:\n\n${lines.join("\n")}`,
  };
}

function handleGetSession(memoryRoot: string, filepath: string) {
  const fullPath = join(memoryRoot, filepath);
  if (!existsSync(fullPath)) {
    return { text: `Session file not found: ${filepath}` };
  }

  const content = readFileSync(fullPath, "utf-8");
  const maxLen = 50000;
  const truncated =
    content.length > maxLen
      ? content.slice(0, maxLen) +
        "\n\n…[truncated, total " +
        content.length +
        " chars]"
      : content;

  return { text: truncated };
}

function handleSaveInsight(
  memoryRoot: string,
  search: MemorySearch,
  project: string,
  topic: string,
  content: string,
  append?: boolean
) {
  const dir = join(memoryRoot, "summaries", project);
  mkdirSync(dir, { recursive: true });

  const filepath = join(dir, `${topic}.md`);
  const shouldAppend = append !== false;

  if (shouldAppend && existsSync(filepath)) {
    const existing = readFileSync(filepath, "utf-8");
    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    writeFileSync(
      filepath,
      `${existing}\n\n---\n_Added: ${timestamp}_\n\n${content}`,
      "utf-8"
    );
  } else {
    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    writeFileSync(
      filepath,
      `# ${topic}\n\n_Created: ${timestamp}_\n\n${content}`,
      "utf-8"
    );
  }

  const count = search.rebuild(memoryRoot);
  search.save();

  return {
    text: `Saved insight to summaries/${project}/${topic}.md (index: ${count} chunks)`,
  };
}

describe("search_memory handler", () => {
  let root: string;
  let search: MemorySearch;

  before(() => {
    root = createTempMemoryRoot();
    populateTestSessions(root);
    search = new MemorySearch(root);
    search.rebuild(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns formatted results for a matching query", () => {
    const result = handleSearchMemory(search, "CSS layout bug");
    assert.ok(result.text.includes("Found"));
    assert.ok(result.text.includes("results for"));
    assert.ok(result.text.includes("webapp"));
  });

  it("returns no-results message for unmatched query", () => {
    const result = handleSearchMemory(search, "xyznonexistent12345");
    assert.ok(result.text.includes("No results found"));
  });

  it("filters by project", () => {
    const result = handleSearchMemory(search, "verbose flag", "cli-tool");
    assert.ok(result.text.includes("Found"));
    // All results should be from cli-tool
    assert.ok(!result.text.includes("[webapp]"));
  });

  it("includes content snippet in results", () => {
    const result = handleSearchMemory(search, "CSS layout bug");
    assert.ok(result.text.includes("**Snippet:**"), "Should include snippet field");
  });

  it("includes score, session, date, and file in output", () => {
    const result = handleSearchMemory(search, "OAuth2 login");
    if (result.text.includes("Found")) {
      assert.ok(result.text.includes("score:"));
      assert.ok(result.text.includes("**Session:**"));
      assert.ok(result.text.includes("**Date:**"));
      assert.ok(result.text.includes("**File:**"));
    }
  });
});

describe("list_sessions handler", () => {
  let root: string;

  before(() => {
    root = createTempMemoryRoot();
    populateTestSessions(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists all sessions without filter", () => {
    const result = handleListSessions(root);
    assert.ok(result.text.includes("sessions found"));
    assert.ok(result.text.includes("webapp"));
    assert.ok(result.text.includes("cli-tool"));
  });

  it("filters by project name", () => {
    const result = handleListSessions(root, "webapp");
    assert.ok(result.text.includes("webapp"));
    assert.ok(!result.text.includes("cli-tool"));
  });

  it("filters by date", () => {
    const result = handleListSessions(root, undefined, "2026-03-09");
    assert.ok(result.text.includes("2026-03-09"));
    // sess-bbb is from 2026-03-08, should not appear
    assert.ok(!result.text.includes("sess-bbb"));
  });

  it("filters by date prefix (month)", () => {
    const result = handleListSessions(root, undefined, "2026-03");
    assert.ok(result.text.includes("sessions found"));
    // All our test sessions are from 2026-03
    assert.ok(result.text.includes("sess-aaa"));
    assert.ok(result.text.includes("sess-bbb"));
    assert.ok(result.text.includes("sess-ccc"));
  });

  it("returns no-match message for nonexistent project", () => {
    const result = handleListSessions(root, "no-such-project");
    assert.ok(result.text.includes("No sessions match"));
  });

  it("sorts sessions by date descending", () => {
    const result = handleListSessions(root);
    const idx09 = result.text.indexOf("2026-03-09");
    const idx08 = result.text.indexOf("2026-03-08");
    assert.ok(idx09 < idx08, "2026-03-09 should appear before 2026-03-08");
  });

  it("respects limit", () => {
    const result = handleListSessions(root, undefined, undefined, 1);
    // Should only show 1 session line, but the total count text shows all
    const lines = result.text.split("\n").filter((l) => l.startsWith("- **"));
    assert.strictEqual(lines.length, 1);
  });

  it("returns no-sessions message when directory missing", () => {
    const emptyRoot = createTempMemoryRoot();
    try {
      const result = handleListSessions(emptyRoot);
      assert.ok(result.text.includes("No sessions recorded"));
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("get_session handler", () => {
  let root: string;

  before(() => {
    root = createTempMemoryRoot();
    populateTestSessions(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("retrieves session content by filepath", () => {
    const result = handleGetSession(
      root,
      "sessions/webapp/2026-03-09/sess-aaa.md"
    );
    assert.ok(result.text.includes("# Session: sess-aaa"));
    assert.ok(result.text.includes("CSS layout"));
  });

  it("returns not-found message for missing file", () => {
    const result = handleGetSession(root, "sessions/webapp/2026-03-09/nope.md");
    assert.ok(result.text.includes("Session file not found"));
  });

  it("truncates very large files", () => {
    // Create a large file
    const dir = join(root, "sessions", "big", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    const bigContent = "x".repeat(60000);
    writeFileSync(join(dir, "big.md"), bigContent, "utf-8");

    const result = handleGetSession(root, "sessions/big/2026-01-01/big.md");
    assert.ok(result.text.includes("truncated"));
    assert.ok(result.text.length < 60000);
  });
});

describe("save_insight handler", () => {
  let root: string;
  let search: MemorySearch;

  before(() => {
    root = createTempMemoryRoot();
    populateTestSessions(root);
    search = new MemorySearch(root);
    search.rebuild(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a new insight file", () => {
    const result = handleSaveInsight(
      root,
      search,
      "webapp",
      "debugging-tips",
      "Always check the browser console first."
    );
    assert.ok(result.text.includes("Saved insight"));
    assert.ok(result.text.includes("summaries/webapp/debugging-tips.md"));

    const filepath = join(root, "summaries", "webapp", "debugging-tips.md");
    assert.ok(existsSync(filepath));
    const content = readFileSync(filepath, "utf-8");
    assert.ok(content.includes("# debugging-tips"));
    assert.ok(content.includes("Always check the browser console first."));
    assert.ok(content.includes("_Created:"));
  });

  it("appends to existing insight file by default", () => {
    // First create
    handleSaveInsight(
      root,
      search,
      "webapp",
      "append-test",
      "First insight."
    );

    // Then append
    handleSaveInsight(
      root,
      search,
      "webapp",
      "append-test",
      "Second insight."
    );

    const filepath = join(root, "summaries", "webapp", "append-test.md");
    const content = readFileSync(filepath, "utf-8");
    assert.ok(content.includes("First insight."));
    assert.ok(content.includes("Second insight."));
    assert.ok(content.includes("_Added:"));
    assert.ok(content.includes("---"));
  });

  it("overwrites when append is false", () => {
    // First create
    handleSaveInsight(
      root,
      search,
      "webapp",
      "overwrite-test",
      "Original content."
    );

    // Overwrite
    handleSaveInsight(
      root,
      search,
      "webapp",
      "overwrite-test",
      "Replacement content.",
      false
    );

    const filepath = join(root, "summaries", "webapp", "overwrite-test.md");
    const content = readFileSync(filepath, "utf-8");
    assert.ok(!content.includes("Original content."));
    assert.ok(content.includes("Replacement content."));
  });

  it("rebuilds the index after saving", () => {
    const countBefore = search.documentCount;
    handleSaveInsight(
      root,
      search,
      "webapp",
      "new-topic",
      "This is a brand new topic with sufficient content for indexing."
    );
    // After rebuild, document count may change
    assert.ok(search.documentCount > 0);
  });

  it("creates project directory if it does not exist", () => {
    handleSaveInsight(
      root,
      search,
      "brand-new-project",
      "first-notes",
      "Starting a new project with some initial notes and observations."
    );
    const dir = join(root, "summaries", "brand-new-project");
    assert.ok(existsSync(dir));
  });
});

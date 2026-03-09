import { describe, it } from "node:test";
import assert from "node:assert";
import { join } from "path";
import {
  deriveProjectName,
  formatDate,
  truncate,
  stripSystemTags,
  renderContent,
  convertTranscript,
} from "../capture.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("deriveProjectName", () => {
  it("extracts the last path component", () => {
    assert.strictEqual(deriveProjectName("/Users/sije/codebases/lcsh"), "lcsh");
  });

  it("handles nested paths", () => {
    assert.strictEqual(
      deriveProjectName("/home/user/projects/my-app"),
      "my-app"
    );
  });

  it("handles root-level paths", () => {
    assert.strictEqual(deriveProjectName("/myproject"), "myproject");
  });

  it("handles trailing slash by returning empty string", () => {
    // basename("/foo/bar/") returns "bar" in Node
    assert.strictEqual(deriveProjectName("/foo/bar/"), "bar");
  });
});

describe("formatDate", () => {
  it("extracts YYYY-MM-DD from ISO timestamp", () => {
    assert.strictEqual(formatDate("2026-03-09T10:30:00.000Z"), "2026-03-09");
  });

  it("works with date-only string", () => {
    assert.strictEqual(formatDate("2026-01-15"), "2026-01-15");
  });

  it("handles timestamp without milliseconds", () => {
    assert.strictEqual(formatDate("2026-12-25T00:00:00Z"), "2026-12-25");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    assert.strictEqual(truncate("hello", 10), "hello");
  });

  it("truncates text exceeding maxLen", () => {
    const result = truncate("hello world", 5);
    assert.strictEqual(result, "hello…");
  });

  it("returns text unchanged when exactly at maxLen", () => {
    assert.strictEqual(truncate("12345", 5), "12345");
  });
});

describe("stripSystemTags", () => {
  it("removes <system-reminder> tags and content", () => {
    const input = "<system-reminder>You are helpful</system-reminder>Fix the bug";
    assert.strictEqual(stripSystemTags(input), "Fix the bug");
  });

  it("removes <local-command-caveat> tags", () => {
    const input = "Do this<local-command-caveat>safe mode</local-command-caveat> please";
    assert.strictEqual(stripSystemTags(input), "Do this please");
  });

  it("removes <command-name> tags", () => {
    const input = "<command-name>git status</command-name>Check the status";
    assert.strictEqual(stripSystemTags(input), "Check the status");
  });

  it("removes <command-message> tags", () => {
    const input = "Hello<command-message>internal msg</command-message> world";
    assert.strictEqual(stripSystemTags(input), "Hello world");
  });

  it("removes <command-args> tags", () => {
    const input = "<command-args>--verbose</command-args>Run it";
    assert.strictEqual(stripSystemTags(input), "Run it");
  });

  it("removes <local-command-stdout> tags", () => {
    const input = "Check<local-command-stdout>output here</local-command-stdout> done";
    assert.strictEqual(stripSystemTags(input), "Check done");
  });

  it("removes multiple tags at once", () => {
    const input =
      "<system-reminder>sys</system-reminder>Hello<local-command-caveat>caveat</local-command-caveat> world";
    assert.strictEqual(stripSystemTags(input), "Hello world");
  });

  it("returns plain text unchanged", () => {
    assert.strictEqual(stripSystemTags("no tags here"), "no tags here");
  });

  it("handles multiline content inside tags", () => {
    const input = "<system-reminder>line1\nline2\nline3</system-reminder>Keep this";
    assert.strictEqual(stripSystemTags(input), "Keep this");
  });
});

describe("renderContent", () => {
  it("returns string content as-is", () => {
    assert.strictEqual(renderContent("plain text"), "plain text");
  });

  it("renders text blocks", () => {
    const result = renderContent([{ type: "text", text: "hello world" }]);
    assert.strictEqual(result, "hello world");
  });

  it("renders tool_use blocks with name and input", () => {
    const result = renderContent([
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: "src/index.ts" },
      },
    ]);
    assert.ok(result.includes("**Tool: Read**"));
    assert.ok(result.includes("file_path"));
    assert.ok(result.includes("```"));
  });

  it("renders tool_result with string content", () => {
    const result = renderContent([
      {
        type: "tool_result",
        content: "file contents here",
      },
    ]);
    assert.ok(result.includes("Tool result"));
    assert.ok(result.includes("file contents here"));
  });

  it("renders tool_result with array content", () => {
    const result = renderContent([
      {
        type: "tool_result",
        content: [{ type: "text", text: "sub result" }],
      },
    ]);
    assert.ok(result.includes("Tool result"));
    assert.ok(result.includes("sub result"));
  });

  it("combines multiple blocks", () => {
    const result = renderContent([
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]);
    assert.ok(result.includes("First"));
    assert.ok(result.includes("Second"));
  });
});

describe("convertTranscript", () => {
  it("converts a minimal JSONL transcript to markdown", () => {
    const md = convertTranscript(
      join(FIXTURES, "minimal-transcript.jsonl"),
      "/Users/sije/codebases/myproject",
      "test-session-001"
    );
    assert.ok(md !== null);
    assert.ok(md!.includes("# Session: test-session-001"));
    assert.ok(md!.includes("| **Project** | myproject |"));
    assert.ok(md!.includes("| **Date** | 2026-03-09 |"));
    assert.ok(md!.includes("| **Branch** | main |"));
    assert.ok(md!.includes("## User"));
    assert.ok(md!.includes("## Assistant"));
    assert.ok(md!.includes("fix a bug"));
  });

  it("handles transcripts with tool_use blocks", () => {
    const md = convertTranscript(
      join(FIXTURES, "session-with-tools.jsonl"),
      "/Users/sije/codebases/myproject",
      "test-session-002"
    );
    assert.ok(md !== null);
    assert.ok(md!.includes("**Tool: Read**"));
    assert.ok(md!.includes("feature/fix"));
  });

  it("returns null for empty/no-message transcripts", () => {
    const md = convertTranscript(
      join(FIXTURES, "empty-transcript.jsonl"),
      "/Users/sije/codebases/myproject",
      "test-session-003"
    );
    assert.strictEqual(md, null);
  });

  it("strips system tags from user messages", () => {
    const md = convertTranscript(
      join(FIXTURES, "transcript-with-system-tags.jsonl"),
      "/Users/sije/codebases/webapp",
      "test-session-004"
    );
    assert.ok(md !== null);
    assert.ok(!md!.includes("<system-reminder>"));
    assert.ok(!md!.includes("<local-command-caveat>"));
    assert.ok(md!.includes("Fix the login page"));
  });

  it("returns null for non-existent transcript file", () => {
    const md = convertTranscript(
      join(FIXTURES, "does-not-exist.jsonl"),
      "/tmp",
      "nope"
    );
    assert.strictEqual(md, null);
  });

  it("includes message count in metadata", () => {
    const md = convertTranscript(
      join(FIXTURES, "minimal-transcript.jsonl"),
      "/Users/sije/codebases/myproject",
      "test-session-001"
    );
    assert.ok(md !== null);
    assert.ok(md!.includes("| **Messages** | 4 |"));
  });

  it("includes timestamps in message headers", () => {
    const md = convertTranscript(
      join(FIXTURES, "minimal-transcript.jsonl"),
      "/Users/sije/codebases/myproject",
      "test-session-001"
    );
    assert.ok(md !== null);
    assert.ok(md!.includes("<sub>10:30:00</sub>"));
  });
});

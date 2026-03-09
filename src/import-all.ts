/**
 * Import all existing Claude Code sessions from ~/.claude/projects/ into the memory repo.
 * Run once to bootstrap: npx tsx src/import-all.ts
 */

import { readdirSync, statSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, basename, dirname } from "path";
import { execSync } from "child_process";

const CLAUDE_DIR = join(process.env.HOME || "", ".claude", "projects");
const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");
const MIN_SIZE = 5000; // Skip sessions smaller than 5KB (likely just /exit)

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
}

interface TranscriptLine {
  type: string;
  message?: { role: string; content: string | ContentBlock[]; model?: string };
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function renderContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      const inputSummary = block.input ? truncate(JSON.stringify(block.input), 200) : "";
      parts.push(`\n**Tool: ${block.name}**\n\`\`\`\n${inputSummary}\n\`\`\``);
    } else if (block.type === "tool_result") {
      const rc = block.content;
      if (typeof rc === "string") {
        parts.push(`\n<details><summary>Tool result</summary>\n\n${truncate(rc, 500)}\n\n</details>`);
      } else if (Array.isArray(rc)) {
        for (const sub of rc) {
          if (sub.type === "text" && sub.text) {
            parts.push(`\n<details><summary>Tool result</summary>\n\n${truncate(sub.text, 500)}\n\n</details>`);
          }
        }
      }
    }
  }
  return parts.join("\n");
}

function stripSystemTags(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

function convertTranscript(jsonlPath: string): { markdown: string; project: string; date: string; sessionId: string } | null {
  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: { role: string; content: string; timestamp: string }[] = [];
  let firstTimestamp = "";
  let branch = "";
  let cwd = "";

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!entry.message || !entry.type) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isSidechain) continue;
    if (entry.isMeta) continue;

    if (!firstTimestamp && entry.timestamp) firstTimestamp = entry.timestamp;
    if (!branch && entry.gitBranch) branch = entry.gitBranch;
    if (!cwd && entry.cwd) cwd = entry.cwd;

    const rawContent = renderContent(entry.message.content);
    const content = entry.type === "user" ? stripSystemTags(rawContent) : rawContent;
    if (!content.trim()) continue;

    messages.push({ role: entry.type, content, timestamp: entry.timestamp || "" });
  }

  if (messages.length === 0) return null;

  const sessionId = basename(jsonlPath, ".jsonl");
  const project = cwd ? basename(cwd) : "unknown";
  const date = firstTimestamp ? firstTimestamp.slice(0, 10) : "unknown";

  const md: string[] = [];
  md.push(`# Session: ${sessionId}`);
  md.push("");
  md.push(`| Field | Value |`);
  md.push(`|-------|-------|`);
  md.push(`| **Project** | ${project} |`);
  md.push(`| **Date** | ${date} |`);
  md.push(`| **Branch** | ${branch || "unknown"} |`);
  md.push(`| **Messages** | ${messages.length} |`);
  md.push("");
  md.push("---");
  md.push("");

  for (const msg of messages) {
    const label = msg.role === "user" ? "User" : "Assistant";
    const time = msg.timestamp ? ` <sub>${msg.timestamp.slice(11, 19)}</sub>` : "";
    md.push(`## ${label}${time}`);
    md.push("");
    md.push(msg.content);
    md.push("");
  }

  return { markdown: md.join("\n"), project, date, sessionId };
}

function main() {
  if (!existsSync(CLAUDE_DIR)) {
    console.error(`Claude projects directory not found: ${CLAUDE_DIR}`);
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;

  for (const projDir of readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
    if (!projDir.isDirectory()) continue;
    const projPath = join(CLAUDE_DIR, projDir.name);

    for (const file of readdirSync(projPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const jsonlPath = join(projPath, file);

      // Skip small files
      const stat = statSync(jsonlPath);
      if (stat.size < MIN_SIZE) {
        skipped++;
        continue;
      }

      // Check if already imported
      const sessionId = file.replace(".jsonl", "");
      // We don't know the exact output path yet, so just try converting
      const result = convertTranscript(jsonlPath);
      if (!result) {
        skipped++;
        continue;
      }

      const outDir = join(MEMORY_ROOT, "sessions", result.project, result.date);
      const outPath = join(outDir, `${result.sessionId}.md`);

      if (existsSync(outPath)) {
        skipped++;
        continue;
      }

      mkdirSync(outDir, { recursive: true });
      writeFileSync(outPath, result.markdown, "utf-8");
      imported++;
      console.log(`  ${result.project}/${result.date}/${result.sessionId}`);
    }
  }

  console.log(`\nImported: ${imported} sessions, Skipped: ${skipped}`);
}

main();

/**
 * Session capture script — called by Claude Code's SessionEnd hook.
 * Reads hook input from stdin, converts JSONL transcript to markdown,
 * saves to sessions/<project>/<date>/<session-id>.md
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { basename, dirname } from "path";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  reason?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
}

interface Message {
  role: string;
  content: string | ContentBlock[];
  model?: string;
}

interface TranscriptLine {
  type: string;
  message?: Message;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  uuid?: string;
}

const MEMORY_ROOT = getMemoryRoot();

export function getMemoryRoot(): string {
  // Allow override via env var, otherwise use the repo's own directory
  return process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");
}

export function deriveProjectName(cwd: string): string {
  // Try to derive a canonical name from the git remote URL.
  // This ensures the same repo gets the same project name regardless
  // of what folder it's cloned into on different machines.
  //   git@github.com:user/my-app.git  → my-app
  //   https://github.com/user/my-app  → my-app
  // Falls back to folder name for non-git directories.
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    })
      .toString()
      .trim();
    if (remote) {
      const name = extractRepoName(remote);
      if (name) return name;
    }
  } catch {
    // Not a git repo or no origin remote — fall back to folder name
  }
  return basename(cwd);
}

export function extractRepoName(remoteUrl: string): string | null {
  // SSH: git@github.com:user/repo.git
  const sshMatch = remoteUrl.match(/[:\/]([^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return null;
}

export function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10); // YYYY-MM-DD
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

export function renderContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      const inputSummary = block.input
        ? truncate(JSON.stringify(block.input), 200)
        : "";
      parts.push(`\n**Tool: ${block.name}**\n\`\`\`\n${inputSummary}\n\`\`\``);
    } else if (block.type === "tool_result") {
      const resultContent = block.content;
      if (typeof resultContent === "string") {
        parts.push(`\n<details><summary>Tool result</summary>\n\n${truncate(resultContent, 500)}\n\n</details>`);
      } else if (Array.isArray(resultContent)) {
        for (const sub of resultContent) {
          if (sub.type === "text" && sub.text) {
            parts.push(`\n<details><summary>Tool result</summary>\n\n${truncate(sub.text, 500)}\n\n</details>`);
          }
        }
      }
    }
  }
  return parts.join("\n");
}

export function stripSystemTags(text: string): string {
  // Remove <local-command-caveat>...</local-command-caveat> and similar meta tags
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

export function convertTranscript(jsonlPath: string, cwd: string, sessionId: string): string | null {
  if (!existsSync(jsonlPath)) {
    process.stderr.write(`Transcript not found: ${jsonlPath}\n`);
    return null;
  }

  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: { role: string; content: string; timestamp: string; model?: string }[] = [];
  let firstTimestamp = "";
  let branch = "";

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip non-message entries
    if (!entry.message || !entry.type) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isSidechain) continue;
    if (entry.isMeta) continue;

    if (!firstTimestamp && entry.timestamp) firstTimestamp = entry.timestamp;
    if (!branch && entry.gitBranch) branch = entry.gitBranch;

    const rawContent = renderContent(entry.message.content);
    const content = entry.type === "user" ? stripSystemTags(rawContent) : rawContent;

    // Skip empty messages after stripping
    if (!content.trim()) continue;

    messages.push({
      role: entry.type,
      content,
      timestamp: entry.timestamp || "",
      model: entry.message.model,
    });
  }

  if (messages.length === 0) return null;

  const project = deriveProjectName(cwd);
  const date = firstTimestamp ? formatDate(firstTimestamp) : "unknown";

  // Build markdown
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

  return md.join("\n");
}

async function main() {
  // Read hook input from stdin
  let stdinData = "";
  try {
    stdinData = readFileSync("/dev/stdin", "utf-8");
  } catch {
    // If stdin is empty/closed, check for CLI args as fallback
  }

  let hookInput: HookInput;

  if (stdinData.trim()) {
    hookInput = JSON.parse(stdinData);
  } else {
    // Fallback: manual invocation with args
    const transcriptPath = process.argv[2];
    if (!transcriptPath) {
      process.stderr.write("Usage: capture.ts <transcript_path> [cwd] [session_id]\n");
      process.exit(1);
    }
    hookInput = {
      transcript_path: transcriptPath,
      cwd: process.argv[3] || dirname(transcriptPath),
      session_id: process.argv[4] || basename(transcriptPath, ".jsonl"),
      permission_mode: "default",
      hook_event_name: "SessionEnd",
    };
  }

  const { transcript_path, cwd, session_id } = hookInput;

  const markdown = convertTranscript(transcript_path, cwd, session_id);
  if (!markdown) {
    process.stderr.write(`No meaningful messages in session ${session_id}, skipping.\n`);
    process.exit(0);
  }

  const project = deriveProjectName(cwd);
  const date = formatDate(new Date().toISOString());
  const outDir = `${MEMORY_ROOT}/sessions/${project}/${date}`;
  const outPath = `${outDir}/${session_id}.md`;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, markdown, "utf-8");

  process.stderr.write(`Captured session → ${outPath}\n`);
}

// Only run main() when executed directly (not imported as a module for testing)
const isDirectRun = process.argv[1]?.endsWith("capture.ts") || process.argv[1]?.endsWith("capture.js");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`capture error: ${err}\n`);
    process.exit(1);
  });
}

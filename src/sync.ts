/**
 * Git sync helper — pull before session, commit+push after capture.
 * Usage: tsx sync.ts pull | tsx sync.ts push
 */

import { execSync } from "child_process";
import { dirname } from "path";

const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");

function run(cmd: string): string {
  try {
    return execSync(cmd, { cwd: MEMORY_ROOT, encoding: "utf-8", timeout: 30000 }).trim();
  } catch (err) {
    const e = err as { stderr?: string };
    process.stderr.write(`sync: ${cmd} failed: ${e.stderr || err}\n`);
    return "";
  }
}

function pull(): void {
  // Check if we have a remote configured
  const remotes = run("git remote");
  if (!remotes) {
    process.stderr.write("sync: no git remote configured, skipping pull\n");
    return;
  }

  run("git pull --rebase --autostash");
  process.stderr.write("sync: pulled latest from remote\n");
}

function push(): void {
  // Check for changes
  const status = run("git status --porcelain");
  if (!status) {
    process.stderr.write("sync: no changes to push\n");
    return;
  }

  // Stage session and summary files only
  run("git add sessions/ summaries/ INDEX.md");

  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  run(`git commit -m "memory: auto-capture ${timestamp}"`);

  const remotes = run("git remote");
  if (remotes) {
    run("git push");
    process.stderr.write("sync: pushed to remote\n");
  } else {
    process.stderr.write("sync: committed locally (no remote configured)\n");
  }
}

const action = process.argv[2];
if (action === "pull") {
  pull();
} else if (action === "push") {
  push();
} else {
  console.log("Usage: tsx sync.ts pull|push");
}

/**
 * Install configuration helper for claude-memory.
 * Merges hooks into ~/.claude/settings.json and MCP server into ~/.claude.json.
 *
 * Usage:
 *   npx tsx src/install-config.ts --install-dir /path/to/claude-memory
 *   npx tsx src/install-config.ts --install-dir /path/to/claude-memory --dry-run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const installDirIdx = args.indexOf("--install-dir");
const INSTALL_DIR =
  installDirIdx !== -1 && args[installDirIdx + 1]
    ? args[installDirIdx + 1]
    : process.cwd();

const HOME = homedir();
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const CLAUDE_JSON_PATH = join(HOME, ".claude.json");

// ─── Helpers ─────────────────────────────────────────────────────────

function readJsonFile(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, data: any): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ─── Merge hooks into settings.json ──────────────────────────────────

function mergeHooks(): { changed: boolean; message: string } {
  const settings = readJsonFile(SETTINGS_PATH);

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

  const sessionStartCommand = `${INSTALL_DIR}/hooks/session-start.sh`;
  const sessionEndCommand = `${INSTALL_DIR}/hooks/session-end.sh`;

  // Check if hooks already exist (match by command path)
  const hasSessionStart = settings.hooks.SessionStart.some((entry: any) =>
    entry.hooks?.some((h: any) => h.command === sessionStartCommand)
  );
  const hasSessionEnd = settings.hooks.SessionEnd.some((entry: any) =>
    entry.hooks?.some((h: any) => h.command === sessionEndCommand)
  );

  let changed = false;

  if (!hasSessionStart) {
    settings.hooks.SessionStart.push({
      matcher: "startup",
      hooks: [
        {
          type: "command",
          command: sessionStartCommand,
          timeout: 15,
          async: true,
        },
      ],
    });
    changed = true;
  }

  if (!hasSessionEnd) {
    settings.hooks.SessionEnd.push({
      hooks: [
        {
          type: "command",
          command: sessionEndCommand,
          timeout: 30,
        },
      ],
    });
    changed = true;
  }

  if (changed && !dryRun) {
    writeJsonFile(SETTINGS_PATH, settings);
  }

  if (!changed) {
    return { changed: false, message: "Hooks already configured in settings.json" };
  }
  if (dryRun) {
    return { changed: true, message: "[dry-run] Would add hooks to settings.json" };
  }
  return { changed: true, message: "Added hooks to settings.json" };
}

// ─── Add MCP server to claude.json ───────────────────────────────────

function addMcpServer(): { changed: boolean; message: string } {
  const config = readJsonFile(CLAUDE_JSON_PATH);

  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers["claude-memory"]) {
    return { changed: false, message: "MCP server already configured in claude.json" };
  }

  config.mcpServers["claude-memory"] = {
    type: "stdio",
    command: "npx",
    args: [
      "--prefix",
      INSTALL_DIR,
      "tsx",
      `${INSTALL_DIR}/src/server.ts`,
    ],
    env: {
      CLAUDE_MEMORY_ROOT: INSTALL_DIR,
    },
  };

  if (!dryRun) {
    writeJsonFile(CLAUDE_JSON_PATH, config);
  }

  if (dryRun) {
    return { changed: true, message: "[dry-run] Would add MCP server to claude.json" };
  }
  return { changed: true, message: "Added MCP server to claude.json" };
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  console.log(`claude-memory installer config`);
  console.log(`  Install dir: ${INSTALL_DIR}`);
  console.log(`  Settings:    ${SETTINGS_PATH}`);
  console.log(`  Claude JSON: ${CLAUDE_JSON_PATH}`);
  if (dryRun) console.log(`  Mode:        DRY RUN`);
  console.log();

  const hookResult = mergeHooks();
  console.log(`  [hooks]  ${hookResult.message}`);

  const mcpResult = addMcpServer();
  console.log(`  [mcp]    ${mcpResult.message}`);

  console.log();

  if (hookResult.changed || mcpResult.changed) {
    if (!dryRun) {
      console.log("Configuration updated successfully.");
    }
  } else {
    console.log("Everything already configured. No changes needed.");
  }
}

main();

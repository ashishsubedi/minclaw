import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../config.ts";
import { getCompactedState } from "./compaction.ts";

export type MemoryEntry = {
  timestamp: number;
  channel: string;
  sender: string;
  role: "user" | "assistant";
  text: string;
};

/**
 * Memory system: all chats saved as markdown files, one per session.
 * A master temporary-memory.md index is regenerated and loaded with every agent call.
 *
 * Structure:
 *   memory/
 *     temporary-memory.md  ← master index, loaded into agent context
 *     chats/
 *       telegram-@user.md
 *       whatsapp-1234567890.md
 *       slack-U12345.md
 */

function getMemoryDir(): string {
  const config = loadConfig();
  return resolve(config.memory.dir);
}

function getChatsDir(): string {
  return join(getMemoryDir(), "chats");
}

function getIndexPath(): string {
  const config = loadConfig();
  return resolve(config.memory.indexFile);
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_@+\-]/g, "_");
}

export function sessionKey(channel: string, sender: string): string {
  return `${channel}-${sanitizeFilename(sender)}`;
}

export function ensureMemoryDirs(): void {
  const memDir = getMemoryDir();
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(memDir, 0o700);
  } catch {}

  const chatsDir = getChatsDir();
  if (!existsSync(chatsDir)) {
    mkdirSync(chatsDir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(chatsDir, 0o700);
  } catch {}
}

/** Append a message to the session's chat markdown file */
export function appendChat(
  channel: string,
  sender: string,
  role: "user" | "assistant",
  text: string
): void {
  ensureMemoryDirs();
  const key = sessionKey(channel, sender);
  const filePath = join(getChatsDir(), `${key}.md`);

  const timestamp = new Date().toISOString();
  const prefix = role === "user" ? "**You**" : "**Agent**";
  const entry = `\n### ${prefix} — ${timestamp}\n\n${text}\n`;

  if (!existsSync(filePath)) {
    const header = `# Chat: ${channel} / ${sender}\n\nSession key: \`${key}\`\n`;
    writeFileSync(filePath, header + entry, "utf-8");
  } else {
    appendFileSync(filePath, entry, "utf-8");
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

/** Get all chat history for a session */
export function getChatHistory(channel: string, sender: string): string {
  const key = sessionKey(channel, sender);
  const filePath = join(getChatsDir(), `${key}.md`);
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8");
}

/** List all sessions with basic stats */
export function listSessions(): Array<{
  key: string;
  file: string;
  lines: number;
  sizeBytes: number;
  lastModified: Date;
}> {
  const chatsDir = getChatsDir();
  if (!existsSync(chatsDir)) return [];

  return readdirSync(chatsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const filePath = join(chatsDir, f);
      const stat = Bun.file(filePath);
      const content = readFileSync(filePath, "utf-8");
      return {
        key: f.replace(".md", ""),
        file: filePath,
        lines: content.split("\n").length,
        sizeBytes: stat.size,
        lastModified: new Date(stat.lastModified),
      };
    })
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

/** Search across all chat files for a query string */
export function searchMemory(query: string): Array<{
  key: string;
  matches: string[];
}> {
  const chatsDir = getChatsDir();
  if (!existsSync(chatsDir)) return [];

  const results: Array<{ key: string; matches: string[] }> = [];
  const queryLower = query.toLowerCase();

  for (const file of readdirSync(chatsDir).filter((f) => f.endsWith(".md"))) {
    const content = readFileSync(join(chatsDir, file), "utf-8");
    const lines = content.split("\n");
    const matches = lines.filter((line) =>
      line.toLowerCase().includes(queryLower)
    );
    if (matches.length > 0) {
      results.push({
        key: file.replace(".md", ""),
        matches,
      });
    }
  }

  return results;
}

/** Rebuild the master temporary-memory.md index file */
export function rebuildMemoryIndex(): string {
  ensureMemoryDirs();
  const sessions = listSessions();
  const indexPath = getIndexPath();

  let md = `# MinClaw Temporary Memory Index\n\n`;
  md += `> Auto-generated. Last updated: ${new Date().toISOString()}\n\n`;
  md += `## Active Sessions (${sessions.length})\n\n`;

  for (const s of sessions) {
    md += `- **${s.key}** — ${s.lines} lines, last active ${s.lastModified.toISOString()}\n`;
  }

  md += `\n## Recent Activity\n\n`;

  // Include last few messages from each recent session
  for (const s of sessions.slice(0, 5)) {
    const content = readFileSync(s.file, "utf-8");
    const lines = content.split("\n");
    const colonKey = s.key.replace("-", ":");
    const compacted = getCompactedState(colonKey);
    const hasSummary = Boolean(compacted?.summary?.trim());
    const tailLines = hasSummary ? 12 : 20;
    const tail = lines.slice(-tailLines).join("\n");

    md += `### ${s.key}\n\n`;
    if (hasSummary && compacted) {
      md += `#### Compacted Summary\n\n${compacted.summary.trim()}\n\n`;
    }
    md += `${tail}\n\n---\n\n`;
  }

  writeFileSync(indexPath, md, "utf-8");
  try {
    chmodSync(indexPath, 0o600);
  } catch {}
  return md;
}

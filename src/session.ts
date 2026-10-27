import { mkdirSync, existsSync, appendFileSync, readFileSync, unlinkSync, chmodSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "./config.ts";

export type SessionToolCall = {
  name: string;
  input: unknown;
  output: string;
};

export type SessionMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  channel?: string;
  sender?: string;
  attachments?: Array<{ type: string; filePath: string; mimeType?: string }>;
  toolCalls?: SessionToolCall[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    costSource?: "catalog" | "estimated-openai" | "unavailable";
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
};

/**
 * JSONL session transcripts — one file per sender.
 * Used to feed conversation history to the agent.
 */

export function getSessionDir(): string {
  const config = loadConfig();
  const dir = resolve(config.sessions.dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

function sessionFilePath(sessionKey: string): string {
  return join(getSessionDir(), `${sessionKey}.jsonl`);
}

export function appendMessage(sessionKey: string, msg: SessionMessage): void {
  const path = sessionFilePath(sessionKey);
  appendFileSync(path, JSON.stringify(msg) + "\n", "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function getAllMessages(sessionKey: string): SessionMessage[] {
  const path = sessionFilePath(sessionKey);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  return lines.map((l) => JSON.parse(l) as SessionMessage);
}

export function getMessages(sessionKey: string): SessionMessage[] {
  let messages = getAllMessages(sessionKey);
  if (messages.length === 0) return [];

  const compactedPath = join(getSessionDir(), `${sessionKey}.compacted.json`);
  if (existsSync(compactedPath)) {
    try {
      const compactedState = JSON.parse(readFileSync(compactedPath, "utf-8"));
      const count = typeof compactedState?.compactedCount === "number" ? compactedState.compactedCount : 0;
      if (count > 0 && count <= messages.length) {
        messages = messages.slice(count);
      } else if (count > messages.length) {
        messages = [];
      }
    } catch (err) {
      console.warn(`[session] Failed to read compacted state for ${sessionKey}:`, err);
    }
  }

  const config = loadConfig();
  // Respect maxTurns — keep the most recent
  if (messages.length > config.sessions.maxTurns * 2) {
    return messages.slice(-config.sessions.maxTurns * 2);
  }
  return messages;
}

export function clearSession(sessionKey: string): void {
  const jsonlPath = sessionFilePath(sessionKey);
  if (existsSync(jsonlPath)) {
    unlinkSync(jsonlPath);
  }
  const compactedPath = join(getSessionDir(), `${sessionKey}.compacted.json`);
  if (existsSync(compactedPath)) {
    unlinkSync(compactedPath);
  }
}

export function sessionKeyFromMessage(
  channel: string,
  sender: string
): string {
  return `${channel}:${sender.replace(/[^a-zA-Z0-9_@+\-]/g, "_")}`;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { listAllUnreadEmails } from "../email/service.ts";

export type ReflexItem = {
  source: "logseq" | "email" | "calendar" | "deal" | "briefing";
  title: string;
  details?: string;
  urgent?: boolean;
};

export type ReflexReport = {
  hasDelta: boolean;
  items: ReflexItem[];
  summary: string;
};

const STATE_DIR = join(homedir(), ".minclaw");
const SEEN_TASKS_FILE = join(STATE_DIR, "seen-tasks.json");
const SEEN_EMAILS_FILE = join(STATE_DIR, "seen-emails.json");
const BRIEFING_STATE_FILE = join(STATE_DIR, "briefing-state.json");

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson<T>(filePath: string, data: T): void {
  ensureStateDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function resolveLogseqGraph(): string {
  const custom = process.env.LOGSEQ_GRAPH;
  if (custom?.trim()) return custom.trim();

  const cfg1 = join(homedir(), ".config/logseq_memory/graph");
  if (existsSync(cfg1)) {
    const val = readFileSync(cfg1, "utf-8").trim();
    if (val) return val;
  }

  const cfg2 = join(homedir(), ".config/logseq-memory/graph");
  if (existsSync(cfg2)) {
    const val = readFileSync(cfg2, "utf-8").trim();
    if (val) return val;
  }

  return "logseq-sync";
}

/**
 * Check Logseq for open delegated agent tasks or human-reviewed tasks
 */
async function checkLogseqTasks(): Promise<ReflexItem[]> {
  const items: ReflexItem[] = [];
  const graph = resolveLogseqGraph();
  const query = '[:find (pull ?b [:db/id :block/title :block/created-at :block/updated-at {:logseq.property/status [:block/title :db/ident]} {:block/tags [:block/title :block/name]} {:block/page [:block/title :block/name]} {:block/refs [:block/title :block/name]}]) :where [?t :block/name "agent_task"] [?b :block/tags ?t]]';

  try {
    const proc = Bun.spawn(
      ["logseq", "query", "--graph", graph, "--query", query, "--output", "json"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!stdout.trim()) return items;
    const parsed = JSON.parse(stdout);
    const rawResults = parsed?.data?.result || [];
    const seenMap = loadJson<Record<string, number>>(SEEN_TASKS_FILE, {});
    let updated = false;

    for (const row of rawResults) {
      const block = Array.isArray(row) ? row[0] : row;
      if (!block || !block["db/id"]) continue;

      const id = String(block["db/id"]);
      const title = block["block/title"] || "(untitled task)";
      const statusObj = block["logseq.property/status"];
      const statusIdent = statusObj?.["db/ident"] || "";
      const tags = (block["block/tags"] || []).map((t: any) => t["block/name"]?.toLowerCase() || "");
      const isDelegate = tags.includes("delegate") || tags.includes("minclaw");
      const updatedAt = block["block/updated-at"] || 0;

      // Check if task is open TODO and marked for delegation
      if (statusIdent.includes("todo") && isDelegate) {
        if (!seenMap[id] || seenMap[id] < updatedAt) {
          items.push({
            source: "logseq",
            title: `Delegated Task: ${title}`,
            details: `Block ID ${id} in ${block["block/page"]?.["block/title"] || "journal"}. Tags: ${tags.join(", ")}`,
            urgent: true,
          });
          seenMap[id] = updatedAt;
          updated = true;
        }
      }
    }

    if (updated) {
      saveJson(SEEN_TASKS_FILE, seenMap);
    }
  } catch (err) {
    // Non-fatal if logseq CLI is temporarily busy
  }

  return items;
}

/**
 * Check unread emails via connected Google/IMAP accounts or Himalaya CLI
 */
async function checkEmailDeltas(): Promise<ReflexItem[]> {
  const items: ReflexItem[] = [];
  const seenIds = new Set(loadJson<string[]>(SEEN_EMAILS_FILE, []));
  let hasNew = false;

  // 1. Check all connected accounts (Google OAuth + configured IMAP)
  try {
    const unreadList = await listAllUnreadEmails(5);
    for (const msg of unreadList) {
      const id = `${msg.accountId}_${msg.id}`;
      if (seenIds.has(id)) continue;

      items.push({
        source: "email",
        title: `[${msg.accountEmail}] New Email from ${msg.from}: ${msg.subject}`,
        details: `Date: ${msg.date}. ${msg.snippet ? `Snippet: ${msg.snippet.slice(0, 100)}` : ""}`,
        urgent: true,
      });
      seenIds.add(id);
      hasNew = true;
    }
  } catch {
    // Non-fatal
  }

  // 2. Fallback to Himalaya envelopes if no items found
  if (items.length === 0) {
    const cfg1 = join(homedir(), ".config/himalaya/config.toml");
    const cfg2 = join(homedir(), "Library/Application Support/himalaya/config.toml");
    if (existsSync(cfg1) || existsSync(cfg2)) {
      try {
        const proc = Bun.spawn(
          ["himalaya", "envelope", "list", "-s", "5", "--output", "json"],
          { stdout: "pipe", stderr: "pipe" }
        );
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        if (stdout.trim()) {
          const envelopes = JSON.parse(stdout);
          if (Array.isArray(envelopes)) {
            for (const env of envelopes) {
              const id = `himalaya_${String(env.id || env.internal_id || "")}`;
              if (!id || seenIds.has(id)) continue;

              const flags = env.flags || [];
              const isUnread = !flags.includes("seen") && !flags.includes("Seen");
              if (isUnread) {
                items.push({
                  source: "email",
                  title: `New Email from ${env.from?.name || env.from?.addr || "Unknown"}: ${env.subject || "(no subject)"}`,
                  details: `Date: ${env.date || "recently"}`,
                  urgent: true,
                });
                seenIds.add(id);
                hasNew = true;
              }
            }
          }
        }
      } catch {}
    }
  }

  if (hasNew) {
    saveJson(SEEN_EMAILS_FILE, Array.from(seenIds).slice(-200));
  }

  return items;
}

/**
 * Check if morning briefing should fire (once a day between 08:00 and 09:30)
 */
function checkBriefingDue(): ReflexItem | null {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const isMorning = (hour === 8 && minute >= 30) || (hour === 9 && minute <= 30);
  if (!isMorning) return null;

  const todayStr = now.toISOString().slice(0, 10);
  const state = loadJson<{ lastBriefingDate?: string }>(BRIEFING_STATE_FILE, {});
  if (state.lastBriefingDate === todayStr) return null;

  state.lastBriefingDate = todayStr;
  saveJson(BRIEFING_STATE_FILE, state);

  return {
    source: "briefing",
    title: "Daily Morning Briefing Due",
    details: `Local time is ${now.toLocaleTimeString()}. Provide a concise status of pending tasks and calendar items.`,
    urgent: false,
  };
}

/**
 * Execute the fast, zero-token reflex gate
 */
export async function runReflexCheck(): Promise<ReflexReport> {
  const items: ReflexItem[] = [];

  const [logseqItems, emailItems] = await Promise.all([
    checkLogseqTasks(),
    checkEmailDeltas(),
  ]);

  items.push(...logseqItems);
  items.push(...emailItems);

  const briefing = checkBriefingDue();
  if (briefing) {
    items.push(briefing);
  }

  const hasDelta = items.length > 0;
  let summary = "";

  if (hasDelta) {
    summary = `Reflex check detected ${items.length} actionable state changes:\n` +
      items.map((it, idx) => `${idx + 1}. [${it.source.toUpperCase()}] ${it.title}`).join("\n");
  }

  return {
    hasDelta,
    items,
    summary,
  };
}

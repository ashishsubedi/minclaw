import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { listAllUnreadEmails } from "../email/service.ts";
import type { EmailMessageSummary } from "../email/types.ts";
import { completeFast } from "../agent.ts";

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
  commit?: () => void;
};

export type EmailScoreResult = {
  id: string;
  score: number; // 0 to 10
  actionRequired: boolean;
  reason: string;
};

type DigestItem = {
  title: string;
  details: string;
  date: string;
};

type BriefingState = {
  lastBriefingDate?: string;
  digestItems?: DigestItem[];
};

const STATE_DIR = join(homedir(), ".minclaw");
const SEEN_TASKS_FILE = join(STATE_DIR, "seen-tasks.json");
const SEEN_EMAILS_FILE = join(STATE_DIR, "seen-emails.json");
const BRIEFING_STATE_FILE = join(STATE_DIR, "briefing-state.json");
const LOW_PRIORITY_EMAIL_QUEUE_FILE = join(STATE_DIR, "low-priority-email-queue.json");
const EMAIL_CLEANUP_STATE_FILE = join(STATE_DIR, "email-cleanup-state.json");

export const ATTENTION_SCORE_THRESHOLD = 7;
export const DIGEST_SCORE_THRESHOLD = 4;
export const LOW_PRIORITY_BATCH_TRIGGER_COUNT = 10;
export const CLEANUP_PROMPT_THRESHOLD = 25;

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

export function formatLocalDate(d = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
async function checkLogseqTasks(commits?: Array<() => void>): Promise<ReflexItem[]> {
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
      const doSave = () => saveJson(SEEN_TASKS_FILE, seenMap);
      if (commits) {
        commits.push(doSave);
      } else {
        doSave();
      }
    }
  } catch {
    // Non-fatal if logseq CLI is temporarily busy
  }

  return items;
}

/**
 * Add an informational email to the daily morning briefing digest queue
 */
function addDigestItem(item: DigestItem, commits?: Array<() => void>): void {
  const doSave = () => {
    const state = loadJson<BriefingState>(BRIEFING_STATE_FILE, {});
    if (!state.digestItems) state.digestItems = [];
    state.digestItems.push(item);
    if (state.digestItems.length > 50) {
      state.digestItems = state.digestItems.slice(-50);
    }
    saveJson(BRIEFING_STATE_FILE, state);
  };
  if (commits) {
    commits.push(doSave);
  } else {
    doSave();
  }
}

function isMorningBriefingWindow(): boolean {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  return (hour === 8 && minute >= 30) || (hour === 9 && minute <= 30);
}

/**
 * Classify a batch of emails using a fast LLM call.
 * Assigns a 0 to 10 score based on whether the email genuinely requires user attention or interaction.
 */
export async function classifyEmailBatchWithLLM(
  emails: EmailMessageSummary[]
): Promise<Map<string, EmailScoreResult>> {
  const results = new Map<string, EmailScoreResult>();
  if (emails.length === 0) return results;

  const payload = emails.map((e) => ({
    id: e.id,
    from: e.from,
    subject: e.subject,
    snippet: e.snippet?.slice(0, 160) || "",
    category: e.category || "other",
  }));

  const systemPrompt = `You are a strict, Wabi-style email attention gatekeeper.
Your job is to protect the user from notification fatigue and decide which emails genuinely require the user's attention or interaction.

Rate each email on a scale of 0 to 10 for how important it is for the user to see or interact with:
- 8 to 10: Critical / Attention required (direct questions, bills needing payment/changes, flight/schedule disruptions, signature requests, high-priority work).
- 4 to 7: Informational / Good to know (shipped orders, non-urgent calendar updates, account statements, useful digests).
- 0 to 3: Pure Noise / Marketing (promotional blasts, 20% off sales, routine ads, social notifications, automated forum posts).

Respond ONLY with a valid JSON array of objects:
[
  {
    "id": "email_id",
    "score": number (0-10),
    "actionRequired": boolean,
    "reason": "1 short sentence explaining what needs attention or why it is informational/noise"
  }
]`;

  try {
    const rawOutput = await completeFast(JSON.stringify(payload, null, 2), systemPrompt);
    const jsonMatch = rawOutput.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as EmailScoreResult[];
      for (const item of parsed) {
        if (item && item.id != null) {
          results.set(String(item.id), item);
        }
      }
    }
  } catch (err) {
    console.warn(`[reflex] Email batch classification error: ${err}`);
  }

  return results;
}

/**
 * Check Himalaya CLI envelopes for fallback when no MinClaw IMAP accounts return items
 */
async function checkHimalayaFallback(seenIds: Set<string>): Promise<ReflexItem[]> {
  const items: ReflexItem[] = [];
  const cfg1 = join(homedir(), ".config/himalaya/config.toml");
  const cfg2 = join(homedir(), "Library/Application Support/himalaya/config.toml");
  if (!existsSync(cfg1) && !existsSync(cfg2)) return items;

  try {
    const proc = Bun.spawn(
      ["himalaya", "envelope", "list", "-s", "5", "--json"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!stdout.trim()) return items;
    const parsed = JSON.parse(stdout);
    const rawEnvelopes = Array.isArray(parsed) ? parsed : parsed?.envelopes;
    if (Array.isArray(rawEnvelopes)) {
      for (const env of rawEnvelopes) {
        const id = `himalaya_${String(env.id || env.internal_id || "")}`;
        if (!id || seenIds.has(id)) continue;

        const rawFlags = Array.isArray(env.flags) ? env.flags : [];
        const hasSeen = rawFlags.some((f: any) => {
          if (typeof f === "string") return f.toLowerCase() === "seen";
          const val = f?.iana || f?.raw || "";
          return String(val).toLowerCase().includes("seen");
        });
        if (!hasSeen) {
          items.push({
            source: "email",
            title: `New Email from ${env.from?.name || env.from?.addr || "Unknown"}: ${env.subject || "(no subject)"}`,
            details: `Date: ${env.date || "recently"}`,
            urgent: true,
          });
          seenIds.add(id);
        }
      }
    }
  } catch {}

  return items;
}

/**
 * Check if unread promotional / low-priority clutter has piled up and suggest cleanup
 */
function checkInboxHygieneSuggestion(
  unreadList: EmailMessageSummary[],
  stateFilePath = EMAIL_CLEANUP_STATE_FILE,
  commits?: Array<() => void>
): ReflexItem | null {
  const promos = unreadList.filter(
    (m) => m.category === "promotions" || m.category === "social" || m.category === "forums"
  );
  if (promos.length < CLEANUP_PROMPT_THRESHOLD) return null;

  const now = new Date();
  const todayStr = formatLocalDate(now);
  const cleanupState = loadJson<{ lastPromptDate?: string }>(stateFilePath, {});

  // Prompt at most once every 3 days
  if (cleanupState.lastPromptDate) {
    const lastDate = new Date(cleanupState.lastPromptDate);
    const diffDays = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 3) return null;
  }

  cleanupState.lastPromptDate = todayStr;
  const doSave = () => saveJson(stateFilePath, cleanupState);
  if (commits) {
    commits.push(doSave);
  } else {
    doSave();
  }

  return {
    source: "email",
    title: "🧹 Inbox Hygiene Suggestion",
    details: `You have ${promos.length}+ unread promotional and marketing emails. Let me know if you would like me to bulk archive or clean them up.`,
    urgent: false,
  };
}

/**
 * Check unread emails via Wabi-style reflex gate:
 * 1. Non-Gmail (IMAP / Uni / Work): Inactive/high-signal -> triggers immediately.
 * 2. Gmail Primary / Updates: Delta triggers immediate fast LLM classification (with 0-10 scoring).
 * 3. Gmail Promotions / Forums: Queued until Primary/Updates delta, threshold count (10+), or morning briefing.
 * 4. Scores 7-10 alert immediately, 4-6 hold for morning briefing, 0-3 silently marked seen.
 */
async function checkEmailDeltas(commits?: Array<() => void>): Promise<ReflexItem[]> {
  const items: ReflexItem[] = [];
  const seenIds = new Set(loadJson<string[]>(SEEN_EMAILS_FILE, []));
  let hasNew = false;

  let unreadList: EmailMessageSummary[] = [];
  try {
    unreadList = await listAllUnreadEmails(15);
  } catch {
    // Non-fatal
  }

  // 1. Non-Gmail (IMAP / University / Work)
  // Low traffic, high signal -> any new unread triggers immediately
  const nonGoogle = unreadList.filter(
    (msg) => msg.accountType !== "google" && !seenIds.has(`${msg.accountId}_${msg.id}`)
  );
  for (const msg of nonGoogle) {
    const id = `${msg.accountId}_${msg.id}`;
    items.push({
      source: "email",
      title: `[${msg.accountEmail}] New Email from ${msg.from}: ${msg.subject}`,
      details: `Date: ${msg.date}. ${msg.snippet ? `Snippet: ${msg.snippet.slice(0, 100)}` : ""}`,
      urgent: true,
    });
    seenIds.add(id);
    hasNew = true;
  }

  // Fallback to Himalaya CLI envelopes if nonGoogle was empty and himalaya exists
  if (nonGoogle.length === 0) {
    const himalayaItems = await checkHimalayaFallback(seenIds);
    if (himalayaItems.length > 0) {
      items.push(...himalayaItems);
      hasNew = true;
    }
  }

  // 2. Gmail Accounts (Selective Attention Gate)
  const googleUnseen = unreadList.filter(
    (msg) => msg.accountType === "google" && !seenIds.has(`${msg.accountId}_${msg.id}`)
  );

  const primaryOrUpdates = googleUnseen.filter(
    (msg) => msg.category === "primary" || msg.category === "updates"
  );
  const newLowerPriority = googleUnseen.filter(
    (msg) => msg.category !== "primary" && msg.category !== "updates"
  );

  // Load existing low-priority queue
  let queuedLower = loadJson<EmailMessageSummary[]>(LOW_PRIORITY_EMAIL_QUEUE_FILE, []);

  // Merge new lower priority emails into queue (avoid duplicates by accountId_id)
  const queuedIds = new Set(queuedLower.map((m) => `${m.accountId}_${m.id}`));
  for (const msg of newLowerPriority) {
    const key = `${msg.accountId}_${msg.id}`;
    if (!queuedIds.has(key)) {
      queuedLower.push(msg);
      queuedIds.add(key);
    }
  }

  const hasPrimaryDelta = primaryOrUpdates.length > 0;
  const queueThresholdReached = queuedLower.length >= LOW_PRIORITY_BATCH_TRIGGER_COUNT;
  const isMorning = isMorningBriefingWindow();

  // If primary/updates has delta, or queue threshold reached, or morning briefing:
  if (hasPrimaryDelta || queueThresholdReached || isMorning) {
    const toClassify: EmailMessageSummary[] = [...primaryOrUpdates, ...queuedLower];

    if (toClassify.length > 0) {
      const scores = await classifyEmailBatchWithLLM(toClassify);

      for (const msg of toClassify) {
        const key = `${msg.accountId}_${msg.id}`;
        seenIds.add(key);
        hasNew = true;

        const rating = scores.get(msg.id);
        if (rating) {
          const score = typeof rating.score === "number" ? rating.score : 0;
          if (score >= ATTENTION_SCORE_THRESHOLD || rating.actionRequired) {
            // High attention: alerts immediately
            items.push({
              source: "email",
              title: `[${msg.accountEmail}] [Action Required] ${msg.from}: ${msg.subject}`,
              details: `Score: ${score}/10. ${rating.reason || msg.snippet?.slice(0, 100) || ""}`,
              urgent: true,
            });
          } else if (score >= DIGEST_SCORE_THRESHOLD) {
            // Informational: buffer for daily morning briefing
            addDigestItem({
              title: `[${msg.accountEmail}] ${msg.from}: ${msg.subject}`,
              details: rating.reason || msg.snippet?.slice(0, 100) || "",
              date: msg.date,
            }, commits);
          } else {
            // Low priority / noise (0-3): silently marked seen, no notification
          }
        } else {
          // Fallback if LLM failed to score this specific item
          if (msg.category === "primary" || msg.category === "updates") {
            items.push({
              source: "email",
              title: `[${msg.accountEmail}] New Email from ${msg.from}: ${msg.subject}`,
              details: `Date: ${msg.date}. ${msg.snippet ? `Snippet: ${msg.snippet.slice(0, 100)}` : ""}`,
              urgent: true,
            });
          }
        }
      }

      // Empty the queue since all queued items have been classified and marked seen
      queuedLower = [];
      const saveQueue = () => saveJson(LOW_PRIORITY_EMAIL_QUEUE_FILE, queuedLower);
      if (commits) {
        commits.push(saveQueue);
      } else {
        saveQueue();
      }
    }
  } else {
    // No primary delta & queue below threshold: save updated queue to disk
    // No LLM call made, zero tokens consumed!
    const saveQueue = () => saveJson(LOW_PRIORITY_EMAIL_QUEUE_FILE, queuedLower);
    if (commits) {
      commits.push(saveQueue);
    } else {
      saveQueue();
    }
  }

  // 3. Proactive Inbox Hygiene / Cleanup Suggestion
  const cleanupSuggestion = checkInboxHygieneSuggestion(unreadList, EMAIL_CLEANUP_STATE_FILE, commits);
  if (cleanupSuggestion) {
    items.push(cleanupSuggestion);
  }

  if (hasNew) {
    const toSave = Array.from(seenIds).slice(-300);
    const saveEmails = () => saveJson(SEEN_EMAILS_FILE, toSave);
    if (commits) {
      commits.push(saveEmails);
    } else {
      saveEmails();
    }
  }

  return items;
}

/**
 * Check if morning briefing should fire (once a day between 08:30 and 09:30)
 */
function checkBriefingDue(commits?: Array<() => void>): ReflexItem | null {
  const now = new Date();
  const isMorning = isMorningBriefingWindow();
  if (!isMorning) return null;

  const todayStr = formatLocalDate(now);
  const state = loadJson<BriefingState>(BRIEFING_STATE_FILE, {});
  if (state.lastBriefingDate === todayStr) return null;

  const digest = state.digestItems || [];
  const updatedState = { ...state, lastBriefingDate: todayStr, digestItems: [] };
  const doSave = () => saveJson(BRIEFING_STATE_FILE, updatedState);
  if (commits) {
    commits.push(doSave);
  } else {
    doSave();
  }

  let details = `Local time is ${now.toLocaleTimeString()}. Provide a concise status of pending tasks and calendar items.`;
  if (digest.length > 0) {
    details += `\n\n## Pending Email Digest (${digest.length} informational items):\n` +
      digest.map((d, i) => `${i + 1}. ${d.title}: ${d.details}`).join("\n");
  }

  return {
    source: "briefing",
    title: "Daily Morning Briefing Due",
    details,
    urgent: false,
  };
}

/**
 * Execute the fast reflex gate
 */
export async function runReflexCheck(options: { deferCommit?: boolean } = {}): Promise<ReflexReport> {
  const deferCommit = options.deferCommit ?? false;
  const commits: Array<() => void> = [];
  const items: ReflexItem[] = [];

  const [logseqItems, emailItems] = await Promise.all([
    checkLogseqTasks(deferCommit ? commits : undefined),
    checkEmailDeltas(deferCommit ? commits : undefined),
  ]);

  items.push(...logseqItems);
  items.push(...emailItems);

  const briefing = checkBriefingDue(deferCommit ? commits : undefined);
  if (briefing) {
    items.push(briefing);
  }

  const hasDelta = items.length > 0;
  let summary = "";

  if (hasDelta) {
    summary =
      `Reflex check detected ${items.length} actionable state changes:\n` +
      items
        .map((it, idx) => {
          let line = `${idx + 1}. [${it.source.toUpperCase()}] ${it.title}`;
          if (it.details?.trim()) {
            line += `\n   ${it.details.trim().split("\n").join("\n   ")}`;
          }
          return line;
        })
        .join("\n");
  }

  const commitFn = () => {
    for (const fn of commits) {
      try {
        fn();
      } catch (err) {
        console.warn(`[reflex] Commit error: ${err}`);
      }
    }
    commits.length = 0;
  };

  if (deferCommit) {
    if (!hasDelta) {
      // Noise (0-3) or buffered updates: commit immediately since onBeat won't run
      commitFn();
    }
  } else {
    commitFn();
  }

  return {
    hasDelta,
    items,
    summary,
    commit: commitFn,
  };
}

export { checkEmailDeltas, checkBriefingDue, checkInboxHygieneSuggestion, addDigestItem };

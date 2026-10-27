import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config.ts";
import { getAllMessages, getSessionDir } from "../session.ts";

export const WATERMARK_HIGH_TOKENS = 32_000;
export const WATERMARK_HIGH_TURNS = 20;
export const WATERMARK_KEEP_RECENT_TURNS = 4;
export const WATERMARK_CEILING_TOKENS = 48_000;

export type CompactedSessionState = {
  sessionKey: string;
  compactedCount: number;
  updatedAt: number;
  summary: string;
};

export type CompactSessionOptions = {
  force?: boolean;
  focus?: string;
  keepRecentTurns?: number;
  summarizer?: (prompt: string, systemPrompt: string) => Promise<string>;
};

export type AutoCompactOptions = {
  lastInputTokens?: number;
  summarizer?: (prompt: string, systemPrompt: string) => Promise<string>;
};

export function getCompactedFilePath(sessionKey: string): string {
  return join(getSessionDir(), `${sessionKey}.compacted.json`);
}

export function getCompactedState(sessionKey: string): CompactedSessionState | null {
  const filePath = getCompactedFilePath(sessionKey);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CompactedSessionState;
  } catch (err) {
    console.warn(`[compaction] Failed to read compacted state for ${sessionKey}:`, err);
    return null;
  }
}

export function saveCompactedState(state: CompactedSessionState): void {
  const filePath = getCompactedFilePath(state.sessionKey);
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export function clearCompactedState(sessionKey: string): void {
  const filePath = getCompactedFilePath(sessionKey);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export async function compactSession(
  sessionKey: string,
  options?: CompactSessionOptions
): Promise<{ compacted: boolean; messagesCompacted: number; state: CompactedSessionState | null }> {
  const allMessages = getAllMessages(sessionKey);
  const prevState = getCompactedState(sessionKey);
  const startIdx = prevState ? Math.min(prevState.compactedCount, allMessages.length) : 0;
  const config = loadConfig();

  let endIdx = startIdx;

  if (options?.keepRecentTurns !== undefined) {
    const keepMessagesCount = options.keepRecentTurns * 2;
    endIdx = Math.max(startIdx, allMessages.length - keepMessagesCount);
  } else {
    const keepRecentTurns = config.sessions.keepRecentTurns ?? 8;
    const keepMessagesCount = keepRecentTurns * 2;

    if (options?.force) {
      if (allMessages.length <= keepMessagesCount) {
        let candidate = allMessages.length - Math.min(4, Math.floor(allMessages.length / 2));
        if (candidate <= startIdx && allMessages.length > startIdx + 2) {
          candidate = allMessages.length - 2;
        } else if (candidate <= startIdx && allMessages.length > startIdx) {
          candidate = allMessages.length > startIdx + 1 ? allMessages.length - 1 : allMessages.length;
        }
        endIdx = Math.max(startIdx, candidate);
      } else {
        endIdx = Math.max(startIdx, allMessages.length - keepMessagesCount);
      }
    } else {
      endIdx = Math.max(startIdx, allMessages.length - keepMessagesCount);
    }
  }

  if (endIdx <= startIdx) {
    return { compacted: false, messagesCompacted: 0, state: prevState };
  }

  const messagesToCompact = allMessages.slice(startIdx, endIdx);
  const transcript = messagesToCompact
    .map((m) => {
      let line = `[${m.role.toUpperCase()}]`;
      if (m.toolCalls && m.toolCalls.length > 0) {
        const toolStr = m.toolCalls
          .map((tc) => {
            const inputStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input);
            const outStr = tc.output.length > 300 ? `${tc.output.slice(0, 300)}...` : tc.output;
            return `${tc.name}(${inputStr}) -> ${outStr.replace(/\s+/g, " ").trim()}`;
          })
          .join("; ");
        line += ` [Tools used: ${toolStr}]`;
      }
      line += ` ${m.content}`;
      return line;
    })
    .join("\n\n");

  const systemPrompt =
    "You are MinClaw's session compaction engine. Your role is to condense older conversation history into a structured, highly informative rolling summary so that vital context, exact IDs, entity names, user decisions, constraints, and tool results are never lost.";

  const prompt = `Please update the rolling session summary by incorporating the new messages below.

${prevState?.summary ? `Existing Summary:\n${prevState.summary}\n\n` : ""}New Messages to Incorporate:
${transcript}
${options?.focus ? `\nFocus Instructions:\n${options.focus}\n` : ""}
Produce a comprehensive, structured markdown summary covering the conversation using EXACTLY these 5 section headings:
### Active Context & Goals
### Key References & Entities
### Decisions & Constraints
### Open Threads
### Next Steps

Guidelines:
- In "### Active Context & Goals", summarize ongoing objectives and project context.
- In "### Key References & Entities", preserve exact names, IDs, file paths, URLs, emails, calendar events, commands, numbers, and tool outputs. Do not omit or generalize identifiers.
- In "### Decisions & Constraints", preserve all explicit user preferences, rules established, and architectural decisions.
- In "### Open Threads", note any unanswered questions, pending tasks, or ongoing discussions.
- In "### Next Steps", outline the immediate next actions or planned roadmap.
- If a section has nothing to report, write "None".
- Output only the markdown starting with "### Active Context & Goals".`;

  const summarizer =
    options?.summarizer ??
    (async (p: string, sp: string) => {
      const { completeFast } = await import("../agent.ts");
      return completeFast(p, sp, 1536);
    });

  const summary = await summarizer(prompt, systemPrompt);
  const newState: CompactedSessionState = {
    sessionKey,
    compactedCount: endIdx,
    updatedAt: Date.now(),
    summary: summary.trim(),
  };

  saveCompactedState(newState);

  // Evict bloated agy session so next turn starts with a fresh conversation
  // seeded with the updated rolling summary, resetting tokens to Low-Water Mark.
  try {
    const { clearAgySession } = await import("../agent.ts");
    clearAgySession(sessionKey);
  } catch {
    // Ignore if agent module not available
  }

  return { compacted: true, messagesCompacted: endIdx - startIdx, state: newState };
}

export function isWatermarkBreached(sessionKey: string, lastInputTokens?: number): boolean {
  if (typeof lastInputTokens === "number" && lastInputTokens >= WATERMARK_HIGH_TOKENS) {
    return true;
  }
  const allMessages = getAllMessages(sessionKey);
  const prevState = getCompactedState(sessionKey);
  const compactedCount = prevState?.compactedCount ?? 0;
  const uncompactedCount = allMessages.length - compactedCount;
  const config = loadConfig();
  const compactAfterTurns = config.sessions.compactAfterTurns ?? WATERMARK_HIGH_TURNS;
  return uncompactedCount >= compactAfterTurns * 2;
}

export async function maybeAutoCompactSession(
  sessionKey: string,
  options?: AutoCompactOptions | ((prompt: string, systemPrompt: string) => Promise<string>)
): Promise<boolean> {
  try {
    const opts: AutoCompactOptions =
      typeof options === "function" ? { summarizer: options } : options ?? {};

    const allMessages = getAllMessages(sessionKey);
    const prevState = getCompactedState(sessionKey);
    const compactedCount = prevState?.compactedCount ?? 0;
    const uncompactedCount = allMessages.length - compactedCount;
    const config = loadConfig();
    const compactAfterTurns = config.sessions.compactAfterTurns ?? WATERMARK_HIGH_TURNS;
    const threshold = compactAfterTurns * 2;

    const breachedByTurns = uncompactedCount >= threshold;
    const breachedByTokens =
      typeof opts.lastInputTokens === "number" && opts.lastInputTokens >= WATERMARK_HIGH_TOKENS;

    if (breachedByTurns || breachedByTokens) {
      const keepRecentTurns = breachedByTokens
        ? WATERMARK_KEEP_RECENT_TURNS
        : (config.sessions.keepRecentTurns ?? WATERMARK_KEEP_RECENT_TURNS);

      const result = await compactSession(sessionKey, {
        keepRecentTurns,
        summarizer: opts.summarizer,
      });
      return result.compacted;
    }
    return false;
  } catch (err) {
    console.error(`[compaction] Auto-compaction failed for ${sessionKey}:`, err);
    return false;
  }
}

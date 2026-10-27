import type { IncomingMessage, ReplyFn } from "./channels/types.ts";
import { runAgent, clearAgySession, budgetToolOutput } from "./agent.ts";
import { appendMessage, sessionKeyFromMessage } from "./session.ts";
import { maybeAutoCompactSession } from "./memory/compaction.ts";
import {
  appendChat,
  rebuildMemoryIndex,
  searchMemory,
  listSessions,
} from "./memory/store.ts";
import { clearSession } from "./session.ts";
import { notifySessionCleared } from "./daemon/server.ts";
import { transcribeAudio } from "./media.ts";
import {
  addJob,
  listJobs,
  removeJob,
  parseTimeToJob,
} from "./scheduler/scheduler.ts";
import { getHeartbeatStatus } from "./scheduler/heartbeat.ts";
import { syncCatalog } from "./skills/catalog.ts";
import { installSkillByName } from "./skills/installer.ts";
import { getAllSkillStatuses } from "./skills/loader.ts";

/**
 * Detects noise or punctuation-only inputs that contain no letters or numbers.
 */
export function isNoiseOnlyInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

/**
 * Detects natural-language phrases requesting to reset, clear, or start a new session.
 */
export function isNaturalResetRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const r1 =
    /^(?:okay[,\s.!]*|ok[,\s.!]*|hey[,\s.!]*|please[,\s.!]*)*(?:can you\s+|could you\s+)?(?:please\s+)?(?:clear|reset|wipe|restart)\s+(?:the\s+|my\s+)?(?:previous\s+|current\s+|chat\s+|voice\s+)?(?:session|conversation|history|context)(?:\s+(?:and\s+)?(?:start\s+)?(?:a\s+|the\s+)?new\s+(?:session|conversation|one))?[.,!\s]*$/i;

  const r2 =
    /^(?:okay[,\s.!]*|ok[,\s.!]*)*(?:clear\s+(?:the\s+)?previous\s+session[,\s]+)?(?:please\s+)?start\s+(?:a\s+|the\s+)?new\s+(?:session|conversation)[.,!\s]*$/i;

  return r1.test(trimmed) || r2.test(trimmed);
}

/**
 * Message router: incoming message → command check → agent → reply.
 * Also handles slash commands before they reach the agent.
 */

export async function handleMessage(
  msg: IncomingMessage,
  reply: ReplyFn,
  onStatus?: (status: string) => Promise<void> | void
): Promise<void> {
  const key = sessionKeyFromMessage(msg.channel, msg.sender);
  const text = msg.text.trim();

  console.log(`[router] ${msg.channel}:${msg.sender} → "${text.slice(0, 80)}"`);

  // Check for slash commands
  if (text.startsWith("/")) {
    const handled = await handleCommand(text, msg, reply, key);
    if (handled) return;
  }

  // Guard against noise or punctuation-only input (e.g. "." or "...")
  if ((!msg.attachments || msg.attachments.length === 0) && isNoiseOnlyInput(text)) {
    console.log(`[router] 🔇 Ignoring noise/punctuation-only input from ${key}: "${text}"`);
    return;
  }

  // Check for natural reset request
  if (isNaturalResetRequest(text)) {
    clearSession(key);
    clearAgySession(key);
    notifySessionCleared(msg.sender);
    notifySessionCleared(key);
    console.log(`[router] 🧹 Cleared session ${key} (natural reset trigger)`);
    await reply("Previous session cleared. Starting fresh—how can I help you?");
    return;
  }

  // Transcribe audio/voice attachments before building text
  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      if (att.type === "audio" || att.type === "voice") {
        const transcription = await transcribeAudio(att.filePath);
        att._transcription = transcription ?? "(transcription unavailable — no Whisper API key configured)";
      }
    }
  }

  // Build the full message for the agent — include attachment context
  let agentText = text;
  if (msg.attachments && msg.attachments.length > 0) {
    const parts: string[] = [];
    for (const att of msg.attachments) {
      if (att._transcription) {
        parts.push(`[Voice transcription]\n"${att._transcription}"`);
      } else {
        let desc = `[${att.type}`;
        if (att.fileName) desc += `: ${att.fileName}`;
        if (att.mimeType) desc += ` (${att.mimeType})`;
        if (att.duration) desc += `, ${att.duration}s`;
        desc += `]\nFile saved to: ${att.filePath}`;
        if (att.caption) desc += `\nCaption: ${att.caption}`;
        parts.push(desc);
      }
    }
    const attachmentContext = parts.join("\n");
    agentText = agentText
      ? `${agentText}\n\n${attachmentContext}`
      : attachmentContext;
  }

  // Convert channel attachments to session format
  const sessionAttachments = msg.attachments?.map((att) => ({
    type: att.type,
    filePath: att.filePath,
    mimeType: att.mimeType,
  }));

  // Save user message
  appendMessage(key, {
    role: "user",
    content: agentText,
    timestamp: msg.timestamp,
    channel: msg.channel,
    sender: msg.sender,
    attachments: sessionAttachments,
  });
  appendChat(msg.channel, msg.sender, "user", agentText);

  // Run agent
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatusAt = 0;
  let statusSent = false;
  const sendStatus = async (statusText: string): Promise<void> => {
    if (msg.channel === "terminal" || msg.sender.startsWith("voice")) return;
    const now = Date.now();
    if (now - lastStatusAt < 3000) return;
    lastStatusAt = now;
    statusSent = true;
    await reply(statusText);
  };

  try {
    if (msg.channel !== "terminal") {
      statusTimer = setTimeout(() => {
        void sendStatus("Thinking...");
      }, 1200);
    }

    const agentStart = Date.now();
    console.log(`[router] 🚀 Running agent for ${msg.channel}:${msg.sender}...`);
    const result = await runAgent(
      key,
      agentText,
      msg.attachments,
      reply,
      { channel: msg.channel, sender: msg.sender },
      async (statusText) => {
        console.log(`[router] Status: ${statusText}`);
        if (onStatus) {
          await onStatus(statusText);
        } else if (msg.channel !== "terminal") {
          if (!statusSent) {
            await sendStatus("Working...");
          }
          await sendStatus(statusText);
        }
      }
    );
    const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
    console.log(`[router] ✅ Agent completed response for ${msg.channel}:${msg.sender} (${elapsed}s)`);

    // Log tool calls to chat history
    if (result.toolCalls && result.toolCalls.length > 0) {
      const toolLog = result.toolCalls
        .map((tc) => {
          const input = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input);
          const outputPreview = tc.output.length > 200 ? `${tc.output.slice(0, 200)}...` : tc.output;
          return `**${tc.name}**(${input})\n> ${outputPreview}`;
        })
        .join("\n\n");
      appendChat(msg.channel, msg.sender, "assistant", `_Tool calls:_\n\n${toolLog}`);
    }

    // Save agent response
    appendMessage(key, {
      role: "assistant",
      content: result.text,
      timestamp: Date.now(),
      usage: result.usage,
      toolCalls: result.toolCalls?.map((tc) => ({
        name: tc.name,
        input: tc.input,
        output: budgetToolOutput(tc.output, 4000),
      })),
    });
    appendChat(msg.channel, msg.sender, "assistant", result.text);

    await reply(result.text);

    // Background auto-compaction with token & turn watermark checks
    void maybeAutoCompactSession(key, { lastInputTokens: result.usage?.input });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[router] Agent error: ${errMsg}`);
    await reply(`Error: ${errMsg}`);
  } finally {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
  }
}

async function handleCommand(
  text: string,
  msg: IncomingMessage,
  reply: ReplyFn,
  sessionKey: string
): Promise<boolean> {
  const [cmd, ...args] = text.split(/\s+/);
  const arg = args.join(" ");

  switch (cmd) {
    case "/help":
    case "/commands": {
      await reply(getHelpText());
      return true;
    }

    case "/reset": {
      clearSession(sessionKey);
      clearAgySession(sessionKey);
      notifySessionCleared(msg.sender);
      notifySessionCleared(sessionKey);
      await reply("Session cleared.");
      return true;
    }

    case "/status": {
      const sessions = listSessions();
      const heartbeat = getHeartbeatStatus();
      const jobs = listJobs();

      let status = `MinClaw Status\n`;
      status += `Sessions: ${sessions.length}\n`;
      status += `Scheduled jobs: ${jobs.length}\n`;
      status += `Heartbeat: ${heartbeat.enabled ? "on" : "off"}`;
      if (heartbeat.nextRun) status += ` (next: ${heartbeat.nextRun})`;
      await reply(status);
      return true;
    }

    case "/memory": {
      const index = rebuildMemoryIndex();
      // Truncate for messaging
      const truncated =
        index.length > 3000 ? index.slice(0, 3000) + "\n..." : index;
      await reply(truncated);
      return true;
    }

    case "/search": {
      if (!arg) {
        await reply("Usage: /search <query>");
        return true;
      }
      const results = searchMemory(arg);
      if (results.length === 0) {
        await reply(`No results for "${arg}"`);
      } else {
        let out = `Search: "${arg}"\n\n`;
        for (const r of results.slice(0, 5)) {
          out += `${r.key}:\n`;
          for (const m of r.matches.slice(0, 3)) {
            out += `  ${m.trim()}\n`;
          }
          out += "\n";
        }
        await reply(out);
      }
      return true;
    }

    case "/schedule": {
      if (!arg) {
        await reply(
          "Usage: /schedule <time> <message> (or <message> <time>)\nExamples:\n  /schedule at 10 Check email\n  /schedule in 30 minutes Call mom\n  /schedule Call mom in 30 minutes\n  /schedule every day at 9am Morning review"
        );
        return true;
      }

      // Try to split time from message: find where the reminder text starts
      const parsed = tryParseSchedule(arg, msg.channel, msg.sender);
      if (!parsed) {
        await reply(
          "Couldn't parse time. Try:\n  at 10, at 3pm, in 30 minutes, every day at 9am\nYou can put time first or last."
        );
        return true;
      }

      const job = addJob(parsed.job);
      await reply(
        `Scheduled: "${parsed.job.name}" → "${parsed.reminderText}"\nID: ${job.id}\nNext: ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "soon"}`
      );
      return true;
    }

    case "/jobs": {
      const jobs = listJobs();
      if (jobs.length === 0) {
        await reply("No scheduled jobs.");
      } else {
        let out = "Scheduled Jobs:\n\n";
        for (const j of jobs) {
          out += `• ${j.name} (${j.cronExpr})`;
          if (j.nextRunAt) out += ` → next: ${new Date(j.nextRunAt).toLocaleString()}`;
          out += `\n  Message: ${j.message}\n  ID: ${j.id}\n\n`;
        }
        await reply(out);
      }
      return true;
    }

    case "/cancel": {
      if (!arg) {
        await reply("Usage: /cancel <job-id>");
        return true;
      }
      const removed = removeJob(arg);
      await reply(removed ? "Job cancelled." : "Job not found.");
      return true;
    }

    case "/heartbeat": {
      const hb = getHeartbeatStatus();
      await reply(
        `Heartbeat: ${hb.enabled ? "enabled" : "disabled"}\n` +
          `Running: ${hb.running}\n` +
          `Cron: ${hb.cronExpr}\n` +
          `Next: ${hb.nextRun || "n/a"}`
      );
      return true;
    }

    case "/skills": {
      if (arg === "sync") {
        try {
          await syncCatalog();
          await reply("Skills catalog synced.");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await reply(`Sync failed: ${errMsg}`);
        }
      } else if (arg.startsWith("install ")) {
        const name = arg.slice(8).trim();
        await reply(`Installing ${name}...`);
        const result = await installSkillByName(name);
        await reply(result.ok ? `Installed ${name}.` : `Failed: ${result.message}`);
      } else {
        const statuses = await getAllSkillStatuses();
        if (statuses.length === 0) {
          await reply("No skills found. Syncing...");
          try {
            await syncCatalog();
            await reply("Synced. Run /skills again to see the list.");
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await reply(`Sync failed: ${errMsg}`);
          }
        } else {
          const ready = statuses.filter((s) => s.eligible);
          const notReady = statuses.filter((s) => !s.eligible);

          let out = `Skills (${ready.length} ready, ${notReady.length} available to install)\n\n`;
          out += "READY:\n";
          for (const s of ready) {
            out += `  ${s.emoji || "\u2713"} ${s.name} \u2014 ${s.description}\n`;
          }
          out += `\nNOT INSTALLED (${notReady.length}):\n`;
          for (const s of notReady) {
            out += `  ${s.emoji || "\u2717"} ${s.name} \u2014 ${s.description}\n`;
            const missing: string[] = [];
            if (s.missing.bins.length) missing.push(`bins: ${s.missing.bins.join(", ")}`);
            if (s.missing.env.length) missing.push(`env: ${s.missing.env.join(", ")}`);
            if (missing.length) out += `    needs: ${missing.join("; ")}\n`;
            if (s.install?.length) {
              out += `    install: /skills install ${s.name}\n`;
            }
          }
          await reply(out);
        }
      }
      return true;
    }

    default:
      return false; // Unknown command — let agent handle it
  }
}

function getHelpText(): string {
  return (
    "Here’s a quick reference to the commands you can use:\n\n" +
    "**General commands**\n" +
    "- /help – show this help\n" +
    "- /reset – clear the current session\n" +
    "- /status – show system status\n" +
    "- /memory – show memory index\n" +
    "- /search <query> – search all chat history\n" +
    "- /schedule <time> <message> – schedule a reminder\n" +
    "- /jobs – list scheduled jobs\n" +
    "- /cancel <id> – cancel a scheduled job\n" +
    "- /heartbeat – show heartbeat status\n" +
    "- /skills – list available skills\n" +
    "- /skills sync – refresh skill catalog from GitHub\n" +
    "- /skills install <name> – install a skill’s dependencies\n\n" +
    "**Attachments** – send audio, images, or documents and I’ll process them."
  );
}

function tryParseSchedule(
  input: string,
  channel: string,
  sender: string
): { job: Omit<import("./scheduler/scheduler.ts").ScheduledJob, "id" | "createdAt">; reminderText: string } | null {
  // Try progressively shorter prefixes as the time part
  const words = input.split(/\s+/);

  for (let i = Math.min(words.length, 6); i >= 1; i--) {
    const timePart = words.slice(0, i).join(" ");
    const messagePart = words.slice(i).join(" ") || "Reminder";

    const parsed = parseTimeToJob(timePart, channel, sender);
    if (parsed) {
      parsed.message = messagePart;
      parsed.name = messagePart.slice(0, 50);
      return { job: parsed, reminderText: messagePart };
    }
  }

  // Also support time phrases at the end:
  // "happy birthday in 1 minute" or "check email at 3pm"
  for (let i = 1; i <= Math.min(words.length, 6); i++) {
    const timePart = words.slice(words.length - i).join(" ");
    const messagePart = words.slice(0, words.length - i).join(" ") || "Reminder";

    const parsed = parseTimeToJob(timePart, channel, sender);
    if (parsed) {
      parsed.message = messagePart;
      parsed.name = messagePart.slice(0, 50);
      return { job: parsed, reminderText: messagePart };
    }
  }

  return null;
}

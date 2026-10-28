import { Type, type Static } from "@sinclair/typebox";
import type { Tool, TextContent } from "@mariozechner/pi-ai";
import { saveProviderCredential } from "./auth/credentials.ts";
import { loadConfig } from "./config.ts";
import { searchMemory, getChatHistory, listSessions } from "./memory/store.ts";
import { compactSession } from "./memory/compaction.ts";
import { sessionKeyFromMessage, clearSession } from "./session.ts";
import { resolve, dirname } from "path";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { getChannelSender, detectMediaType, getRegisteredChannels } from "./channels/registry.ts";
import { addJob, parseTimeToJob } from "./scheduler/scheduler.ts";
import { listAllUnreadEmails, sendEmail, readEmailMessage } from "./email/service.ts";
import { listAllUpcomingEvents, createCalendarEvent, getLastCalendarError } from "./email/calendar.ts";
import {
  registerToolExtension,
  getToolExtension,
  getAllRegisteredTools,
  getAllToolExtensions,
  type ToolExtension,
  type ToolResult,
} from "./extensions/tools-registry.ts";

export type ToolContext = {
  channel: string;
  sender: string;
  sessionKey?: string;
  reply?: (text: string) => Promise<void>;
};

// ── Tool definitions ──────────────────────────────────────────────

const ShellParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (default 30, max 120)", minimum: 1, maximum: 120 })
  ),
});

const ReadFileParams = Type.Object({
  path: Type.String({ description: "File path (absolute or workspace-relative)" }),
  maxLines: Type.Optional(
    Type.Number({ description: "Maximum lines to return (default 500)", minimum: 1, maximum: 2000 })
  ),
});

const SaveCredentialParams = Type.Object({
  provider: Type.String({ description: "Provider name, e.g. 'whisper', 'anthropic', 'deepgram'" }),
  apiKey: Type.String({ description: "The API key to save" }),
});

export const shellTool: Tool<typeof ShellParams> = {
  name: "shell",
  description:
    "Execute a shell command. Use for curl, git, ls, package managers, and any CLI operation. " +
    "stdout+stderr are captured. Timeout defaults to 30s (max 120s). Output truncated at 50k chars. " +
    "A per-command temp directory is available at $NUDKCLAW_TMP_DIR (also set as TMPDIR); " +
    "use it for temporary files to avoid cluttering the workspace. " +
    "Risky or networked commands are blocked unless prefixed with CONFIRM:.",
  parameters: ShellParams,
};

export const readFileTool: Tool<typeof ReadFileParams> = {
  name: "read_file",
  description:
    "Read a file from disk. Path can be absolute or relative to the workspace directory. " +
    "Returns up to 500 lines by default (max 2000).",
  parameters: ReadFileParams,
};

export const saveCredentialTool: Tool<typeof SaveCredentialParams> = {
  name: "save_credential",
  description:
    "Save an API key to ~/.minclaw/credentials.json for a given provider. " +
    "Use when the user provides an API key they want stored. " +
    "IMPORTANT: For OpenAI keys (for Whisper/transcription), always use provider 'whisper' — " +
    "never use 'openai' (that's reserved for the chat model's OAuth credentials). " +
    "Keys take effect immediately — no daemon restart needed.",
  parameters: SaveCredentialParams,
};

const SearchMemoryParams = Type.Object({
  query: Type.String({ description: "Search query — matched case-insensitively against all chat history" }),
  maxResults: Type.Optional(
    Type.Number({ description: "Max sessions to return (default 5)", minimum: 1, maximum: 20 })
  ),
});

export const searchMemoryTool: Tool<typeof SearchMemoryParams> = {
  name: "search_memory",
  description:
    "Search across all past conversations (chat history) for a keyword or phrase. " +
    "Returns matching lines grouped by session. Use this to recall what a user said, " +
    "find past decisions, look up shared information, or answer 'did we talk about X?' questions. " +
    "For full context around a match, follow up with read_file on the chat file path.",
  parameters: SearchMemoryParams,
};

const RememberParams = Type.Object({
  note: Type.String({
    description:
      "A concise durable fact to store in persistent memory (e.g. user preference, identity detail, stable project rule)"
  }),
});

export const rememberTool: Tool<typeof RememberParams> = {
  name: "remember",
  description:
    "Save a durable fact to persistent memory at brain/permanent-memory.md. " +
    "Use this for user preferences, stable personal details, project constraints, and long-term decisions. " +
    "Do not use for one-off transient details.",
  parameters: RememberParams,
};

const SendFileParams = Type.Object({
  filePath: Type.String({ description: "Absolute path to the file to send (e.g. an image the user asked you to create/edit)" }),
  caption: Type.Optional(
    Type.String({ description: "Optional caption to accompany the file" })
  ),
});

const SendMessageParams = Type.Object({
  text: Type.String({
    description:
      "Text to send as an immediate standalone message to the current user/channel"
  }),
});

export const sendMessageTool: Tool<typeof SendMessageParams> = {
  name: "send_message",
  description:
    "Send an immediate standalone text message to the current user/channel. " +
    "Use when the user explicitly asks for multiple separate messages (e.g. countdowns, step-by-step pings). " +
    "Can be called multiple times in a loop.",
  parameters: SendMessageParams,
};

const ScheduleReminderParams = Type.Object({
  when: Type.String({
    description:
      "When to remind. Examples: 'in 1 minute', 'at 10', 'at 3pm', 'every day at 9am', 'every 2 hours'"
  }),
  message: Type.String({
    description:
      "Reminder message text to send when it fires"
  }),
  mode: Type.Optional(
    Type.Unsafe<"reminder" | "agent">({
      type: "string",
      enum: ["reminder", "agent"],
      description:
        "Execution mode: 'reminder' sends static text; 'agent' runs the autonomous agent with tools to research/generate output at fire time",
    })
  ),
});

export const scheduleReminderTool: Tool<typeof ScheduleReminderParams> = {
  name: "schedule_reminder",
  description:
    "Create a reminder job for the current user/channel. " +
    "Use for requests like 'remind me in 1 minute' or 'message me at 3pm'. " +
    "Returns the job id and next run time if scheduled successfully.",
  parameters: ScheduleReminderParams,
};

export const sendFileTool: Tool<typeof SendFileParams> = {
  name: "send_file",
  description:
    "Send a file (image, video, audio, document) back to the user through the current channel (WhatsApp, Telegram). " +
    "Use this after creating, downloading, or processing a file that the user wants sent back. " +
    "The file is sent to the same user in the same channel as the current conversation. " +
    "Supports images (.jpg, .png, .gif, .webp), videos (.mp4, .mov), audio (.mp3, .ogg), and documents (any).",
  parameters: SendFileParams,
};

const WebSearchParams = Type.Object({
  query: Type.String({
    description: "Search query for web search using searxng. Uses different technology like DuckDuckGo, Google, Bing... Returns results with title, URL, snippet, source, and date.",
  }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return",
      minimum: 1,
      maximum: 10,
      default: 5,
    })
  ),
});

export const webSearchTool: Tool<typeof WebSearchParams> = {
  name: "web_search",
  description:
    "Search the web using SearXNG. Returns normalized search results with titles, URLs, snippets, sources, and dates.",
  parameters: WebSearchParams,
};

const WebFetchParams = Type.Object({
  url: Type.String({
    description: "The URL to fetch content from (must be a valid HTTP/HTTPS URL)",
  }),
  maxSize: Type.Optional(
    Type.Number({
      description: "Maximum content size to return in bytes (default 100KB, max 1MB)",
      minimum: 1000,
      maximum: 1048576,
      default: 102400,
    })
  ),
});

export const webFetchTool: Tool<typeof WebFetchParams> = {
  name: "web_fetch",
  description:
    "Fetch and retrieve content from a URL. Returns the raw content (HTML, JSON, plain text, etc.). " +
    "Useful for getting details from URLs found by web_search. " +
    "Content is truncated at maxSize (default 100KB). " +
    "Returns content type and status information.",
  parameters: WebFetchParams,
};

const EmailParams = Type.Object({
  action: Type.String({
    description:
      "Action to perform: 'list_unread' to view unread messages, 'read' to read a full email by ID, or 'send' to send an email",
  }),
  id: Type.Optional(Type.String({ description: "Email message ID to read (required for action='read')" })),
  account: Type.Optional(
    Type.String({ description: "Optional account filter (e.g. 'uni-saarland', 'gmail', or email address)" })
  ),
  to: Type.Optional(Type.String({ description: "Recipient email address (required for send action)" })),
  subject: Type.Optional(Type.String({ description: "Email subject (required for send action)" })),
  body: Type.Optional(Type.String({ description: "Email body text (required for send action)" })),
  from: Type.Optional(Type.String({ description: "Optional sender account email address" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of unread emails to return (default 5)" })),
});

export const emailTool: Tool<typeof EmailParams> = {
  name: "email",
  description:
    "Check unread emails, read full email content by ID, or send an email across connected Google Workspace and University IMAP accounts. " +
    "Use action='list_unread' to view incoming unread messages with IDs, subjects, senders, and snippets. " +
    "Use action='read' with id and optional account to read full message content. " +
    "Use action='send' with to, subject, and body to draft and send an email.",
  parameters: EmailParams,
};

const CalendarParams = Type.Object({
  action: Type.String({
    description: "Action to perform: 'list_events' to see schedule and upcoming meetings, 'create_event' (or 'add_event') to schedule a new event",
  }),
  limit: Type.Optional(Type.Number({ description: "Maximum number of upcoming events to return for list_events (default 5)" })),
  summary: Type.Optional(Type.String({ description: "Event title / summary (required for create_event)" })),
  startTime: Type.Optional(Type.String({ description: "Event start time (ISO 8601 string, 'YYYY-MM-DD HH:mm', or time string like '11:30' / '11:30 AM')" })),
  endTime: Type.Optional(Type.String({ description: "Event end time (optional; defaults to 1 hour after start time)" })),
  location: Type.Optional(Type.String({ description: "Event location or venue (optional)" })),
  description: Type.Optional(Type.String({ description: "Event description or notes (optional)" })),
  account: Type.Optional(Type.String({ description: "Optional specific Google account email to schedule under" })),
});

export const calendarTool: Tool<typeof CalendarParams> = {
  name: "calendar",
  description:
    "Check upcoming Google Calendar events or create new ones. " +
    "Use action='list_events' to view upcoming meetings and video links. " +
    "Use action='create_event' with summary and startTime (and optional endTime, location, description) to add an event to Google Calendar.",
  parameters: CalendarParams,
};

const CompactSessionParams = Type.Object({
  focus: Type.Optional(
    Type.String({
      description:
        "Optional focus instructions specifying what details, decisions, or references to prioritize in the summary",
    })
  ),
  keepRecentTurns: Type.Optional(
    Type.Number({
      description: "Number of recent conversation turns to keep uncompacted in raw history (default 8)",
      minimum: 0,
      maximum: 25,
    })
  ),
});

export const compactSessionTool: Tool<typeof CompactSessionParams> = {
  name: "compact_session",
  description:
    "Compact earlier conversation turns into a structured rolling summary to free context while preserving critical entity IDs, files, decisions, and constraints.",
  parameters: CompactSessionParams,
};

const YoutubeParams = Type.Object({
  action: Type.Optional(
    Type.Unsafe<"play" | "search">({
      type: "string",
      enum: ["play", "search"],
      description: "Action: 'play' to search and open video in browser (Firefox by default), or 'search' to list matching YouTube videos",
      default: "play",
    })
  ),
  query: Type.String({ description: "YouTube search query or video URL" }),
  browser: Type.Optional(
    Type.String({ description: "Browser application to open the video in (default: 'Firefox')" })
  ),
  limit: Type.Optional(
    Type.Number({ description: "Number of search results (default 5)", minimum: 1, maximum: 10 })
  ),
});

export const youtubeTool: Tool<typeof YoutubeParams> = {
  name: "youtube",
  description:
    "Search YouTube and open videos in browser (Firefox by default) or list matching videos. " +
    "Uses fast metadata extraction (--flat-playlist) for sub-second search results.",
  parameters: YoutubeParams,
};

const SessionResetParams = Type.Object({
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Session key to reset (e.g. 'terminal:voice_macbook' or 'telegram:123456789'). Defaults to current session.",
    })
  ),
});

export const sessionResetTool: Tool<typeof SessionResetParams> = {
  name: "session_reset",
  description:
    "Reset conversation session history for the current or specified session key. " +
    "Clears persistent transcripts and in-memory agent session state.",
  parameters: SessionResetParams,
};

const QueueSelfImprovementParams = Type.Object({
  title: Type.String({ description: "Short descriptive title of the improvement, feature gap, or bug to fix." }),
  description: Type.String({ description: "Details of what needs to be changed/implemented, relevant files, and expected behavior." }),
  toolName: Type.Optional(Type.String({ description: "Target tool or subsystem (e.g. 'calendar', 'email', 'voice', 'daemon')." })),
  targetType: Type.Optional(
    Type.Unsafe<"skill" | "script" | "operational_runbook" | "general">({
      type: "string",
      enum: ["skill", "script", "operational_runbook", "general"],
      description: "Target scaffolding type: 'skill', 'script', 'operational_runbook', or 'general'.",
    })
  ),
});

export const queueSelfImprovementTool: Tool<typeof QueueSelfImprovementParams> = {
  name: "queue_self_improvement",
  description:
    "Queue a self-improvement task, codebase bugfix, or feature enhancement for offline background execution. " +
    "NEVER inspect src/ or edit code during live conversational turns — queue the enhancement here and fulfill the user request immediately with available tools.",
  parameters: QueueSelfImprovementParams,
};

const UpdateSelfImprovementParams = Type.Object({
  id: Type.String({ description: "ID of the self-improvement task (e.g. 'si-1730000000-abcde')." }),
  status: Type.String({ description: "Status to set: 'completed', 'failed', or 'in_progress'." }),
  notes: Type.Optional(Type.String({ description: "Optional notes or summary of the changes made." })),
});

export const updateSelfImprovementTool: Tool<typeof UpdateSelfImprovementParams> = {
  name: "update_self_improvement",
  description: "Update the status of a queued self-improvement task (typically called during background heartbeat execution).",
  parameters: UpdateSelfImprovementParams,
};

export const allTools: Tool[] = [
  shellTool,
  readFileTool,
  saveCredentialTool,
  searchMemoryTool,
  rememberTool,
  scheduleReminderTool,
  sendMessageTool,
  sendFileTool,
  webSearchTool,
  webFetchTool,
  emailTool,
  calendarTool,
  compactSessionTool,
  youtubeTool,
  sessionResetTool,
  queueSelfImprovementTool,
  updateSelfImprovementTool,
];

// ── Tool execution ────────────────────────────────────────────────

export type { ToolResult };

const MAX_OUTPUT = 50_000;

function text(s: string): TextContent[] {
  return [{ type: "text", text: s }];
}

function isTelegramContext(context?: ToolContext): boolean {
  return context?.channel === "telegram";
}

function isLoopbackUrl(url: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(url);
}

export function isSafeReadOnlyNetworkCommand(command: string, context?: ToolContext): boolean {
  // Heuristic-based detection of safe read-only network commands.
  // Allow common read-only `curl`/`wget` invocations that do not include
  // request bodies, file redirections via shell metacharacters, or explicit
  // non-GET methods. This avoids maintaining a huge domain whitelist.
  const trimmed = command.trim();
  if (!/^(curl|wget)\b/i.test(trimmed)) return false;

  // Reject obvious shell injection / piping / redirection patterns
  if (/[;&|`<>]/.test(trimmed) || /\$\(/.test(trimmed)) return false;

  // Disallow flags that indicate a request body or upload
  const unsafeFlags = /(^|\s)(-d\b|--data\b|--data-raw\b|--data-urlencode\b|--form\b|--form-string\b|--upload-file\b)/i;
  if (unsafeFlags.test(trimmed)) return false;

  // If the user explicitly sets -X/--request to a non-GET method, treat as unsafe
  const explicitMethodMatch = trimmed.match(/(^|\s)(?:-X|--request)\s+(\w+)\b/i);
  if (explicitMethodMatch && explicitMethodMatch[2] && explicitMethodMatch[2].toUpperCase() !== "GET") {
    return false;
  }

  // For wget, reject --post-data / --post-file
  if (/\bwget\b/i.test(trimmed) && /(^|\s)(--post-data\b|--post-file\b)/i.test(trimmed)) return false;

  // Extract URLs
  const urlPattern = /\bhttps?:\/\/[^\s'"|;]+/gi;
  const urls = (trimmed.match(urlPattern) || []);
  if (urls.length === 0) return false;

  // Allow loopback (localhost) unconditionally
  const allLoopback = urls.every((u) => isLoopbackUrl(u));
  if (allLoopback) return true;

  // Avoid contacting local/internal hostnames by default
  // (e.g., 10.x.x.x, 192.168.x.x) — treat these as not safe unless explicitly confirmed
  const internalPattern = /^https?:\/\/(?:10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i;
  if (urls.some((u) => internalPattern.test(u))) return false;

  // At this point we have HTTP(s) URLs, no body flags, no injection, and no internal hosts.
  // Treat these as safe read-only commands.
  return true;
}

async function executeShell(args: Static<typeof ShellParams>, context?: ToolContext): Promise<ToolResult> {
  const timeout = Math.min(args.timeout ?? 30, 120) * 1000;
  const tmpBase = process.env.TMPDIR || "/tmp";
  const tmpDir = `${tmpBase.replace(/\/$/, "")}/minclaw-${Date.now()}`;
  let command = args.command.trim();

  const isConfirmed = command.startsWith("CONFIRM:");
  if (isConfirmed) {
    command = command.slice("CONFIRM:".length).trim();
  }

  const riskyPattern = /(\brm\b\s+-rf\b|\brm\b\s+-fr\b|\bsudo\b|\bdd\b\s+if=|\bmkfs\b|\bshutdown\b|\breboot\b|\bhalt\b|\bkill\b\s+-9\b|\bchmod\b\s+-R\b\s+0|\bchown\b\s+-R\b)/i;
  const networkPattern = /(\bcurl\b|\bwget\b|\bbrew\b\s+(install|upgrade|tap|update)\b|\bnpm\b\s+install\b|\bpnpm\b\s+install\b|\byarn\b\s+add\b|\bpip\b\s+install\b|\bpip3\b\s+install\b|\bgit\b\s+clone\b|\bgh\b\s+repo\b\s+clone\b|\bpython\b\s+-m\s+pip\s+install\b|\bconda\b\s+install\b)/i;
  if (riskyPattern.test(command) && !isConfirmed) {
    return {
      content: text(
        "Blocked a potentially destructive command. " +
        "Re-run with 'CONFIRM: <command>' to proceed."
      ),
      isError: true,
    };
  }
  if (networkPattern.test(command) && !isConfirmed && !isSafeReadOnlyNetworkCommand(command, context)) {
    return {
      content: text(
        "Blocked a command that accesses the network. " +
        "Re-run with 'CONFIRM: <command>' to proceed."
      ),
      isError: true,
    };
  }

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMPDIR: tmpDir, NUDKCLAW_TMP_DIR: tmpDir },
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);

    const exitCode = await proc.exited;
    let output = stdout + (stderr ? `\n${stderr}` : "");
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n... (truncated)";
    }

    if (exitCode !== 0) {
      return { content: text(`Exit code ${exitCode}\n${output}`.trim()), isError: true };
    }
    return { content: text(output || "(no output)"), isError: false };
  } catch (err: any) {
    return { content: text(`Error: ${err.message}`), isError: true };
  }
}

function executeReadFile(args: Static<typeof ReadFileParams>): ToolResult {
  const maxLines = Math.min(args.maxLines ?? 500, 2000);

  let filePath = args.path;
  if (!filePath.startsWith("/")) {
    const config = loadConfig();
    filePath = resolve(config.workspace, filePath);
  }

  if (!existsSync(filePath)) {
    return { content: text(`File not found: ${filePath}`), isError: true };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const truncated = lines.length > maxLines;
    const output = lines.slice(0, maxLines).join("\n");
    const suffix = truncated ? `\n... (${lines.length - maxLines} more lines)` : "";
    return { content: text(output + suffix), isError: false };
  } catch (err: any) {
    return { content: text(`Error reading file: ${err.message}`), isError: true };
  }
}

function getPersistentMemoryPath(): string {
  const config = loadConfig();
  return resolve(config.brain.dir, "permanent-memory.md");
}

function executeRemember(args: Static<typeof RememberParams>): ToolResult {
  const note = args.note.trim().replace(/\s+/g, " ");
  if (!note) {
    return { content: text("Nothing to remember: note is empty."), isError: true };
  }

  const path = getPersistentMemoryPath();
  const dir = dirname(path);

  try {
    mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      const header =
        "# Persistent Memory\n\n" +
        "<!-- Auto-updated by MinClaw. You can also edit this file manually. -->\n\n" +
        "## Learned Facts\n\n";
      writeFileSync(path, header, "utf-8");
    }

    const existing = readFileSync(path, "utf-8");
    const normalizedExisting = existing.toLowerCase();
    const normalizedNote = note.toLowerCase();
    if (normalizedExisting.includes(normalizedNote)) {
      return {
        content: text(`Already remembered (duplicate skipped): "${note}"`),
        isError: false,
      };
    }

    const entry = `- [${new Date().toISOString()}] ${note}\n`;
    const spacer = existing.endsWith("\n") ? "" : "\n";
    appendFileSync(path, spacer + entry, "utf-8");

    return {
      content: text(`Remembered: "${note}" (${path})`),
      isError: false,
    };
  } catch (err: any) {
    return { content: text(`Error saving memory: ${err.message}`), isError: true };
  }
}

function executeSaveCredential(args: Static<typeof SaveCredentialParams>): ToolResult {
  try {
    // Never overwrite "openai" — that's the chat model's OAuth credential.
    // Remap OpenAI API keys to "whisper" (used for transcription).
    let provider = args.provider;
    if (provider === "openai" && args.apiKey.startsWith("sk-")) {
      provider = "whisper";
      console.log('[agent] Remapped provider "openai" → "whisper" to protect chat credentials');
    }

    saveProviderCredential(provider, { method: "api_key", apiKey: args.apiKey });
    return { content: text(`Saved API key for provider "${provider}". Takes effect immediately.`), isError: false };
  } catch (err: any) {
    return { content: text(`Error saving credential: ${err.message}`), isError: true };
  }
}

function executeSearchMemory(args: Static<typeof SearchMemoryParams>): ToolResult {
  const maxResults = args.maxResults ?? 5;

  const results = searchMemory(args.query);
  if (results.length === 0) {
    return { content: text(`No results for "${args.query}".`), isError: false };
  }

  const sessions = listSessions();
  const fileMap = new Map(sessions.map((s) => [s.key, s.file]));

  let output = `Found matches in ${results.length} session(s) for "${args.query}":\n\n`;
  for (const r of results.slice(0, maxResults)) {
    const filePath = fileMap.get(r.key) || `memory/chats/${r.key}.md`;
    output += `── ${r.key} (${filePath})\n`;
    for (const m of r.matches.slice(0, 5)) {
      output += `  ${m.trim()}\n`;
    }
    if (r.matches.length > 5) {
      output += `  ... (${r.matches.length - 5} more matches)\n`;
    }
    output += "\n";
  }

  if (output.length > MAX_OUTPUT) {
    output = output.slice(0, MAX_OUTPUT) + "\n... (truncated)";
  }

  return { content: text(output), isError: false };
}

async function executeSendMessage(args: Static<typeof SendMessageParams>, context?: ToolContext): Promise<ToolResult> {
  if (!context?.reply) {
    return {
      content: text("send_message requires an active reply context and cannot be used in headless sessions."),
      isError: true,
    };
  }

  const msg = args.text.trim();
  if (!msg) {
    return { content: text("send_message text cannot be empty."), isError: true };
  }

  try {
    await context.reply(msg);
    return { content: text(`Sent message to ${context.channel}:${context.sender}`), isError: false };
  } catch (err: any) {
    return { content: text(`Error sending message: ${err.message}`), isError: true };
  }
}

function executeScheduleReminder(args: Static<typeof ScheduleReminderParams>, context?: ToolContext): ToolResult {
  if (!context) {
    return {
      content: text("schedule_reminder requires a session context (channel + sender)."),
      isError: true,
    };
  }

  const when = args.when.trim();
  const message = args.message.trim();

  if (!when) {
    return { content: text("Missing reminder time phrase in `when`."), isError: true };
  }
  if (!message) {
    return { content: text("Missing reminder message text in `message`."), isError: true };
  }

  const parsed = parseTimeToJob(when, context.channel, context.sender);
  if (!parsed) {
    return {
      content: text(
        `Couldn't parse schedule time "${when}". Try: in 1 minute, at 3pm, every day at 9am.`
      ),
      isError: true,
    };
  }

  parsed.message = message;
  parsed.name = message.slice(0, 50);
  if (args.mode) {
    parsed.mode = args.mode;
  }

  const job = addJob(parsed);
  const next = job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "soon";
  return {
    content: text(`Scheduled reminder "${message}" (id: ${job.id}) next: ${next}`),
    isError: false,
  };
}

async function executeSendFile(args: Static<typeof SendFileParams>, context?: ToolContext): Promise<ToolResult> {
  if (!context) {
    return { content: text("send_file requires a session context (channel + sender). Cannot send files from headless sessions."), isError: true };
  }

  const { channel, sender } = context;

  if (channel === "terminal") {
    return { content: text(`File is at: ${args.filePath} (terminal sessions don't support file attachments)`), isError: false };
  }

  const channelSender = getChannelSender(channel);
  if (!channelSender) {
    const registered = getRegisteredChannels();
    return {
      content: text(`No file sender registered for channel "${channel}". Registered channels: ${registered.join(", ") || "none"}`),
      isError: true,
    };
  }

  if (!existsSync(args.filePath)) {
    return { content: text(`File not found: ${args.filePath}`), isError: true };
  }

  try {
    await channelSender.sendFile({
      recipient: sender,
      filePath: args.filePath,
      caption: args.caption,
    });
    const mediaType = detectMediaType(args.filePath);
    return { content: text(`Sent ${mediaType} to ${sender} on ${channel}.`), isError: false };
  } catch (err: any) {
    return { content: text(`Error sending file: ${err.message}`), isError: true };
  }
}

async function executeWebFetch(
  args: Static<typeof WebFetchParams>,
  context?: ToolContext
): Promise<ToolResult> {
  const urlStr = String(args.url || "").trim();
  const maxSize = Math.min(args.maxSize ?? 102400, 1048576);

  if (!urlStr) {
    return {
      content: text("Web fetch URL cannot be empty."),
      isError: true,
    };
  }

  let url: URL;
  try {
    url = new URL(urlStr);
    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        content: text(`Invalid protocol "${url.protocol}". Only HTTP and HTTPS are supported.`),
        isError: true,
      };
    }
  } catch (err: any) {
    return {
      content: text(`Invalid URL: ${err.message}`),
      isError: true,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    const res = await fetch(urlStr, {
      method: "GET",
      headers: {
        "User-Agent": "MinClaw/1.0 (+https://github.com/openclaw/minclaw)",
        Accept: "*/*",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        content: text(
          `Fetch failed with status ${res.status}: ${res.statusText}`
        ),
        isError: true,
      };
    }

    const contentType = res.headers.get("content-type") || "unknown";
    const contentLength = res.headers.get("content-length");

    // Read with size limit
    const buffer = await res.arrayBuffer();
    let contentBytes = new Uint8Array(buffer);

    if (contentBytes.length > maxSize) {
      contentBytes = contentBytes.slice(0, maxSize);
    }

    // Try to decode as text
    let content: string;
    try {
      content = new TextDecoder().decode(contentBytes);
    } catch {
      // If text decoding fails, return base64
      content = `[Binary content - ${contentBytes.length} bytes, base64:\n${Buffer.from(contentBytes).toString("base64")}]`;
    }

    // Build result
    let output = `Fetched content from: ${urlStr}\n`;
    output += `Content-Type: ${contentType}\n`;
    output += `Content-Length: ${contentLength || contentBytes.length} bytes\n`;

    if (contentBytes.length > maxSize) {
      output += `⚠️ Content truncated at ${maxSize} bytes\n`;
    }

    output += "\n--- Content ---\n";
    output += content;

    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n... (output truncated)";
    }

    return {
      content: text(output),
      isError: false,
    };
  } catch (err: any) {
    const message =
      err?.name === "AbortError"
        ? "Fetch request timed out (30s limit)."
        : err?.message || String(err);

    return {
      content: text(`Error fetching URL: ${message}`),
      isError: true,
    };
  }
}

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  score: number;
  publishedDate: string | null;
  category: string;
  thumbnail: string | null;
};

async function executeWebSearch(
  args: Static<typeof WebSearchParams>,
  context?: ToolContext
): Promise<ToolResult> {
  const query = String(args.query || "").trim();
  const maxResults = Math.min(args.maxResults ?? 5, 5);

  if (!query) {
    return {
      content: text("Web search query cannot be empty."),
      isError: true,
    };
  }

  const searxngUrl =
    process.env.SEARXNG_BASE_URL || "http://localhost:8080";

  const searchUrl =
    `${searxngUrl.replace(/\/$/, "")}` +
    `/?q=${encodeURIComponent(query)}` +
    `&format=json`;

  try {
    // Timeout protection
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    const res = await fetch(searchUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "MinClaw/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        content: text(
          `Search failed with status ${res.status}: ${res.statusText}`
        ),
        isError: true,
      };
    }

    const data: any = await res.json();

    if (!data || typeof data !== "object") {
      return {
        content: text("Invalid search response."),
        isError: true,
      };
    }

    const rawResults = Array.isArray(data.results)
      ? data.results
      : [];

    const answers = Array.isArray(data.answers)
      ? data.answers
      : [];

    const suggestions = Array.isArray(data.suggestions)
      ? data.suggestions
      : [];

    const infoboxes = Array.isArray(data.infoboxes)
      ? data.infoboxes
      : [];

    if (rawResults.length === 0) {
      return {
        content: text(`No results found for "${query}".`),
        isError: false,
      };
    }

    const seen = new Set<string>();
    const results: WebSearchResult[] = rawResults
      .filter((r: any) => r && typeof r === "object")
      .map((r: any): WebSearchResult => {
        const title =
          typeof r.title === "string"
            ? r.title.trim()
            : "Untitled";

        const url =
          typeof r.url === "string"
            ? r.url.trim()
            : "";

        const snippet =
          typeof r.content === "string"
            ? r.content.trim()
            : "";

        const source =
          Array.isArray(r.engines)
            ? r.engines.join(", ")
            : typeof r.engine === "string"
              ? r.engine
              : "unknown";

        const score =
          typeof r.score === "number"
            ? r.score
            : 0;

        const publishedDate =
          r.publishedDate ||
          r.pubdate ||
          null;

        const category =
          typeof r.category === "string"
            ? r.category
            : "general";

        const thumbnail =
          r.thumbnail ||
          r.img_src ||
          null;

        return {
          title,
          url,
          snippet,
          source,
          score,
          publishedDate,
          category,
          thumbnail,
        };
      })
      .filter((r: WebSearchResult) => {
        if (!r.url) return false;

        try {
          new URL(r.url);
        } catch {
          return false;
        }

        if (seen.has(r.url)) {
          return false;
        }

        seen.add(r.url);

        return true;
      })
      .sort((a: WebSearchResult, b: WebSearchResult) => {
        return b.score - a.score;
      })
      .slice(0, maxResults);

    if (results.length === 0) {
      return {
        content: text(`No usable search results found.`),
        isError: false,
      };
    }

    // Keep tool output compact so follow-up requests stay small and stable.
    let output = `Search results for "${query}":\n\n`;

    for (const [i, r] of results.entries()) {
      output += `${i + 1}. ${r.title}\n`;
      output += `URL: ${r.url}\n`;

      if (r.snippet) {
        output += `Snippet: ${r.snippet}\n`;
      }

      output += `Source: ${r.source}\n`;

      if (r.publishedDate) {
        output += `Published: ${r.publishedDate}\n`;
      }

      output += `Category: ${r.category}\n`;

      output += "\n";
    }

    if (answers.length > 0) {
      output += `Answers:\n`;

      for (const answer of answers.slice(0, 3)) {
        output += `- ${String(answer)}\n`;
      }

      output += "\n";
    }

    if (suggestions.length > 0) {
      output += `Search suggestions:\n`;

      for (const suggestion of suggestions.slice(0, 5)) {
        output += `- ${String(suggestion)}\n`;
      }

      output += "\n";
    }

    if (infoboxes.length > 0) {
      output += `Infoboxes:\n`;

      for (const info of infoboxes.slice(0, 2)) {
        if (info?.infobox) {
          output += `- ${String(info.infobox)}\n`;
        }
      }

      output += "\n";
    }

    if (output.length > MAX_OUTPUT) {
      output =
        output.slice(0, MAX_OUTPUT) +
        "\n... (truncated)";
    }

    return {
      content: text(output.trim()),
      isError: false,
    };
  } catch (err: any) {
    const message =
      err?.name === "AbortError"
        ? "Search request timed out."
        : err?.message || String(err);

    return {
      content: text(`Error performing web search: ${message}`),
      isError: true,
    };
  }
}

async function executeEmail(args: Static<typeof EmailParams>): Promise<ToolResult> {
  try {
    if (args.action === "list_unread") {
      const fetchLimit = args.limit || 5;
      const filter = args.account || args.from;
      let messages = await listAllUnreadEmails(fetchLimit, filter);
      if (messages.length === 0) {
        const scopeMsg = filter ? ` matching '${filter}'` : "";
        return { content: text(`No unread emails found${scopeMsg} across connected accounts.`), isError: false };
      }
      const formatted = messages
        .map(
          (m, idx) =>
            `[${idx + 1}] ID: ${m.id} | Account: ${m.accountEmail} (${m.accountType})\n    From: ${m.from}\n    Subject: ${m.subject}\n    Date: ${m.date}${m.snippet ? `\n    Snippet: ${m.snippet}` : ""}`
        )
        .join("\n\n");
      return { content: text(`Found ${messages.length} unread email(s):\n\n${formatted}`), isError: false };
    }

    if (args.action === "read") {
      if (!args.id) {
        return {
          content: text("Error: 'id' parameter is required for action='read' (e.g. action=read id=\"1043\")."),
          isError: true,
        };
      }
      const messageId = String(args.id).trim();
      const filter = args.account || args.from;
      const body = await readEmailMessage(messageId, filter);
      return { content: text(body), isError: false };
    }

    if (args.action === "send") {
      if (!args.to || !args.subject || !args.body) {
        return {
          content: text("Error: 'to', 'subject', and 'body' are required to send an email."),
          isError: true,
        };
      }
      const res = await sendEmail(args.to, args.subject, args.body, args.from);
      if (res.ok) {
        return {
          content: text(`Email sent successfully (Message ID: ${res.id || "ok"}).`),
          isError: false,
        };
      }
      return { content: text(`Failed to send email: ${res.error}`), isError: true };
    }

    return {
      content: text(
        `Invalid email action: '${args.action || "undefined"}'. Valid actions are: 'list_unread' (optional: limit, account), 'read' (required: id, optional: account), or 'send' (required: to, subject, body).`
      ),
      isError: true,
    };
  } catch (err: any) {
    return {
      content: text(`Email tool error: ${err.message || String(err)}`),
      isError: true,
    };
  }
}

async function executeCalendar(args: Static<typeof CalendarParams>): Promise<ToolResult> {
  const action = (args.action || "list_events").toLowerCase().trim();

  if (action === "create_event" || action === "add_event" || action === "create" || action === "add") {
    if (!args.summary || !args.summary.trim()) {
      return { content: text("Error: 'summary' (event title) is required for create_event."), isError: true };
    }
    if (!args.startTime || !args.startTime.trim()) {
      return { content: text("Error: 'startTime' is required for create_event."), isError: true };
    }
    try {
      const created = await createCalendarEvent({
        summary: args.summary.trim(),
        startTime: args.startTime.trim(),
        endTime: args.endTime?.trim(),
        location: args.location?.trim(),
        description: args.description?.trim(),
        accountEmail: args.account?.trim(),
      });
      const lines = [
        `Event scheduled successfully: "${created.summary}"`,
        `Time: ${created.startTime} - ${created.endTime}`,
      ];
      if (created.location) lines.push(`Location: ${created.location}`);
      if (created.description) lines.push(`Description: ${created.description}`);
      lines.push(`Account: ${created.accountEmail}`);
      if (created.id) lines.push(`Event ID: ${created.id}`);
      return { content: text(lines.join("\n")), isError: false };
    } catch (err: any) {
      const scopeErr = getLastCalendarError();
      if (scopeErr) {
        return { content: text(`Unable to create calendar event: ${scopeErr}`), isError: true };
      }
      return { content: text(`Calendar error: ${err.message || String(err)}`), isError: true };
    }
  }

  try {
    const events = await listAllUpcomingEvents(args.limit || 5);
    const scopeErr = getLastCalendarError();
    if (events.length === 0) {
      if (scopeErr) {
        return {
          content: text(`Unable to check calendar: ${scopeErr}`),
          isError: false,
        };
      }
      return { content: text("No upcoming calendar events found."), isError: false };
    }
    const formatted = events
      .map((e, idx) => {
        const parts = [`[${idx + 1}] ${e.summary}`];
        parts.push(`    Time: ${e.startTime} - ${e.endTime}`);
        if (e.location) parts.push(`    Location: ${e.location}`);
        if (e.meetLink) parts.push(`    Meet: ${e.meetLink}`);
        parts.push(`    Account: ${e.accountEmail}`);
        return parts.join("\n");
      })
      .join("\n\n");
    return { content: text(`Upcoming Calendar Events:\n\n${formatted}`), isError: false };
  } catch (err: any) {
    return { content: text(`Calendar error: ${err.message || String(err)}`), isError: true };
  }
}

async function executeCompactSession(
  args: Static<typeof CompactSessionParams>,
  context?: ToolContext
): Promise<ToolResult> {
  if (!context?.channel || !context?.sender) {
    return { content: text("compact_session requires channel and sender context."), isError: true };
  }

  const sessionKey = sessionKeyFromMessage(context.channel, context.sender);
  const result = await compactSession(sessionKey, {
    force: true,
    focus: args.focus,
    keepRecentTurns: args.keepRecentTurns ?? 8,
  });

  if (result.compacted) {
    return {
      content: text(
        `Session successfully compacted (${result.messagesCompacted} messages folded into summary).\n\n${result.state?.summary}`
      ),
      isError: false,
    };
  } else if (result.state?.summary) {
    return {
      content: text(
        `Session is already compact (${result.state.compactedCount} messages previously compacted). Current summary:\n\n${result.state.summary}`
      ),
      isError: false,
    };
  } else {
    return {
      content: text("Session is already compact (not enough turns to compact)."),
      isError: false,
    };
  }
}

export type YoutubeRunner = {
  runYtDlp?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  openBrowser?: (url: string, browser?: string) => Promise<{ exitCode: number }>;
};

function isYoutubeUrl(str: string): boolean {
  return /^(https?:\/\/)?((www|m)\.)?(youtube\.com\/(watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]+/i.test(
    str.trim()
  );
}

function formatDuration(seconds?: number): string {
  if (typeof seconds !== "number" || isNaN(seconds) || seconds <= 0) return "";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export async function executeYoutube(
  args: Static<typeof YoutubeParams>,
  context?: ToolContext,
  runner?: YoutubeRunner
): Promise<ToolResult> {
  const action = args.action || "play";
  const browser = args.browser || "Firefox";
  const query = (args.query || "").trim();
  const limit = Math.min(Math.max(args.limit || 5, 1), 10);

  if (!query) {
    return { content: text("Error: query parameter is required for youtube tool."), isError: true };
  }

  try {
    // If query is already a direct YouTube URL and action !== "search", open directly
    if (isYoutubeUrl(query) && action !== "search") {
      let openExitCode = 0;
      if (runner?.openBrowser) {
        const res = await runner.openBrowser(query, browser);
        openExitCode = res.exitCode;
      } else {
        try {
          const proc1 = Bun.spawn(["open", "-a", browser, query]);
          await proc1.exited;
          if (proc1.exitCode !== 0) {
            const proc2 = Bun.spawn(["open", query]);
            await proc2.exited;
            openExitCode = proc2.exitCode ?? 1;
          }
        } catch {
          const procFallback = Bun.spawn(["open", query]);
          await procFallback.exited;
          openExitCode = procFallback.exitCode ?? 1;
        }
      }

      if (openExitCode !== 0) {
        return {
          content: text(`Failed to open URL in browser (exit code ${openExitCode}).`),
          isError: true,
        };
      }
      return {
        content: text(`Opened ${query} in ${browser}.`),
        isError: false,
      };
    }

    // Run yt-dlp search with --flat-playlist for fast sub-second metadata fetching
    const ytArgs = ["--flat-playlist", "--dump-single-json", `ytsearch${limit}:${query}`];
    let ytRes: { stdout: string; stderr: string; exitCode: number };

    if (runner?.runYtDlp) {
      ytRes = await runner.runYtDlp(ytArgs);
    } else {
      const proc = Bun.spawn(["yt-dlp", ...ytArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((_, reject) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          reject(new Error("yt-dlp search timed out after 10 seconds"));
        }, 10_000)
      );

      const runPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })();

      ytRes = await Promise.race([runPromise, timeoutPromise]);
    }

    if (ytRes.exitCode !== 0) {
      return {
        content: text(`YouTube search failed: ${ytRes.stderr.trim() || `yt-dlp exited with ${ytRes.exitCode}`}`),
        isError: true,
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(ytRes.stdout);
    } catch (err: any) {
      return {
        content: text(`Failed to parse yt-dlp output as JSON: ${err.message}`),
        isError: true,
      };
    }

    const rawEntries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : parsed?.id
        ? [parsed]
        : [];

    const entries = rawEntries
      .map((e: any) => ({
        id: e.id,
        title: e.title || "Untitled",
        url: e.url && e.url.startsWith("http") ? e.url : (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ""),
        channel: e.channel || e.uploader || "Unknown",
        duration: e.duration,
      }))
      .filter((e: any) => e.url || e.id);

    if (entries.length === 0) {
      return {
        content: text(`No YouTube results found for "${query}".`),
        isError: false,
      };
    }

    if (action === "search") {
      const formatted = entries
        .map((e: any, idx: number) => {
          const dur = formatDuration(e.duration);
          const parts = [`[${idx + 1}] ${e.title}`, `    URL: ${e.url}`, `    Channel: ${e.channel}`];
          if (dur) parts.push(`    Duration: ${dur}`);
          return parts.join("\n");
        })
        .join("\n\n");
      return {
        content: text(`YouTube Search Results for "${query}":\n\n${formatted}`),
        isError: false,
      };
    }

    // Default action === "play"
    const first = entries[0];
    const videoUrl = first.url || `https://www.youtube.com/watch?v=${first.id}`;

    let openExitCode = 0;
    if (runner?.openBrowser) {
      const res = await runner.openBrowser(videoUrl, browser);
      openExitCode = res.exitCode;
    } else {
      try {
        const proc1 = Bun.spawn(["open", "-a", browser, videoUrl]);
        await proc1.exited;
        if (proc1.exitCode !== 0) {
          const proc2 = Bun.spawn(["open", videoUrl]);
          await proc2.exited;
          openExitCode = proc2.exitCode ?? 1;
        }
      } catch {
        const procFallback = Bun.spawn(["open", videoUrl]);
        await procFallback.exited;
        openExitCode = procFallback.exitCode ?? 1;
      }
    }

    if (openExitCode !== 0) {
      return {
        content: text(`Failed to open browser for "${first.title}" (${videoUrl}).`),
        isError: true,
      };
    }

    return {
      content: text(`Opened "${first.title}" (${videoUrl}) in ${browser}.`),
      isError: false,
    };
  } catch (err: any) {
    return {
      content: text(`YouTube tool error: ${err.message || String(err)}`),
      isError: true,
    };
  }
}

export async function executeSessionReset(
  args: Static<typeof SessionResetParams>,
  context?: ToolContext
): Promise<ToolResult> {
  try {
    const targetKey =
      args.sessionKey ||
      (context?.channel && context?.sender
        ? sessionKeyFromMessage(context.channel, context.sender)
        : "voice:macbook");

    clearSession(targetKey);
    if (targetKey === "voice:macbook") {
      clearSession("terminal:voice_macbook");
    } else if (targetKey === "terminal:voice_macbook") {
      clearSession("voice:macbook");
    }

    try {
      const { clearAgySession } = await import("./agent.ts");
      if (typeof clearAgySession === "function") {
        clearAgySession(targetKey);
      }
    } catch {
      // Ignore in tests or if agent module is not active
    }

    return {
      content: text(`Session ${targetKey} cleared.`),
      isError: false,
    };
  } catch (err: any) {
    return {
      content: text(`session_reset error: ${err.message || String(err)}`),
      isError: true,
    };
  }
}

export async function executeQueueSelfImprovement(
  args: Static<typeof QueueSelfImprovementParams>,
  context?: ToolContext
): Promise<ToolResult> {
  const { enqueueSelfImprovement } = await import("./self-improvement/queue.ts");
  if (!args.title || !args.title.trim()) {
    return { content: text("Error: 'title' is required to queue a self-improvement task."), isError: true };
  }
  if (!args.description || !args.description.trim()) {
    return { content: text("Error: 'description' is required to queue a self-improvement task."), isError: true };
  }
  const task = enqueueSelfImprovement({
    title: args.title.trim(),
    description: args.description.trim(),
    toolName: args.toolName?.trim(),
    targetType: args.targetType,
    sourceSession: context?.sessionKey,
  });
  return {
    content: text(
      `Self-improvement task queued successfully.\n` +
      `ID: ${task.id}\n` +
      `Title: "${task.title}"\n` +
      `Target Type: ${task.targetType || "general"}\n` +
      `Status: pending (will be executed offline by background agent)`
    ),
    isError: false,
  };
}

export async function executeUpdateSelfImprovement(
  args: Static<typeof UpdateSelfImprovementParams>
): Promise<ToolResult> {
  const { updateSelfImprovementStatus } = await import("./self-improvement/queue.ts");
  const validStatuses = ["pending", "in_progress", "completed", "failed"];
  const s = args.status?.toLowerCase().trim();
  if (!validStatuses.includes(s)) {
    return {
      content: text(`Error: Invalid status '${args.status}'. Must be one of: ${validStatuses.join(", ")}`),
      isError: true,
    };
  }
  const ok = updateSelfImprovementStatus(args.id, s as any, args.notes);
  if (!ok) {
    return {
      content: text(`Error: Self-improvement task not found with ID '${args.id}'`),
      isError: true,
    };
  }
  return {
    content: text(`Self-improvement task '${args.id}' updated to status '${s}'.`),
    isError: false,
  };
}

// ── Built-in tool extension registrations ─────────────────────────

registerToolExtension({
  tool: shellTool,
  execute: (args, ctx) => executeShell(args, ctx),
  cliUsage: 'minclaw tool call shell command="ls -la"',
});

registerToolExtension({
  tool: readFileTool,
  execute: (args) => executeReadFile(args),
  cliUsage: 'minclaw tool call read_file path="package.json"',
});

registerToolExtension({
  tool: saveCredentialTool,
  execute: (args) => executeSaveCredential(args),
  cliUsage: 'minclaw tool call save_credential provider="whisper" apiKey="..."',
});

registerToolExtension({
  tool: searchMemoryTool,
  execute: (args) => executeSearchMemory(args),
  cliUsage: 'minclaw tool call search_memory query="deployment"',
});

registerToolExtension({
  tool: rememberTool,
  execute: (args) => executeRemember(args),
  cliUsage: 'minclaw tool call remember note="User prefers dark mode"',
});

registerToolExtension({
  tool: scheduleReminderTool,
  execute: (args, ctx) => executeScheduleReminder(args, ctx),
  cliUsage: 'minclaw tool call schedule_reminder when="in 10 minutes" message="Take a break"',
});

registerToolExtension({
  tool: sendMessageTool,
  execute: (args, ctx) => executeSendMessage(args, ctx),
  cliUsage: 'minclaw tool call send_message text="Hello from MinClaw"',
});

registerToolExtension({
  tool: sendFileTool,
  execute: (args, ctx) => executeSendFile(args, ctx),
  cliUsage: 'minclaw tool call send_file filePath="/path/to/file.png"',
});

registerToolExtension({
  tool: webSearchTool,
  execute: (args, ctx) => executeWebSearch(args, ctx),
  cliUsage: 'minclaw tool call web_search query="TypeScript 5.8 features"',
});

registerToolExtension({
  tool: webFetchTool,
  execute: (args, ctx) => executeWebFetch(args, ctx),
  cliUsage: 'minclaw tool call web_fetch url="https://example.com"',
});

registerToolExtension({
  tool: emailTool,
  execute: (args) => executeEmail(args),
  cliUsage: 'minclaw tool call email action=list_unread',
});

registerToolExtension({
  tool: calendarTool,
  execute: (args) => executeCalendar(args),
  cliUsage: 'minclaw tool call calendar action=list_events',
});

registerToolExtension({
  tool: compactSessionTool,
  execute: (args, ctx) => executeCompactSession(args, ctx),
  cliUsage: 'minclaw tool call compact_session',
});

registerToolExtension({
  tool: youtubeTool,
  execute: (args, ctx) => executeYoutube(args, ctx),
  cliUsage: 'minclaw tool call youtube action=play query="Rick Astley" browser="Firefox"',
});

registerToolExtension({
  tool: sessionResetTool,
  execute: (args, ctx) => executeSessionReset(args, ctx),
  cliUsage: 'minclaw tool call session_reset sessionKey="terminal:voice_macbook"',
});

registerToolExtension({
  tool: queueSelfImprovementTool,
  execute: (args, ctx) => executeQueueSelfImprovement(args, ctx),
  cliUsage: 'minclaw tool call queue_self_improvement title="Add PDF parser skill" description="Parse PDF invoices using pdfplumber" targetType="skill"',
});

registerToolExtension({
  tool: updateSelfImprovementTool,
  execute: (args) => executeUpdateSelfImprovement(args),
  cliUsage: 'minclaw tool call update_self_improvement id="si-..." status="completed"',
});

export async function executeTool(
  name: string,
  args: Record<string, any>,
  context?: ToolContext
): Promise<ToolResult> {
  const ext = getToolExtension(name);
  if (ext) {
    return ext.execute(args, context);
  }

  switch (name) {
    case "shell":
      return executeShell(args as Static<typeof ShellParams>, context);
    case "read_file":
      return executeReadFile(args as Static<typeof ReadFileParams>);
    case "save_credential":
      return executeSaveCredential(args as Static<typeof SaveCredentialParams>);
    case "search_memory":
      return executeSearchMemory(args as Static<typeof SearchMemoryParams>);
    case "remember":
      return executeRemember(args as Static<typeof RememberParams>);
    case "schedule_reminder":
      return executeScheduleReminder(args as Static<typeof ScheduleReminderParams>, context);
    case "send_message":
      return executeSendMessage(args as Static<typeof SendMessageParams>, context);
    case "send_file":
      return executeSendFile(args as Static<typeof SendFileParams>, context);
    case "web_search":
      return executeWebSearch(args as Static<typeof WebSearchParams>, context);
    case "web_fetch":
      return executeWebFetch(args as Static<typeof WebFetchParams>, context);
    case "email":
      return executeEmail(args as Static<typeof EmailParams>);
    case "calendar":
      return executeCalendar(args as Static<typeof CalendarParams>);
    case "compact_session":
      return executeCompactSession(args as Static<typeof CompactSessionParams>, context);
    case "youtube":
      return executeYoutube(args as Static<typeof YoutubeParams>, context);
    case "session_reset":
      return executeSessionReset(args as Static<typeof SessionResetParams>, context);
    case "queue_self_improvement":
      return executeQueueSelfImprovement(args as Static<typeof QueueSelfImprovementParams>, context);
    case "update_self_improvement":
      return executeUpdateSelfImprovement(args as Static<typeof UpdateSelfImprovementParams>);
    default:
      return { content: text(`Unknown tool: ${name}`), isError: true };
  }
}

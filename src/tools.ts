import { Type, type Static } from "@sinclair/typebox";
import type { Tool, TextContent } from "@mariozechner/pi-ai";
import { saveProviderCredential } from "./auth/credentials.ts";
import { loadConfig } from "./config.ts";
import { searchMemory, getChatHistory, listSessions } from "./memory/store.ts";
import { resolve, dirname } from "path";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { getChannelSender, detectMediaType, getRegisteredChannels } from "./channels/registry.ts";
import { addJob, parseTimeToJob } from "./scheduler/scheduler.ts";

export type ToolContext = {
  channel: string;
  sender: string;
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
    "Save an API key to ~/.nakedclaw/credentials.json for a given provider. " +
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
];

// ── Tool execution ────────────────────────────────────────────────

type ToolResult = { content: TextContent[]; isError: boolean };

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
  const tmpDir = `${tmpBase.replace(/\/$/, "")}/nakedclaw-${Date.now()}`;
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
        "<!-- Auto-updated by NakedClaw. You can also edit this file manually. -->\n\n" +
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
  const maxResults = Math.min(args.maxResults ?? 5, 10);

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
        "User-Agent": "NakedClaw/1.0",
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

    // LLM-friendly formatting
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
      output += `Suggestions:\n`;

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

export async function executeTool(
  name: string,
  args: Record<string, any>,
  context?: ToolContext
): Promise<ToolResult> {
  console.log(`[agent] Tool call: ${name}(${JSON.stringify(args)})`);

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
    default:
      return { content: text(`Unknown tool: ${name}`), isError: true };
  }
}

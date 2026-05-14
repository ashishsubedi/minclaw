import { completeSimple, getModel, type Message, type ToolResultMessage, type Model } from "@mariozechner/pi-ai";
import { getApiKeyForProvider } from "./auth/credentials.ts";
import { loadChannels, loadPersistentMemory, loadSystemPrompt } from "./brain/loader.ts";
import { loadSkillsPrompt } from "./skills/loader.ts";
import { loadConfig } from "./config.ts";
import { rebuildMemoryIndex } from "./memory/store.ts";
import { getMessages, type SessionMessage } from "./session.ts";
import type { Attachment } from "./channels/types.ts";
import { readImageAsBase64 } from "./media.ts";
import { allTools, executeTool, type ToolContext } from "./tools.ts";

export type AgentResponse = {
  text: string;
  toolCalls?: Array<{ name: string; input: unknown; output: string }>;
};

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 8192;
const DEFAULT_OLLAMA_MAX_TOKENS = 4096;
const VERBOSE = process.env.NUDKCLAW_VERBOSE === "1";
const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingShellConfirmations = new Map<string, { command: string; timestamp: number }>();

function truncateLog(text: string, maxLen = 2000): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... (truncated)`;
}

function normalizeOllamaBaseUrl(input?: string): string {
  const raw = (input || "").trim();
  if (!raw) return DEFAULT_OLLAMA_BASE_URL;
  if (raw.endsWith("/v1")) return raw;
  return raw.endsWith("/") ? `${raw}v1` : `${raw}/v1`;
}

function buildOllamaModel(modelId: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: `Ollama ${modelId}`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_OLLAMA_CONTEXT_WINDOW,
    maxTokens: DEFAULT_OLLAMA_MAX_TOKENS,
  };
}

function getPendingConfirmation(sessionKey: string): string | null {
  const pending = pendingShellConfirmations.get(sessionKey);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > PENDING_CONFIRM_TTL_MS) {
    pendingShellConfirmations.delete(sessionKey);
    return null;
  }
  return pending.command;
}

function clearPendingConfirmation(sessionKey: string): void {
  pendingShellConfirmations.delete(sessionKey);
}

function setPendingConfirmation(sessionKey: string, command: string): void {
  if (!command) return;
  pendingShellConfirmations.set(sessionKey, { command, timestamp: Date.now() });
}

export async function runAgent(
  sessionKey: string,
  userMessage: string,
  attachments?: Attachment[],
  reply?: (text: string) => Promise<void>,
  toolContextOverride?: { channel: string; sender: string },
  status?: (text: string) => Promise<void>
): Promise<AgentResponse> {
  const colonIdx = sessionKey.indexOf(":");
  const toolContext: ToolContext | undefined = toolContextOverride
    ? { channel: toolContextOverride.channel, sender: toolContextOverride.sender, reply }
    : colonIdx > 0
      ? { channel: sessionKey.slice(0, colonIdx), sender: sessionKey.slice(colonIdx + 1), reply }
      : undefined;
  const trimmedMessage = userMessage.trim();
  const lowerMessage = trimmedMessage.toLowerCase();
  const isDirectConfirm = trimmedMessage.startsWith("CONFIRM:");
  const isPlainConfirm = lowerMessage === "confirm";

  if (isPlainConfirm) {
    const pending = getPendingConfirmation(sessionKey);
    if (!pending) {
      return { text: "No pending command to confirm." };
    }
    clearPendingConfirmation(sessionKey);
    const result = await executeTool("shell", { command: `CONFIRM: ${pending}` }, toolContext);
    const resultText = result.content.map((c) => c.text).join("\n") || "(no output)";
    return {
      text: resultText,
      toolCalls: [{ name: "shell", input: { command: `CONFIRM: ${pending}` }, output: resultText }],
    };
  }

  if (isDirectConfirm) {
    clearPendingConfirmation(sessionKey);
    const command = trimmedMessage;
    if (command.length <= "CONFIRM:".length) {
      return { text: "Please include a command after the prefix." };
    }
    const result = await executeTool("shell", { command }, toolContext);
    const resultText = result.content.map((c) => c.text).join("\n") || "(no output)";
    return {
      text: resultText,
      toolCalls: [{ name: "shell", input: { command }, output: resultText }],
    };
  }

  if (trimmedMessage) {
    clearPendingConfirmation(sessionKey);
  }

  const config = loadConfig();
  const provider = config.model.provider || "anthropic";
  let apiKey = await getApiKeyForProvider(provider);
  if (provider === "ollama" && !apiKey) {
    apiKey = "ollama";
  }

  // Rebuild memory index so agent has fresh context
  const memoryContext = rebuildMemoryIndex();

  // Get conversation history
  const history = getMessages(sessionKey);

  // Resolve the model through pi-ai (needed before building messages for the API string)
  const modelRef = config.model.name as any;
  const model = provider === "ollama"
    ? buildOllamaModel(modelRef, normalizeOllamaBaseUrl(config.model.baseUrl))
    : getModel(provider as any, modelRef);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelRef}`);
  }

  // Build messages for the API
  const systemPrompt = await buildSystemPrompt(config.workspace, memoryContext);
  const supportsVision = model.input.includes("image");
  const messages = historyToApiMessages(history, userMessage, model.api, provider, supportsVision, attachments);

  // Only pass temperature for non-reasoning models (OpenAI reasoning models reject it)
  const options: Record<string, any> = {
    apiKey,
    maxTokens: 4096,
  };
  if (!model.reasoning) {
    options.temperature = 0.7;
  }

  const MAX_TOOL_ITERATIONS = config.sessions.maxToolIterations ?? 25;
  const toolCallLog: AgentResponse["toolCalls"] = [];
  const toolCallCounts = new Map<string, number>();
  const MAX_REPEAT_TOOL_CALLS = 3;
  let consecutiveToolErrors = 0;
  const MAX_CONSECUTIVE_TOOL_ERRORS = 4;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const res = await completeSimple(
      model,
      { systemPrompt, messages, tools: allTools },
      options
    );

    if (res.errorMessage) {
      if (res.errorMessage.includes("only authorized for use with Claude Code")) {
        throw new Error(
          "Your OAuth token is restricted to Claude Code and can't be used for external API calls.\n" +
          "Fix: set ANTHROPIC_API_KEY or run `nakedclaw setup` and choose API key auth.\n" +
          "Get a key at https://console.anthropic.com/settings/keys"
        );
      }
      throw new Error(res.errorMessage);
    }

    // Push assistant message into conversation for multi-turn tool use
    messages.push(res);

    if (VERBOSE) {
      const responseText = res.content
        .filter((block) => block.type === "text")
        .map((block) => ("text" in block ? block.text : ""))
        .join("\n")
        .trim();
      console.log(
        `[agent] Model response (stopReason=${res.stopReason || "unknown"}): ` +
        `${truncateLog(responseText || "(no text)")}`
      );
    }

    if (res.stopReason !== "toolUse") {
      // Final text response — extract and return
      const text =
        res.content
          .filter((block) => block.type === "text")
          .map((block) => ("text" in block ? block.text : ""))
          .join("\n") || "(no response)";

      return { text, toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined };
    }

    // Execute each tool call and push results
    const toolCalls = res.content.filter((block) => block.type === "toolCall");

    for (const call of toolCalls) {
      if (call.type !== "toolCall") continue;
      const callSignature = `${call.name}:${JSON.stringify(call.arguments)}`;
      const seen = (toolCallCounts.get(callSignature) || 0) + 1;
      toolCallCounts.set(callSignature, seen);
      if (seen > MAX_REPEAT_TOOL_CALLS) {
        return {
          text:
            "I got stuck repeating the same tool call and stopped. " +
            "Try a different approach or give a more specific instruction.",
          toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
        };
      }
      if (status) {
        try {
          const input = JSON.stringify(call.arguments);
          await status(`Running tool: ${call.name}\n${input}`);
        } catch {}
      }
      const result = await executeTool(call.name, call.arguments, toolContext);
      const resultText = result.content.map((c) => c.text).join("\n");

      if (VERBOSE) {
        console.log(
          `[agent] Tool result (${call.name}, error=${result.isError}): ` +
          `${truncateLog(resultText || "(no output)")}`
        );
      }

      if (result.isError) {
        consecutiveToolErrors += 1;
        if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
          return {
            text:
              "I hit several tool errors in a row and stopped. " +
              "If you want me to try a different approach, please clarify the request.",
            toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
          };
        }
      } else {
        consecutiveToolErrors = 0;
      }

      toolCallLog.push({
        name: call.name,
        input: call.arguments,
        output: resultText,
      });

      if (
        call.name === "shell" &&
        result.isError &&
        (resultText.includes("Blocked a potentially destructive command") ||
          resultText.includes("Blocked a command that accesses the network"))
      ) {
        const original = String((call.arguments as { command?: string }).command || "").trim();
        setPendingConfirmation(sessionKey, original);
        const confirmLine = original ? `CONFIRM: ${original}` : "CONFIRM: <command>";
        return {
          text:
            "That command needs confirmation. Reply with:\n\n" +
            `${confirmLine}`,
          toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
        };
      }

      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      };
      messages.push(toolResult);
    }
  }

  // If we exhaust iterations, return whatever text we have
  console.log("[agent] Tool loop hit max iterations");
  return { text: "(max tool iterations reached)", toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined };
}

async function buildSystemPrompt(workspace: string, memoryContext: string): Promise<string> {
  const [system, channels, memory, skills] = await Promise.all([
    loadSystemPrompt(workspace),
    loadChannels(),
    loadPersistentMemory(),
    loadSkillsPrompt(),
  ]);

  const parts = [system];

  if (channels) {
    parts.push(channels);
  }

  if (skills) {
    parts.push(skills);
  }

  if (memory) {
    parts.push(`## Permanent Memory\n\n${memory}`);
  }

  parts.push(`## Temporary Memory Index\n\nRecent conversation summaries:\n\n${memoryContext}`);

  return parts.join("\n\n");
}

function buildUserContent(
  text: string,
  sessionAttachments: SessionMessage["attachments"] | undefined,
  supportsVision: boolean
): string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (!supportsVision || !sessionAttachments || sessionAttachments.length === 0) {
    return text;
  }

  const imageAttachments = sessionAttachments.filter((a) => a.type === "image");
  if (imageAttachments.length === 0) return text;

  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  if (text) {
    content.push({ type: "text", text });
  }

  for (const att of imageAttachments) {
    const img = readImageAsBase64(att.filePath);
    if (img) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  return content.length === 1 && content[0]!.type === "text" ? text : content;
}

function historyToApiMessages(
  history: SessionMessage[],
  currentMessage: string,
  api: string,
  provider: string,
  supportsVision: boolean,
  currentAttachments?: Attachment[]
): Message[] {
  const msgs: Message[] = [];
  const now = Date.now();

  for (const h of history) {
    if (h.role === "user") {
      const content = buildUserContent(h.content, h.attachments, supportsVision);
      msgs.push({ role: "user", content, timestamp: now });
    } else if (h.role === "assistant") {
      msgs.push({
        role: "assistant",
        content: [{ type: "text", text: h.content }],
        api,
        provider,
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: now,
      });
    }
  }

  // Current message — convert channel attachments to session format for buildUserContent
  const sessionAtts = currentAttachments?.map((a) => ({
    type: a.type,
    filePath: a.filePath,
    mimeType: a.mimeType,
  }));
  const content = buildUserContent(currentMessage, sessionAtts, supportsVision);
  msgs.push({ role: "user", content, timestamp: now });
  return msgs;
}

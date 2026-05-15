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
  usage?: UsageSummary;
};

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 8192;
const DEFAULT_OLLAMA_MAX_TOKENS = 4096;
const VERBOSE = process.env.NUDKCLAW_VERBOSE === "1";
const DEBUG_LLM = process.env.NUDKCLAW_DEBUG_LLM === "1" || process.env.NUDKCLAW_VERBOSE === "1";
const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingShellConfirmations = new Map<string, { command: string; timestamp: number }>();

type UsageSummary = {
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

type CostBreakdown = NonNullable<UsageSummary["cost"]>;

function calculateCostBreakdown(model: Model<any>, usage: UsageSummary): CostBreakdown {
  const input = ((model.cost?.input ?? 0) / 1_000_000) * (usage.input ?? 0);
  const output = ((model.cost?.output ?? 0) / 1_000_000) * (usage.output ?? 0);
  const cacheRead = ((model.cost?.cacheRead ?? 0) / 1_000_000) * (usage.cacheRead ?? 0);
  const cacheWrite = ((model.cost?.cacheWrite ?? 0) / 1_000_000) * (usage.cacheWrite ?? 0);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function getEstimatedCopilotPricingModel(model: Model<any>): Model<any> | undefined {
  if (model.provider !== "github-copilot") return undefined;
  return getModel("openai" as any, model.id) || getModel("openai-codex" as any, model.id);
}

function truncateLog(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... (truncated)`;
}

function debugLog(message: string): void {
  if (!DEBUG_LLM) return;
  console.error(`[llm-debug] ${message}`);
}

function debugPayload(label: string, payload: unknown): void {
  if (!DEBUG_LLM) return;
  let serialized = "";
  try {
    if (typeof payload === "object" && payload !== null) {
      // Create a shallow copy or specific summary for common large objects
      serialized = JSON.stringify(payload, (key, value) => {
        if (key === "content" && typeof value === "string") return truncateLog(value, 200);
        if (key === "systemPrompt") return truncateLog(String(value), 200);
        if (key === "data" && typeof value === "string" && value.length > 100) return `[base64 data: ${value.length} chars]`;
        return value;
      }, 2);
    } else {
      serialized = String(payload);
    }
  } catch (err) {
    serialized = `[unserializable payload: ${err instanceof Error ? err.message : String(err)}]`;
  }
  debugLog(`${label}: ${truncateLog(serialized, 2000)}`);
}

function summarizeUsage(usage: unknown, model?: Model<any>): UsageSummary | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const typed = usage as UsageSummary;
  const summary: UsageSummary = {
    input: typed.input,
    output: typed.output,
    cacheRead: typed.cacheRead,
    cacheWrite: typed.cacheWrite,
    totalTokens: typed.totalTokens,
    costSource: typed.cost ? "catalog" : "unavailable",
    cost: typed.cost
      ? {
          input: typed.cost.input,
          output: typed.cost.output,
          cacheRead: typed.cost.cacheRead,
          cacheWrite: typed.cost.cacheWrite,
          total: typed.cost.total,
        }
      : undefined,
  };

  if (model && summary.cost && summary.cost.total === 0 && model.provider === "github-copilot") {
    const pricingModel = getEstimatedCopilotPricingModel(model);
    if (pricingModel && (pricingModel.cost.input || pricingModel.cost.output || pricingModel.cost.cacheRead || pricingModel.cost.cacheWrite)) {
      summary.cost = calculateCostBreakdown(pricingModel, summary);
      summary.costSource = "estimated-openai";
    }
  }

  return summary;
}

function summarizeMessage(message: Message, model?: Model<any>): unknown {

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return { role: "user", content: truncateLog(message.content, 200) };
    }
    return {
      role: "user",
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: truncateLog(part.text, 120) }
          : { type: "image", mimeType: part.mimeType, size: part.data.length }
      ),
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      provider: message.provider,
      api: message.api,
      model: message.model,
      stopReason: message.stopReason,
      usage: summarizeUsage((message as { usage?: unknown }).usage, model),
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "text", text: truncateLog(part.text, 120) };
        }
        if (part.type === "thinking") {
          return { type: "thinking", text: truncateLog(part.thinking, 120) };
        }
        return { type: "toolCall", name: part.name, id: part.id };
      }),
    };
  }

  return {
    role: "toolResult",
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isError: message.isError,
    content: message.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: truncateLog(part.text, 120) }
        : { type: "image", mimeType: part.mimeType, size: part.data.length }
    ),
  };
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

type ResolvedModel = {
  model: Model<any>;
  apiKey: string;
  provider: string;
};

async function resolveModels(config: ReturnType<typeof loadConfig>): Promise<ResolvedModel[]> {
  const configs = [
    { provider: config.model.provider || "anthropic", name: config.model.name, baseUrl: config.model.baseUrl },
    ...(config.model.fallbacks || []),
  ];

  const resolved: ResolvedModel[] = [];
  for (const c of configs) {
    let apiKey = await getApiKeyForProvider(c.provider);
    if (c.provider === "ollama" && !apiKey) apiKey = "ollama";
    
    const model = c.provider === "ollama"
      ? buildOllamaModel(c.name, normalizeOllamaBaseUrl(c.baseUrl))
      : getModel(c.provider as any, c.name as any);
      
    if (model && apiKey) {
      resolved.push({ model, apiKey, provider: c.provider });
    } else {
      debugLog(`Warning: Could not resolve model ${c.provider}/${c.name} (missing model or API key)`);
    }
  }
  return resolved;
}

async function callModelWithFallback(
  resolvedModels: ResolvedModel[],
  context: { systemPrompt: string; messages: Message[]; tools: any[] },
  options: { temperature?: number; maxTokens?: number }
): Promise<{ response: Message; successfulConfig: ResolvedModel }> {
  let lastError: Error | null = null;

  for (const rm of resolvedModels) {
    const { model, apiKey } = rm;
    debugLog(`Attempting model ${model.id} (provider=${rm.provider}, api=${model.api})`);
    
    try {
      const res = await completeSimple(model, context, {
        ...options,
        apiKey,
        onPayload: (payload) => debugPayload("provider payload", payload),
      });

      if (res.role === "assistant" && res.errorMessage) {
        if (res.errorMessage.includes("only authorized for use with Claude Code")) {
          throw new Error(
            "Your OAuth token is restricted to Claude Code and can't be used for external API calls.\n" +
            "Fix: set ANTHROPIC_API_KEY or run `minclaw setup` and choose API key auth.\n" +
            "Get a key at https://console.anthropic.com/settings/keys"
          );
        }
        throw new Error(res.errorMessage);
      }
      return { response: res, successfulConfig: rm };
    } catch (err) {
      lastError = err as Error;
      debugLog(`Model ${model.id} failed: ${lastError.message}`);
      if (rm === resolvedModels[resolvedModels.length - 1]) throw lastError;
      debugLog("Retrying with fallback model...");
    }
  }
  throw lastError || new Error("Failed to get response from any model.");
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

  const config = loadConfig();
  const resolvedModels = await resolveModels(config);
  if (resolvedModels.length === 0) {
    throw new Error("No valid models could be resolved (check config and API keys).");
  }

  const memoryContext = rebuildMemoryIndex();
  const history = getMessages(sessionKey);
  const systemPrompt = await buildSystemPrompt(config.workspace, memoryContext);
  const primary = resolvedModels[0];
  const supportsVision = primary.model.input.includes("image");
  const messages = historyToApiMessages(history, userMessage, primary.model.api, primary.provider, supportsVision, attachments);

  const toolCallLog: AgentResponse["toolCalls"] = [];
  const toolCallCounts = new Map<string, number>();
  const MAX_REPEAT_TOOL_CALLS = 3;
  const MAX_TOOL_ITERATIONS = config.sessions.maxToolIterations ?? 25;
  const MAX_CONSECUTIVE_TOOL_ERRORS = 4;
  let consecutiveToolErrors = 0;
  let lastUsage: UsageSummary | undefined;

  // Handle Confirmation — if user confirms, execute and inject result so loop continues
  const trimmedMessage = userMessage.trim();
  const isPlainConfirm = trimmedMessage.toLowerCase() === "confirm";
  const isDirectConfirm = trimmedMessage.startsWith("CONFIRM:");

  if (isPlainConfirm || isDirectConfirm) {
    let commandToRun = "";
    if (isPlainConfirm) {
      commandToRun = getPendingConfirmation(sessionKey) || "";
    } else {
      commandToRun = trimmedMessage.slice("CONFIRM:".length).trim();
    }

    if (commandToRun) {
      clearPendingConfirmation(sessionKey);
      if (status) await status(`Running confirmed command: ${commandToRun}`);
      const result = await executeTool("shell", { command: `CONFIRM: ${commandToRun}` }, toolContext);
      const resultText = result.content.map((c) => c.text).join("\n") || "(no output)";
      
      toolCallLog.push({ name: "shell", input: { command: commandToRun }, output: resultText });
      
      const callId = `confirm-${Date.now()}`;
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "shell", arguments: { command: commandToRun } }],
        api: primary.model.api,
        provider: primary.provider,
        model: primary.model.id,
        stopReason: "toolUse",
      } as any);
      messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: "shell",
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      });
    } else if (isPlainConfirm) {
      return { text: "No pending command to confirm." };
    }
  } else if (trimmedMessage) {
    clearPendingConfirmation(sessionKey);
  }

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const { response: res, successfulConfig } = await callModelWithFallback(
      resolvedModels,
      { systemPrompt, messages, tools: allTools },
      { 
        maxTokens: 4096, 
        temperature: resolvedModels[0].model.reasoning ? undefined : 0.7 
      }
    );

    if (res.role !== "assistant") {
      throw new Error("Unexpected non-assistant response from model.");
    }

    const currentModel = successfulConfig.model;
    const currentProvider = successfulConfig.provider;

    lastUsage = summarizeUsage((res as { usage?: unknown }).usage, currentModel);
    messages.push(res);

    if (VERBOSE) {
      const parts: string[] = [];
      if (Array.isArray(res.content)) {
        for (const block of res.content) {
          if (block.type === "text") parts.push(block.text);
          if (block.type === "thinking") parts.push(`[Thinking: ${truncateLog(block.thinking, 100)}]`);
          if (block.type === "toolCall") parts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.arguments)})]`);
        }
      } else {
        parts.push(String(res.content));
      }
      
      const responsePreview = parts.join(" ").trim();
      console.log(`[agent] ${currentModel.id} response (stopReason=${res.stopReason}): ${truncateLog(responsePreview || "(empty)", 300)}`);
      
      if (lastUsage) {
        const { cost, costSource, ...u } = lastUsage;
        console.log(`[agent] Usage (${costSource}): input=${u.input} output=${u.output} total=${u.totalTokens}${cost ? ` cost=${cost.total}` : ""}`);
      }
    }

    if (res.stopReason !== "toolUse") {
      const text = Array.isArray(res.content)
        ? res.content.filter((b) => b.type === "text").map((b) => ("text" in b ? b.text : "")).join("\n") || "(no response)"
        : String(res.content);
      return { text, toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined, usage: lastUsage };
    }

    const toolCalls = Array.isArray(res.content) ? res.content.filter((b) => b.type === "toolCall") : [];
    for (const call of toolCalls) {
      if (call.type !== "toolCall") continue;

      const callSignature = `${call.name}:${JSON.stringify(call.arguments)}`;
      const seen = (toolCallCounts.get(callSignature) || 0) + 1;
      toolCallCounts.set(callSignature, seen);

      if (seen > MAX_REPEAT_TOOL_CALLS) {
        return {
          text: "I got stuck repeating the same tool call. Please provide more specific instructions.",
          toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
          usage: lastUsage,
        };
      }

      if (status) await status(`Running tool: ${call.name}`);
      const result = await executeTool(call.name, call.arguments, toolContext);
      const resultText = result.content.map((c) => c.text).join("\n");

      if (VERBOSE) {
        console.log(`[agent] Tool ${call.name} result (error=${result.isError}): ${truncateLog(resultText, 100)}`);
      }

      toolCallLog.push({ name: call.name, input: call.arguments, output: resultText });

      if (result.isError) {
        consecutiveToolErrors++;
        if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
          return {
            text: "I encountered multiple consecutive tool errors and stopped to prevent further issues.",
            toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
            usage: lastUsage,
          };
        }

        // Special case: Shell command blocked, needs confirmation
        if (call.name === "shell" && (resultText.includes("Blocked a potentially destructive command") || resultText.includes("Blocked a command that accesses the network"))) {
          const original = String((call.arguments as { command?: string }).command || "").trim();
          setPendingConfirmation(sessionKey, original);
          
          const confirmPrompt = `I need your confirmation to run:\n\nCONFIRM: ${original}\n\nReply with 'confirm' to proceed.`;
          
          // Add the confirmation request to the conversation history so the agent remembers it asked
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: confirmPrompt }],
            api: currentModel.api,
            provider: currentProvider,
            model: currentModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          } as any);

          return { text: confirmPrompt, toolCalls: toolCallLog, usage: lastUsage };
        }
      } else {
        consecutiveToolErrors = 0;
      }

      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      });
    }
  }

  return { text: "(max tool iterations reached)", toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined, usage: lastUsage };
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

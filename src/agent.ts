import { completeSimple, getModel, type Message, type ToolResultMessage, type Model } from "@mariozechner/pi-ai";
import { getApiKeyForProvider } from "./auth/credentials.ts";
import { loadChannels, loadPersistentMemory, loadSystemPrompt } from "./brain/loader.ts";
import { loadSkillsPrompt } from "./skills/loader.ts";
import { loadConfig } from "./config.ts";
import { rebuildMemoryIndex } from "./memory/store.ts";
import { getCompactedState } from "./memory/compaction.ts";
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
    const content = Array.isArray(message.content)
      ? message.content.map((part) => {
          if (part.type === "text") {
            return { type: "text", text: truncateLog(part.text, 120) };
          }
          if (part.type === "thinking") {
            return { type: "thinking", text: truncateLog(part.thinking, 120) };
          }
          return { type: "toolCall", name: part.name, id: part.id };
        })
      : truncateLog(String(message.content), 120);

    return {
      role: "assistant",
      provider: message.provider,
      api: message.api,
      model: message.model,
      stopReason: message.stopReason,
      usage: summarizeUsage((message as { usage?: unknown }).usage, model),
      content,
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

function buildGoogleModel(modelId: string): Model<"google-generative-ai"> {
  return {
    id: modelId,
    name: `Google ${modelId}`,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };
}

export function normalizeAgyModelName(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  if (
    trimmed === "flash:medium" ||
    trimmed === "flash-medium" ||
    trimmed === "gemini-flash:medium" ||
    trimmed === "gemini-3.8-flash:medium" ||
    trimmed === "flash"
  ) {
    return "gemini-3.8-flash-medium";
  }
  if (
    trimmed === "flash:high" ||
    trimmed === "flash-high" ||
    trimmed === "gemini-flash:high" ||
    trimmed === "gemini-3.8-flash:high"
  ) {
    return "gemini-3.8-flash-high";
  }
  if (
    trimmed === "flash:low" ||
    trimmed === "flash-low" ||
    trimmed === "gemini-flash:low" ||
    trimmed === "gemini-3.8-flash:low"
  ) {
    return "gemini-3.8-flash-low";
  }
  if (trimmed === "argon:medium" || trimmed === "argon-medium" || trimmed === "argon") {
    return "gemini-4-argon-medium";
  }
  if (trimmed === "argon:high" || trimmed === "argon-high") {
    return "gemini-4-argon-high";
  }
  if (trimmed === "argon:low" || trimmed === "argon-low") {
    return "gemini-4-argon-low";
  }
  if (trimmed === "opus:medium" || trimmed === "opus-medium" || trimmed === "opus") {
    return "claude-opus-5-5-medium";
  }
  if (trimmed === "opus:high" || trimmed === "opus-high") {
    return "claude-opus-5-5-high";
  }
  if (trimmed === "opus:low" || trimmed === "opus-low") {
    return "claude-opus-5-5-low";
  }
  if (trimmed === "sonnet:medium" || trimmed === "sonnet-medium" || trimmed === "sonnet") {
    return "claude-sonnet-5-5-medium";
  }
  if (trimmed === "sonnet:high" || trimmed === "sonnet-high") {
    return "claude-sonnet-5-5-high";
  }
  if (trimmed === "sonnet:low" || trimmed === "sonnet-low") {
    return "claude-sonnet-5-5-low";
  }
  return modelId.trim();
}

function buildAgyModel(modelId: string): Model<any> {
  const normalizedId = normalizeAgyModelName(modelId);
  return {
    id: normalizedId,
    name: `Antigravity ${normalizedId}`,
    api: "openai-completions" as any,
    provider: "agy",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
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
    if (c.provider === "agy" && !apiKey) apiKey = "agy";
    
    const model = c.provider === "ollama"
      ? buildOllamaModel(c.name, normalizeOllamaBaseUrl(c.baseUrl))
      : c.provider === "agy"
        ? buildAgyModel(c.name)
        : getModel(c.provider as any, c.name as any) ||
          (c.provider === "google" ? buildGoogleModel(c.name) : undefined);
      
    if (model && apiKey) {
      resolved.push({ model, apiKey, provider: c.provider });
    } else {
      debugLog(`Warning: Could not resolve model ${c.provider}/${c.name} (missing model or API key)`);
    }
  }
  return resolved;
}

const agySessions = new Map<string, string>();
const activeAgyProcesses = new Set<{ kill: (sig?: any) => void }>();

export function killActiveAgyProcesses(): void {
  for (const proc of activeAgyProcesses) {
    try {
      if (typeof proc.kill === "function") {
        proc.kill("SIGTERM");
      }
    } catch {
      // Ignore errors if process already terminated
    }
  }
  activeAgyProcesses.clear();
}

export function clearAgySession(sessionKey: string): void {
  agySessions.delete(sessionKey);
}

export function getAgySession(sessionKey: string): string | undefined {
  return agySessions.get(sessionKey);
}

export const AGY_STATIC_DELEGATION_HEADER = `[MinClaw Autonomous Agent Delegation]
You are being invoked as the autonomous execution agent for MinClaw, a personal AI assistant daemon.
MinClaw has delegated this request to you as its fallback agent.

Operating Directives:
1. Autonomous Tool Execution: You have full access to your workspace tools (reading/writing/editing workspace files, executing shell commands, web search, MCP servers, etc.). Use your tools directly to investigate, inspect, run commands, or solve the request.
2. Built-in Tools via CLI (Zero-Discovery Single Step):
   MinClaw provides built-in tools callable directly via:
   bun run src/cli.ts tool call <tool> <arg>=<val> ...
   NEVER waste turns reading \`src/\` files or writing \`bun -e\` scripts to figure out how email, calendar, YouTube, memory, or session reset work — run the \`bun run src/cli.ts tool call <name> ...\` command directly in 1 step!
   - Unread emails: bun run src/cli.ts tool call email action=list_unread limit=10
   - Read full email by ID: bun run src/cli.ts tool call email action=read id="<id>" account="<account>"
   - Send email: bun run src/cli.ts tool call email action=send to="..." subject="..." body="..."
   - Upcoming calendar events: bun run src/cli.ts tool call calendar action=list_events limit=10
   - Play YouTube video in Firefox: bun run src/cli.ts tool call youtube action=play query="<song or video>" browser="Firefox"
   - Search YouTube fast: bun run src/cli.ts tool call youtube action=search query="<query>"
   - Reset session: bun run src/cli.ts tool call session_reset
   - Save permanent memory: bun run src/cli.ts tool call remember note="<fact>"
   - Search chat memory: bun run src/cli.ts tool call search_memory query="<keyword>"
   - Schedule reminder: bun run src/cli.ts tool call schedule_reminder when="<time>" message="<text>"
3. Workspace Context: You are running inside the MinClaw workspace.
4. Skip Logseq Memory: Unless explicitly requested by the user or strictly critical to the task, skip Logseq memory operations (do not query Logseq tasks/graphs or sync journal pulses). This session is for user's everyday random tasks, not autonomous AI development lifecycle tracking.
5. Final Output Delivery: When your tool operations are complete, output your final, concise, helpful response for the user. MinClaw is waiting for your final output and will deliver it directly to the user on their channel.`;

export function buildAgyPrompt(
  context: { systemPrompt: string; messages: Message[] },
  sessionKey?: string,
  isContinuation = false
): string {
  const lastMsg = context.messages[context.messages.length - 1];
  let currentPromptText = "";

  if (lastMsg) {
    if (typeof lastMsg.content === "string") {
      currentPromptText = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
      currentPromptText = (lastMsg.content as any[])
        .filter((p) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
    } else {
      currentPromptText = String(lastMsg.content);
    }
  }

  // If this conversation is continuing an existing agy session (--conversation <id>),
  // Antigravity already holds the conversation history with the static system context prefix.
  // We provide the user request cleanly to preserve prefix caching on prior turns.
  if (isContinuation) {
    return [
      `[Current User Request]`,
      currentPromptText,
    ].join("\n");
  }

  // First agy turn for this session:
  // Layout strictly ordered for LLM Prompt Caching:
  // 1. Static Invariant Header (identical across all sessions and channels)
  // 2. Static MinClaw System Prompt (persona, permanent memories, skills)
  // 3. Dynamic Conversation History (past turns, tool calls/results)
  // 4. Dynamic Current User Request
  const sections: string[] = [AGY_STATIC_DELEGATION_HEADER];

  if (context.systemPrompt && context.systemPrompt.trim()) {
    sections.push(
      `[MinClaw System Context & Knowledge]\n${context.systemPrompt.trim()}`
    );
  }

  const historyTurns: string[] = [];
  const priorMessages = context.messages.slice(0, -1);

  for (const m of priorMessages) {
    if (m.role === "toolResult") {
      const toolName = (m as any).toolName || "tool";
      const resultText = Array.isArray(m.content)
        ? (m.content as any[]).map((c: any) => c.text || "").join("\n")
        : String(m.content);
      historyTurns.push(`[Tool Result (${toolName})]: ${resultText.slice(0, 1000)}`);
      continue;
    }

    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    if (typeof m.content === "string" && m.content.trim()) {
      historyTurns.push(`${role}: ${m.content.trim()}`);
    } else if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const part of m.content as any[]) {
        if (part.type === "text" && part.text?.trim()) {
          texts.push(part.text.trim());
        } else if (part.type === "toolCall") {
          texts.push(`[Called Tool: ${part.name}(${JSON.stringify(part.arguments)})]`);
        }
      }
      if (texts.length > 0) {
        historyTurns.push(`${role}: ${texts.join("\n")}`);
      }
    }
  }

  if (historyTurns.length > 0) {
    sections.push(
      `[Prior Conversation History]\n${historyTurns.slice(-10).join("\n\n")}`
    );
  }

  sections.push(
    `[Current User Request]\n${currentPromptText}`
  );

  return sections.join("\n\n");
}

async function callModelWithFallback(
  resolvedModels: ResolvedModel[],
  context: { systemPrompt: string; messages: Message[]; tools: any[] },
  options: { temperature?: number; maxTokens?: number },
  sessionKey?: string,
  status?: (text: string) => Promise<void>
): Promise<{
  response: Message;
  successfulConfig: ResolvedModel;
  agyToolCalls?: Array<{ name: string; input: unknown; output: string }>;
}> {
  const logPrefix = sessionKey ? `[agent:${sessionKey}]` : "[agent]";
  const agyLogPrefix = sessionKey ? `[agent:${sessionKey}:agy]` : "[agent:agy]";
  let lastError: Error | null = null;

  for (const rm of resolvedModels) {
    const { model, apiKey } = rm;
    const modelLabel = `${rm.provider}/${model.id}`;
    console.log(`${logPrefix} 🤖 Calling model: ${modelLabel}...`);
    debugLog(`Attempting model ${model.id} (provider=${rm.provider}, api=${model.api})`);
    
    if (rm.provider === "agy") {
      console.log(`${logPrefix} ⚙️ Invoking agy CLI with model ${model.id}...`);
      debugLog(`Invoking agy CLI with model ${model.id}...`);
      try {
        const conversationId = sessionKey ? agySessions.get(sessionKey) : undefined;
        const promptText = buildAgyPrompt(context, sessionKey, !!conversationId);

        const spawnArgs = [
          "agy",
          "--print",
          promptText,
          "--model",
          model.id,
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
          "--disable-slash-commands",
          "--print-timeout",
          "180s",
        ];
        if (conversationId) {
          spawnArgs.push("--conversation", conversationId);
        }

        const proc = Bun.spawn(spawnArgs, {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });
        activeAgyProcesses.add(proc);

        try {
          const stderrPromise = new Response(proc.stderr).text();
          const capturedToolCalls: Array<{ name: string; input: unknown; output: string }> = [];
          let textRes = "";
          let agyError: string | undefined;
          let agyUsage: any = undefined;

          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          const handleAgyJson = async (parsed: any) => {
            // Direct legacy or single-object JSON support
            if (parsed.status === "ERROR") {
              agyError = parsed.error || "agy returned error status";
              return;
            }
            if (parsed.conversation_id && sessionKey) {
              agySessions.set(sessionKey, parsed.conversation_id);
              debugLog(`Updated agy conversation ${parsed.conversation_id} for session ${sessionKey}`);
            }
            if (typeof parsed.response === "string" && !parsed.event) {
              textRes = parsed.response.trim();
            }

            // stream-json events
            const eventType = parsed.event;
            if (eventType === "init") {
              const initConvId = parsed.conversation_id || parsed.init?.conversation_id;
              if (initConvId && sessionKey) {
                agySessions.set(sessionKey, initConvId);
                debugLog(`Updated agy conversation ${initConvId} for session ${sessionKey}`);
              }
            } else if (eventType === "step_update") {
              const step = parsed.step_update;
              if (!step) return;

              if (step.step_type === "tool") {
                const toolName = step.tool_name || step.tool_info?.name || "tool";
                const params = step.tool_info?.parameters;

                if (step.state === "ACTIVE") {
                  let displayToolName = toolName;
                  if (toolName === "call_mcp_tool" && params?.ToolName) {
                    displayToolName = `mcp:${params.ToolName}`;
                  } else if (toolName === "run_command" && params?.CommandLine) {
                    const firstWord = String(params.CommandLine).trim().split(/\s+/)[0];
                    displayToolName = `run_command (${firstWord})`;
                  }
                  const statusMsg = `Running tool: ${displayToolName}`;

                  const paramsSummary = params ? truncateLog(JSON.stringify(params), 100) : "";
                  console.log(`${logPrefix} 🔧 agy tool: ${toolName} ${paramsSummary}`);
                  if (status) {
                    try {
                      await status(statusMsg);
                    } catch (e: any) {
                      debugLog(`status callback error: ${e.message}`);
                    }
                  }
                } else if (step.state === "DONE") {
                  const dur = typeof step.duration_seconds === "number"
                    ? ` (${step.duration_seconds.toFixed(1)}s)`
                    : "";
                  const outText = typeof step.tool_info?.output === "string" ? step.tool_info.output : "";
                  const outPreview = outText ? ` → ${truncateLog(outText.trim().replace(/\s+/g, " "), 100)}` : "";
                  console.log(`${logPrefix} 🛠️ agy tool done: ${toolName}${dur}${outPreview}`);

                  capturedToolCalls.push({
                    name: toolName,
                    input: params ?? {},
                    output: outText,
                  });
                }
              } else if (step.step_type === "agent_response") {
                if (step.state === "DONE" && step.usage?.thinking_tokens) {
                  const dur = typeof step.duration_seconds === "number"
                    ? ` (${step.duration_seconds.toFixed(1)}s)`
                    : "";
                  console.log(`${logPrefix} 🧠 agy thinking${dur}: tokens in=${step.usage?.input_tokens ?? 0} out=${step.usage?.output_tokens ?? 0} thinking=${step.usage?.thinking_tokens ?? 0}`);
                  if (status) {
                    try {
                      await status("Thinking...");
                    } catch (e: any) {
                      debugLog(`status callback error: ${e.message}`);
                    }
                  }
                }
              }
            } else if (eventType === "result") {
              const result = parsed.result;
              if (!result) return;
              if (result.status === "ERROR") {
                agyError = result.error || "agy execution failed with error status";
                return;
              }
              if (result.conversation_id && sessionKey) {
                agySessions.set(sessionKey, result.conversation_id);
              }
              if (typeof result.response === "string") {
                textRes = result.response.trim();
              }
              if (result.usage) {
                agyUsage = result.usage;
              }
              const dur = typeof result.duration_seconds === "number"
                ? ` in ${result.duration_seconds.toFixed(1)}s`
                : "";
              const turns = typeof result.num_turns === "number"
                ? ` (${result.num_turns} turn${result.num_turns === 1 ? "" : "s"})`
                : "";
              console.log(`${logPrefix} ⚡ agy model ${model.id} completed${dur}${turns}`);
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line) continue;
              if (line.startsWith("{")) {
                try {
                  const parsed = JSON.parse(line);
                  await handleAgyJson(parsed);
                  continue;
                } catch {
                  // fall through to non-json logging
                }
              }
              console.log(`${agyLogPrefix} ${line}`);
            }
          }

          if (buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith("{")) {
              try {
                const parsed = JSON.parse(line);
                await handleAgyJson(parsed);
              } catch {
                console.log(`${agyLogPrefix} ${line}`);
              }
            } else {
              console.log(`${agyLogPrefix} ${line}`);
            }
          }

          const stderr = (await stderrPromise).trim();
          const code = await proc.exited;

          if (agyError) {
            throw new Error(agyError);
          }
          if (code !== 0) {
            throw new Error(`agy CLI exited with code ${code}: ${stderr || textRes || "Unknown error"}`);
          }

          const res: Message = {
            role: "assistant",
            content: [{ type: "text", text: textRes || "(no response)" }],
            stopReason: "stop",
            usage: agyUsage
              ? {
                  input: agyUsage.input_tokens ?? 0,
                  output: agyUsage.output_tokens ?? 0,
                  cacheRead: agyUsage.cache_read_tokens ?? 0,
                  cacheWrite: 0,
                  totalTokens: agyUsage.total_tokens ?? 0,
                }
              : undefined,
          } as any;

          return {
            response: res,
            successfulConfig: rm,
            agyToolCalls: capturedToolCalls,
          };
        } finally {
          activeAgyProcesses.delete(proc);
        }
      } catch (err) {
        lastError = err as Error;
        console.warn(`${logPrefix} ⚠️ agy model ${model.id} failed: ${lastError.message}`);
        debugLog(`agy model ${model.id} failed: ${lastError.message}`);
        continue;
      }
    }

    for (let attempt = 0; attempt <= 2; attempt++) {
      const modelStart = Date.now();
      try {
        const res = await completeSimple(model, context, {
          ...options,
          apiKey,
          onPayload: (payload) => debugPayload("provider payload", payload),
        });

        const duration = ((Date.now() - modelStart) / 1000).toFixed(1);

        if (res.role === "assistant" && res.errorMessage) {
          const isBillingDepleted =
            res.errorMessage.includes("402") ||
            res.errorMessage.includes("Payment Required") ||
            res.errorMessage.includes("prepayment credits");

          const isTransient =
            !isBillingDepleted &&
            (res.errorMessage.includes("503") ||
              res.errorMessage.includes("high demand") ||
              res.errorMessage.includes("UNAVAILABLE") ||
              res.errorMessage.includes("429") ||
              res.errorMessage.includes("RESOURCE_EXHAUSTED"));

          console.warn(`${logPrefix} ⚠️ Model ${modelLabel} error (${duration}s): ${res.errorMessage.slice(0, 100)}`);

          if (isBillingDepleted) {
            console.warn(`${logPrefix} 💳 Payment or prepayment credits depleted on ${modelLabel}. Skipping retries...`);
            throw new Error(res.errorMessage);
          }

          if (isTransient && attempt < 2) {
            const delay = (attempt + 1) * 1200;
            console.log(`${logPrefix} ⏳ Transient error on ${modelLabel}, retrying in ${delay}ms (attempt ${attempt + 2}/3)...`);
            debugLog(`Transient error on ${model.id} (${res.errorMessage.slice(0, 80)}...), retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          if (res.errorMessage.includes("only authorized for use with Claude Code")) {
            throw new Error(
              "Your OAuth token is restricted to Claude Code and can't be used for external API calls.\n" +
              "Fix: set ANTHROPIC_API_KEY or run `minclaw setup` and choose API key auth.\n" +
              "Get a key at https://console.anthropic.com/settings/keys"
            );
          }
          throw new Error(res.errorMessage);
        }

        console.log(`${logPrefix} ⚡ Model ${modelLabel} responded (${duration}s, stopReason=${res.stopReason})`);
        return { response: res, successfulConfig: rm };
      } catch (err) {
        lastError = err as Error;
        const duration = ((Date.now() - modelStart) / 1000).toFixed(1);
        const isBillingDepleted =
          lastError.message.includes("402") ||
          lastError.message.includes("Payment Required") ||
          lastError.message.includes("prepayment credits");

        const isTransient =
          !isBillingDepleted &&
          (lastError.message.includes("503") ||
            lastError.message.includes("high demand") ||
            lastError.message.includes("UNAVAILABLE"));

        if (isBillingDepleted) {
          console.warn(`${logPrefix} 💳 Payment or prepayment credits depleted on ${modelLabel}. Skipping retries...`);
        } else if (isTransient && attempt < 2) {
          const delay = (attempt + 1) * 1200;
          console.log(`${logPrefix} ⏳ Transient error on ${modelLabel} (${duration}s), retrying in ${delay}ms (attempt ${attempt + 2}/3)...`);
          debugLog(`Transient error on ${model.id}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        console.warn(`${logPrefix} ❌ Model ${modelLabel} failed (${duration}s): ${lastError.message}`);
        debugLog(`Model ${model.id} failed: ${lastError.message}`);
        if (rm === resolvedModels[resolvedModels.length - 1] && attempt === 2) throw lastError;
        console.log(`${logPrefix} 🔄 Attempting fallback model...`);
        debugLog("Retrying with fallback model...");
        break;
      }
    }
  }
  throw lastError || new Error("Failed to get response from any model.");
}

/**
 * Fast, stateless model completion for zero-tool, high-speed reflexive tasks
 * (e.g. reflex email triage, short summaries, intent checks).
 */
export async function completeFast(
  prompt: string,
  systemPrompt = "",
  maxTokens = 1024
): Promise<string> {
  const config = loadConfig();
  const resolvedModels = await resolveModels(config);
  if (resolvedModels.length === 0 || !resolvedModels[0]) {
    throw new Error("No valid models could be resolved (check config and API keys).");
  }

  const nonAgyModels = resolvedModels.filter((rm) => rm.provider !== "agy");
  const modelsToUse = nonAgyModels.length > 0 ? nonAgyModels : resolvedModels;

  const { response } = await callModelWithFallback(
    modelsToUse,
    {
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      tools: [],
    },
    { temperature: 0.1, maxTokens },
    "fast"
  );

  if (typeof response.content === "string") return response.content;
  if (Array.isArray(response.content)) {
    return response.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
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
  if (resolvedModels.length === 0 || !resolvedModels[0]) {
    throw new Error("No valid models could be resolved (check config and API keys).");
  }

  const memoryContext = rebuildMemoryIndex();
  const history = getMessages(sessionKey);
  const systemPrompt = await buildSystemPrompt(config.workspace, memoryContext, sessionKey);
  const primary = resolvedModels[0];
  const supportsVision = primary.model.input.includes("image");
  const messages = historyToApiMessages(history, userMessage, primary.model.api, primary.provider, supportsVision, attachments);
  const fallbackChain = resolvedModels.map((m) => `${m.provider}/${m.model.id}`).join(" → ");
  const logPrefix = sessionKey ? `[agent:${sessionKey}]` : "[agent]";
  console.log(`${logPrefix} Starting turn for ${sessionKey} [chain: ${fallbackChain}]`);

  const toolCallLog: AgentResponse["toolCalls"] = [];
  const toolCallCounts = new Map<string, number>();
  const MAX_REPEAT_TOOL_CALLS = 3;
  const MAX_TOOL_ITERATIONS = config.sessions.maxToolIterations ?? 15;
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
      console.log(`${logPrefix} ⚡ Running confirmed command: ${commandToRun}`);
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
    if (i > 0) {
      console.log(`${logPrefix} ── Turn iteration ${i + 1}/${MAX_TOOL_ITERATIONS} ──`);
    }

    const { response: res, successfulConfig, agyToolCalls } = await callModelWithFallback(
      resolvedModels,
      { systemPrompt, messages, tools: allTools },
      { 
        maxTokens: 4096, 
        temperature: primary.model.reasoning ? undefined : 0.7 
      },
      sessionKey,
      status
    );

    if (agyToolCalls && agyToolCalls.length > 0) {
      toolCallLog.push(...agyToolCalls);
    }

    if (res.role !== "assistant") {
      throw new Error("Unexpected non-assistant response from model.");
    }

    const currentModel = successfulConfig.model;
    const currentProvider = successfulConfig.provider;

    lastUsage = summarizeUsage((res as { usage?: unknown }).usage, currentModel);
    messages.push(res);

    if (Array.isArray(res.content)) {
      for (const block of res.content) {
        if (block.type === "thinking" && block.thinking) {
          const clean = block.thinking.trim().replace(/\s+/g, " ");
          console.log(`${logPrefix} 🧠 Thinking: ${truncateLog(clean, 180)}`);
        }
      }
    }

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
      console.log(`${logPrefix} ${currentModel.id} response (stopReason=${res.stopReason}): ${truncateLog(responsePreview || "(empty)", 300)}`);
    }

    if (res.stopReason !== "toolUse") {
      const text = Array.isArray(res.content)
        ? res.content.filter((b) => b.type === "text").map((b) => ("text" in b ? b.text : "")).join("\n") || "(no response)"
        : String(res.content);
      const clean = text.trim().replace(/\s+/g, " ");
      console.log(`${logPrefix} 💬 Final response: ${truncateLog(clean, 180)}`);
      if (lastUsage) {
        const { cost, costSource, ...u } = lastUsage;
        const costStr = cost?.total ? ` | $${cost.total.toFixed(4)}` : "";
        console.log(`${logPrefix} 📊 Tokens: in=${u.input ?? 0} out=${u.output ?? 0} total=${u.totalTokens ?? 0}${costStr}`);
      }
      return { text, toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined, usage: lastUsage };
    }

    const toolCalls = Array.isArray(res.content) ? res.content.filter((b) => b.type === "toolCall") : [];
    for (const call of toolCalls) {
      if (call.type !== "toolCall") continue;

      const callSignature = `${call.name}:${JSON.stringify(call.arguments)}`;
      const seen = (toolCallCounts.get(callSignature) || 0) + 1;
      toolCallCounts.set(callSignature, seen);

      if (seen > MAX_REPEAT_TOOL_CALLS) {
        console.warn(`${logPrefix} ⚠️ Stuck repeating tool call: ${call.name}`);
        return {
          text: "I got stuck repeating the same tool call. Please provide more specific instructions.",
          toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
          usage: lastUsage,
        };
      }

      console.log(`${logPrefix} 🛠️ Tool: ${call.name}(${JSON.stringify(call.arguments)})`);
      if (status) await status(`Running tool: ${call.name}`);
      const toolStart = Date.now();
      const result = await executeTool(call.name, call.arguments, toolContext);
      const toolElapsed = Date.now() - toolStart;
      const resultText = result.content.map((c) => c.text).join("\n");
      const cleanResult = resultText.trim().replace(/\s+/g, " ");
      console.log(`${logPrefix} ↳ Tool ${call.name} ${result.isError ? "FAILED ❌" : "completed ✅"} (${toolElapsed}ms): ${truncateLog(cleanResult, 140)}`);

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

async function buildSystemPrompt(workspace: string, memoryContext: string, sessionKey?: string): Promise<string> {
  const [system, channels, memory, skills] = await Promise.all([
    loadSystemPrompt(workspace),
    loadChannels(),
    loadPersistentMemory(),
    loadSkillsPrompt(),
  ]);

  const parts = [system];

  if (sessionKey?.includes("voice")) {
    parts.push(
      `## Voice Session Strict Constraints\n` +
      `- You are speaking to the user over the macOS Voice Companion via Text-to-Speech.\n` +
      `- STRICT LANGUAGE RESTRICTION: You strictly communicate ONLY in English and Nepali. Never respond in Korean, Japanese, Chinese, or any other language.\n` +
      `- Audio Formatting: Keep responses conversational, natural, and concise for spoken delivery. Avoid markdown tables, ascii art, and excessive bullet points.`
    );
  }

  if (channels) {
    parts.push(channels);
  }

  if (skills) {
    parts.push(skills);
  }

  if (memory) {
    parts.push(`## Permanent Memory\n\n${memory}`);
  }

  if (sessionKey) {
    const compacted = getCompactedState(sessionKey);
    if (compacted?.summary && compacted.summary.trim()) {
      parts.push(
        `## Current Session Summary (Compacted History)\n\nThe following structured summary captures earlier turns in this conversation before the recent messages window:\n\n${compacted.summary.trim()}`
      );
    }
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
      let textContent = h.content;
      if (h.toolCalls && h.toolCalls.length > 0) {
        const toolSummary = h.toolCalls
          .map((tc) => {
            const inputStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input);
            const outStr = tc.output.length > 300 ? `${tc.output.slice(0, 300)}...` : tc.output;
            return `- ${tc.name}(${inputStr}) -> ${outStr.replace(/\s+/g, " ").trim()}`;
          })
          .join("\n");
        textContent = `[Tools used in this turn:\n${toolSummary}]\n\n${h.content}`;
      }
      msgs.push({
        role: "assistant",
        content: [{ type: "text", text: textContent }],
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

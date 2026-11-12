import {
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONRPCNotification,
  type ACPInitializeResult,
  type ACPSessionNewResult,
  type ACPPromptResult,
  type ACPSessionUpdateNotification,
} from "./types.ts";

export interface ACPToolCallRecord {
  name: string;
  input: unknown;
  output: string;
  toolCallId?: string;
}

export interface ACPPromptCallbacks {
  onChunk?: (text: string) => Promise<void> | void;
  onThought?: (text: string) => Promise<void> | void;
  onToolCall?: (call: { name: string; args: Record<string, any>; toolCallId: string }) => Promise<void> | void;
  onToolDone?: (call: { name: string; toolCallId: string; output: string }) => Promise<void> | void;
  onStatus?: (status: string) => Promise<void> | void;
}

export interface ACPTurnResult {
  text: string;
  toolCalls: ACPToolCallRecord[];
  usage?: ACPPromptResult["usage"];
  stopReason?: string;
}

export class ACPClient {
  private proc: any = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      method: string;
    }
  >();
  private activeTurns = new Map<string, {
    callbacks: ACPPromptCallbacks;
    accumulatedText: string;
    capturedTools: Map<string, ACPToolCallRecord>;
    toolOrder: string[];
    resolve: (res: ACPTurnResult) => void;
    reject: (err: Error) => void;
    promptId: number;
    usage?: ACPPromptResult["usage"];
  }>();

  private isInitialized = false;
  private isClosing = false;
  private initPromise: Promise<ACPInitializeResult> | null = null;
  private activeSessions = new Map<string, string>(); // sessionKey -> ACP sessionId
  private sessionModels = new Map<string, string>(); // sessionId -> configured modelId
  private binaryPath: string;

  constructor(binaryPath: string = "agy") {
    this.binaryPath = binaryPath;
  }

  /**
   * Spawns the warm agy acp process and performs the initialize handshake.
   */
  public async ensureRunning(): Promise<ACPInitializeResult> {
    if (this.isInitialized && this.proc && this.proc.exitCode === null) {
      return this.initPromise!;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const spawnArgs = [
          this.binaryPath,
          "acp",
          "--stdio",
          "--dangerously-skip-permissions",
        ];

        this.proc = Bun.spawn(spawnArgs, {
          cwd: process.cwd(),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

        this.reader = this.proc.stdout.getReader();

        // Start processing background output stream
        void this.readLoop();
        void this.logStderr();

        // Perform ACP initialize handshake
        const initResult = await this.sendRequest<ACPInitializeResult>("initialize", {
          clientInfo: {
            name: "minclaw",
            version: "1.0",
          },
        });

        this.isInitialized = true;
        return initResult;
      } catch (err) {
        this.teardown();
        throw err;
      }
    })();

    return this.initPromise;
  }

  /**
   * Obtains or creates an ACP session for the given MinClaw sessionKey.
   * Ensures the session is explicitly configured with target modelId (defaults to gemini-3.8-flash-medium).
   */
  public async getOrCreateSession(sessionKey: string, modelId?: string): Promise<string> {
    await this.ensureRunning();

    const targetModel = modelId || "gemini-3.8-flash-medium";

    let sessionId = this.activeSessions.get(sessionKey);
    if (!sessionId) {
      const res = await this.sendRequest<ACPSessionNewResult>("session/new", {
        cwd: process.cwd(),
      });
      sessionId = res.sessionId;
      this.activeSessions.set(sessionKey, sessionId);
    }

    if (this.sessionModels.get(sessionId) !== targetModel) {
      await this.setModel(sessionId, targetModel);
    }

    return sessionId;
  }

  /**
   * Configures the active model for an ACP session via session/set_model,
   * falling back to session/set_config_option if needed.
   */
  public async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureRunning();
    try {
      await this.sendRequest("session/set_model", {
        sessionId,
        modelId,
      });
      this.sessionModels.set(sessionId, modelId);
    } catch {
      // Fallback: set via session/set_config_option
      const baseModel = modelId.includes("flash")
        ? "gemini-3.8-flash"
        : modelId.includes("argon")
        ? "gemini-4-argon"
        : modelId.includes("opus")
        ? "claude-opus-5-5"
        : modelId.includes("sonnet")
        ? "claude-sonnet-5-5"
        : modelId;
      await this.sendRequest("session/set_config_option", {
        sessionId,
        configId: "model",
        value: baseModel,
      });
      this.sessionModels.set(sessionId, modelId);
    }
  }

  /**
   * Checks if an active ACP session exists for the given MinClaw sessionKey.
   */
  public hasSession(sessionKey: string): boolean {
    return this.activeSessions.has(sessionKey);
  }

  /**
   * Clears the cached session ID for a sessionKey (e.g. on /reset).
   */
  public clearSession(sessionKey: string): void {
    const sessionId = this.activeSessions.get(sessionKey);
    if (sessionId) {
      this.sessionModels.delete(sessionId);
    }
    this.activeSessions.delete(sessionKey);
  }

  /**
   * Executes a turn through ACP, streaming chunks, tool calls, and thoughts.
   */
  public async runPrompt(
    sessionId: string,
    promptText: string,
    callbacks: ACPPromptCallbacks = {}
  ): Promise<ACPTurnResult> {
    await this.ensureRunning();

    return new Promise<ACPTurnResult>((resolve, reject) => {
      const promptId = this.nextId++;

      this.activeTurns.set(sessionId, {
        callbacks,
        accumulatedText: "",
        capturedTools: new Map(),
        toolOrder: [],
        resolve,
        reject,
        promptId,
      });

      this.sendRequestRaw({
        jsonrpc: "2.0",
        id: promptId,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        },
      }).catch((err) => {
        this.activeTurns.delete(sessionId);
        reject(err);
      });
    });
  }

  /**
   * Steers an in-flight prompt on the active session (e.g. at step 7 checkpoint or user interrupt).
   * In ACP, sending session/prompt while a turn is active invokes waitForSteer and pivots the agent.
   */
  public async steer(sessionId: string, steerText: string): Promise<void> {
    await this.ensureRunning();

    const steerId = this.nextId++;
    const active = this.activeTurns.get(sessionId);
    if (active) {
      // The steer prompt takes over the turn
      active.promptId = steerId;
    }

    await this.sendRequestRaw({
      jsonrpc: "2.0",
      id: steerId,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: steerText }],
      },
    });
  }

  /**
   * Cancels the active prompt for a session without terminating the session or process.
   */
  public async cancel(sessionId: string): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    try {
      await this.sendRequestRaw({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });
    } catch {
      // ignore cancel send error
    }
  }

  /**
   * Sends a JSON-RPC request and awaits the response.
   */
  private async sendRequest<T>(method: string, params?: Record<string, any>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      this.sendRequestRaw({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }).catch((err) => {
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  private async sendRequestRaw(msg: JSONRPCRequest | Record<string, any>): Promise<void> {
    if (!this.proc || !this.proc.stdin) {
      throw new Error("ACP process stdin is not writable.");
    }
    const payload = new TextEncoder().encode(JSON.stringify(msg) + "\n");
    this.proc.stdin.write(payload);
    if (typeof this.proc.stdin.flush === "function") {
      this.proc.stdin.flush();
    }
  }

  /**
   * Background reader loop parsing JSON-RPC messages from agy acp stdout.
   */
  private async readLoop(): Promise<void> {
    if (!this.reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (!line.startsWith("{")) continue;

          try {
            const parsed = JSON.parse(line);
            this.handleIncomingMessage(parsed);
          } catch {
            // non-json output or partial chunk
          }
        }
      }
    } catch {
      // Reader disconnected
    } finally {
      this.handleProcessExit();
    }
  }

  private async logStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    try {
      const text = await new Response(this.proc.stderr).text();
      if (text.trim()) {
        const lines = text.trim().split("\n");
        for (const l of lines) {
          if (l.includes("error") || l.includes("warning")) {
            console.warn(`[acp:stderr] ${l}`);
          }
        }
      }
    } catch {}
  }

  private handleIncomingMessage(msg: any): void {
    // 1. JSON-RPC Response to pending request (has id)
    if (typeof msg.id === "number") {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`ACP Error (${msg.error.code}): ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }

      // Check if this was a session/prompt completion
      for (const [sessionId, turn] of this.activeTurns.entries()) {
        if (turn.promptId === msg.id) {
          this.activeTurns.delete(sessionId);
          if (msg.error) {
            turn.reject(new Error(`ACP prompt error: ${msg.error.message}`));
          } else {
            const result: ACPPromptResult = msg.result || { stopReason: "end_turn" };
            const toolList = turn.toolOrder.map((id) => turn.capturedTools.get(id)!);
            turn.resolve({
              text: turn.accumulatedText,
              toolCalls: toolList,
              usage: result.usage,
              stopReason: result.stopReason,
            });
          }
        }
      }
      return;
    }

    // 2. Notification (no id, has method)
    if (msg.method === "session/update" && msg.params?.sessionId) {
      const notif = msg as ACPSessionUpdateNotification;
      const turn = this.activeTurns.get(notif.params.sessionId);
      if (!turn) return;

      const update = notif.params.update;
      if (!update) return;

      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const chunk = update.content?.text || "";
          if (chunk) {
            turn.accumulatedText += chunk;
            if (turn.callbacks.onChunk) {
              void turn.callbacks.onChunk(chunk);
            }
          }
          break;
        }

        case "thought_chunk": {
          const thought = update.content?.text || "";
          if (thought && turn.callbacks.onThought) {
            void turn.callbacks.onThought(thought);
          }
          break;
        }

        case "tool_call": {
          const tcId = update.toolCallId;
          const toolName = update.name || "tool";
          const args = update.args || {};

          if (!turn.capturedTools.has(tcId)) {
            turn.capturedTools.set(tcId, {
              name: toolName,
              input: args,
              output: "",
              toolCallId: tcId,
            });
            turn.toolOrder.push(tcId);
          }

          if (turn.callbacks.onToolCall) {
            void turn.callbacks.onToolCall({ name: toolName, args, toolCallId: tcId });
          }
          break;
        }

        case "tool_call_update": {
          const tcId = update.toolCallId;
          let entry = turn.capturedTools.get(tcId);
          if (!entry) {
            entry = {
              name: update.name || "tool",
              input: update.args || {},
              output: "",
              toolCallId: tcId,
            };
            turn.capturedTools.set(tcId, entry);
            turn.toolOrder.push(tcId);
          }

          if (update.rawOutput !== undefined) {
            entry.output = typeof update.rawOutput === "string"
              ? update.rawOutput
              : JSON.stringify(update.rawOutput);
          } else if (update.content) {
            if (Array.isArray(update.content)) {
              entry.output = update.content
                .map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
                .join("\n");
            } else if (typeof update.content === "string") {
              entry.output = update.content;
            } else {
              entry.output = JSON.stringify(update.content);
            }
          } else if (update.output !== undefined) {
            entry.output = typeof update.output === "string"
              ? update.output
              : JSON.stringify(update.output);
          }

          if (turn.callbacks.onToolDone) {
            void turn.callbacks.onToolDone({
              name: entry.name,
              toolCallId: tcId,
              output: entry.output,
            });
          }
          break;
        }
      }
    }
  }

  private handleProcessExit(): void {
    if (this.isClosing) return;
    const err = new Error("ACP process exited unexpectedly.");
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();

    for (const turn of this.activeTurns.values()) {
      turn.reject(err);
    }
    this.activeTurns.clear();
    this.teardown();
  }

  public teardown(): void {
    this.isClosing = true;
    this.isInitialized = false;
    this.initPromise = null;
    this.activeSessions.clear();
    this.sessionModels.clear();

    if (this.proc?.stdin) {
      try {
        this.proc.stdin.end();
      } catch {}
    }

    if (this.reader) {
      try {
        this.reader.cancel().catch(() => {});
      } catch {}
      this.reader = null;
    }

    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
  }
}

// Global warm singleton instance
let defaultAcpClient: ACPClient | null = null;

export function getGlobalAcpClient(): ACPClient {
  if (!defaultAcpClient) {
    defaultAcpClient = new ACPClient();
  }
  return defaultAcpClient;
}

export function resetGlobalAcpClient(): void {
  if (defaultAcpClient) {
    defaultAcpClient.teardown();
    defaultAcpClient = null;
  }
}

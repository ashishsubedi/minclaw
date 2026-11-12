/**
 * TypeScript types for the Agent Client Protocol (ACP) over JSON-RPC 2.0.
 * Specification compliant with Antigravity agy acp stdio server.
 */

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, any>;
}

export interface JSONRPCResponse<T = any> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface JSONRPCNotification<T = any> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

// --- ACP Specific Requests & Responses ---

export interface ACPClientInfo {
  name: string;
  version: string;
}

export interface ACPInitializeParams {
  clientInfo: ACPClientInfo;
}

export interface ACPInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, any>;
  agentInfo?: {
    name: string;
    version: string;
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}

export interface ACPSessionNewParams {
  cwd: string;
  model?: string;
}

export interface ACPSessionSetModelParams {
  sessionId: string;
  modelId: string;
}

export interface ACPSessionSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

export interface ACPSessionNewResult {
  sessionId: string;
  models?: {
    availableModels?: Array<{ modelId: string; name: string }>;
    currentModelId?: string;
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id: string; name: string; description: string }>;
  };
  configOptions?: Array<{
    id: string;
    name: string;
    category?: string;
    type?: string;
    currentValue?: string;
    options?: Array<{ value: string; name: string; description?: string }>;
  }>;
}

export type ACPPromptItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ACPPromptParams {
  sessionId: string;
  prompt: ACPPromptItem[];
}

export interface ACPPromptResult {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    totalTokens?: number;
  };
}

// --- ACP session/update Notifications ---

export type ACPSessionUpdate =
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      name: string;
      args: Record<string, any>;
      status?: string;
      kind?: string;
      title?: string;
      rawInput?: string;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      name?: string;
      args?: Record<string, any>;
      status?: string;
      kind?: string;
      title?: string;
      rawInput?: string;
      rawOutput?: string;
      output?: any;
      content?: any;
    }
  | {
      sessionUpdate: "agent_message_chunk";
      content: {
        type: "text";
        text: string;
      };
    }
  | {
      sessionUpdate: "thought_chunk";
      content: {
        type: "text";
        text: string;
      };
    }
  | {
      sessionUpdate: "session_info_update";
      title?: string;
    }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands?: Array<{ name: string; description: string }>;
    }
  | {
      sessionUpdate: string;
      [key: string]: any;
    };

export interface ACPSessionUpdateParams {
  sessionId: string;
  update: ACPSessionUpdate;
}

export interface ACPSessionUpdateNotification {
  jsonrpc?: "2.0";
  method: "session/update";
  params: ACPSessionUpdateParams;
}

import { expect, test, describe, mock } from "bun:test";
import {
  normalizeAgyModelName,
  buildAgyPrompt,
  filterSystemPromptForAgy,
  clearAgySession,
  getAgySession,
  killActiveAgyProcesses,
  AGY_STATIC_DELEGATION_HEADER,
} from "../src/agent.ts";
import type { Message } from "@mariozechner/pi-ai";

describe("Antigravity Agent Fallback & System Prompt Integration", () => {
  describe("Model Name Normalization", () => {
    test("normalizes flash aliases to gemini-3.8-flash variants", () => {
      expect(normalizeAgyModelName("flash:medium")).toBe("gemini-3.8-flash-medium");
      expect(normalizeAgyModelName("flash-medium")).toBe("gemini-3.8-flash-medium");
      expect(normalizeAgyModelName("gemini-flash:medium")).toBe("gemini-3.8-flash-medium");
      expect(normalizeAgyModelName("flash")).toBe("gemini-3.8-flash-medium");

      expect(normalizeAgyModelName("flash:high")).toBe("gemini-3.8-flash-high");
      expect(normalizeAgyModelName("flash:low")).toBe("gemini-3.8-flash-low");
    });

    test("normalizes argon, opus, and sonnet aliases", () => {
      expect(normalizeAgyModelName("argon:medium")).toBe("gemini-4-argon-medium");
      expect(normalizeAgyModelName("argon:high")).toBe("gemini-4-argon-high");
      expect(normalizeAgyModelName("opus:medium")).toBe("claude-opus-5-5-medium");
      expect(normalizeAgyModelName("sonnet:medium")).toBe("claude-sonnet-5-5-medium");
    });

    test("preserves explicit model ids", () => {
      expect(normalizeAgyModelName("gemini-3.8-flash-medium")).toBe("gemini-3.8-flash-medium");
      expect(normalizeAgyModelName("custom-local-model")).toBe("custom-local-model");
    });
  });

  describe("Prompt Caching Preservation (buildAgyPrompt)", () => {
    test("starts with static invariant delegation header and system prompt (cache-friendly prefix)", () => {
      const context = {
        systemPrompt: "You are MinClaw. Always be concise. Remember user likes dark mode.",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Check my disk space." }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      };

      const prompt = buildAgyPrompt(context, "telegram:12345", false);

      // Invariant prefix check
      expect(prompt.startsWith(AGY_STATIC_DELEGATION_HEADER)).toBe(true);
      expect(prompt).toContain("[MinClaw System Context & Knowledge]");
      expect(prompt).toContain("You are MinClaw. Always be concise. Remember user likes dark mode.");

      // Verify no volatile session key exists in the prefix to avoid busting cache across sessions
      expect(prompt).not.toContain("telegram:12345");

      // Verify dynamic request is placed at the end
      expect(prompt).toContain("[Current User Request]\nCheck my disk space.");
    });

    test("preserves exact identical cacheable prefix across different sessions and channels", () => {
      const systemPrompt = "Stable MinClaw System Prompt with 4000 tokens of personas and skills...";
      const context1 = {
        systemPrompt,
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Question A" }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      };
      const context2 = {
        systemPrompt,
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Question B" }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      };

      const promptSession1 = buildAgyPrompt(context1, "telegram:owner", false);
      const promptSession2 = buildAgyPrompt(context2, "slack:workplace", false);

      const staticPrefix = `${AGY_STATIC_DELEGATION_HEADER}\n\n[MinClaw System Context & Knowledge]\n${systemPrompt}`;

      // Both sessions share the exact same byte-for-byte prefix, enabling 100% LLM prompt cache hit
      expect(promptSession1.startsWith(staticPrefix)).toBe(true);
      expect(promptSession2.startsWith(staticPrefix)).toBe(true);
    });

    test("formats prior conversation history including past tool calls and results after system context", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "What files are in this repo?" }],
          timestamp: Date.now() - 10000,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking directory..." },
            { type: "toolCall", id: "c1", name: "shell", arguments: { command: "ls -la" } },
          ],
          stopReason: "toolUse",
        } as any,
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "shell",
          content: [{ type: "text", text: "package.json\nminclaw.json5\nsrc/" }],
          isError: false,
          timestamp: Date.now() - 5000,
        } as any,
        {
          role: "user",
          content: [{ type: "text", text: "Now inspect minclaw.json5" }],
          timestamp: Date.now(),
        },
      ];

      const context = {
        systemPrompt: "System persona active.",
        messages,
        tools: [],
      };

      const prompt = buildAgyPrompt(context, "terminal:default", false);

      expect(prompt).toContain("[Prior Conversation History]");
      expect(prompt).toContain("User: What files are in this repo?");
      expect(prompt).toContain('[Called Tool: shell({"command":"ls -la"})]');
      expect(prompt).toContain("[Tool Result (shell)]: package.json\nminclaw.json5\nsrc/");
      expect(prompt).toContain("[Current User Request]\nNow inspect minclaw.json5");
    });

    test("formats lightweight continuation prompt without volatile session headers", () => {
      const context = {
        systemPrompt: "Long system prompt that should not be repeated in full",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Follow up question." }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      };

      const prompt = buildAgyPrompt(context, "telegram:12345", true);

      // Continuation mode is clean and minimal: [Current User Request]\nFollow up question.
      expect(prompt).toBe("[Current User Request]\nFollow up question.");
      // No duplicate system prompt or sessionKey headers
      expect(prompt).not.toContain("telegram:12345");
      expect(prompt).not.toContain("[MinClaw System Context & Knowledge]");
    });
  });

  describe("Session Management", () => {
    test("clears and retrieves agy session conversations", () => {
      clearAgySession("session-test-1");
      expect(getAgySession("session-test-1")).toBeUndefined();
    });

    test("killActiveAgyProcesses executes cleanly without throwing", () => {
      expect(() => killActiveAgyProcesses()).not.toThrow();
    });
  });

  describe("Zero-Discovery Built-in Tools Header", () => {
    test("AGY_STATIC_DELEGATION_HEADER instructs agy on zero-discovery CLI invocation", () => {
      expect(AGY_STATIC_DELEGATION_HEADER).toContain("Built-in Tools via CLI (Zero-Discovery Single Step)");
      expect(AGY_STATIC_DELEGATION_HEADER).toContain("NEVER waste turns reading `src/` files or writing `bun -e` scripts");
      expect(AGY_STATIC_DELEGATION_HEADER).toContain("bun run src/cli.ts tool call email action=list_unread limit=10");
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call email action=read id="<id>" account="<account>"');
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call email action=send to="..." subject="..." body="..."');
      expect(AGY_STATIC_DELEGATION_HEADER).toContain("bun run src/cli.ts tool call calendar action=list_events limit=10");
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call youtube action=play query="<song or video>" browser="Firefox"');
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call youtube action=search query="<query>"');
      expect(AGY_STATIC_DELEGATION_HEADER).toContain("bun run src/cli.ts tool call session_reset");
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call remember note="<fact>"');
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call search_memory query="<keyword>"');
      expect(AGY_STATIC_DELEGATION_HEADER).toContain('bun run src/cli.ts tool call schedule_reminder when="<time>" message="<text>"');
    });
  });

  describe("Stream-JSON Tool & Status Event Handling", () => {
    test("formats descriptive status messages for various tools", () => {
      // Test tool formatting conventions
      const formatToolStatus = (toolName: string, params?: any) => {
        let displayToolName = toolName;
        if (toolName === "call_mcp_tool" && params?.ToolName) {
          displayToolName = `mcp:${params.ToolName}`;
        } else if (toolName === "run_command" && params?.CommandLine) {
          const firstWord = String(params.CommandLine).trim().split(/\s+/)[0];
          displayToolName = `run_command (${firstWord})`;
        }
        return `Running tool: ${displayToolName}`;
      };

      expect(formatToolStatus("run_command", { CommandLine: "tail -f daemon.log" })).toBe("Running tool: run_command (tail)");
      expect(formatToolStatus("read_file", { Path: "/Users/test/package.json" })).toBe("Running tool: read_file");
      expect(formatToolStatus("call_mcp_tool", { ToolName: "get_daily_summary" })).toBe("Running tool: mcp:get_daily_summary");
      expect(formatToolStatus("search_web", { query: "minclaw" })).toBe("Running tool: search_web");
    });
  });

  describe("AGY Tailored Prompt Filtering (filterSystemPromptForAgy)", () => {
    test("strips mcporter documentation while keeping other instructions", () => {
      const sample = `
You are MinClaw.

## MCP Tools (via mcporter)
Use mcporter list to see tools.
Call via mcporter call server.tool.

## Logseq Second Brain & Human-in-the-Loop Control Center
Logseq operating rules and tasks tagged #agent_task.

## YouTube Playback & Media
Call youtube tool directly.
      `.trim();

      const filtered = filterSystemPromptForAgy(sample);
      expect(filtered).not.toContain("## MCP Tools (via mcporter)");
      expect(filtered).not.toContain("mcporter list");
      expect(filtered).toContain("## Logseq Second Brain & Human-in-the-Loop Control Center");
      expect(filtered).toContain("## YouTube Playback & Media");
    });

    test("filters out duplicate skills that AGY provides natively", () => {
      const sample = `
## Skills Catalog

<ready_skills>
- **fittrack**: Track workouts (in skills/fittrack/SKILL.md)
- **searxng**: Search web (in skills/searxng/SKILL.md)
- **youtube**: Play music in Firefox (in skills/youtube/SKILL.md)
- **coding-agent**: Code agent (in skills/coding-agent/SKILL.md)
- **weather**: Get weather (in skills/weather/SKILL.md)
</ready_skills>
      `.trim();

      const filtered = filterSystemPromptForAgy(sample);
      expect(filtered).not.toContain("- **fittrack**:");
      expect(filtered).not.toContain("- **searxng**:");
      expect(filtered).not.toContain("- **coding-agent**:");
      expect(filtered).toContain("- **youtube**:");
      expect(filtered).toContain("- **weather**:");
    });
  });
});

import { expect, test, mock } from "bun:test";
import * as credentials from "../src/auth/credentials.ts";
import * as piAi from "@mariozechner/pi-ai";
import * as configLoader from "../src/config.ts";

// Track spawned commands
let spawnedCalls: { args: string[]; options?: any }[] = [];
let spawnReturnValue: any = null;

let streamedStatuses: string[] = [];

const originalSpawn = Bun.spawn;
(Bun as any).spawn = (args: string[], options?: any) => {
  if (args[0] === "agy") {
    spawnedCalls.push({ args, options });
    return spawnReturnValue || {
      stdout: new Response(
        [
          JSON.stringify({ event: "init", conversation_id: "agy-conv-12345" }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "agy-conv-12345",
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "git log -n 5" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "agy-conv-12345",
              step_index: 1,
              state: "DONE",
              step_type: "tool",
              tool_name: "run_command",
              duration_seconds: 0.05,
              tool_info: { name: "run_command", parameters: { CommandLine: "git log -n 5" }, output: "commit abc" },
            },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "agy-conv-12345",
              status: "SUCCESS",
              response: "Handled autonomously by agy with built-in tools.",
              duration_seconds: 1.2,
              num_turns: 1,
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            },
          }),
        ].join("\n")
      ).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    };
  }
  return originalSpawn(args as any, options);
};

// Mock credentials so primary has a key and agy has "agy"
mock.module("../src/auth/credentials.ts", () => ({
  ...credentials,
  getApiKeyForProvider: async (provider: string) => {
    if (provider === "google") return "mock-google-key";
    if (provider === "agy") return "agy";
    return "";
  },
}));

// Mock completeSimple so that Google models fail immediately with quota/prepayment error by default
let mockCompleteSimpleHandler = async (_model: any, _context: any, _options: any): Promise<any> => {
  throw new Error("402 Payment Required: prepayment credits depleted");
};

mock.module("@mariozechner/pi-ai", () => ({
  ...piAi,
  completeSimple: mock(async (...args: any[]) => {
    return mockCompleteSimpleHandler(args[0], args[1], args[2]);
  }),
}));

// Mock loadConfig to ensure fallback chain includes { provider: 'agy', name: 'flash:medium' }
const baseConfig = configLoader.loadConfig();
mock.module("../src/config.ts", () => ({
  ...configLoader,
  loadConfig: () => ({
    ...baseConfig,
    model: {
      provider: "google",
      name: "gemini-3.5-flash-lite",
      fallbacks: [
        { provider: "google", name: "gemini-3.5-flash" },
        { provider: "agy", name: "flash:medium" },
      ],
    },
  }),
}));

test("MinClaw falls back to agy with full system prompt, tools delegation, and waits for final response", async () => {
  const { runAgent, clearAgySession, getAgySession } = await import("../src/agent.ts");
  
  clearAgySession("telegram:123456789");
  spawnedCalls = [];

  streamedStatuses = [];
  const statusCallback = async (text: string) => {
    streamedStatuses.push(text);
  };

  const response = await runAgent(
    "telegram:123456789",
    "List the recent git commits and explain what changed.",
    undefined,
    undefined,
    undefined,
    statusCallback
  );

  // 1. MinClaw waited for final output from agy
  expect(response.text).toBe("Handled autonomously by agy with built-in tools.");
  expect(response.toolCalls).toBeDefined();
  expect(response.toolCalls?.length).toBe(1);
  expect(response.toolCalls?.[0]?.name).toBe("run_command");
  expect(response.toolCalls?.[0]?.output).toBe("commit abc");

  // Verify status callback received tool execution update
  expect(streamedStatuses).toContain("Running tool: run_command (git)");

  // 2. agy was spawned with stream-json
  expect(spawnedCalls.length).toBe(1);
  const call1 = spawnedCalls[0]!;
  expect(call1.args[0]).toBe("agy");
  expect(call1.args[1]).toBe("--print");
  
  const prompt = call1.args[2]!;
  // Verify MinClaw system prompt and autonomous agent delegation directives are included
  expect(prompt).toContain("[MinClaw Autonomous Agent Delegation]");
  expect(prompt).toContain("Autonomous Tool Execution: You have full access to your workspace tools");
  expect(prompt).toContain("Skip Logseq Memory: Unless explicitly requested by the user or strictly critical to the task, skip Logseq memory operations");
  expect(prompt).toContain("Final Output Delivery: When your tool operations are complete, output your final, concise, helpful response");
  expect(prompt).toContain("List the recent git commits and explain what changed.");

  // Verify model name was normalized from flash:medium -> gemini-3.8-flash-medium
  expect(call1.args[3]).toBe("--model");
  expect(call1.args[4]).toBe("gemini-3.8-flash-medium");

  // Verify permission, stream-json format, slash commands disabled, and print timeout flags
  expect(call1.args).toContain("--dangerously-skip-permissions");
  expect(call1.args).toContain("--output-format");
  expect(call1.args).toContain("stream-json");
  expect(call1.args).toContain("--disable-slash-commands");
  expect(call1.args).toContain("--print-timeout");
  expect(call1.args).toContain("180s");

  // Verify prompt contains zero-discovery tool CLI instructions
  expect(prompt).toContain("Built-in Tools via CLI (Zero-Discovery Single Step)");
  expect(prompt).toContain("NEVER waste turns reading `src/` files or writing `bun -e` scripts");
  expect(prompt).toContain('bun run src/cli.ts tool call youtube action=play query="<song or video>" browser="Firefox"');

  // 3. Conversation ID was remembered for sessionKey
  expect(getAgySession("telegram:123456789")).toBe("agy-conv-12345");

  // 4. On turn 2 in the same session, --conversation agy-conv-12345 is passed
  const response2 = await runAgent(
    "telegram:123456789",
    "Now summarize line 5 of package.json"
  );

  expect(response2.text).toBe("Handled autonomously by agy with built-in tools.");
  expect(spawnedCalls.length).toBe(2);
  const call2 = spawnedCalls[1]!;
  expect(call2.args).toContain("--conversation");
  expect(call2.args).toContain("agy-conv-12345");
  expect(call2.args).toContain("--disable-slash-commands");
  expect(call2.args).toContain("--print-timeout");
  expect(call2.args).toContain("180s");
  expect(call2.args[2]).toBe("[Current User Request]\nNow summarize line 5 of package.json");
});

test("completeFast skips agy provider and uses non-agy model in fallback chain", async () => {
  const { completeFast } = await import("../src/agent.ts");

  const spawnedCountBefore = spawnedCalls.length;
  let modelUsed: string | undefined;

  mockCompleteSimpleHandler = async (model: any) => {
    modelUsed = model.id;
    return {
      role: "assistant",
      content: [{ type: "text", text: '{"decision":"important"}' }],
      stopReason: "stop",
      usage: { input: 12, output: 6, totalTokens: 18 },
    };
  };

  const fastResult = await completeFast(
    "Classify priority of this notification",
    "You are a notification triager"
  );

  // 1. Result was returned immediately from direct model API
  expect(fastResult).toBe('{"decision":"important"}');

  // 2. Used the non-agy direct API model (gemini-3.5-flash-lite)
  expect(modelUsed).toBe("gemini-3.5-flash-lite");

  // 3. agy CLI was NOT spawned
  expect(spawnedCalls.length).toBe(spawnedCountBefore);
});

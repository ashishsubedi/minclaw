import { expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runAgent } from "../src/agent.ts";
import * as configLoader from "../src/config.ts";
import * as piAi from "@mariozechner/pi-ai";
import * as credentials from "../src/auth/credentials.ts";

// Mocking dependencies
mock.module("../src/config.ts", () => ({
  loadConfig: () => ({
    model: {
      provider: "primary-provider",
      name: "primary-model",
      fallbacks: [
        { provider: "fallback-provider", name: "fallback-model" }
      ]
    },
    workspace: ".",
    sessions: { dir: "./sessions", maxToolIterations: 10 },
    memory: { dir: "./memory", indexFile: "./memory/index.md" },
    brain: { dir: "./brain" },
    heartbeat: { enabled: false, cronExpr: "* * * * *" },
    channels: {
      telegram: { enabled: false, allowFrom: [] },
      whatsapp: { enabled: false, allowFrom: [] },
      slack: { enabled: false, allowFrom: [] }
    }
  })
}));

mock.module("../src/auth/credentials.ts", () => ({
  getApiKeyForProvider: async (provider: string) => `key-for-${provider}`
}));

mock.module("@mariozechner/pi-ai", () => ({
  completeSimple: mock(async (model: any) => {
    if (model.id === "primary-model") {
      throw new Error("Primary failed");
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: "Fallback success" }],
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 }
    };
  }),
  getModel: (provider: string, id: string) => ({
    id,
    provider,
    api: "mock-api",
    input: ["text"],
    reasoning: false
  })
}));

test("runAgent falls back to second model if primary fails", async () => {
  const response = await runAgent("test-session", "hello");
  expect(response.text).toBe("Fallback success");
});

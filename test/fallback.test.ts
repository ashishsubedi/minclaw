import { expect, test, mock, afterAll } from "bun:test";
import { runAgent } from "../src/agent.ts";
import * as configLoader from "../src/config.ts";
import * as piAi from "@mariozechner/pi-ai";
import * as credentials from "../src/auth/credentials.ts";

const originalGetApiKey = credentials.getApiKeyForProvider;

mock.module("../src/auth/credentials.ts", () => ({
  ...credentials,
  getApiKeyForProvider: async (provider: string) => {
    if (provider.startsWith("primary") || provider.startsWith("fallback")) {
      return `key-for-${provider}`;
    }
    return originalGetApiKey(provider);
  },
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
  mock.restore();
});

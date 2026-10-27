import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  WATERMARK_HIGH_TOKENS,
  WATERMARK_HIGH_TURNS,
  WATERMARK_KEEP_RECENT_TURNS,
  WATERMARK_CEILING_TOKENS,
  maybeAutoCompactSession,
  isWatermarkBreached,
  getCompactedState,
} from "../src/memory/compaction.ts";
import { appendMessage, clearSession, getSessionDir, getMessages } from "../src/session.ts";
import {
  budgetToolOutput,
  isTransientAgyError,
  clearAgySession,
  getAgySession,
  callModelWithFallback,
  buildAgyPrompt,
  AGY_MAX_OBSERVATION_CHARS,
} from "../src/agent.ts";
import type { ResolvedModel } from "../src/agent.ts";

const TEST_SESSION = "test:watermark_eval";

describe("Token & Turn Watermark Windowing and Agys Stability", () => {
  beforeEach(() => {
    clearSession(TEST_SESSION);
    clearAgySession(TEST_SESSION);
  });

  afterEach(() => {
    clearSession(TEST_SESSION);
    clearAgySession(TEST_SESSION);
  });

  it("1. exports correct watermark constants according to empirical research", () => {
    expect(WATERMARK_HIGH_TOKENS).toBe(32000);
    expect(WATERMARK_HIGH_TURNS).toBe(20);
    expect(WATERMARK_KEEP_RECENT_TURNS).toBe(4);
    expect(WATERMARK_CEILING_TOKENS).toBe(48000);
    expect(AGY_MAX_OBSERVATION_CHARS).toBe(4000);
  });

  it("2. truncates oversized tool outputs to preserve observation budget", () => {
    const smallOutput = "Status OK: 3 unread emails found.";
    expect(budgetToolOutput(smallOutput)).toBe(smallOutput);

    const hugeOutput = "A".repeat(10000);
    const budgeted = budgetToolOutput(hugeOutput, 4000);
    expect(budgeted.length).toBeLessThan(10000);
    expect(budgeted.startsWith("A".repeat(4000))).toBe(true);
    expect(budgeted).toContain("[...truncated 6000 chars for context window budget...]");
  });

  it("3. correctly detects transient agy network errors for auto-retry", () => {
    expect(isTransientAgyError(new Error("read: connection reset by peer"))).toBe(true);
    expect(isTransientAgyError(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(isTransientAgyError(new Error("socket hang up"))).toBe(true);
    expect(isTransientAgyError(new Error("write: broken pipe"))).toBe(true);
    expect(isTransientAgyError(new Error("network error: ETIMEDOUT"))).toBe(true);

    // Non-transient errors should NOT trigger retry
    expect(isTransientAgyError(new Error("Invalid API key"))).toBe(false);
    expect(isTransientAgyError(new Error("Model not found: gemini-invalid"))).toBe(false);
    expect(isTransientAgyError(null)).toBe(false);
  });

  it("4. triggers auto-compaction and evicts agySession when token watermark (>= 32,000) is breached", async () => {
    // Populate session with 6 turns (12 messages) — below turn threshold (20)
    for (let i = 1; i <= 6; i++) {
      appendMessage(TEST_SESSION, {
        role: "user",
        content: `User query ${i} about system performance`,
        timestamp: Date.now() + i * 100,
      });
      appendMessage(TEST_SESSION, {
        role: "assistant",
        content: `Assistant response ${i} with diagnostic data`,
        timestamp: Date.now() + i * 100 + 50,
      });
    }

    // Pretend agy has an active session ID
    const { _setAgySessionForTest } = await import("../src/agent.ts") as any;
    if (typeof _setAgySessionForTest === "function") {
      _setAgySessionForTest(TEST_SESSION, "agy-conv-12345");
    }

    // 15,000 tokens should NOT breach watermark
    expect(isWatermarkBreached(TEST_SESSION, 15000)).toBe(false);
    let compacted = await maybeAutoCompactSession(TEST_SESSION, {
      lastInputTokens: 15000,
      summarizer: async () => "### Active Context & Goals\nSummary",
    });
    expect(compacted).toBe(false);

    // 32,500 tokens DOES breach high watermark
    expect(isWatermarkBreached(TEST_SESSION, 32500)).toBe(true);

    compacted = await maybeAutoCompactSession(TEST_SESSION, {
      lastInputTokens: 32500,
      summarizer: async (prompt) => {
        expect(prompt).toContain("User query 1");
        return [
          "### Active Context & Goals\nSystem diagnostic in progress.",
          "### Key References & Entities\nNone",
          "### Decisions & Constraints\nNone",
          "### Open Threads\nNone",
          "### Next Steps\nContinue monitoring.",
        ].join("\n");
      },
    });

    expect(compacted).toBe(true);

    // State must be saved
    const state = getCompactedState(TEST_SESSION);
    expect(state).not.toBeNull();
    expect(state?.summary).toContain("System diagnostic in progress.");

    // agySession must be cleared so the next turn starts with a fresh conversation ID!
    expect(getAgySession(TEST_SESSION)).toBeUndefined();
  });

  it("5. triggers auto-compaction when turn watermark (>= 20 turns / 40 messages) is breached", async () => {
    // Populate session with 21 turns (42 messages)
    for (let i = 1; i <= 21; i++) {
      appendMessage(TEST_SESSION, {
        role: "user",
        content: `Turn ${i} request`,
        timestamp: Date.now() + i * 100,
      });
      appendMessage(TEST_SESSION, {
        role: "assistant",
        content: `Turn ${i} response`,
        timestamp: Date.now() + i * 100 + 50,
      });
    }

    expect(isWatermarkBreached(TEST_SESSION)).toBe(true);

    const compacted = await maybeAutoCompactSession(TEST_SESSION, {
      lastInputTokens: 2500, // Low tokens, but turns threshold breached
      summarizer: async () => "### Active Context & Goals\nTurn watermark reached.",
    });

    expect(compacted).toBe(true);
    const state = getCompactedState(TEST_SESSION);
    expect(state?.summary).toContain("Turn watermark reached.");

    // Verifies Low-Water Mark: getMessages() returns only keepRecentTurns * 2
    const remainingMessages = getMessages(TEST_SESSION);
    expect(remainingMessages.length).toBeLessThanOrEqual(16);
    expect(remainingMessages.length).toBeGreaterThan(0);
  });

  it("6. verifies low-water mark prompt reconstruction after compaction", async () => {
    // Populate session with 10 turns
    for (let i = 1; i <= 10; i++) {
      appendMessage(TEST_SESSION, {
        role: "user",
        content: `Task step ${i}: Inspect module ${i}`,
        timestamp: Date.now() + i * 100,
      });
      appendMessage(TEST_SESSION, {
        role: "assistant",
        content: `Result of step ${i}: Module ${i} operational`,
        timestamp: Date.now() + i * 100 + 50,
      });
    }

    // Force compaction
    await maybeAutoCompactSession(TEST_SESSION, {
      lastInputTokens: 35000,
      summarizer: async () => "### Active Context & Goals\nModules 1-6 inspected successfully.",
    });

    // After compaction, agySession was evicted, so isContinuation is false
    expect(getAgySession(TEST_SESSION)).toBeUndefined();

    // buildAgyPrompt builds fresh prompt with system context and recent messages
    const recentMessages = getMessages(TEST_SESSION);
    const prompt = buildAgyPrompt(
      {
        systemPrompt: "MinClaw System Persona\n## Current Session Summary (Compacted History)\nModules 1-6 inspected successfully.",
        messages: recentMessages as any,
      },
      TEST_SESSION,
      false // fresh conversation
    );

    // Prompt contains the rolling summary
    expect(prompt).toContain("Modules 1-6 inspected successfully.");
    // Prompt contains recent messages
    expect(prompt).toContain("Task step 10");
    // Earlier compacted messages (step 1) are NOT in the verbatim prompt turns!
    expect(prompt).not.toContain("Task step 1:");
  });

  it("7. auto-retries transient agy connection reset before failing over", async () => {
    let callCount = 0;
    const originalSpawn = Bun.spawn;

    (Bun as any).spawn = (args: string[], opts: any) => {
      callCount++;
      if (args[0] === "agy") {
        if (callCount === 1) {
          // Simulate transient TCP socket reset on first attempt
          return {
            stdout: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            stderr: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("read: connection reset by peer\n"));
                controller.close();
              },
            }),
            exited: Promise.resolve(1),
            kill: () => {},
          };
        } else {
          // Attempt 2 succeeds
          return {
            stdout: new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      event: "result",
                      result: {
                        response: "Recovered from transient reset successfully",
                        conversation_id: "conv-retry-ok",
                        usage: { input_tokens: 3500, output_tokens: 50 },
                      },
                    }) + "\n"
                  )
                );
                controller.close();
              },
            }),
            stderr: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            exited: Promise.resolve(0),
            kill: () => {},
          };
        }
      }
      return originalSpawn(args, opts);
    };

    try {
      const resolvedModels: ResolvedModel[] = [
        {
          provider: "agy",
          apiKey: "agy",
          model: { id: "gemini-3.8-flash-medium", name: "Gemini Flash Medium", api: "agy" } as any,
        },
      ];

      const res = await callModelWithFallback(
        resolvedModels,
        { systemPrompt: "Test", messages: [{ role: "user", content: "Hello", timestamp: Date.now() }], tools: [] },
        {},
        TEST_SESSION
      );

      // Successfully recovered on attempt 2!
      expect(callCount).toBe(2);
      expect(res.response.content[0]).toEqual({ type: "text", text: "Recovered from transient reset successfully" });
      expect(getAgySession(TEST_SESSION)).toBe("conv-retry-ok");
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });
});

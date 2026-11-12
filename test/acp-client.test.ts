import { describe, it, expect, afterEach } from "bun:test";
import { ACPClient } from "../src/acp/client.ts";

describe("ACPClient", () => {
  let client: ACPClient | null = null;

  afterEach(() => {
    if (client) {
      client.teardown();
      client = null;
    }
  });

  it("spawns agy acp and completes initialize handshake", async () => {
    client = new ACPClient();
    const initRes = await client.ensureRunning();
    expect(initRes).toBeDefined();
    expect(initRes.protocolVersion).toBeGreaterThanOrEqual(1);
    expect(initRes.agentInfo?.name).toContain("Antigravity ACP");
  }, 15000);

  it("creates and caches session for a sessionKey and configures model", async () => {
    client = new ACPClient();
    const sessionId1 = await client.getOrCreateSession("test-key-1", "gemini-3.8-flash-medium");
    expect(typeof sessionId1).toBe("string");
    expect(sessionId1.length).toBeGreaterThan(10);

    // Second call returns cached sessionId and applies new model if changed
    const sessionId2 = await client.getOrCreateSession("test-key-1", "gemini-3.8-flash-high");
    expect(sessionId2).toBe(sessionId1);
  }, 15000);

  it("executes turn with streaming text and tool event callbacks", async () => {
    client = new ACPClient();
    const sessionId = await client.getOrCreateSession("test-key-streaming");

    const chunks: string[] = [];
    const tools: string[] = [];

    const result = await client.runPrompt(
      sessionId,
      "Say 'hello acp' and nothing else.",
      {
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
        onToolCall: (call) => {
          tools.push(call.name);
        },
      }
    );

    expect(result.text.toLowerCase()).toContain("hello");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe(result.text);
  }, 20000);

  it("steers an in-flight prompt mid-turn via ACP", async () => {
    client = new ACPClient();
    const sessionId = await client.getOrCreateSession("test-key-steer");

    let steerSent = false;
    const promptPromise = client.runPrompt(
      sessionId,
      'Run bash -c "for i in {1..3}; do echo step $i; sleep 1; done" and then print all numbers.',
      {
        onToolCall: async () => {
          if (!steerSent) {
            steerSent = true;
            // Send steer while tool is running!
            await client!.steer(sessionId, 'STOP immediately! Checkpoint reached. Say "STEERED_SUCCESS".');
          }
        },
      }
    );

    const result = await promptPromise;
    expect(result.text).toContain("STEERED_SUCCESS");
  }, 60000);
});

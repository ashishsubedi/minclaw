import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  appendMessage,
  getMessages,
  getAllMessages,
  clearSession,
  getSessionDir,
  sessionKeyFromMessage,
  type SessionMessage,
} from "../src/session.ts";
import {
  compactSession,
  maybeAutoCompactSession,
  getCompactedState,
  saveCompactedState,
  clearCompactedState,
  getCompactedFilePath,
  type CompactedSessionState,
} from "../src/memory/compaction.ts";
import { executeTool } from "../src/tools.ts";
import { rebuildMemoryIndex, appendChat } from "../src/memory/store.ts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const MOCK_SUMMARY = `### Active Context & Goals
The user is building the MinClaw session compaction feature.

### Key References & Entities
- File: \`/workspace/minclaw/src/memory/compaction.ts\`
- Server ID: srv-9921
- Email: dev@example.com
- Tool: shell(ls) -> file1.txt file2.txt

### Decisions & Constraints
- Keep recent 8 turns verbatim by default.
- Compaction must never throw unhandled rejections.

### Open Threads
- Testing auto-compaction trigger thresholds.

### Next Steps
- Verify bun test and lint passes.`;

describe("Session Compaction & Context Preservation", () => {
  const testKey = "test:user_compaction_unit";
  const channel = "test";
  const sender = "user_compaction_unit";

  beforeEach(() => {
    clearSession(testKey);
  });

  afterEach(() => {
    clearSession(testKey);
  });

  it("1. saves and loads SessionMessage with toolCalls digests", () => {
    const userMsg: SessionMessage = {
      role: "user",
      content: "Can you list the directory contents?",
      timestamp: Date.now(),
      channel,
      sender,
    };

    const assistantMsg: SessionMessage = {
      role: "assistant",
      content: "Here are the files in your directory.",
      timestamp: Date.now() + 100,
      toolCalls: [
        {
          name: "shell",
          input: { command: "ls -la" },
          output: "total 48\n-rw-r--r-- 1 user staff 1024 package.json",
        },
      ],
    };

    appendMessage(testKey, userMsg);
    appendMessage(testKey, assistantMsg);

    const loaded = getAllMessages(testKey);
    expect(loaded.length).toBe(2);
    expect(loaded[0]!.content).toBe("Can you list the directory contents?");
    expect(loaded[1]!.toolCalls).toBeDefined();
    expect(loaded[1]!.toolCalls?.length).toBe(1);
    expect(loaded[1]!.toolCalls?.[0]?.name).toBe("shell");
    expect(loaded[1]!.toolCalls?.[0]?.output).toContain("total 48");
  });

  it("2. creates compacted state, passes 5 required sections to summarizer, keeps keepRecentTurns verbatim, and slices getMessages()", async () => {
    // Populate 24 messages (12 turns)
    for (let i = 1; i <= 12; i++) {
      appendMessage(testKey, {
        role: "user",
        content: `User query ${i} referencing id_${i * 100}`,
        timestamp: 1000 + i * 10,
      });
      appendMessage(testKey, {
        role: "assistant",
        content: `Assistant reply ${i}`,
        timestamp: 1000 + i * 10 + 1,
        toolCalls: i === 1 ? [{ name: "shell", input: "pwd", output: "/workspace/minclaw" }] : undefined,
      });
    }

    expect(getAllMessages(testKey).length).toBe(24);

    let capturedPrompt = "";
    let capturedSystemPrompt = "";

    const customSummarizer = async (prompt: string, systemPrompt: string) => {
      capturedPrompt = prompt;
      capturedSystemPrompt = systemPrompt;
      return MOCK_SUMMARY;
    };

    // Compact with default keepRecentTurns = 8 (16 messages kept verbatim, 24 - 16 = 8 compacted)
    const result = await compactSession(testKey, { summarizer: customSummarizer });
    expect(result.compacted).toBe(true);
    expect(result.messagesCompacted).toBe(8);

    // Verify prompt instructions require the 5 exact sections
    expect(capturedPrompt).toContain("### Active Context & Goals");
    expect(capturedPrompt).toContain("### Key References & Entities");
    expect(capturedPrompt).toContain("### Decisions & Constraints");
    expect(capturedPrompt).toContain("### Open Threads");
    expect(capturedPrompt).toContain("### Next Steps");
    expect(capturedPrompt).toContain("[Tools used: shell(pwd) -> /workspace/minclaw]");
    expect(capturedSystemPrompt).toContain("session compaction engine");

    // Check saved state
    const state = getCompactedState(testKey);
    expect(state).not.toBeNull();
    expect(state?.compactedCount).toBe(8);
    expect(state?.summary).toBe(MOCK_SUMMARY);

    // getAllMessages() should still return all 24 messages
    expect(getAllMessages(testKey).length).toBe(24);

    // getMessages() should return only the 16 uncompacted messages (messages 8..23)
    const activeMessages = getMessages(testKey);
    expect(activeMessages.length).toBe(16);
    expect(activeMessages[0]!.content).toBe("User query 5 referencing id_500");
  });

  it("3. supports incremental compaction, merging previous summary with newly evicted turns", async () => {
    // Start with 20 messages (10 turns)
    for (let i = 1; i <= 10; i++) {
      appendMessage(testKey, {
        role: "user",
        content: `Initial message ${i}`,
        timestamp: 1000 + i * 10,
      });
      appendMessage(testKey, {
        role: "assistant",
        content: `Initial response ${i}`,
        timestamp: 1000 + i * 10 + 1,
      });
    }

    // First compaction keeping 8 turns (16 messages) -> compacts 4 messages
    await compactSession(testKey, {
      summarizer: async () => MOCK_SUMMARY,
    });

    const state1 = getCompactedState(testKey);
    expect(state1?.compactedCount).toBe(4);

    // Append 10 more messages (total 30 messages)
    for (let i = 11; i <= 15; i++) {
      appendMessage(testKey, {
        role: "user",
        content: `Follow-up message ${i}`,
        timestamp: 2000 + i * 10,
      });
      appendMessage(testKey, {
        role: "assistant",
        content: `Follow-up response ${i}`,
        timestamp: 2000 + i * 10 + 1,
      });
    }

    expect(getAllMessages(testKey).length).toBe(30);

    let secondPrompt = "";
    const updatedSummary = MOCK_SUMMARY + "\n\nAdditional notes incorporated.";

    const result2 = await compactSession(testKey, {
      focus: "focus on follow-up tasks",
      summarizer: async (prompt) => {
        secondPrompt = prompt;
        return updatedSummary;
      },
    });

    expect(result2.compacted).toBe(true);
    // Total 30 messages, keep 16 => endIdx is 14. startIdx was 4. 14 - 4 = 10 messages compacted!
    expect(result2.messagesCompacted).toBe(10);
    expect(secondPrompt).toContain("Existing Summary:");
    expect(secondPrompt).toContain("Focus Instructions:\nfocus on follow-up tasks");

    const state2 = getCompactedState(testKey);
    expect(state2?.compactedCount).toBe(14);
    expect(state2?.summary).toBe(updatedSummary);
    expect(getMessages(testKey).length).toBe(16);
  });

  it("4. triggers maybeAutoCompactSession() only when uncompacted turns reach compactAfterTurns * 2", async () => {
    const autoKey = "test:auto_compact_test";
    clearSession(autoKey);

    try {
      let summarizerCalled = false;
      const mockSummarizer = async () => {
        summarizerCalled = true;
        return MOCK_SUMMARY;
      };

      // Add 30 messages (15 turns). Since default compactAfterTurns is 16 (32 messages), should NOT trigger.
      for (let i = 1; i <= 15; i++) {
        appendMessage(autoKey, { role: "user", content: `Q${i}`, timestamp: i });
        appendMessage(autoKey, { role: "assistant", content: `A${i}`, timestamp: i });
      }

      const didCompact1 = await maybeAutoCompactSession(autoKey, mockSummarizer);
      expect(didCompact1).toBe(false);
      expect(summarizerCalled).toBe(false);
      expect(getCompactedState(autoKey)).toBeNull();

      // Add 2 more messages to reach 32 (16 turns = threshold)
      appendMessage(autoKey, { role: "user", content: "Q16", timestamp: 100 });
      appendMessage(autoKey, { role: "assistant", content: "A16", timestamp: 101 });

      const didCompact2 = await maybeAutoCompactSession(autoKey, mockSummarizer);
      expect(didCompact2).toBe(true);
      expect(summarizerCalled).toBe(true);

      const state = getCompactedState(autoKey);
      expect(state).not.toBeNull();
      // 32 total messages, keeps 8 turns (16 messages) => 16 compacted!
      expect(state?.compactedCount).toBe(16);
    } finally {
      clearSession(autoKey);
    }
  });

  it("5. executes compact_session tool end-to-end", async () => {
    // Populate session with 10 messages
    for (let i = 1; i <= 5; i++) {
      appendMessage(testKey, { role: "user", content: `Question ${i}`, timestamp: i });
      appendMessage(testKey, { role: "assistant", content: `Answer ${i}`, timestamp: i });
    }

    // Save a pre-existing compacted state or mock executeTool call
    // Note: executeTool calls compactSession which defaults to completeFast if no summarizer provided,
    // so we can test saveCompactedState and executeCompactSession behavior
    const mockState: CompactedSessionState = {
      sessionKey: testKey,
      compactedCount: 6,
      updatedAt: Date.now(),
      summary: MOCK_SUMMARY,
    };
    saveCompactedState(mockState);

    // Call tool without context -> error
    const errRes = await executeTool("compact_session", {});
    expect(errRes.isError).toBe(true);
    expect(errRes.content[0]!.text).toContain("requires channel and sender");

    // Call tool with context on already compact session
    const res = await executeTool("compact_session", { focus: "api keys" }, { channel, sender });
    expect(res.isError).toBe(false);
    expect(res.content[0]!.text).toContain("already compact");
    expect(res.content[0]!.text).toContain("Active Context & Goals");
  });

  it("6. removes both .jsonl and .compacted.json on clearSession()", () => {
    appendMessage(testKey, { role: "user", content: "hello", timestamp: 1 });
    saveCompactedState({
      sessionKey: testKey,
      compactedCount: 1,
      updatedAt: Date.now(),
      summary: MOCK_SUMMARY,
    });

    const jsonlPath = join(getSessionDir(), `${testKey}.jsonl`);
    const compactedPath = getCompactedFilePath(testKey);

    expect(existsSync(jsonlPath)).toBe(true);
    expect(existsSync(compactedPath)).toBe(true);

    clearSession(testKey);

    expect(existsSync(jsonlPath)).toBe(false);
    expect(existsSync(compactedPath)).toBe(false);
    expect(getCompactedState(testKey)).toBeNull();
    expect(getAllMessages(testKey).length).toBe(0);
  });

  it("7. includes Compacted Summary in rebuildMemoryIndex()", () => {
    // Add chat markdown so listSessions() picks it up
    appendChat(channel, sender, "user", "Hello memory!");
    appendChat(channel, sender, "assistant", "Hello! Here is your answer.");

    saveCompactedState({
      sessionKey: testKey,
      compactedCount: 2,
      updatedAt: Date.now(),
      summary: MOCK_SUMMARY,
    });

    const indexContent = rebuildMemoryIndex();
    expect(indexContent).toContain("#### Compacted Summary");
    expect(indexContent).toContain("The user is building the MinClaw session compaction feature.");
  });
});

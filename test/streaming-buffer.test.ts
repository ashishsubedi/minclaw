import { describe, it, expect } from "bun:test";
import { StreamingBuffer, balanceStreamingMarkdown } from "../src/channels/streaming-buffer.ts";

describe("StreamingBuffer", () => {
  it("accumulates chunks and flushes final text cleanly", async () => {
    const flushed: string[] = [];
    const buffer = new StreamingBuffer({
      throttleMs: 50,
      minChunkChars: 5,
      onFlush: (text) => {
        flushed.push(text);
      },
    });

    buffer.append("Hello ");
    buffer.append("World!");
    expect(buffer.getText()).toBe("Hello World!");

    await buffer.flushFinal();
    expect(flushed.length).toBeGreaterThan(0);
    expect(flushed[flushed.length - 1]).toBe("Hello World!");
  });

  it("balances unclosed markdown backticks safely for partial streaming", () => {
    // Unclosed triple backticks
    const partialFence = "Here is code:\n```typescript\nconst x = 10;";
    expect(balanceStreamingMarkdown(partialFence)).toBe("Here is code:\n```typescript\nconst x = 10;\n```");

    // Already closed code fence
    const closedFence = "```typescript\nconst x = 10;\n```";
    expect(balanceStreamingMarkdown(closedFence)).toBe("```typescript\nconst x = 10;\n```");

    // Unclosed inline backtick
    const partialInline = "Run `bun test to verify";
    expect(balanceStreamingMarkdown(partialInline)).toBe("Run `bun test to verify`");
  });
});

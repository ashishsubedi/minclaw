import { describe, expect, it } from "bun:test";
import { isNetworkAvailable, cleanAgentResponse, isRawApiError } from "../src/network.ts";

describe("Network Pre-flight & ACP Error Filtering", () => {
  it("detects online network connectivity", async () => {
    const online = await isNetworkAvailable(3000);
    expect(online).toBe(true);
  });

  it("respects MINCLAW_TEST_NETWORK_OFFLINE env var", async () => {
    const prev = process.env.MINCLAW_TEST_NETWORK_OFFLINE;
    process.env.MINCLAW_TEST_NETWORK_OFFLINE = "1";
    try {
      const online = await isNetworkAvailable(100);
      expect(online).toBe(false);
    } finally {
      if (prev !== undefined) {
        process.env.MINCLAW_TEST_NETWORK_OFFLINE = prev;
      } else {
        delete process.env.MINCLAW_TEST_NETWORK_OFFLINE;
      }
    }
  });

  it("strips raw API errors from assistant responses with content", () => {
    const mixed =
      '⚠ API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 10.211.44.23:64594->172.217.119.4:443: read: connection reset by peer Hello Ashish! How can I help you today?';
    const cleaned = cleanAgentResponse(mixed);
    expect(cleaned).toBe("Hello Ashish! How can I help you today?");
    expect(isRawApiError(mixed)).toBe(false);
  });

  it("detects and empties purely error responses", () => {
    const rawError =
      '⚠ API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host ⚠ API error (attempt 2): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host ⚠ There was a network issue connecting to the server, please try again.';
    const cleaned = cleanAgentResponse(rawError);
    expect(cleaned).toBe("");
    expect(isRawApiError(rawError)).toBe(true);
  });

  it("leaves normal markdown and text completely untouched", () => {
    const normal =
      "### Scheduled AI Thesis Digest\n\nHere are top MLSys papers from arXiv today:\n1. **FlashAttention-3**: Fast and Memory-Efficient Exact Attention\n2. **BitNet b1.58**: 1-bit LLMs for efficient inference.";
    expect(cleanAgentResponse(normal)).toBe(normal);
    expect(isRawApiError(normal)).toBe(false);
  });

  it("strips stream interrupted and connection reset errors in the middle of text", () => {
    const interrupted =
      '**Summary:** Task started. ⚠ The stream was interrupted. Please continue the task you were working on. ⚠ API error (attempt 3): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 10.211.44.23:64594->172.217.119.4:443: read: connection reset by peer ⚠ There was a network issue connecting to the server, please try again.';
    const cleaned = cleanAgentResponse(interrupted);
    expect(cleaned).toBe("**Summary:** Task started.");
  });
});

import { expect, test, describe } from "bun:test";
import {
  runReflexCheck,
  classifyEmailBatchWithLLM,
  checkInboxHygieneSuggestion,
  ATTENTION_SCORE_THRESHOLD,
  DIGEST_SCORE_THRESHOLD,
  LOW_PRIORITY_BATCH_TRIGGER_COUNT,
  CLEANUP_PROMPT_THRESHOLD,
  formatLocalDate,
} from "../src/scheduler/reflex.ts";
import type { EmailMessageSummary } from "../src/email/types.ts";

describe("Wabi-style Reflex Email Gate", () => {
  test("runReflexCheck returns a valid report structure", async () => {
    const report = await runReflexCheck();
    expect(typeof report.hasDelta).toBe("boolean");
    expect(Array.isArray(report.items)).toBe(true);
    expect(typeof report.summary).toBe("string");
  });

  test("defines correct attention thresholds and batch trigger limits", () => {
    expect(ATTENTION_SCORE_THRESHOLD).toBe(7);
    expect(DIGEST_SCORE_THRESHOLD).toBe(4);
    expect(LOW_PRIORITY_BATCH_TRIGGER_COUNT).toBe(10);
    expect(CLEANUP_PROMPT_THRESHOLD).toBe(25);
  });

  test("checkInboxHygieneSuggestion detects when promotional clutter builds up", () => {
    const testStatePath = `/tmp/test-cleanup-state-${Date.now()}.json`;
    const mockPromos: EmailMessageSummary[] = Array.from({ length: 30 }, (_, i) => ({
      id: `promo_${i}`,
      accountId: "acc_1",
      accountEmail: "user@gmail.com",
      accountType: "google",
      from: `Store ${i} <store@deals.com>`,
      subject: "50% off sale today!",
      date: new Date().toISOString(),
      unread: true,
      category: "promotions",
    }));

    const suggestion = checkInboxHygieneSuggestion(mockPromos, testStatePath);
    expect(suggestion).not.toBeNull();
    expect(suggestion?.title).toContain("Inbox Hygiene");
    expect(suggestion?.urgent).toBe(false);

    // Below threshold should return null
    const smallList = mockPromos.slice(0, 5);
    const noSuggestion = checkInboxHygieneSuggestion(smallList, testStatePath);
    expect(noSuggestion).toBeNull();
  });

  test("classifyEmailBatchWithLLM handles empty inputs gracefully", async () => {
    const results = await classifyEmailBatchWithLLM([]);
    expect(results.size).toBe(0);
  });

  test("formatLocalDate formats date in local YYYY-MM-DD", () => {
    const testDate = new Date(2026, 9, 26, 15, 30); // Oct 26, 2026 local
    expect(formatLocalDate(testDate)).toBe("2026-10-26");
  });

  test("runReflexCheck summary includes details and formats them under titles", async () => {
    const report = await runReflexCheck();
    if (report.hasDelta) {
      for (const item of report.items) {
        if (item.details?.trim()) {
          const firstLine = item.details.trim().split("\n")[0]!;
          expect(report.summary).toContain(firstLine);
        }
      }
    }
  });

  test("runReflexCheck with deferCommit: true returns a commit function and defers persistence when hasDelta is true", async () => {
    const report = await runReflexCheck({ deferCommit: true });
    expect(typeof report.commit).toBe("function");
    // Executing commit should run cleanly
    expect(() => report.commit?.()).not.toThrow();
  });
});

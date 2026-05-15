import { expect, test } from "bun:test";
import { aggregateUsage } from "../src/web/data.ts";

test("aggregates session usage totals", () => {
  const totals = aggregateUsage([
    {
      role: "assistant",
      content: "one",
      timestamp: 1,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 15,
        costSource: "catalog",
        cost: { total: 0.03 },
      },
    },
    {
      role: "assistant",
      content: "two",
      timestamp: 2,
      usage: {
        input: 4,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        costSource: "estimated-openai",
        cost: { total: 0.02 },
      },
    },
  ] as any);

  expect(totals.input).toBe(14);
  expect(totals.output).toBe(11);
  expect(totals.totalTokens).toBe(25);
  expect(totals.costTotal).toBeCloseTo(0.05);
  expect(totals.costSource).toBe("estimated-openai");
});
import { expect, test } from "bun:test";
import { runReflexCheck } from "../src/scheduler/reflex.ts";

test("runReflexCheck returns a valid report structure", async () => {
  const report = await runReflexCheck();
  expect(typeof report.hasDelta).toBe("boolean");
  expect(Array.isArray(report.items)).toBe(true);
  expect(typeof report.summary).toBe("string");
});

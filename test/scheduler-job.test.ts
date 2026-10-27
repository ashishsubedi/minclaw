import { describe, expect, test } from "bun:test";
import { isAgenticJob, updateJobMode, addJob, removeJob, setJobsFileForTest, type ScheduledJob } from "../src/scheduler/scheduler.ts";
import { unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("ScheduledJob Agentic vs Reminder Detection", () => {
  test("explicit mode='agent' always returns true", () => {
    const job: ScheduledJob = {
      id: "1",
      name: "Custom task",
      cronExpr: "0 9 * * *",
      message: "Call mom",
      channel: "telegram",
      sender: "123",
      oneShot: true,
      mode: "agent",
      createdAt: Date.now(),
    };
    expect(isAgenticJob(job)).toBe(true);
  });

  test("explicit mode='reminder' always returns false even with agent keywords", () => {
    const job: ScheduledJob = {
      id: "2",
      name: "Static digest title",
      cronExpr: "0 9 * * *",
      message: "Search for the keys in the living room",
      channel: "telegram",
      sender: "123",
      oneShot: false,
      mode: "reminder",
      createdAt: Date.now(),
    };
    expect(isAgenticJob(job)).toBe(false);
  });

  test("recurring jobs (!oneShot) default to agentic mode", () => {
    const job: ScheduledJob = {
      id: "3",
      name: "Recurring reminder",
      cronExpr: "0 8 * * *",
      message: "Daily status ping",
      channel: "telegram",
      sender: "123",
      oneShot: false,
      createdAt: Date.now(),
    };
    expect(isAgenticJob(job)).toBe(true);
  });

  test("one-shot jobs with research/digest/search keywords are inferred as agentic", () => {
    const keywords = [
      "search recent arxiv papers",
      "find the latest tech news",
      "research vector database options",
      "digest of morning emails",
      "summarize unread chat threads",
      "check flight status",
      "review open PRs",
      "report on system metrics",
      "fetch the weather forecast",
      "morning briefing",
    ];

    for (const kw of keywords) {
      const job: ScheduledJob = {
        id: crypto.randomUUID(),
        name: kw,
        cronExpr: "* * * * *",
        message: kw,
        channel: "terminal",
        sender: "user",
        oneShot: true,
        createdAt: Date.now(),
      };
      expect(isAgenticJob(job)).toBe(true);
    }
  });

  test("one-shot jobs with simple static reminder text are not agentic", () => {
    const job: ScheduledJob = {
      id: "4",
      name: "Laundry",
      cronExpr: "* * * * *",
      message: "Take laundry out of dryer",
      channel: "terminal",
      sender: "user",
      oneShot: true,
      createdAt: Date.now(),
    };
    expect(isAgenticJob(job)).toBe(false);
  });

  test("updateJobMode updates job mode and persists it", () => {
    const tempFile = join(tmpdir(), `minclaw-jobs-test-${Date.now()}.json`);
    setJobsFileForTest(tempFile);

    try {
      const job = addJob({
        name: "Test Mode Toggle",
        cronExpr: "0 10 * * *",
        message: "Test message",
        channel: "web",
        sender: "web-dashboard",
        oneShot: false,
      });

      const updatedToAgent = updateJobMode(job.id, "agent");
      expect(updatedToAgent?.mode).toBe("agent");

      const updatedToReminder = updateJobMode(job.id, "reminder");
      expect(updatedToReminder?.mode).toBe("reminder");

      const resetToAuto = updateJobMode(job.id, undefined);
      expect(resetToAuto?.mode).toBeUndefined();

      removeJob(job.id);
    } finally {
      setJobsFileForTest(); // restore default
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  });
});

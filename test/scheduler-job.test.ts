import { describe, expect, test } from "bun:test";
import {
  isAgenticJob,
  updateJobMode,
  addJob,
  removeJob,
  setJobsFileForTest,
  parseTimeToJob,
  type ScheduledJob,
} from "../src/scheduler/scheduler.ts";
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

describe("parseTimeToJob natural language parsing", () => {
  test("parses relative minutes in various formats", () => {
    const job1 = parseTimeToJob("in 5 minutes", "terminal", "user");
    expect(job1).not.toBeNull();
    expect(job1?.name).toBe("Reminder in 5m");
    expect(job1?.oneShot).toBe(true);

    const job2 = parseTimeToJob("in 15m", "terminal", "user");
    expect(job2?.name).toBe("Reminder in 15m");

    const job3 = parseTimeToJob("in 30 mins", "terminal", "user");
    expect(job3?.name).toBe("Reminder in 30m");
  });

  test("parses relative hours in various formats", () => {
    const job1 = parseTimeToJob("in 2 hours", "terminal", "user");
    expect(job1).not.toBeNull();
    expect(job1?.name).toBe("Reminder in 2h");
    expect(job1?.oneShot).toBe(true);

    const job2 = parseTimeToJob("in 1 hr", "terminal", "user");
    expect(job2?.name).toBe("Reminder in 1h");

    const job3 = parseTimeToJob("in 3h", "terminal", "user");
    expect(job3?.name).toBe("Reminder in 3h");
  });

  test("parses tomorrow specifications with am/pm and dots", () => {
    const tomorrow10am = parseTimeToJob("tomorrow at 10am", "terminal", "user");
    expect(tomorrow10am).not.toBeNull();
    expect(tomorrow10am?.name).toBe("Reminder tomorrow at 10:00");
    expect(tomorrow10am?.cronExpr).toMatch(/^0 10 \d{1,2} \d{1,2} \*$/);
    expect(tomorrow10am?.oneShot).toBe(true);

    const tomorrowDotAm = parseTimeToJob("tomorrow at 10 a.m.", "terminal", "user");
    expect(tomorrowDotAm?.name).toBe("Reminder tomorrow at 10:00");

    const tomorrowAround1130 = parseTimeToJob("tomorrow around 11:30", "terminal", "user");
    expect(tomorrowAround1130?.name).toBe("Reminder tomorrow at 11:30");
    expect(tomorrowAround1130?.cronExpr).toMatch(/^30 11 \d{1,2} \d{1,2} \*$/);

    const tomorrowDefault = parseTimeToJob("tomorrow", "terminal", "user");
    expect(tomorrowDefault?.name).toBe("Reminder tomorrow at 10:00");
  });

  test("parses tomorrow periods (morning, afternoon, evening, night)", () => {
    const morning = parseTimeToJob("tomorrow morning", "terminal", "user");
    expect(morning?.name).toBe("Reminder tomorrow morning");
    expect(morning?.cronExpr).toMatch(/^0 9 \d{1,2} \d{1,2} \*$/);

    const afternoon = parseTimeToJob("tomorrow afternoon", "terminal", "user");
    expect(afternoon?.name).toBe("Reminder tomorrow afternoon");
    expect(afternoon?.cronExpr).toMatch(/^0 14 \d{1,2} \d{1,2} \*$/);

    const evening = parseTimeToJob("tomorrow evening", "terminal", "user");
    expect(evening?.name).toBe("Reminder tomorrow evening");
    expect(evening?.cronExpr).toMatch(/^0 18 \d{1,2} \d{1,2} \*$/);
  });

  test("parses absolute times with around/at and a.m./p.m.", () => {
    const at3pm = parseTimeToJob("at 3pm", "terminal", "user");
    expect(at3pm?.name).toBe("Reminder at 15:00");

    const aroundDotPm = parseTimeToJob("around 5 p.m.", "terminal", "user");
    expect(aroundDotPm?.name).toBe("Reminder at 17:00");
  });
});

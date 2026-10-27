import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import {
  getDashboardOverview,
  getExtensionsStatus,
  getPermanentMemoryContent,
  getTemporaryMemoryContent,
} from "../src/web/data.ts";
import { addJob, removeJob, triggerJob, setJobsFileForTest } from "../src/scheduler/scheduler.ts";
import { isWhatsAppPaired, getWhatsAppChannelStatus, resetWhatsAppAuth } from "../src/channels/whatsapp.ts";

test("getDashboardOverview returns enriched metrics and extensions", async () => {
  const overview = await getDashboardOverview();
  expect(overview).toBeDefined();
  expect(typeof overview.daemon.memoryRssMb).toBe("number");
  expect(overview.daemon.memoryRssMb).toBeGreaterThan(0);
  expect(typeof overview.daemon.uptimeSeconds).toBe("number");
  expect(overview.daemon.uptimeSeconds).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(overview.extensions)).toBe(true);
});

test("getPermanentMemoryContent reads permanent-memory.md", () => {
  const mem = getPermanentMemoryContent();
  expect(mem.ok).toBe(true);
  expect(mem.path).toContain("permanent-memory.md");
  expect(mem.content.length).toBeGreaterThan(0);
});

test("getTemporaryMemoryContent reads temporary-memory.md index", () => {
  const mem = getTemporaryMemoryContent();
  expect(mem.ok).toBe(true);
  expect(mem.path).toContain("temporary-memory.md");
  expect(mem.content).toContain("Temporary Memory");
});

test("triggerJob manually executes an existing scheduled job", () => {
  const tempFile = join(tmpdir(), `minclaw-jobs-test-${Date.now()}.json`);
  setJobsFileForTest(tempFile);

  try {
    const job = addJob({
      name: "Manual Test Trigger Job",
      cronExpr: "0 12 * * *",
      message: "Unit test triggered message",
      channel: "web",
      sender: "test-sender",
      oneShot: false,
      mode: "agent",
    });

    const triggered = triggerJob(job.id);
    expect(triggered).toBeDefined();
    expect(triggered?.id).toBe(job.id);
    expect(typeof triggered?.lastRunAt).toBe("number");
  } finally {
    setJobsFileForTest(); // restore default
    if (existsSync(tempFile)) unlinkSync(tempFile);
  }
});

test("getExtensionsStatus discovers voice-mac extension", () => {
  const exts = getExtensionsStatus();
  expect(Array.isArray(exts)).toBe(true);
  const voice = exts.find((e) => e.id === "voice-mac");
  expect(voice).toBeDefined();
  expect(voice?.name).toBe("voice-mac");
  expect(voice?.hotkey).toBeDefined();
  expect(voice?.stt?.engine).toBe("mlx_whisper");
});

test("WhatsApp pairing helpers accurately validate paired status", () => {
  const paired = isWhatsAppPaired();
  const status = getWhatsAppChannelStatus();
  expect(typeof paired).toBe("boolean");
  expect(status.paired).toBe(paired);
  expect(status.state).toBeDefined();
});

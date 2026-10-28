import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import {
  getDashboardOverview,
  getExtensionsStatus,
  getPermanentMemoryContent,
  getTemporaryMemoryContent,
  getTelemetryData,
  runGarbageCollection,
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

test("clearSession removes jsonl and compacted session files", () => {
  const { appendMessage, clearSession, getMessages } = require("../src/session.ts");
  const testKey = `test:delete-me-${Date.now()}`;
  appendMessage(testKey, { role: "user", content: "hello test", timestamp: Date.now() });

  expect(getMessages(testKey).length).toBe(1);

  clearSession(testKey);
  expect(getMessages(testKey).length).toBe(0);
});

test("getTelemetryData returns system vitals, memory breakdown, tokens, and history", async () => {
  const telemetry = await getTelemetryData();
  expect(telemetry).toBeDefined();
  expect(typeof telemetry.process.pid).toBe("number");
  expect(typeof telemetry.process.uptimeSeconds).toBe("number");
  expect(typeof telemetry.process.formattedUptime).toBe("string");
  expect(typeof telemetry.memory.rssMb).toBe("number");
  expect(telemetry.memory.rssMb).toBeGreaterThan(0);
  expect(typeof telemetry.memory.heapTotalMb).toBe("number");
  expect(typeof telemetry.memory.heapUsedMb).toBe("number");
  expect(typeof telemetry.memory.heapUsedPercent).toBe("number");
  expect(typeof telemetry.host.cpuCores).toBe("number");
  expect(telemetry.host.cpuCores).toBeGreaterThan(0);
  expect(typeof telemetry.host.totalMemoryGb).toBe("number");
  expect(Array.isArray(telemetry.host.loadAverage)).toBe(true);
  expect(typeof telemetry.tokens.totalTokens).toBe("number");
  expect(typeof telemetry.tokens.cacheHitRate).toBe("number");
  expect(telemetry.models.primary.name).toBeDefined();
  expect(Array.isArray(telemetry.models.fallbacks)).toBe(true);
  expect(Array.isArray(telemetry.history)).toBe(true);
  expect(telemetry.history.length).toBeGreaterThan(0);
});

test("runGarbageCollection executes Bun.gc and returns memory statistics", () => {
  const result = runGarbageCollection();
  expect(result.ok).toBe(true);
  expect(typeof result.beforeRssMb).toBe("number");
  expect(typeof result.afterRssMb).toBe("number");
  expect(typeof result.freedMb).toBe("number");
  expect(result.freedMb).toBeGreaterThanOrEqual(0);
});

test("GET /api/telemetry and POST /api/telemetry/gc endpoint responses", async () => {
  const { handleRequest } = require("../src/web/server.ts");
  const { createSession, createSessionCookieHeader } = require("../src/auth/touchid.ts");

  const token = createSession();
  const cookieHeader = createSessionCookieHeader(token);

  // 1. GET /api/telemetry
  const getReq = new Request("http://127.0.0.1:8787/api/telemetry", {
    method: "GET",
    headers: {
      Host: "127.0.0.1:8787",
      Cookie: cookieHeader.split(";")[0] || "",
    },
  });

  const getRes = await handleRequest(getReq);
  expect(getRes.status).toBe(200);
  const getData = await getRes.json();
  expect(getData.memory.rssMb).toBeGreaterThan(0);
  expect(getData.host.cpuCores).toBeGreaterThan(0);
  expect(Array.isArray(getData.history)).toBe(true);

  // 2. POST /api/telemetry/gc
  const postReq = new Request("http://127.0.0.1:8787/api/telemetry/gc", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:8787",
      Cookie: cookieHeader.split(";")[0] || "",
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:8787",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({}),
  });

  const postRes = await handleRequest(postReq);
  expect(postRes.status).toBe(200);
  const postData = await postRes.json();
  expect(postData.ok).toBe(true);
  expect(typeof postData.afterRssMb).toBe("number");
});

import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBrain,
  loadOperationalMemory,
  buildBrainSystemPrompt,
  type BrainFiles,
} from "../src/brain/loader.ts";
import {
  buildAgyPrompt,
  filterSystemPromptForAgy,
  extractOperationalMemory,
  buildSystemPrompt,
  AGY_STATIC_DELEGATION_HEADER,
} from "../src/agent.ts";

describe("Operational Memory & Experience Library (Level 2 Experience)", () => {
  test("loadBrain loads operational-memory.md properly into BrainFiles", async () => {
    const brain: BrainFiles = await loadBrain();

    expect(typeof brain.operationalMemory).toBe("string");
    expect(brain.operationalMemory.length).toBeGreaterThan(0);
    expect(brain.operationalMemory).toContain("## 🛠️ Tool & API Quirks");
    expect(brain.operationalMemory).toContain("## 🧠 Environment & Platform Gotchas");
    expect(brain.operationalMemory).toContain("## 📜 Golden Operational Patterns");
    expect(brain.operationalMemory).toContain("minclaw tool call");
  });

  test("loadOperationalMemory loads brain/operational-memory.md directly", async () => {
    const opMemory = await loadOperationalMemory();

    expect(opMemory.length).toBeGreaterThan(0);
    expect(opMemory).toContain("MinClaw Operational Memory & Experience Library");
    expect(opMemory).toContain("action=list_unread");
  });

  test("loadBrain and loadOperationalMemory handle missing operational-memory.md safely without throwing", async () => {
    const emptyTempDir = mkdtempSync(join(tmpdir(), "minclaw-empty-brain-"));

    try {
      // 1. loadBrain with empty dir returns empty strings with no error
      const brain = await loadBrain(emptyTempDir);
      expect(brain.operationalMemory).toBe("");
      expect(brain.system).toBe("");
      expect(brain.permanentMemory).toBe("");

      // 2. loadOperationalMemory with empty dir returns empty string without throwing
      const opMem = await loadOperationalMemory(emptyTempDir);
      expect(opMem).toBe("");
    } finally {
      rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });

  test("loadBrain reads custom operational-memory.md when present in dir", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "minclaw-custom-brain-"));

    try {
      writeFileSync(join(tempDir, "operational-memory.md"), "## Custom Quirks\n- Always pass foo=bar", "utf-8");
      writeFileSync(join(tempDir, "system.md"), "Custom system prompt", "utf-8");

      const brain = await loadBrain(tempDir);
      expect(brain.operationalMemory).toBe("## Custom Quirks\n- Always pass foo=bar");
      expect(brain.system).toBe("Custom system prompt");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("buildBrainSystemPrompt formats brain files with Operational Memory section", () => {
    const brain: BrainFiles = {
      system: "System persona",
      channels: "Channel configs",
      permanentMemory: "User facts",
      heartbeat: "Heartbeat instructions",
      operationalMemory: "Tool quirks & workarounds",
    };

    const prompt = buildBrainSystemPrompt(brain);

    expect(prompt).toContain("System persona");
    expect(prompt).toContain("Channel configs");
    expect(prompt).toContain("## Permanent Memory\n\nUser facts");
    expect(prompt).toContain("## Operational Memory & Runbook\n\nTool quirks & workarounds");
  });

  test("filterSystemPromptForAgy strips Operational Memory section cleanly", () => {
    const rawSystemPrompt = [
      "Base system instructions.",
      "## Permanent Memory",
      "User likes dark mode.",
      "## Operational Memory & Runbook",
      "## 🛠️ Tool & API Quirks",
      "- AppleScript timeout 10s",
    ].join("\n\n");

    const filtered = filterSystemPromptForAgy(rawSystemPrompt);

    expect(filtered).toContain("Base system instructions.");
    expect(filtered).toContain("## Permanent Memory");
    expect(filtered).not.toContain("## Operational Memory & Runbook");
    expect(filtered).not.toContain("AppleScript timeout 10s");
  });

  test("extractOperationalMemory extracts operational memory from system prompt", () => {
    const rawSystemPrompt = [
      "Base persona.",
      "## Operational Memory & Runbook",
      "## 🛠️ Tool & API Quirks",
      "- SearXNG query format",
      "## Temporary Memory Index",
      "Recent conversation index",
    ].join("\n\n");

    const extracted = extractOperationalMemory(rawSystemPrompt);

    expect(extracted).toContain("## 🛠️ Tool & API Quirks");
    expect(extracted).toContain("- SearXNG query format");
    expect(extracted).not.toContain("Temporary Memory Index");
  });

  test("buildAgyPrompt injects [Operational Memory & Runbook] right after [MinClaw System Context & Knowledge]", () => {
    const context = {
      systemPrompt: [
        "MinClaw Autonomous Host Persona.",
        "## Permanent Memory",
        "Fact 1: User timezone UTC+2",
        "## Operational Memory & Runbook",
        "## 🛠️ Tool & API Quirks",
        "- Calendar event dates require ISO 8601 formatting",
      ].join("\n\n"),
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Schedule a meeting tomorrow at 3pm." }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    };

    const prompt = buildAgyPrompt(context, "telegram:12345", false);

    // 1. Invariant delegation header starts first
    expect(prompt.startsWith(AGY_STATIC_DELEGATION_HEADER)).toBe(true);

    // 2. [MinClaw System Context & Knowledge] follows
    const sysCtxIdx = prompt.indexOf("[MinClaw System Context & Knowledge]");
    expect(sysCtxIdx).toBeGreaterThan(0);

    // 3. [Operational Memory & Runbook] is injected right after [MinClaw System Context & Knowledge]
    const opMemIdx = prompt.indexOf("[Operational Memory & Runbook]");
    expect(opMemIdx).toBeGreaterThan(sysCtxIdx);
    expect(prompt).toContain("Calendar event dates require ISO 8601 formatting");

    // 4. [MinClaw System Context & Knowledge] does not duplicate the operational memory section
    const sysSection = prompt.slice(sysCtxIdx, opMemIdx);
    expect(sysSection).not.toContain("Calendar event dates require ISO 8601 formatting");

    // 5. User request appears at the end
    const reqIdx = prompt.indexOf("[Current User Request]");
    expect(reqIdx).toBeGreaterThan(opMemIdx);
    expect(prompt).toContain("Schedule a meeting tomorrow at 3pm.");
  });

  test("buildAgyPrompt supports operationalMemory passed explicitly on context", () => {
    const context = {
      systemPrompt: "Persona instructions only.",
      operationalMemory: "## 🧠 Environment & Platform Gotchas\n- Never kill MinClaw daemon",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "What is your status?" }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    };

    const prompt = buildAgyPrompt(context, "terminal:default", false);

    const sysCtxIdx = prompt.indexOf("[MinClaw System Context & Knowledge]");
    const opMemIdx = prompt.indexOf("[Operational Memory & Runbook]");
    expect(opMemIdx).toBeGreaterThan(sysCtxIdx);
    expect(prompt).toContain("Never kill MinClaw daemon");
  });

  test("buildAgyPrompt omits [Operational Memory & Runbook] when none exists, preserving cache prefix", () => {
    const context = {
      systemPrompt: "Clean system prompt without op memory.",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Hello" }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    };

    const prompt = buildAgyPrompt(context, "terminal:default", false);

    expect(prompt).not.toContain("[Operational Memory & Runbook]");
    expect(prompt).toContain("[MinClaw System Context & Knowledge]");
  });

  test("AGY_STATIC_DELEGATION_HEADER instructs agy to record enduring heuristics in brain/operational-memory.md", () => {
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("Operational Memory & Experience Library (Level 2 Experience)");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("brain/operational-memory.md");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("## 🛠️ Tool & API Quirks");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("## 🧠 Environment & Platform Gotchas");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("## 📜 Golden Operational Patterns");
  });

  test("buildSystemPrompt incorporates operational-memory.md into complete prompt", async () => {
    const prompt = await buildSystemPrompt(process.cwd(), "Recent conversation notes", "terminal:test");

    expect(prompt).toContain("## Operational Memory & Runbook");
    expect(prompt).toContain("MinClaw Operational Memory & Experience Library");
  });
});

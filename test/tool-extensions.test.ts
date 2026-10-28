import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  registerToolExtension,
  getToolExtension,
  getAllToolExtensions,
  getAllRegisteredTools,
  loadExternalToolExtensions,
} from "../src/extensions/tools-registry.ts";

import {
  executeTool,
  executeYoutube,
  executeSessionReset,
  youtubeTool,
  sessionResetTool,
  type YoutubeRunner,
} from "../src/tools.ts";

import {
  parseCliToolArgs,
  handleToolCli,
  formatToolList,
} from "../src/cli/tool-ctl.ts";

import {
  appendMessage,
  getMessages,
  clearSession,
} from "../src/session.ts";

describe("Tool Extensions Architecture & Registry", () => {
  test("registers all 15 built-in tools on startup", () => {
    const extensions = getAllToolExtensions();
    expect(extensions.length).toBeGreaterThanOrEqual(15);

    const names = extensions.map((e) => e.tool.name);
    const expected = [
      "shell",
      "read_file",
      "save_credential",
      "search_memory",
      "remember",
      "schedule_reminder",
      "send_message",
      "send_file",
      "web_search",
      "web_fetch",
      "email",
      "calendar",
      "compact_session",
      "youtube",
      "session_reset",
    ];

    for (const exp of expected) {
      expect(names).toContain(exp);
      const ext = getToolExtension(exp);
      expect(ext).toBeDefined();
      expect(typeof ext?.execute).toBe("function");
      expect(typeof ext?.cliUsage).toBe("string");
    }
  });

  test("getAllRegisteredTools returns Tool definitions", () => {
    const tools = getAllRegisteredTools();
    expect(tools.length).toBeGreaterThanOrEqual(15);
    const youtube = tools.find((t) => t.name === "youtube");
    expect(youtube).toBeDefined();
    expect(youtube?.name).toBe("youtube");
  });

  test("registers and executes a custom ToolExtension", async () => {
    const CustomParams = Type.Object({
      msg: Type.String(),
    });

    registerToolExtension({
      tool: {
        name: "custom_echo_test",
        description: "Custom echo test tool",
        parameters: CustomParams,
      },
      cliUsage: 'minclaw tool call custom_echo_test msg="hello"',
      execute: (args: { msg: string }) => {
        return {
          content: [{ type: "text", text: `echo:${args.msg.toUpperCase()}` }],
          isError: false,
        };
      },
    });

    const ext = getToolExtension("custom_echo_test");
    expect(ext).toBeDefined();
    expect(ext?.cliUsage).toBe('minclaw tool call custom_echo_test msg="hello"');

    const res = await executeTool("custom_echo_test", { msg: "testing" });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe("echo:TESTING");
  });

  test("discovers and loads external tool manifest from tool.json5", async () => {
    const testExtDir = join(tmpdir(), `minclaw_test_ext_${Date.now()}`);
    const sampleDir = join(testExtDir, "echo_ext");
    mkdirSync(sampleDir, { recursive: true });

    const manifestContent = `
{
  name: "sample_external_ext",
  description: "External test extension from tool.json5",
  command: "echo external_ok",
  cliUsage: "minclaw tool call sample_external_ext"
}
`;
    writeFileSync(join(sampleDir, "tool.json5"), manifestContent, "utf-8");

    try {
      const loaded = loadExternalToolExtensions(testExtDir);
      expect(loaded.length).toBe(1);
      expect(loaded[0]?.tool.name).toBe("sample_external_ext");

      const ext = getToolExtension("sample_external_ext");
      expect(ext).toBeDefined();
      expect(ext?.tool.description).toBe("External test extension from tool.json5");

      const res = await ext!.execute({});
      expect(res.isError).toBe(false);
      expect(res.content[0]?.text).toContain("external_ok");
    } finally {
      if (existsSync(testExtDir)) {
        rmSync(testExtDir, { recursive: true, force: true });
      }
    }
  });
});

describe("CLI Tool Controller (src/cli/tool-ctl.ts)", () => {
  test("parseCliToolArgs parses help and list commands", () => {
    expect(parseCliToolArgs([])).toEqual({ command: "help", args: {} });
    expect(parseCliToolArgs(["--help"])).toEqual({ command: "help", args: {} });
    expect(parseCliToolArgs(["list"])).toEqual({ command: "list", args: {} });
    expect(parseCliToolArgs(["ls"])).toEqual({ command: "list", args: {} });
  });

  test("parseCliToolArgs parses key=value pairs, boolean coercion, and numeric coercion", () => {
    const parsed = parseCliToolArgs([
      "call",
      "youtube",
      "action=play",
      'query="Rick Astley"',
      "browser='Firefox'",
      "limit=5",
      "timeout=30",
      "maxResults=8",
      "dryRun=true",
      "force=false",
      "--session=telegram:12345",
    ]);

    expect(parsed.command).toBe("call");
    expect(parsed.toolName).toBe("youtube");
    expect(parsed.sessionKey).toBe("telegram:12345");
    expect(parsed.args).toEqual({
      action: "play",
      query: "Rick Astley",
      browser: "Firefox",
      limit: 5,
      timeout: 30,
      maxResults: 8,
      dryRun: true,
      force: false,
    });
  });

  test("parseCliToolArgs shorthand invocation without 'call'", () => {
    const parsed = parseCliToolArgs([
      "youtube",
      "action=search",
      "query=lofi beats",
      "limit=3",
      "-s",
      "terminal:voice_macbook",
    ]);

    expect(parsed.command).toBe("call");
    expect(parsed.toolName).toBe("youtube");
    expect(parsed.sessionKey).toBe("terminal:voice_macbook");
    expect(parsed.args).toEqual({
      action: "search",
      query: "lofi beats",
      limit: 3,
    });
  });

  test("parseCliToolArgs merges --json arguments with CLI key=value flags", () => {
    const parsed = parseCliToolArgs([
      "call",
      "youtube",
      "--json",
      '{"action": "search", "limit": 2}',
      "query=ambient space",
    ]);

    expect(parsed.command).toBe("call");
    expect(parsed.toolName).toBe("youtube");
    expect(parsed.args).toEqual({
      action: "search",
      limit: 2,
      query: "ambient space",
    });
  });

  test("formatToolList generates readable list of registered tools", () => {
    const list = formatToolList();
    expect(list).toContain("Registered MinClaw Tools");
    expect(list).toContain("youtube");
    expect(list).toContain("session_reset");
    expect(list).toContain("Usage:");
  });

  test("parseCliToolArgs parses tool-specific help e.g. ['call', 'email', '--help']", () => {
    expect(parseCliToolArgs(["call", "email", "--help"])).toEqual({
      command: "help",
      toolName: "email",
      args: {},
    });
    expect(parseCliToolArgs(["email", "-h"])).toEqual({
      command: "help",
      toolName: "email",
      args: {},
    });
  });

  test("handleToolCli prints tool-specific help with parameters for 'email --help'", async () => {
    const result = await handleToolCli(["call", "email", "--help"], { noExit: true });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("MinClaw Tool:");
    expect(result.output).toContain("email");
    expect(result.output).toContain("action");
    expect(result.output).toContain("id");
    expect(result.output).toContain("account");
  });

  test("handleToolCli runs in-process fallback cleanly", async () => {
    const result = await handleToolCli(
      ["call", "session_reset", "sessionKey=test_in_process_cli_session"],
      { noExit: true, directInProcess: true }
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Session test_in_process_cli_session cleared.");
  });
});

describe("session_reset Tool", () => {
  const testKey = "test_tool_session_reset_key";
  let tempSessionsDir: string;
  let originalSessionsDir: string | undefined;

  beforeAll(() => {
    tempSessionsDir = mkdtempSync(join(tmpdir(), "minclaw-test-sessions-"));
    originalSessionsDir = process.env.MINCLAW_SESSIONS_DIR;
    process.env.MINCLAW_SESSIONS_DIR = tempSessionsDir;
  });

  afterAll(() => {
    if (originalSessionsDir !== undefined) {
      process.env.MINCLAW_SESSIONS_DIR = originalSessionsDir;
    } else {
      delete process.env.MINCLAW_SESSIONS_DIR;
    }
    try {
      rmSync(tempSessionsDir, { recursive: true, force: true });
    } catch {}
  });

  test("clears persisted session messages and returns confirmation", async () => {
    appendMessage(testKey, {
      role: "user",
      content: "Hello agent!",
      timestamp: Date.now(),
    });
    appendMessage(testKey, {
      role: "assistant",
      content: "Hello! How can I help you?",
      timestamp: Date.now(),
    });

    const msgsBefore = getMessages(testKey);
    expect(msgsBefore.length).toBe(2);

    const result = await executeSessionReset({ sessionKey: testKey });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe(`Session ${testKey} cleared.`);

    const msgsAfter = getMessages(testKey);
    expect(msgsAfter.length).toBe(0);
  });

  test("resolves sessionKey from context when omitted", async () => {
    const contextSessionKey = "telegram:user_reset_test";
    appendMessage(contextSessionKey, {
      role: "user",
      content: "Context test",
      timestamp: Date.now(),
    });

    const result = await executeSessionReset(
      {},
      { channel: "telegram", sender: "user_reset_test" }
    );

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe(`Session ${contextSessionKey} cleared.`);
    expect(getMessages(contextSessionKey).length).toBe(0);
  });

  test("defaults to voice:macbook when neither args nor context are provided", async () => {
    const result = await executeSessionReset({});
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Session voice:macbook cleared.");
  });
});

describe("youtube Tool", () => {
  test("direct YouTube watch URL opens directly in browser without search", async () => {
    let openedUrl = "";
    let openedBrowser = "";

    const runner: YoutubeRunner = {
      openBrowser: async (url, browser) => {
        openedUrl = url;
        openedBrowser = browser || "";
        return { exitCode: 0 };
      },
    };

    const directUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const res = await executeYoutube(
      { query: directUrl, action: "play", browser: "Firefox" },
      undefined,
      runner
    );

    expect(res.isError).toBe(false);
    expect(openedUrl).toBe(directUrl);
    expect(openedBrowser).toBe("Firefox");
    expect(res.content[0]?.text).toBe(`Opened ${directUrl} in Firefox.`);
  });

  test("direct youtu.be short URL opens directly in specified browser", async () => {
    let openedUrl = "";
    let openedBrowser = "";

    const runner: YoutubeRunner = {
      openBrowser: async (url, browser) => {
        openedUrl = url;
        openedBrowser = browser || "";
        return { exitCode: 0 };
      },
    };

    const shortUrl = "https://youtu.be/dQw4w9WgXcQ";
    const res = await executeYoutube(
      { query: shortUrl, action: "play", browser: "Safari" },
      undefined,
      runner
    );

    expect(res.isError).toBe(false);
    expect(openedUrl).toBe(shortUrl);
    expect(openedBrowser).toBe("Safari");
    expect(res.content[0]?.text).toBe(`Opened ${shortUrl} in Safari.`);
  });

  test("search action returns formatted results with duration and channels", async () => {
    const fakeJson = JSON.stringify({
      entries: [
        {
          id: "vid_123",
          title: "Rick Astley - Never Gonna Give You Up",
          channel: "Rick Astley",
          duration: 214,
        },
        {
          id: "vid_456",
          title: "Rick Astley - Together Forever",
          uploader: "Rick Astley Vevo",
          duration: 204,
        },
      ],
    });

    const runner: YoutubeRunner = {
      runYtDlp: async (args) => {
        expect(args).toContain("--flat-playlist");
        expect(args).toContain("--dump-single-json");
        return { stdout: fakeJson, stderr: "", exitCode: 0 };
      },
    };

    const res = await executeYoutube(
      { query: "never gonna give you up", action: "search", limit: 2 },
      undefined,
      runner
    );

    expect(res.isError).toBe(false);
    const output = res.content[0]?.text || "";
    expect(output).toContain("YouTube Search Results for \"never gonna give you up\":");
    expect(output).toContain("[1] Rick Astley - Never Gonna Give You Up");
    expect(output).toContain("URL: https://www.youtube.com/watch?v=vid_123");
    expect(output).toContain("Channel: Rick Astley");
    expect(output).toContain("Duration: 3:34");
    expect(output).toContain("[2] Rick Astley - Together Forever");
    expect(output).toContain("URL: https://www.youtube.com/watch?v=vid_456");
  });

  test("play action searches via yt-dlp, picks first entry, and opens in Firefox", async () => {
    const fakeJson = JSON.stringify({
      entries: [
        {
          id: "top_hit_999",
          title: "Chill Synthwave Beats",
          channel: "Lofi Records",
          duration: 3600,
        },
      ],
    });

    let openedUrl = "";
    let openedBrowser = "";

    const runner: YoutubeRunner = {
      runYtDlp: async () => ({ stdout: fakeJson, stderr: "", exitCode: 0 }),
      openBrowser: async (url, browser) => {
        openedUrl = url;
        openedBrowser = browser || "";
        return { exitCode: 0 };
      },
    };

    const res = await executeYoutube(
      { query: "chill synthwave", action: "play", browser: "Firefox" },
      undefined,
      runner
    );

    expect(res.isError).toBe(false);
    expect(openedUrl).toBe("https://www.youtube.com/watch?v=top_hit_999");
    expect(openedBrowser).toBe("Firefox");
    expect(res.content[0]?.text).toContain('Opened "Chill Synthwave Beats" (https://www.youtube.com/watch?v=top_hit_999) in Firefox.');
  });

  test("handles empty search results gracefully", async () => {
    const runner: YoutubeRunner = {
      runYtDlp: async () => ({ stdout: JSON.stringify({ entries: [] }), stderr: "", exitCode: 0 }),
    };

    const res = await executeYoutube(
      { query: "non_existent_unlikely_query_12345", action: "search" },
      undefined,
      runner
    );

    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain('No YouTube results found for "non_existent_unlikely_query_12345".');
  });

  test("handles missing query error", async () => {
    const res = await executeYoutube({ query: "" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Error: query parameter is required");
  });

  test("handles yt-dlp failure cleanly", async () => {
    const runner: YoutubeRunner = {
      runYtDlp: async () => ({ stdout: "", stderr: "Network error", exitCode: 1 }),
    };

    const res = await executeYoutube(
      { query: "fail test" },
      undefined,
      runner
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("YouTube search failed: Network error");
  });
});

describe("email Tool", () => {
  test("returns clear error on missing or invalid action", async () => {
    const res = await executeTool("email", { action: "invalid_action" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Invalid email action: 'invalid_action'");
    expect(res.content[0]?.text).toContain("'list_unread'");
    expect(res.content[0]?.text).toContain("'read'");
    expect(res.content[0]?.text).toContain("'send'");
  });

  test("action='read' requires 'id' parameter", async () => {
    const res = await executeTool("email", { action: "read" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Error: 'id' parameter is required for action='read'");
  });
});

describe("calendar Tool & parseCalendarDateTime", () => {
  test("parseCalendarDateTime parses ISO and local date/time strings", async () => {
    const { parseCalendarDateTime } = await import("../src/email/calendar.ts");
    const d1 = parseCalendarDateTime("2026-10-27T11:30:00+01:00");
    expect(d1.toISOString()).toBe("2026-10-27T10:30:00.000Z");

    const fallback = new Date("2026-10-27T00:00:00.000Z");
    const d2 = parseCalendarDateTime("11:30", fallback);
    expect(d2.getHours()).toBe(11);
    expect(d2.getMinutes()).toBe(30);
  });

  test("calendar create_event requires summary and startTime", async () => {
    const res1 = await executeTool("calendar", { action: "create_event" });
    expect(res1.isError).toBe(true);
    expect(res1.content[0]?.text).toContain("'summary' (event title) is required");

    const res2 = await executeTool("calendar", { action: "create_event", summary: "Test meeting" });
    expect(res2.isError).toBe(true);
    expect(res2.content[0]?.text).toContain("'startTime' is required");
  });

  test("parseCliToolArgs parses --direct flag", async () => {
    const { parseCliToolArgs } = await import("../src/cli/tool-ctl.ts");
    const parsed = parseCliToolArgs(["call", "calendar", "--direct", "action=create_event", "summary=Lunch"]);
    expect(parsed.toolName).toBe("calendar");
    expect(parsed.directInProcess).toBe(true);
    expect(parsed.args.action).toBe("create_event");
    expect(parsed.args.summary).toBe("Lunch");
  });
});

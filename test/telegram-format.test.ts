import { describe, expect, test } from "bun:test";
import {
  escapeTelegramHtml,
  formatTelegramHtml,
  buildInteractiveWidget,
  buildLiveStatusWidget,
  type WidgetCardSpec,
  type LiveStatusState,
} from "../src/channels/telegram-format.ts";

describe("escapeTelegramHtml", () => {
  test("escapes &, <, and >", () => {
    expect(escapeTelegramHtml("Tom & Jerry <friends> & 'fun'")).toBe(
      "Tom &amp; Jerry &lt;friends&gt; &amp; 'fun'"
    );
  });

  test("handles strings without special characters", () => {
    expect(escapeTelegramHtml("Hello World 123")).toBe("Hello World 123");
  });
});

describe("formatTelegramHtml", () => {
  test("converts exact broken heartbeat message from screenshot", () => {
    const markdown = [
      "### 💓 Heartbeat Status: Healthy & Normal",
      "",
      "* **Time**: Tuesday, Nov 10, 2026 — 17:07 CET",
      "* **Script**: `scripts/schedule-date-reminder.ts`",
      "* **Email**: assu00001_stud_uni_saarland_de",
      "* **Contact**: GrippeImpftagUdS@uni.saarland",
      "* **Newsletter**: *The Pragmatic Engineer*",
    ].join("\n");

    const html = formatTelegramHtml(markdown);

    // No raw ### or ** remaining
    expect(html.includes("###")).toBe(false);
    expect(html.includes("**")).toBe(false);

    // Heading converted
    expect(html).toContain("<b>💓 Heartbeat Status: Healthy &amp; Normal</b>");

    // Ampersand properly escaped
    expect(html).toContain("Healthy &amp; Normal");

    // Bullet and bold converted
    expect(html).toContain("• <b>Time</b>: Tuesday, Nov 10, 2026 — 17:07 CET");

    // Inline code rendered
    expect(html).toContain("• <b>Script</b>: <code>scripts/schedule-date-reminder.ts</code>");

    // Underscores in identifiers/emails are preserved and NOT converted to <i>
    expect(html).toContain("assu00001_stud_uni_saarland_de");
    expect(html.includes("<i>stud</i>")).toBe(false);
    expect(html).toContain("GrippeImpftagUdS@uni.saarland");

    // Nested italic bullet converted
    expect(html).toContain("• <b>Newsletter</b>: <i>The Pragmatic Engineer</i>");
  });

  test("does not convert snake_case, filenames, or identifiers with underscores into italics", () => {
    const input = [
      "Check scripts/schedule_date_reminder.ts and user_compaction_unit.",
      "Email: assu00001_stud_uni_saarland_de",
      "const my_variable_name = 42;",
    ].join("\n");

    const html = formatTelegramHtml(input);

    expect(html).toContain("scripts/schedule_date_reminder.ts");
    expect(html).toContain("user_compaction_unit");
    expect(html).toContain("assu00001_stud_uni_saarland_de");
    expect(html).toContain("my_variable_name");
    expect(html.includes("<i>")).toBe(false);
  });

  test("converts legitimate underscore italics when bounded by whitespace or punctuation", () => {
    expect(formatTelegramHtml("_italic text_")).toBe("<i>italic text</i>");
    expect(formatTelegramHtml("This is _important_!")).toBe("This is <i>important</i>!");
    expect(formatTelegramHtml("(_parenthesized_)")).toBe("(<i>parenthesized</i>)");
  });

  test("escapes < and > inside fenced code blocks and inline code", () => {
    const markdown = [
      "Here is a code block:",
      "```ts",
      "if (a < b && c > d) {",
      "  return a < c;",
      "}",
      "```",
      "And inline: `x < 10 && y > 20`",
    ].join("\n");

    const html = formatTelegramHtml(markdown);

    expect(html).toContain(
      "<pre><code>if (a &lt; b &amp;&amp; c &gt; d) {\n  return a &lt; c;\n}</code></pre>"
    );
    expect(html).toContain("<code>x &lt; 10 &amp;&amp; y &gt; 20</code>");
    expect(html.includes("< b")).toBe(false);
    expect(html.includes("> d")).toBe(false);
  });

  test("converts markdown links and strips inline code / backticks from link labels", () => {
    const input = [
      "See [MinClaw Guide](https://example.com/guide).",
      "Check [`schedule.ts`](https://example.com/schedule.ts).",
      "Read [**Important RFC**](https://example.com/rfc).",
    ].join("\n");

    const html = formatTelegramHtml(input);

    expect(html).toContain('<a href="https://example.com/guide">MinClaw Guide</a>');
    // Nested backticks stripped so code entity does not break <a> entity in Telegram
    expect(html).toContain('<a href="https://example.com/schedule.ts">schedule.ts</a>');
    expect(html.includes('<code>schedule.ts</code>')).toBe(false);
    expect(html).toContain('<a href="https://example.com/rfc"><b>Important RFC</b></a>');
  });

  test("converts blockquotes and merges consecutive blockquote lines", () => {
    const input = [
      "> First line of quote",
      "> Second line of quote",
      "",
      "Regular paragraph",
    ].join("\n");

    const html = formatTelegramHtml(input);

    expect(html).toContain("<blockquote>First line of quote\nSecond line of quote</blockquote>");
    expect(html).toContain("Regular paragraph");
  });

  test("converts strikethrough ~~text~~ to <s>text</s>", () => {
    expect(formatTelegramHtml("This is ~~deprecated~~.")).toBe("This is <s>deprecated</s>.");
  });

  test("converts markdown horizontal rules (---, ___, ***) to unicode divider", () => {
    const input = [
      "Paragraph 1",
      "---",
      "Paragraph 2",
      "***",
      "Paragraph 3",
      "___",
      "Paragraph 4",
    ].join("\n");
    const html = formatTelegramHtml(input);
    expect(html).toContain("Paragraph 1\n──────────\nParagraph 2\n──────────\nParagraph 3\n──────────\nParagraph 4");
    expect(html.includes("---")).toBe(false);
    expect(html.includes("***")).toBe(false);
    expect(html.includes("___")).toBe(false);
  });

  test("converts various heading levels (# to ######)", () => {
    expect(formatTelegramHtml("# Heading 1")).toBe("<b>Heading 1</b>");
    expect(formatTelegramHtml("## Heading 2")).toBe("<b>Heading 2</b>");
    expect(formatTelegramHtml("### Heading 3")).toBe("<b>Heading 3</b>");
    expect(formatTelegramHtml("#### Heading 4")).toBe("<b>Heading 4</b>");
  });

  test("handles empty and plain strings cleanly", () => {
    expect(formatTelegramHtml("")).toBe("");
    expect(formatTelegramHtml("Just plain text")).toBe("Just plain text");
  });
});

describe("buildInteractiveWidget", () => {
  test("generates valid dark-mode HTML, fallback, chatData, and 2-per-row buttons", () => {
    const spec: WidgetCardSpec = {
      title: "Server Deployment",
      subtitle: "Production Environment",
      badge: "LIVE",
      items: [
        { label: "Status", value: "Operational", badge: "OK", tone: "success" },
        { label: "Region", value: "eu-central-1", tone: "default" },
      ],
      sections: [
        {
          heading: "Health Metrics",
          body: "All systems **nominal** at 99.98% uptime.",
          items: [{ label: "Latency", value: "24ms", tone: "accent" }],
        },
      ],
      actions: [
        { label: "Restart", action: "restart_server" },
        { label: "View Logs", action: "view_logs" },
        { label: "Docs", action: "open_docs", url: "https://example.com/docs" },
      ],
      footer: "Updated every 60s",
    };

    const widget = buildInteractiveWidget(spec);

    // Verify dark mode theme colors
    expect(widget.html).toContain("<!DOCTYPE html>");
    expect(widget.html).toContain("#0e1621"); // dark outer background
    expect(widget.html).toContain("#17212b"); // dark card surface
    expect(widget.html).toContain("#242f3d"); // border
    expect(widget.html).toContain("#2b5278"); // primary button
    expect(widget.html).toContain("#6ab2f2"); // accent blue

    // Verify content rendered
    expect(widget.html).toContain("Server Deployment");
    expect(widget.html).toContain("Production Environment");
    expect(widget.html).toContain("LIVE");
    expect(widget.html).toContain("Operational");
    expect(widget.html).toContain("Health Metrics");
    expect(widget.html).toContain("restart_server");
    expect(widget.html).toContain("view_logs");

    // Verify script bridge and optimistic UI
    expect(widget.html).toContain("window.TelegramWidget");
    expect(widget.html).toContain("triggerAction");
    expect(widget.html).toContain("⚡ Working...");

    // Verify size constraint (< 32 KB limit, ideally < 8 KB)
    const byteSize = Buffer.byteLength(widget.html, "utf-8");
    expect(byteSize).toBeLessThan(8192);

    // Verify buttons chunked 2 per row
    expect(widget.buttons.length).toBe(2);
    expect(widget.buttons[0]!.length).toBe(2);
    expect(widget.buttons[1]!.length).toBe(1);
    expect(widget.buttons[0]![0]!.action).toBe("restart_server");
    expect(widget.buttons[0]![1]!.action).toBe("view_logs");
    expect(widget.buttons[1]![0]!.action).toBe("open_docs");

    // Verify chatData
    expect(widget.chatData.title).toBe("Server Deployment");
    expect(widget.chatData.statusBadge).toBe("LIVE");
    expect(Array.isArray(widget.chatData.completedActions)).toBe(true);

    // Verify fallback HTML
    expect(widget.fallbackHtml).toContain("<b>Server Deployment</b>");
    expect(widget.fallbackHtml).toContain("• <b>Status</b>: Operational");
    expect(widget.fallbackHtml).toContain("<b>Health Metrics</b>");
  });

  test("supports customHtml in interactive widget", () => {
    const spec: WidgetCardSpec = {
      title: "Custom LLM UI",
      customHtml: '<div class="custom-chart"><canvas id="chart"></canvas></div>',
      actions: [{ label: "Approve", action: "approve" }],
    };

    const widget = buildInteractiveWidget(spec);
    expect(widget.html).toContain('<div class="custom-chart"><canvas id="chart"></canvas></div>');
    expect(widget.html).toContain("Approve");
    expect(Buffer.byteLength(widget.html, "utf-8")).toBeLessThan(8192);
  });
});

describe("buildLiveStatusWidget", () => {
  test("generates compact dark-mode live status HUD", () => {
    const state: LiveStatusState = {
      phase: "working",
      currentStep: "Running tool: calendar",
      steps: ["Thinking", "Checking database", "Running tool: calendar"],
      startedAt: Date.now() - 5000,
      elapsedSec: 5,
    };

    const widget = buildLiveStatusWidget(state);

    expect(widget.html).toContain("<!DOCTYPE html>");
    expect(widget.html).toContain("#0e1621");
    expect(widget.html).toContain("Running tool: calendar");
    expect(widget.html).toContain("5s");
    expect(widget.html).toContain("dot-pulsing");
    expect(widget.html).toContain("Thinking");
    expect(widget.html).toContain("Checking database");
    expect(widget.html).toContain("step-trail");
    expect(widget.html).toContain("Array.isArray(data.steps)");
    expect(widget.html).toContain("TelegramWidget.onEvent");
    expect(widget.html).toContain("chatDataChanged");
    expect(widget.html).toContain("TelegramWidget.chatData");
    expect(widget.html).toContain("applyDataUpdates");
    expect(widget.html).toContain('id="hud-badge"');

    // Verify size < 8 KB (well under 32 KB)
    const byteSize = Buffer.byteLength(widget.html, "utf-8");
    expect(byteSize).toBeLessThan(8192);

    // Verify fallback HTML
    expect(widget.fallbackHtml).toContain("<b>⚡ Status:</b> Running tool: calendar (<code>5s</code>)");
    expect(widget.fallbackHtml).toContain("• ✓ Thinking");
    expect(widget.fallbackHtml).toContain("• ⚡ Running tool: calendar");

    // Verify chatData
    expect(widget.chatData.phase).toBe("working");
    expect(widget.chatData.currentStep).toBe("Running tool: calendar");
    expect(widget.chatData.elapsedSec).toBe(5);
  });
});

#!/usr/bin/env bun
/**
 * scripts/send-widget.ts
 *
 * Deterministic helper script to safely format and invoke `send_widget`.
 * Handles parsing of CLI arguments where `items` and `actions` may be passed
 * as JSON strings or arrays, ensuring robust conversion before tool execution.
 */

import { parseArgs } from "node:util";

const options = {
  title: { type: "string" as const },
  header: { type: "string" as const },
  body: { type: "string" as const },
  items: { type: "string" as const },
  actions: { type: "string" as const },
  customHtml: { type: "string" as const },
  help: { type: "boolean" as const, short: "h" },
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options,
  strict: false,
});

if (values.help) {
  console.log(`
Usage:
  bun run scripts/send-widget.ts --title="Title" --body="Text" [options]

Options:
  --title="<string>"       Card title
  --header="<string>"      Optional top header
  --body="<string>"        Card text
  --items="<json-string>"  Array of { label, value } or raw key/val
  --actions="<json-str>"   Array of { label, command }
  --customHtml="<html-str>" Custom Telegram HTML body
`);
  process.exit(0);
}

function safeParseJson(input: string | undefined): any {
  if (!input) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

const itemsRaw = typeof values.items === "string" ? values.items : undefined;
const actionsRaw = typeof values.actions === "string" ? values.actions : undefined;
const parsedItems = safeParseJson(itemsRaw);
const parsedActions = safeParseJson(actionsRaw);

// If customHtml is not provided and items are present, format a clean dark-mode representation
let html = typeof values.customHtml === "string" ? values.customHtml : "";
if (!html && Array.isArray(parsedItems)) {
  const itemRows = parsedItems
    .map((item) => `• <b>${item.label || item.key || ""}:</b> ${item.value || ""}`)
    .join("\n");
  const bodyText = typeof values.body === "string" ? values.body : "";
  html = bodyText ? `${bodyText}\n\n${itemRows}` : itemRows;
}

const cmdArgs = ["run", "src/cli.ts", "tool", "call", "send_widget"];
if (values.title) cmdArgs.push(`title=${values.title}`);
if (values.header) cmdArgs.push(`header=${values.header}`);
if (values.body) cmdArgs.push(`body=${values.body}`);
if (html) cmdArgs.push(`customHtml=${html}`);
if (values.actions) cmdArgs.push(`actions=${typeof values.actions === "string" ? values.actions : JSON.stringify(values.actions)}`);

console.error(`[send-widget] Executing send_widget with sanitized arguments...`);
const proc = Bun.spawn(["bun", ...cmdArgs], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
process.exit(exitCode);

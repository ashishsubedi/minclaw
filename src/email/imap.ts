import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { EmailAccount, EmailMessageSummary, ImapAccountData } from "./types.ts";
import { getEmailAccounts } from "./store.ts";

const HIMALAYA_DIR = join(homedir(), ".config/himalaya");
const HIMALAYA_CONFIG = join(HIMALAYA_DIR, "config.toml");

function sanitizeAccountKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Sync IMAP accounts stored in MinClaw into Himalaya config.toml
 * so CLI tools and Himalaya commands work seamlessly.
 */
export function syncHimalayaConfig(): void {
  try {
    if (!existsSync(HIMALAYA_DIR)) {
      mkdirSync(HIMALAYA_DIR, { recursive: true });
    }

    const accounts = getEmailAccounts().filter((a) => a.type === "imap" && a.imap);
    if (accounts.length === 0) return;

    let content = "";
    if (existsSync(HIMALAYA_CONFIG)) {
      content = readFileSync(HIMALAYA_CONFIG, "utf-8");
    }

    for (const acc of accounts) {
      const imap = acc.imap!;
      const key = sanitizeAccountKey(acc.id);
      const sectionHeader = `[accounts.${key}]`;

      // Remove any existing section for this account (old v1 or duplicate)
      const regex = new RegExp(`(^|\\n)\\[accounts\\.${key}\\][\\s\\S]*?(?=\\n\\[accounts\\.|\$)`, "g");
      content = content.replace(regex, "").trim();

      const port = imap.port || 993;
      const scheme = imap.tls !== false ? "imaps" : "imap";
      const block = [
        sectionHeader,
        `email = "${acc.email}"`,
        `display-name = "${acc.displayName || acc.email}"`,
        `imap.server = "${scheme}://${imap.host}:${port}"`,
        `imap.sasl.plain.authcid = "${imap.user || acc.email}"`,
        `imap.sasl.plain.passwd.raw = "${imap.pass}"`,
      ];

      if (imap.smtpHost) {
        const smtpPort = imap.smtpPort || 465;
        const smtpScheme = imap.smtpTls !== false ? "smtps" : "smtp";
        block.push(
          `smtp.server = "${smtpScheme}://${imap.smtpHost}:${smtpPort}"`,
          `smtp.sasl.plain.authcid = "${imap.smtpUser || imap.user || acc.email}"`,
          `smtp.sasl.plain.passwd.raw = "${imap.smtpPass || imap.pass}"`
        );
      }

      content += "\n\n" + block.join("\n");
    }

    writeFileSync(HIMALAYA_CONFIG, content.trim() + "\n", "utf-8");
  } catch (err) {
    console.warn(`[email] Himalaya config sync warning: ${err}`);
  }
}

/**
 * Fetch unread messages for an IMAP account using Himalaya CLI
 */
export async function listImapUnreadMessages(
  account: EmailAccount,
  maxResults = 10
): Promise<EmailMessageSummary[]> {
  const summaries: EmailMessageSummary[] = [];
  const key = sanitizeAccountKey(account.id);

  try {
    const proc = Bun.spawn(
      ["himalaya", "-a", key, "envelope", "list", "-s", String(maxResults), "--json"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!stdout.trim()) return summaries;
    const parsed = JSON.parse(stdout);
    const rawEnvelopes = Array.isArray(parsed) ? parsed : parsed.envelopes;
    if (!Array.isArray(rawEnvelopes)) return summaries;

    for (const env of rawEnvelopes) {
      const rawFlags = Array.isArray(env.flags) ? env.flags : [];
      const hasSeen = rawFlags.some((f: any) => {
        if (typeof f === "string") return f.toLowerCase() === "seen";
        const val = f?.iana || f?.raw || "";
        return String(val).toLowerCase().includes("seen");
      });

      let fromStr = "Unknown";
      if (Array.isArray(env.from) && env.from.length > 0) {
        const primary = env.from[0];
        fromStr = primary.name ? `"${primary.name}" <${primary.email || primary.addr}>` : primary.email || primary.addr || "Unknown";
      } else if (env.from && typeof env.from === "object") {
        fromStr = env.from.name ? `"${env.from.name}" <${env.from.email || env.from.addr}>` : env.from.email || env.from.addr || "Unknown";
      } else if (typeof env.from === "string") {
        fromStr = env.from;
      }

      summaries.push({
        id: String(env.id || env.internal_id || Math.random()),
        accountId: account.id,
        accountEmail: account.email,
        accountType: "imap",
        from: fromStr,
        subject: env.subject || "(no subject)",
        date: env.date || new Date().toISOString(),
        unread: !hasSeen,
      });
    }
  } catch (err) {
    console.warn(`[email] Failed to read IMAP envelopes for ${account.email}: ${err}`);
  }

  return summaries;
}

/**
 * Read the full content of an email message by ID via Himalaya CLI
 */
export async function readImapMessage(
  account: EmailAccount,
  messageId: string
): Promise<string> {
  const key = sanitizeAccountKey(account.id);
  const proc = Bun.spawn(
    ["himalaya", "-a", key, "message", "read", String(messageId)],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      `Himalaya message read failed (${exitCode}): ${stderr.trim() || stdout.trim() || "unknown error"}`
    );
  }

  return stdout.trim();
}

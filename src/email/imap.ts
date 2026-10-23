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

    let existingContent = "";
    if (existsSync(HIMALAYA_CONFIG)) {
      existingContent = readFileSync(HIMALAYA_CONFIG, "utf-8");
    }

    // Build TOML blocks for each IMAP account
    const lines: string[] = [existingContent.trim()];

    for (const acc of accounts) {
      const imap = acc.imap!;
      const key = sanitizeAccountKey(acc.id);
      const sectionHeader = `[accounts.${key}]`;

      // If section is already in config, skip rewriting it
      if (existingContent.includes(sectionHeader)) {
        continue;
      }

      const block = [
        "",
        sectionHeader,
        `email = "${acc.email}"`,
        `display-name = "${acc.displayName || acc.email}"`,
        `backend.type = "imap"`,
        `backend.host = "${imap.host}"`,
        `backend.port = ${imap.port || 993}`,
        `backend.encryption.type = "${imap.tls !== false ? "tls" : "none"}"`,
        `backend.login = "${imap.user || acc.email}"`,
        `backend.auth.type = "password"`,
        `backend.auth.password = "${imap.pass}"`,
      ];

      if (imap.smtpHost) {
        block.push(
          `message.send.backend.type = "smtp"`,
          `message.send.backend.host = "${imap.smtpHost}"`,
          `message.send.backend.port = ${imap.smtpPort || 465}`,
          `message.send.backend.encryption.type = "${imap.smtpTls !== false ? "tls" : "start-tls"}"`,
          `message.send.backend.login = "${imap.smtpUser || imap.user || acc.email}"`,
          `message.send.backend.auth.type = "password"`,
          `message.send.backend.auth.password = "${imap.smtpPass || imap.pass}"`
        );
      }

      lines.push(block.join("\n"));
    }

    const newContent = lines.filter(Boolean).join("\n\n") + "\n";
    writeFileSync(HIMALAYA_CONFIG, newContent, "utf-8");
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
      ["himalaya", "--account", key, "envelope", "list", "-s", String(maxResults), "--output", "json"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!stdout.trim()) return summaries;
    const envelopes = JSON.parse(stdout);
    if (!Array.isArray(envelopes)) return summaries;

    for (const env of envelopes) {
      const flags = env.flags || [];
      const isUnread = !flags.includes("seen") && !flags.includes("Seen");

      summaries.push({
        id: String(env.id || env.internal_id || Math.random()),
        accountId: account.id,
        accountEmail: account.email,
        accountType: "imap",
        from: env.from?.name ? `"${env.from.name}" <${env.from.addr}>` : env.from?.addr || "Unknown",
        subject: env.subject || "(no subject)",
        date: env.date || new Date().toISOString(),
        unread: isUnread,
      });
    }
  } catch (err) {
    console.warn(`[email] Failed to read IMAP envelopes for ${account.email}: ${err}`);
  }

  return summaries;
}

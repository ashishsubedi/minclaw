import { getEmailAccounts, refreshGoogleAccessToken } from "./store.ts";
import { listGoogleUnreadMessages, sendGoogleEmail, readGoogleMessage } from "./gmail.ts";
import { listImapUnreadMessages, readImapMessage } from "./imap.ts";
import type { EmailAccount, EmailMessageSummary } from "./types.ts";

/**
 * Fetch unread messages from ALL connected email accounts (Google + IMAP)
 */
export async function listAllUnreadEmails(
  maxPerAccount = 8,
  accountFilter?: string
): Promise<EmailMessageSummary[]> {
  const cappedPerAccount = Math.min(Math.max(1, maxPerAccount), 8);
  let accounts = getEmailAccounts().filter((a) => a.status === "connected");

  if (accountFilter && accountFilter.trim()) {
    const q = accountFilter.toLowerCase().trim();
    accounts = accounts.filter(
      (a) =>
        a.email.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.type.toLowerCase().includes(q) ||
        (a.displayName && a.displayName.toLowerCase().includes(q))
    );
  }

  const allSummaries: EmailMessageSummary[] = [];

  const promises = accounts.map(async (account) => {
    try {
      if (account.type === "google") {
        return await listGoogleUnreadMessages(account, cappedPerAccount);
      }
      if (account.type === "imap") {
        return await listImapUnreadMessages(account, cappedPerAccount);
      }
      return [];
    } catch (err) {
      console.warn(`[email] Failed to fetch unread emails for ${account.email}: ${err}`);
      return [];
    }
  });

  const results = await Promise.all(promises);
  for (const items of results) {
    allSummaries.push(...items);
  }

  // Sort newest first
  allSummaries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return allSummaries;
}

/**
 * Read the full content of an email message by ID across connected accounts
 */
export async function readEmailMessage(
  messageId: string,
  accountFilter?: string
): Promise<string> {
  let accounts = getEmailAccounts().filter((a) => a.status === "connected");

  if (accountFilter && accountFilter.trim()) {
    const q = accountFilter.toLowerCase().trim();
    accounts = accounts.filter(
      (a) =>
        a.email.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.type.toLowerCase().includes(q) ||
        (a.displayName && a.displayName.toLowerCase().includes(q))
    );
    if (accounts.length === 0) {
      throw new Error(`No connected email account matching filter '${accountFilter}' found.`);
    }
  } else {
    if (accounts.length === 0) {
      throw new Error("No connected email accounts found. Please connect an account in the Web UI.");
    }
    // If messageId is purely numeric (e.g. /^\d+$/, typical IMAP envelope ID like "1043"),
    // prioritize imap accounts first; otherwise prioritize google accounts first.
    const isNumericId = /^\d+$/.test(messageId.trim());
    accounts.sort((a, b) => {
      if (isNumericId) {
        return (a.type === "imap" ? 0 : 1) - (b.type === "imap" ? 0 : 1);
      }
      return (a.type === "google" ? 0 : 1) - (b.type === "google" ? 0 : 1);
    });
  }

  const errors: string[] = [];
  for (const account of accounts) {
    try {
      if (account.type === "google") {
        return await readGoogleMessage(account, messageId);
      }
      if (account.type === "imap") {
        return await readImapMessage(account, messageId);
      }
    } catch (err: any) {
      errors.push(`[${account.email} (${account.type})]: ${err.message || String(err)}`);
    }
  }

  throw new Error(
    `Could not read message ID '${messageId}' across ${accounts.length} account(s):\n${errors.join("\n")}`
  );
}

/**
 * Send an email from a specified account or the default connected account
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  fromEmail?: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const accounts = getEmailAccounts().filter((a) => a.status === "connected");
  if (accounts.length === 0) {
    return { ok: false, error: "No email accounts connected. Please connect an account in the Web UI." };
  }

  const account = fromEmail
    ? accounts.find((a) => a.email.toLowerCase() === fromEmail.toLowerCase()) || accounts[0]
    : accounts[0];

  if (!account) {
    return { ok: false, error: `Account ${fromEmail} not found.` };
  }

  if (account.type === "google") {
    return await sendGoogleEmail(account, to, subject, body);
  }

  return { ok: false, error: "Sending from IMAP accounts via web service is not yet supported. Use Gmail or Himalaya CLI." };
}

import { getEmailAccounts, refreshGoogleAccessToken } from "./store.ts";
import { listGoogleUnreadMessages, sendGoogleEmail } from "./gmail.ts";
import { listImapUnreadMessages } from "./imap.ts";
import type { EmailAccount, EmailMessageSummary } from "./types.ts";

/**
 * Fetch unread messages from ALL connected email accounts (Google + IMAP)
 */
export async function listAllUnreadEmails(maxPerAccount = 5): Promise<EmailMessageSummary[]> {
  const accounts = getEmailAccounts().filter((a) => a.status === "connected");
  const allSummaries: EmailMessageSummary[] = [];

  const promises = accounts.map(async (account) => {
    try {
      if (account.type === "google") {
        return await listGoogleUnreadMessages(account, maxPerAccount);
      }
      if (account.type === "imap") {
        return await listImapUnreadMessages(account, maxPerAccount);
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

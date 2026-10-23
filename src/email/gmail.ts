import { refreshGoogleAccessToken } from "./store.ts";
import type { EmailAccount, EmailCategory, EmailMessageSummary } from "./types.ts";

function base64url(str: string): string {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Fetch unread messages for a connected Google account via Gmail REST API
 */
export async function listGoogleUnreadMessages(
  account: EmailAccount,
  maxResults = 10
): Promise<EmailMessageSummary[]> {
  const token = await refreshGoogleAccessToken(account);

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=${maxResults}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!listRes.ok) {
    const errText = await listRes.text();
    throw new Error(`Gmail API list error (${listRes.status}): ${errText}`);
  }

  const listData = (await listRes.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
  };

  const rawMessages = listData.messages || [];
  if (rawMessages.length === 0) return [];

  const summaries: EmailMessageSummary[] = [];

  // Fetch metadata for each message in parallel
  const detailPromises = rawMessages.map(async (msg) => {
    try {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`;
      const msgRes = await fetch(msgUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!msgRes.ok) return null;

      const detail = (await msgRes.json()) as {
        id: string;
        threadId?: string;
        labelIds?: string[];
        snippet?: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
        };
      };

      const headers = detail.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      const labelIds = detail.labelIds || [];
      let category: EmailCategory = "other";
      if (labelIds.includes("CATEGORY_PERSONAL")) category = "primary";
      else if (labelIds.includes("CATEGORY_UPDATES")) category = "updates";
      else if (labelIds.includes("CATEGORY_PROMOTIONS")) category = "promotions";
      else if (labelIds.includes("CATEGORY_SOCIAL")) category = "social";
      else if (labelIds.includes("CATEGORY_FORUMS")) category = "forums";
      else if (labelIds.includes("INBOX")) category = "primary";

      return {
        id: detail.id,
        threadId: detail.threadId,
        accountId: account.id,
        accountEmail: account.email,
        accountType: "google" as const,
        from: getHeader("From") || "Unknown Sender",
        to: getHeader("To") || account.email,
        subject: getHeader("Subject") || "(no subject)",
        date: getHeader("Date") || new Date().toISOString(),
        snippet: detail.snippet || "",
        unread: true,
        labelIds,
        category,
      };
    } catch {
      return null;
    }
  });

  const resolved = await Promise.all(detailPromises);
  for (const item of resolved) {
    if (item) summaries.push(item);
  }

  return summaries;
}

/**
 * Send an email from a connected Google account via Gmail REST API
 */
export async function sendGoogleEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  bodyText: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const token = await refreshGoogleAccessToken(account);

    const rfcMessage = [
      `From: ${account.displayName ? `"${account.displayName}" <${account.email}>` : account.email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      `MIME-Version: 1.0`,
      ``,
      bodyText,
    ].join("\r\n");

    const raw = base64url(rfcMessage);

    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      return { ok: false, error: `Gmail send failed (${sendRes.status}): ${errText}` };
    }

    const data = (await sendRes.json()) as { id: string };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

async function getValidToken(accountEmail: string): Promise<string> {
  const accountsPath = join(homedir(), ".minclaw", "email-accounts.json");
  const oauthPath = join(homedir(), ".minclaw", "google-oauth.json");
  const accounts = JSON.parse(readFileSync(accountsPath, "utf8"));
  const oauth = JSON.parse(readFileSync(oauthPath, "utf8"));

  const acc = accounts.find((a: any) => a.email === accountEmail || (!accountEmail && a.type === "google"));

  if (!acc || !acc.google) {
    throw new Error(`Google account ${accountEmail} not found`);
  }

  const clientId = oauth.clientId || acc.google.clientId;
  const clientSecret = oauth.clientSecret || acc.google.clientSecret;
  const refreshToken = acc.google.refreshToken;

  console.log(`Using client_id: ${clientId?.slice(0, 15)}... with refresh token`);

  // Refresh token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  acc.google.accessToken = data.access_token;
  acc.google.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), "utf8");
  return data.access_token;
}

async function deleteEvent(eventId: string, accountEmail: string) {
  const token = await getValidToken(accountEmail);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 204 || res.status === 200 || res.status === 410) {
    console.log(`Successfully deleted event ${eventId}`);
  } else {
    const text = await res.text();
    console.error(`Failed to delete event: ${res.status} ${text}`);
    process.exit(1);
  }
}

const eventId = process.argv[2];
const accountEmail = process.argv[3];
if (!eventId) {
  console.error("Usage: bun run scripts/calendar-delete.ts <event_id> [account_email]");
  process.exit(1);
}
deleteEvent(eventId, accountEmail || "").catch((err) => {
  console.error(err);
  process.exit(1);
});

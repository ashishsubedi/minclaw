import { refreshGoogleAccessToken, getEmailAccounts, fetchGoogleWithRetry } from "./store.ts";
import type { EmailAccount } from "./types.ts";

export type CalendarEventSummary = {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  startTime: string;
  endTime: string;
  meetLink?: string;
  accountEmail: string;
};

let lastCalendarError: string | null = null;

export function getLastCalendarError(): string | null {
  return lastCalendarError;
}

/**
 * Fetch upcoming calendar events for a connected Google account
 */
export async function listUpcomingCalendarEvents(
  account: EmailAccount,
  maxResults = 10,
  timeMinIso?: string,
  timeMaxIso?: string
): Promise<CalendarEventSummary[]> {
  lastCalendarError = null;
  if (account.type !== "google") return [];

  let token = await refreshGoogleAccessToken(account);
  const timeMin = timeMinIso || new Date().toISOString();

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  if (timeMaxIso) url.searchParams.set("timeMax", timeMaxIso);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(maxResults));

  let res = await fetchGoogleWithRetry(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    token = await refreshGoogleAccessToken(account, true);
    res = await fetchGoogleWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || errText.includes("insufficientPermissions")) {
      lastCalendarError = `Google Calendar permission is not granted on ${account.email}. Reconnect on http://127.0.0.1:8787/#accounts with Calendar access enabled.`;
    }
    throw new Error(`Google Calendar API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      hangoutLink?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };

  const rawEvents = data.items || [];
  return rawEvents.map((item) => ({
    id: item.id,
    summary: item.summary || "(No Title)",
    description: item.description,
    location: item.location,
    startTime: item.start?.dateTime || item.start?.date || "",
    endTime: item.end?.dateTime || item.end?.date || "",
    meetLink: item.hangoutLink,
    accountEmail: account.email,
  }));
}

/**
 * Fetch upcoming events across all connected Google accounts
 */
export async function listAllUpcomingEvents(maxResults = 10): Promise<CalendarEventSummary[]> {
  const accounts = getEmailAccounts().filter((a) => a.type === "google" && a.status === "connected");
  const allEvents: CalendarEventSummary[] = [];

  for (const acc of accounts) {
    try {
      const events = await listUpcomingCalendarEvents(acc, maxResults);
      allEvents.push(...events);
    } catch (err) {
      console.warn(`[calendar] Failed to fetch events for ${acc.email}: ${err}`);
    }
  }

  allEvents.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return allEvents.slice(0, maxResults);
}

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

export type CreateCalendarEventParams = {
  summary: string;
  description?: string;
  location?: string;
  startTime: string;
  endTime?: string;
  accountEmail?: string;
};

export function parseCalendarDateTime(input: string, fallbackDate: Date = new Date()): Date {
  const trimmed = input.trim();

  // If already standard ISO with offset or Z, e.g. 2026-10-27T11:30:00+01:00 or 2026-10-27T10:30:00Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d;
  }

  // If YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD HH:mm:ss without offset, construct in local time
  const ymdMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1]!, 10);
    const month = parseInt(ymdMatch[2]!, 10) - 1;
    const day = parseInt(ymdMatch[3]!, 10);
    const hours = parseInt(ymdMatch[4]!, 10);
    const minutes = parseInt(ymdMatch[5]!, 10);
    const seconds = ymdMatch[6] ? parseInt(ymdMatch[6]!, 10) : 0;
    const d = new Date(year, month, day, hours, minutes, seconds);
    if (!isNaN(d.getTime())) return d;
  }

  // Time-only string: "11:30", "11:30am", "11:30 AM", "11:30:00"
  const timeMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]!, 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]!, 10) : 0;
    const seconds = timeMatch[3] ? parseInt(timeMatch[3]!, 10) : 0;
    const ampm = timeMatch[4]?.toLowerCase();
    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const d = new Date(fallbackDate);
    d.setHours(hours, minutes, seconds, 0);
    return d;
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;
  throw new Error(`Unable to parse date/time: "${input}"`);
}

/**
 * Create a new event on Google Calendar
 */
export async function createCalendarEvent(
  params: CreateCalendarEventParams
): Promise<CalendarEventSummary> {
  lastCalendarError = null;
  const accounts = getEmailAccounts().filter((a) => a.type === "google" && a.status === "connected");
  if (accounts.length === 0) {
    throw new Error("No connected Google account found.");
  }

  const account = params.accountEmail
    ? accounts.find((a) => a.email.toLowerCase() === params.accountEmail!.toLowerCase()) || accounts[0]!
    : accounts[0]!;

  let token = await refreshGoogleAccessToken(account);

  const startDate = parseCalendarDateTime(params.startTime);
  const endDate = params.endTime
    ? parseCalendarDateTime(params.endTime, startDate)
    : new Date(startDate.getTime() + 60 * 60 * 1000);

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");

  const eventPayload: Record<string, any> = {
    summary: params.summary,
    start: {
      dateTime: startDate.toISOString(),
    },
    end: {
      dateTime: endDate.toISOString(),
    },
  };
  if (params.description) eventPayload.description = params.description;
  if (params.location) eventPayload.location = params.location;

  let res = await fetchGoogleWithRetry(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(eventPayload),
  });

  if (res.status === 401) {
    token = await refreshGoogleAccessToken(account, true);
    res = await fetchGoogleWithRetry(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventPayload),
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || errText.includes("insufficientPermissions")) {
      lastCalendarError = `Google Calendar permission is not granted on ${account.email}. Reconnect on http://127.0.0.1:8787/#accounts with Calendar access enabled.`;
    }
    throw new Error(`Google Calendar API error (${res.status}): ${errText}`);
  }

  const item = (await res.json()) as any;
  return {
    id: item.id,
    summary: item.summary || params.summary,
    description: item.description,
    location: item.location,
    startTime: item.start?.dateTime || item.start?.date || startDate.toISOString(),
    endTime: item.end?.dateTime || item.end?.date || endDate.toISOString(),
    meetLink: item.hangoutLink,
    accountEmail: account.email,
  };
}

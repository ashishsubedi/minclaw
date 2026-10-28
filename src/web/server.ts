#!/usr/bin/env bun

import { existsSync } from "fs";
import { extname, join, resolve } from "path";
import { handleMessage } from "../router.ts";
import { addJob, parseTimeToJob, removeJob, triggerJob, updateJobMode } from "../scheduler/scheduler.ts";
import { installSkillByName, installSkillFromClawhub } from "../skills/installer.ts";
import { syncCatalog } from "../skills/catalog.ts";
import { clearSession, sessionKeyFromMessage } from "../session.ts";
import { clearAgySession } from "../agent.ts";
import { notifySessionCleared } from "../daemon/server.ts";
import { loadConfig } from "../config.ts";
import { getWhatsAppChannelStatus, requestWhatsAppPairing, resetWhatsAppAuth } from "../channels/whatsapp.ts";
import {
  getDashboardConfig,
  getDashboardOverview,
  getDashboardSessionMessages,
  getExtensionsStatus,
  getPermanentMemoryContent,
  getTemporaryMemoryContent,
  getTelemetryData,
  runGarbageCollection,
  saveDashboardConfig,
  searchDashboardMemory,
} from "./data.ts";
import {
  getEmailAccounts,
  removeEmailAccount,
  saveEmailAccount,
  getGoogleOAuthConfig,
  saveGoogleOAuthConfig,
  refreshGoogleAccessToken,
} from "../email/store.ts";
import { syncHimalayaConfig } from "../email/imap.ts";
import { listAllUnreadEmails } from "../email/service.ts";
import type { EmailAccount } from "../email/types.ts";
import {
  isScreenLocked,
  isTouchIdAvailable,
  verifyTouchId,
  verifyPassword,
  createSession,
  validateSession,
  revokeSession,
  extractSessionToken,
  createSessionCookieHeader,
  clearSessionCookieHeader,
} from "../auth/touchid.ts";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.NAKEDCLAW_WEB_PORT || "8787", 10);
const PUBLIC_ROOT = resolve(import.meta.dir, "../../public");
const WEB_DIR = join(PUBLIC_ROOT, "web");

type ChatBody = {
  text?: string;
  sessionKey?: string;
};

function contentTypeFor(pathname: string): string {
  switch (extname(pathname)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (extraHeaders) {
    if (extraHeaders instanceof Headers) {
      extraHeaders.forEach((val, key) => headers.set(key, val));
    } else if (Array.isArray(extraHeaders)) {
      for (const [key, val] of extraHeaders) {
        headers.set(key, val);
      }
    } else {
      for (const [key, val] of Object.entries(extraHeaders)) {
        headers.set(key, val);
      }
    }
  }
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers,
  });
}

function text(data: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(data, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

export function isValidOrigin(originStr: string): boolean {
  if (!originStr) return false;
  try {
    const parsed = new URL(originStr);
    const proto = parsed.protocol;
    const hostname = parsed.hostname.toLowerCase();

    if (proto !== "http:" && proto !== "https:") {
      return false;
    }

    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }

    if (hostname === "minclaw.localhost" || hostname.endsWith(".minclaw.localhost")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function verifyCsrfAndOrigin(
  req: Request,
  url: URL
): { ok: boolean; status?: number; error?: string } {
  // 1. Check Host header: must be localhost:<port>, 127.0.0.1:<port>, minclaw.localhost (or minclaw.localhost:<port>)
  const host = req.headers.get("host") || url.host || "";
  const validHostRegex = /^(localhost|127\.0\.0\.1|minclaw\.localhost|\[::1\])(:\d+)?$/i;
  if (!host || !validHostRegex.test(host.trim())) {
    return { ok: false, status: 403, error: "Invalid Host header" };
  }

  // 2. Allow OAuth callbacks like /api/auth/google/callback
  if (url.pathname === "/api/auth/google/callback") {
    return { ok: true };
  }

  // 3. Allow static assets (non /api/ paths) and non-mutating GET/HEAD/OPTIONS requests
  if (!url.pathname.startsWith("/api/")) {
    return { ok: true };
  }

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ok: true };
  }

  // 4. For mutating requests (POST, PUT, PATCH, DELETE):
  // Check Sec-Fetch-Site: if present, reject "cross-site". Allow "same-origin", "same-site", or "none"
  const secFetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite) {
    if (secFetchSite === "cross-site" || (secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none")) {
      return { ok: false, status: 403, error: "Cross-site requests forbidden" };
    }
  }

  // Check Origin / Referer: if present, origin must match http://localhost:*, http://127.0.0.1:*, http://minclaw.localhost*, https://minclaw.localhost*
  const origin = req.headers.get("origin");
  if (origin && !isValidOrigin(origin)) {
    return { ok: false, status: 403, error: "Cross-origin request forbidden" };
  }

  const referer = req.headers.get("referer");
  if (referer && !isValidOrigin(referer)) {
    return { ok: false, status: 403, error: "Cross-origin request forbidden" };
  }

  // Check Content-Type: must be application/json (ignoring parameters like charset) if request has a body. Reject text/plain or missing content-type on JSON API requests.
  const rawContentType = req.headers.get("content-type");
  const contentLength = req.headers.get("content-length");
  const hasContentLength = contentLength !== null && parseInt(contentLength, 10) > 0;
  const hasChunked = req.headers.get("transfer-encoding") === "chunked";
  const hasBody = req.body !== null || hasContentLength || hasChunked;

  if (rawContentType) {
    const mime = (rawContentType.split(";")[0] ?? "").trim().toLowerCase();
    if (mime !== "application/json") {
      return { ok: false, status: 415, error: "Content-Type must be application/json" };
    }
  } else if (hasBody) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }

  return { ok: true };
}

async function serveStatic(pathname: string): Promise<Response> {
  let normalized = pathname === "/" ? "/index.html" : pathname;
  if (normalized === "/favicon.ico") {
    normalized = "/minclaw.svg";
  }
  
  // Try WEB_DIR first
  let filePath = join(WEB_DIR, normalized);
  if (!existsSync(filePath)) {
    // Try PUBLIC_ROOT (for assets like minclaw.svg)
    filePath = join(PUBLIC_ROOT, normalized);
  }

  if (!filePath.startsWith(PUBLIC_ROOT) || !existsSync(filePath)) {
    return text("Not found", 404);
  }

  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": contentTypeFor(filePath),
      "cache-control": filePath.endsWith(".html") || filePath.endsWith(".js") ? "no-store" : "public, max-age=3600",
    },
  });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  if (req.method === "GET" && url.pathname === "/api/overview") {
    return json(await getDashboardOverview());
  }

  if (req.method === "GET" && url.pathname === "/api/telemetry") {
    return json(await getTelemetryData());
  }

  if (req.method === "POST" && url.pathname === "/api/telemetry/gc") {
    return json(runGarbageCollection());
  }

  if (req.method === "GET" && url.pathname === "/api/memory/permanent") {
    return json(getPermanentMemoryContent());
  }

  if (req.method === "GET" && url.pathname === "/api/memory/temporary") {
    return json(getTemporaryMemoryContent());
  }

  if (req.method === "GET" && url.pathname === "/api/extensions") {
    return json({ ok: true, extensions: getExtensionsStatus() });
  }

  if (req.method === "GET" && url.pathname === "/api/channels/whatsapp/status") {
    return json(getWhatsAppChannelStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/channels/whatsapp/pair") {
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const res = await requestWhatsAppPairing({ force });
    return json(res);
  }

  if (req.method === "POST" && url.pathname === "/api/channels/whatsapp/reset") {
    resetWhatsAppAuth();
    return json({ ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/channels/telegram/status") {
    const config = loadConfig();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    return json({
      enabled: !!config.channels?.telegram?.enabled,
      hasToken: !!token,
      ownerRecipient: config.owner?.recipient || "",
      allowedUsers: config.channels?.telegram?.allowFrom || [],
    });
  }

  if (req.method === "POST" && url.pathname === "/api/channels/telegram/config") {
    const body = (await req.json()) as { token?: string; ownerRecipient?: string };
    if (body.token) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${body.token.trim()}/getMe`);
        const data = (await res.json()) as any;
        if (!data.ok) {
          return json({ ok: false, error: data.description || "Invalid Telegram bot token" }, 400);
        }
        return json({ ok: true, bot: data.result, message: `Bot verified: @${data.result.username}` });
      } catch (err: any) {
        return json({ ok: false, error: err.message || "Failed to reach Telegram API" }, 400);
      }
    }
    return json({ ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const overview = await getDashboardOverview();
    return json({ sessions: overview.sessions.active, total: overview.sessions.total });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const sessionKey = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const session = getDashboardSessionMessages(sessionKey);
    return session ? json(session) : text("Session not found", 404);
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
    const sessionKey = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    clearSession(sessionKey);
    clearAgySession(sessionKey);
    notifySessionCleared(sessionKey);
    return json({ ok: true, sessionKey });
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const overview = await getDashboardOverview();
    return json({ jobs: overview.jobs });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const body = (await req.json()) as {
      when?: string;
      message?: string;
      mode?: "reminder" | "agent";
      name?: string;
    };
    if (!body.when || !body.message) {
      return json({ error: "Both 'when' and 'message' are required." }, 400);
    }
    const parsed = parseTimeToJob(body.when, "web", "web-dashboard");
    if (!parsed) {
      return json(
        { error: "Could not parse schedule time. Examples: 'in 30 minutes', 'at 3pm', 'every day at 9am'" },
        400
      );
    }
    parsed.message = body.message.trim();
    parsed.name = (body.name || body.message).trim().slice(0, 60);
    if (body.mode === "agent" || body.mode === "reminder") {
      parsed.mode = body.mode;
    }
    const job = addJob(parsed);
    return json({ ok: true, job });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
    const body = (await req.json()) as { mode?: "reminder" | "agent" | null };
    const updated = updateJobMode(jobId, body.mode ?? undefined);
    if (!updated) {
      return json({ error: "Job not found" }, 404);
    }
    return json({ ok: true, job: updated });
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/run")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/jobs/".length, -"/run".length));
    const job = triggerJob(jobId);
    if (!job) {
      return json({ error: "Job not found" }, 404);
    }
    return json({ ok: true, job, message: `Job '${job.name}' triggered successfully` });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
    return json({ ok: removeJob(jobId) });
  }

  if (req.method === "GET" && url.pathname === "/api/config/raw") {
    return json(getDashboardConfig());
  }

  if (req.method === "PUT" && url.pathname === "/api/config/raw") {
    const body = (await req.json()) as { raw?: string };
    if (typeof body.raw !== "string") {
      return text("Missing raw config", 400);
    }
    return json(saveDashboardConfig(body.raw));
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    const overview = await getDashboardOverview();
    return json({ skills: overview.skills });
  }

  if (req.method === "POST" && url.pathname === "/api/skills/sync") {
    const entries = await syncCatalog();
    return json({ ok: true, count: entries.length });
  }

  if (req.method === "POST" && url.pathname === "/api/skills/install") {
    const body = (await req.json()) as { name?: string; specId?: string; source?: string; version?: string };
    if (!body.name) return text("Missing skill name", 400);

    const result =
      body.source === "clawhub"
        ? await installSkillFromClawhub(body.name, body.version)
        : await installSkillByName(body.name, body.specId);

    return json(result, result.ok ? 200 : 400);
  }

  if (req.method === "GET" && url.pathname === "/api/memory/search") {
    const query = url.searchParams.get("q") || "";
    if (!query) return json({ results: [] });
    return json({ results: searchDashboardMemory(query) });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = (await req.json()) as ChatBody;
    const textToSend = body.text?.trim();
    if (!textToSend) return text("Missing text", 400);

    let channel = "web";
    let sender = "web-dashboard";
    if (body.sessionKey) {
      const idx = body.sessionKey.indexOf(":");
      if (idx > 0) {
        channel = body.sessionKey.slice(0, idx);
        sender = body.sessionKey.slice(idx + 1);
      } else {
        sender = body.sessionKey;
      }
    }

    const replies: string[] = [];
    const storedSessionKey = sessionKeyFromMessage(channel, sender);

    await handleMessage(
      {
        channel: channel as any,
        sender,
        senderName: "Web UI",
        text: textToSend,
        timestamp: Date.now(),
      },
      async (replyText: string) => {
        replies.push(replyText);
      }
    );

    return json({
      ok: true,
      sessionKey: storedSessionKey,
      replies,
      reply: replies.at(-1) || "",
    });
  }

  // --- Email & OAuth APIs ---
  if (req.method === "GET" && url.pathname === "/api/email/accounts") {
    const accounts = getEmailAccounts().map((a) => ({
      id: a.id,
      type: a.type,
      email: a.email,
      displayName: a.displayName,
      avatarUrl: a.avatarUrl,
      status: a.status,
      errorMessage: a.errorMessage,
      createdAt: a.createdAt,
      imapHost: a.imap?.host,
    }));
    return json({ accounts });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/email/accounts/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/email/accounts/".length));
    const ok = removeEmailAccount(id);
    return json({ ok });
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/email/accounts/") && url.pathname.endsWith("/test")) {
    const id = decodeURIComponent(url.pathname.slice("/api/email/accounts/".length, -"/test".length));
    const account = getEmailAccounts().find((a) => a.id === id);
    if (!account) return json({ error: "Account not found" }, 404);

    if (account.type === "google") {
      try {
        await refreshGoogleAccessToken(account, true);
        return json({ ok: true, message: "Google OAuth access token refreshed & connection verified." });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
    } else {
      try {
        const emails = await listAllUnreadEmails(1, account.id);
        return json({ ok: true, message: `IMAP connection verified (found ${emails.length} unread sample message(s)).` });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  }

  if (req.method === "POST" && url.pathname === "/api/email/accounts/imap") {
    const body = (await req.json()) as {
      email?: string;
      displayName?: string;
      host?: string;
      port?: number;
      tls?: boolean;
      user?: string;
      pass?: string;
      smtpHost?: string;
      smtpPort?: number;
      smtpTls?: boolean;
    };

    if (!body.email || !body.host || !body.pass) {
      return text("Email, host, and password are required", 400);
    }

    const id = `imap_${body.email.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
    const account: EmailAccount = {
      id,
      type: "imap",
      email: body.email.trim(),
      displayName: body.displayName?.trim() || body.email.trim(),
      imap: {
        host: body.host.trim(),
        port: Number(body.port) || 993,
        tls: body.tls !== false,
        user: (body.user || body.email).trim(),
        pass: body.pass,
        smtpHost: body.smtpHost?.trim(),
        smtpPort: body.smtpPort ? Number(body.smtpPort) : 465,
        smtpTls: body.smtpTls !== false,
      },
      createdAt: Date.now(),
      status: "connected",
    };

    saveEmailAccount(account);
    syncHimalayaConfig();
    return json({ ok: true, account: { id: account.id, email: account.email } });
  }

  if (req.method === "GET" && url.pathname === "/api/email/messages") {
    const messages = await listAllUnreadEmails(10);
    return json({ messages });
  }

  if (req.method === "GET" && url.pathname === "/api/email/google/config") {
    const cfg = getGoogleOAuthConfig();
    return json({
      configured: !!cfg,
      clientId: cfg?.clientId ? `${cfg.clientId.slice(0, 16)}...` : undefined,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/email/google/config") {
    const body = (await req.json()) as { clientId?: string; clientSecret?: string };
    if (!body.clientId || !body.clientSecret) {
      return text("Client ID and Client Secret are required", 400);
    }
    saveGoogleOAuthConfig({
      clientId: body.clientId.trim(),
      clientSecret: body.clientSecret.trim(),
    });
    return json({ ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google/start") {
    const config = getGoogleOAuthConfig();
    if (!config) {
      return text("Google OAuth Client ID & Secret not configured yet", 400);
    }

    const redirectUri = "http://127.0.0.1:8787/api/auth/google/callback";
    const scopes = [
      "openid",
      "email",
      "profile",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/calendar",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes,
      access_type: "offline",
      prompt: "consent",
    });

    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      return Response.redirect(`/#accounts?error=${encodeURIComponent(error)}`, 302);
    }
    if (!code) {
      return text("Missing authorization code", 400);
    }

    const config = getGoogleOAuthConfig();
    if (!config) {
      return text("Google OAuth configuration missing", 500);
    }

    const redirectUri = "http://127.0.0.1:8787/api/auth/google/callback";

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return Response.redirect(`/#accounts?error=${encodeURIComponent(`Token exchange failed: ${err}`)}`, 302);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Fetch user info (email, name, picture)
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = (await userRes.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };

    const email = userData.email || "unknown@gmail.com";
    const id = `google_${email.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
    const existing = getEmailAccounts().find((a) => a.id === id);

    const account: EmailAccount = {
      id,
      type: "google",
      email,
      displayName: userData.name || email,
      avatarUrl: userData.picture,
      google: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || existing?.google?.refreshToken || "",
        expiresAt: Date.now() + tokenData.expires_in * 1000,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      },
      createdAt: Date.now(),
      status: "connected",
    };

    saveEmailAccount(account);
    return Response.redirect(`/#accounts?success=google_connected&email=${encodeURIComponent(email)}`, 302);
  }

  return text("Not found", 404);
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/")) {
    const verifyResult = verifyCsrfAndOrigin(req, url);
    if (!verifyResult.ok) {
      return json({ error: verifyResult.error }, verifyResult.status || 403);
    }

    // Ungated auth endpoints:
    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      const token = extractSessionToken(req);
      const authenticated = validateSession(token);
      const locked = isScreenLocked();
      const touchIdAvailable = isTouchIdAvailable();
      return json({ authenticated, locked, touchIdAvailable });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/touchid") {
      if (isScreenLocked()) {
        return json({ ok: false, error: "macOS screen is locked" }, 401);
      }
      const success = await verifyTouchId();
      if (success) {
        const token = createSession();
        return json({ ok: true }, 200, {
          "Set-Cookie": createSessionCookieHeader(token),
        });
      }
      return json({ ok: false, error: "Touch ID verification failed or cancelled" }, 401);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password") {
      if (isScreenLocked()) {
        return json({ ok: false, error: "macOS screen is locked" }, 401);
      }
      let password = "";
      try {
        const body = (await req.json()) as { password?: string };
        if (typeof body?.password === "string") {
          password = body.password;
        }
      } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
      }

      if (verifyPassword(password)) {
        const token = createSession();
        return json({ ok: true }, 200, {
          "Set-Cookie": createSessionCookieHeader(token),
        });
      }
      return json({ ok: false, error: "Invalid password" }, 401);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/lock") {
      const token = extractSessionToken(req);
      if (token) {
        revokeSession(token);
      }
      return json({ ok: true }, 200, {
        "Set-Cookie": clearSessionCookieHeader(),
      });
    }

    if (url.pathname === "/api/auth/google/callback") {
      try {
        return await handleApi(req, url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, 500);
      }
    }

    // Gate ALL other /api/* endpoints:
    const token = extractSessionToken(req);
    if (!validateSession(token)) {
      return json(
        { error: "Authentication required", locked: isScreenLocked() },
        401
      );
    }

    try {
      return await handleApi(req, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  }

  return await serveStatic(url.pathname);
}

export function startWebServer(startPort = PORT): Bun.Server<undefined> {
  let lastError: unknown;

  for (let candidate = startPort; candidate < startPort + 20; candidate += 1) {
    try {
      const server = Bun.serve({
        hostname: HOST,
        port: candidate,
        fetch(req) {
          return handleRequest(req);
        },
      });

      if (server.port !== PORT) {
        console.log(`[web] MinClaw web UI port ${PORT} was busy; using http://${HOST}:${server.port}`);
      } else {
        console.log(`[web] MinClaw web UI listening on http://${HOST}:${server.port}`);
      }
      return server;
    } catch (err) {
      lastError = err;
      if (!(err instanceof Error) || !err.message.includes("EADDRINUSE")) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to start web server on ports ${startPort}-${startPort + 19}`);
}

if (import.meta.main) {
  startWebServer(PORT);
}
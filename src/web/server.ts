#!/usr/bin/env bun

import { existsSync } from "fs";
import { extname, join, resolve } from "path";
import { handleMessage } from "../router.ts";
import { removeJob } from "../scheduler/scheduler.ts";
import { installSkillByName, installSkillFromClawhub } from "../skills/installer.ts";
import { syncCatalog } from "../skills/catalog.ts";
import { sessionKeyFromMessage } from "../session.ts";
import {
  getDashboardConfig,
  getDashboardOverview,
  getDashboardSessionMessages,
  saveDashboardConfig,
  searchDashboardMemory,
} from "./data.ts";
import {
  getEmailAccounts,
  removeEmailAccount,
  saveEmailAccount,
  getGoogleOAuthConfig,
  saveGoogleOAuthConfig,
} from "../email/store.ts";
import { syncHimalayaConfig } from "../email/imap.ts";
import { listAllUnreadEmails } from "../email/service.ts";
import type { EmailAccount } from "../email/types.ts";

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
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

async function serveStatic(pathname: string): Promise<Response> {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  
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

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const overview = await getDashboardOverview();
    return json({ sessions: overview.sessions.active, total: overview.sessions.total });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const sessionKey = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const session = getDashboardSessionMessages(sessionKey);
    return session ? json(session) : text("Session not found", 404);
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const overview = await getDashboardOverview();
    return json({ jobs: overview.jobs });
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

    const sessionKey = body.sessionKey?.trim() || "web-dashboard";
    const replies: string[] = [];
    const storedSessionKey = sessionKeyFromMessage("web", sessionKey);

    await handleMessage(
      {
        channel: "web",
        sender: sessionKey,
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

export function startWebServer(startPort = PORT): Bun.Server<undefined> {
  let lastError: unknown;

  for (let candidate = startPort; candidate < startPort + 20; candidate += 1) {
    try {
      const server = Bun.serve({
        hostname: HOST,
        port: candidate,
        async fetch(req) {
          const url = new URL(req.url);

          if (url.pathname.startsWith("/api/")) {
            try {
              return await handleApi(req, url);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return json({ error: message }, 500);
            }
          }

          return await serveStatic(url.pathname);
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
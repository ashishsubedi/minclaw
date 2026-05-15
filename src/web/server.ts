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

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.NAKEDCLAW_WEB_PORT || "8787", 10);
const PUBLIC_DIR = resolve(import.meta.dir, "../../public/web");

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
  const filePath = join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    return text("Not found", 404);
  }

  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": contentTypeFor(filePath),
      "cache-control": pathname.endsWith(".html") || pathname.endsWith(".js") ? "no-store" : "public, max-age=3600",
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

  return text("Not found", 404);
}

function startServer(startPort: number): Bun.Server<WebSocket> {
  let lastError: unknown;

  for (let candidate = startPort; candidate < startPort + 20; candidate += 1) {
    try {
      return Bun.serve({
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

const server = startServer(PORT);

if (server.port !== PORT) {
  console.log(`MinClaw web UI port ${PORT} was busy; using http://${HOST}:${server.port}`);
} else {
  console.log(`MinClaw web UI listening on http://${HOST}:${server.port}`);
}
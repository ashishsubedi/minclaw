import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { statSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { verifyCsrfAndOrigin, isValidOrigin } from "../src/web/server.ts";
import { buildAgySpawnArgs } from "../src/agent.ts";
import {
  ensureStateDir,
  getStateDir,
  getCredsPath,
  saveProviderCredential,
  loadAllCredentials,
} from "../src/auth/credentials.ts";
import {
  saveEmailAccount,
  getEmailAccounts,
  saveGoogleOAuthConfig,
} from "../src/email/store.ts";
import {
  ensureMemoryDirs,
  appendChat,
  sessionKey,
} from "../src/memory/store.ts";
import {
  getSessionDir,
  appendMessage,
  getAllMessages,
} from "../src/session.ts";
import { startDaemonServer } from "../src/daemon/server.ts";
import { SOCKET_FILENAME } from "../src/daemon/protocol.ts";

describe("Phase 1 Security Hardening", () => {
  let testStateDir: string;
  const originalEnvStateDir = process.env.MINCLAW_STATE_DIR;

  beforeEach(() => {
    testStateDir = mkdtempSync(join(tmpdir(), "minclaw-sec-test-"));
    process.env.MINCLAW_STATE_DIR = testStateDir;
  });

  afterEach(() => {
    if (originalEnvStateDir !== undefined) {
      process.env.MINCLAW_STATE_DIR = originalEnvStateDir;
    } else {
      delete process.env.MINCLAW_STATE_DIR;
    }
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  describe("Web UI CSRF & Origin Shield (verifyCsrfAndOrigin)", () => {
    test("accepts valid localhost GET and HEAD requests", () => {
      const getReq = new Request("http://localhost:8787/api/overview", {
        headers: { host: "localhost:8787" },
      });
      const getRes = verifyCsrfAndOrigin(getReq, new URL(getReq.url));
      expect(getRes.ok).toBe(true);

      const headReq = new Request("http://127.0.0.1:8787/api/overview", {
        method: "HEAD",
        headers: { host: "127.0.0.1:8787" },
      });
      const headRes = verifyCsrfAndOrigin(headReq, new URL(headReq.url));
      expect(headRes.ok).toBe(true);
    });

    test("accepts valid localhost POST with Content-Type: application/json and matching Origin", () => {
      const postReq = new Request("http://localhost:8787/api/jobs", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          "content-type": "application/json; charset=utf-8",
          origin: "http://localhost:8787",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ when: "in 10m", message: "check in" }),
      });
      const postRes = verifyCsrfAndOrigin(postReq, new URL(postReq.url));
      expect(postRes.ok).toBe(true);
    });

    test("accepts 127.0.0.1 and minclaw.localhost origins", () => {
      expect(isValidOrigin("http://localhost:8787")).toBe(true);
      expect(isValidOrigin("http://127.0.0.1:8787")).toBe(true);
      expect(isValidOrigin("http://minclaw.localhost:8787")).toBe(true);
      expect(isValidOrigin("https://minclaw.localhost:8787")).toBe(true);
      expect(isValidOrigin("https://sub.minclaw.localhost")).toBe(true);
      expect(isValidOrigin("http://attacker.com")).toBe(false);
      expect(isValidOrigin("http://localhost.evil.com")).toBe(false);
      expect(isValidOrigin("null")).toBe(false);

      const req = new Request("http://minclaw.localhost:8787/api/chat", {
        method: "POST",
        headers: {
          host: "minclaw.localhost:8787",
          "content-type": "application/json",
          origin: "http://minclaw.localhost:8787",
        },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(verifyCsrfAndOrigin(req, new URL(req.url)).ok).toBe(true);
    });

    test("rejects cross-origin POST with Sec-Fetch-Site: cross-site", () => {
      const req = new Request("http://localhost:8787/api/jobs", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
          origin: "http://evil.com",
        },
        body: JSON.stringify({ when: "now", message: "exploit" }),
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
      expect(res.error).toContain("Cross-site");
    });

    test("rejects cross-origin POST with foreign Origin", () => {
      const req = new Request("http://localhost:8787/api/jobs", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          "content-type": "application/json",
          origin: "https://evil-site.com",
        },
        body: JSON.stringify({ when: "now", message: "exploit" }),
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
      expect(res.error).toContain("Cross-origin");
    });

    test("rejects cross-origin POST with foreign Referer", () => {
      const req = new Request("http://localhost:8787/api/jobs", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          "content-type": "application/json",
          referer: "https://attacker.org/phish",
        },
        body: JSON.stringify({ when: "now", message: "exploit" }),
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
    });

    test("rejects mutating POST with Content-Type: text/plain", () => {
      const req = new Request("http://localhost:8787/api/jobs", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          "content-type": "text/plain",
          origin: "http://localhost:8787",
        },
        body: "text body that bypasses simple preflight",
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(false);
      expect(res.status).toBe(415);
      expect(res.error).toContain("application/json");
    });

    test("rejects mutating POST with missing Content-Type on request with body", () => {
      const req = new Request("http://localhost:8787/api/jobs", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "http://localhost:8787",
        },
        body: JSON.stringify({ test: 1 }),
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(false);
      expect(res.status).toBe(415);
    });

    test("rejects invalid Host header", () => {
      const req = new Request("http://localhost:8787/api/overview", {
        headers: { host: "evil-rebinding.org" },
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
      expect(res.error).toContain("Host");
    });

    test("permits Google OAuth callback even with cross-site Referer", () => {
      const req = new Request("http://localhost:8787/api/auth/google/callback?code=mock_code_123", {
        headers: {
          host: "localhost:8787",
          "sec-fetch-site": "cross-site",
          referer: "https://accounts.google.com/",
        },
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(true);
    });

    test("permits static assets without API checks", () => {
      const req = new Request("http://localhost:8787/dashboard.js", {
        headers: { host: "localhost:8787" },
      });
      const res = verifyCsrfAndOrigin(req, new URL(req.url));
      expect(res.ok).toBe(true);
    });
  });

  describe("Agent --sandbox configuration", () => {
    test("buildAgySpawnArgs generates spawn args with --sandbox and expected flags", () => {
      const args = buildAgySpawnArgs("Test prompt text", "gemini-3.8-flash-medium", "conv-test-999");

      expect(args[0]).toBe("agy");
      expect(args).toContain("--sandbox");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--disable-slash-commands");
      expect(args).toContain("--print-timeout");
      expect(args).toContain("180s");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--model");
      expect(args).toContain("gemini-3.8-flash-medium");
      expect(args).toContain("--conversation");
      expect(args).toContain("conv-test-999");
    });
  });

  describe("Filesystem & Socket Permissions (0700 & 0600)", () => {
    test("ensureStateDir creates ~/.minclaw, tmp, and logs with 0700 permissions", () => {
      ensureStateDir();

      const dirStat = statSync(testStateDir);
      expect((dirStat.mode & 0o777).toString(8)).toBe("700");

      const logsDir = join(testStateDir, "logs");
      const logsStat = statSync(logsDir);
      expect((logsStat.mode & 0o777).toString(8)).toBe("700");

      const tmpDir = join(testStateDir, "tmp");
      const tmpStat = statSync(tmpDir);
      expect((tmpStat.mode & 0o777).toString(8)).toBe("700");
    });

    test("credentials.json is saved with 0600 permissions", () => {
      saveProviderCredential("anthropic", {
        method: "api_key",
        apiKey: "sk-ant-test-key",
      });

      const credsPath = getCredsPath();
      expect(existsSync(credsPath)).toBe(true);
      const stat = statSync(credsPath);
      expect((stat.mode & 0o777).toString(8)).toBe("600");

      const creds = loadAllCredentials();
      expect(creds.anthropic).toBeDefined();
    });

    test("email accounts and google oauth config are saved with 0600 permissions", () => {
      saveGoogleOAuthConfig({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
      const googleOAuthFile = join(testStateDir, "google-oauth.json");
      expect(existsSync(googleOAuthFile)).toBe(true);
      expect((statSync(googleOAuthFile).mode & 0o777).toString(8)).toBe("600");

      saveEmailAccount({
        id: "test-acc-1",
        type: "google",
        email: "test@example.com",
        displayName: "Tester",
        createdAt: Date.now(),
        status: "connected",
      });
      const accountsFile = join(testStateDir, "email-accounts.json");
      expect(existsSync(accountsFile)).toBe(true);
      expect((statSync(accountsFile).mode & 0o777).toString(8)).toBe("600");
    });

    test("memory chats and sessions enforce 0700 dir and 0600 file permissions", () => {
      ensureMemoryDirs();
      const sKey = sessionKey("unit-test", `user-${Date.now()}`);
      appendChat("unit-test", `user-${Date.now()}`, "user", "Hello security check");

      // Check session jsonl writing
      const sessionDir = getSessionDir();
      expect(existsSync(sessionDir)).toBe(true);
      expect((statSync(sessionDir).mode & 0o777).toString(8)).toBe("700");

      const sessionTestKey = `sec-test-session-${Date.now()}`;
      appendMessage(sessionTestKey, {
        role: "user",
        content: "checking permissions",
        timestamp: Date.now(),
      });
      const jsonlPath = join(sessionDir, `${sessionTestKey}.jsonl`);
      expect(existsSync(jsonlPath)).toBe(true);
      expect((statSync(jsonlPath).mode & 0o777).toString(8)).toBe("600");

      const msgs = getAllMessages(sessionTestKey);
      expect(msgs.length).toBe(1);
    });

    test("daemon unix domain socket file enforces 0600 permissions", () => {
      const server = startDaemonServer();
      try {
        const socketPath = join(testStateDir, SOCKET_FILENAME);
        expect(existsSync(socketPath)).toBe(true);
        const socketStat = statSync(socketPath);
        expect((socketStat.mode & 0o777).toString(8)).toBe("600");
      } finally {
        server.stop();
      }
    });
  });
});

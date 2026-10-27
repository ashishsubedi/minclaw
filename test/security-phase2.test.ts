import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearAllSessions,
  clearSessionCookieHeader,
  createSession,
  createSessionCookieHeader,
  extractSessionToken,
  getActiveSessionCount,
  getStoredPassword,
  isScreenLocked,
  isTouchIdAvailable,
  revokeSession,
  saveStoredPassword,
  validateSession,
  verifyPassword,
  verifyTouchId,
  SESSION_TTL_MS,
} from "../src/auth/touchid.ts";
import { handleRequest, verifyCsrfAndOrigin } from "../src/web/server.ts";

describe("Phase 2 Security Hardening: Touch ID & Screen-Lock Session Manager", () => {
  let tempStateDir: string;
  const originalStateDir = process.env.MINCLAW_STATE_DIR;
  const originalTestLocked = process.env.MINCLAW_TEST_LOCKED;
  const originalTestTouchId = process.env.MINCLAW_TEST_TOUCHID;
  const originalTestTouchIdAvailable = process.env.MINCLAW_TEST_TOUCHID_AVAILABLE;
  const originalWebPassword = process.env.MINCLAW_WEB_PASSWORD;

  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), "minclaw-sec2-test-"));
    process.env.MINCLAW_STATE_DIR = tempStateDir;
    delete process.env.MINCLAW_TEST_LOCKED;
    delete process.env.MINCLAW_TEST_TOUCHID;
    delete process.env.MINCLAW_TEST_TOUCHID_AVAILABLE;
    delete process.env.MINCLAW_WEB_PASSWORD;
    clearAllSessions();
  });

  afterEach(() => {
    clearAllSessions();
    if (originalStateDir !== undefined) {
      process.env.MINCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.MINCLAW_STATE_DIR;
    }
    if (originalTestLocked !== undefined) {
      process.env.MINCLAW_TEST_LOCKED = originalTestLocked;
    } else {
      delete process.env.MINCLAW_TEST_LOCKED;
    }
    if (originalTestTouchId !== undefined) {
      process.env.MINCLAW_TEST_TOUCHID = originalTestTouchId;
    } else {
      delete process.env.MINCLAW_TEST_TOUCHID;
    }
    if (originalTestTouchIdAvailable !== undefined) {
      process.env.MINCLAW_TEST_TOUCHID_AVAILABLE = originalTestTouchIdAvailable;
    } else {
      delete process.env.MINCLAW_TEST_TOUCHID_AVAILABLE;
    }
    if (originalWebPassword !== undefined) {
      process.env.MINCLAW_WEB_PASSWORD = originalWebPassword;
    } else {
      delete process.env.MINCLAW_WEB_PASSWORD;
    }

    try {
      if (existsSync(tempStateDir)) {
        rmSync(tempStateDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("Native Touch ID & Screen Lock Detection", () => {
    test("detects screen lock state and respects MINCLAW_TEST_LOCKED env var", () => {
      // In normal test execution without lock, isScreenLocked() should return boolean
      const naturalLock = isScreenLocked();
      expect(typeof naturalLock).toBe("boolean");

      // Mock locked = true
      process.env.MINCLAW_TEST_LOCKED = "true";
      expect(isScreenLocked()).toBe(true);

      process.env.MINCLAW_TEST_LOCKED = "1";
      expect(isScreenLocked()).toBe(true);

      // Mock locked = false
      process.env.MINCLAW_TEST_LOCKED = "false";
      expect(isScreenLocked()).toBe(false);

      process.env.MINCLAW_TEST_LOCKED = "0";
      expect(isScreenLocked()).toBe(false);
    });

    test("checks Touch ID availability and respects MINCLAW_TEST_TOUCHID_AVAILABLE env var", () => {
      process.env.MINCLAW_TEST_TOUCHID_AVAILABLE = "true";
      expect(isTouchIdAvailable()).toBe(true);

      process.env.MINCLAW_TEST_TOUCHID_AVAILABLE = "false";
      expect(isTouchIdAvailable()).toBe(false);
    });

    test("verifyTouchId respects MINCLAW_TEST_TOUCHID env var", async () => {
      process.env.MINCLAW_TEST_TOUCHID = "true";
      const success = await verifyTouchId();
      expect(success).toBe(true);

      process.env.MINCLAW_TEST_TOUCHID = "false";
      const failure = await verifyTouchId();
      expect(failure).toBe(false);
    });

    test("compiled bin/minclaw-touchid binary runs CLI actions correctly", () => {
      const binPath = join(import.meta.dir, "../bin/minclaw-touchid");
      expect(existsSync(binPath)).toBe(true);

      // Test is-locked CLI
      const proc = Bun.spawnSync([binPath, "is-locked"]);
      const out = proc.stdout.toString().trim();
      expect(["true", "false"]).toContain(out);
      if (out === "true") {
        expect(proc.exitCode).toBe(0);
      } else {
        expect(proc.exitCode).toBe(1);
      }

      // Test check/can-prompt CLI
      const checkProc = Bun.spawnSync([binPath, "check"]);
      expect([0, 2]).toContain(checkProc.exitCode);
    });
  });

  describe("Session Issuance, Sliding Idle Expiry & Revocation", () => {
    test("creates session tokens and validates them", () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token = createSession();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(10);

      expect(validateSession(token)).toBe(true);
      expect(getActiveSessionCount()).toBe(1);
    });

    test("supports sliding idle TTL (1 hour)", () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token = createSession();
      const baseTime = 1000000000;

      // Initial validation at baseTime
      expect(validateSession(token, baseTime)).toBe(true);

      // Activity at 30 minutes (1800s) -> slides TTL
      const thirtyMinsLater = baseTime + 1800 * 1000;
      expect(validateSession(token, thirtyMinsLater)).toBe(true);

      // Activity at 75 minutes from baseTime (which is 45 minutes after the 30-min slide) -> still valid!
      const seventyFiveMinsLater = baseTime + 4500 * 1000; // 30m + 45m = 75m
      expect(validateSession(token, seventyFiveMinsLater)).toBe(true);

      // Now jump 61 minutes after the last activity -> should expire!
      const expiredTime = seventyFiveMinsLater + 3601 * 1000;
      expect(validateSession(token, expiredTime)).toBe(false);

      // Session has been purged
      expect(getActiveSessionCount()).toBe(0);
    });

    test("revokes session manually", () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token = createSession();
      expect(validateSession(token)).toBe(true);

      const revoked = revokeSession(token);
      expect(revoked).toBe(true);
      expect(validateSession(token)).toBe(false);
      expect(getActiveSessionCount()).toBe(0);
    });

    test("extracts minclaw_session cookie accurately", () => {
      const req1 = new Request("http://localhost:8787/api/overview", {
        headers: { cookie: "minclaw_session=test-token-12345" },
      });
      expect(extractSessionToken(req1)).toBe("test-token-12345");

      const req2 = new Request("http://localhost:8787/api/overview", {
        headers: { cookie: "foo=bar; minclaw_session=abc-xyz-789; other=value" },
      });
      expect(extractSessionToken(req2)).toBe("abc-xyz-789");

      const req3 = new Request("http://localhost:8787/api/overview", {
        headers: { cookie: "minclaw_session=" },
      });
      expect(extractSessionToken(req3)).toBe(null);

      const req4 = new Request("http://localhost:8787/api/overview");
      expect(extractSessionToken(req4)).toBe(null);
    });

    test("formats session cookie headers according to spec", () => {
      const setCookie = createSessionCookieHeader("secret-token");
      expect(setCookie).toBe("minclaw_session=secret-token; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600");

      const clearCookie = clearSessionCookieHeader();
      expect(clearCookie).toBe("minclaw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    });
  });

  describe("Screen-Lock Session Invalidation", () => {
    test("invalidates all active sessions immediately when macOS screen is locked", () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token1 = createSession();
      const token2 = createSession();
      expect(validateSession(token1)).toBe(true);
      expect(validateSession(token2)).toBe(true);
      expect(getActiveSessionCount()).toBe(2);

      // Screen locks!
      process.env.MINCLAW_TEST_LOCKED = "true";

      // Validating an active token while screen is locked must fail and clear all sessions
      expect(validateSession(token1)).toBe(false);
      expect(getActiveSessionCount()).toBe(0);

      // When screen unlocks again, previous sessions must NOT be restored
      process.env.MINCLAW_TEST_LOCKED = "false";
      expect(validateSession(token1)).toBe(false);
      expect(validateSession(token2)).toBe(false);
      expect(getActiveSessionCount()).toBe(0);
    });
  });

  describe("Password Verification & ~/.minclaw/auth.json", () => {
    test("verifies against MINCLAW_WEB_PASSWORD if set", () => {
      process.env.MINCLAW_WEB_PASSWORD = "super-secret-password";
      expect(verifyPassword("super-secret-password")).toBe(true);
      expect(verifyPassword("wrong-password")).toBe(false);
      expect(verifyPassword("")).toBe(false);
    });

    test("saves and verifies password from ~/.minclaw/auth.json with 0600 permissions", () => {
      saveStoredPassword("my-persisted-password");

      const authFile = join(tempStateDir, "auth.json");
      expect(existsSync(authFile)).toBe(true);

      const stat = statSync(authFile);
      expect(stat.mode & 0o777).toBe(0o600);

      const parsed = JSON.parse(readFileSync(authFile, "utf-8"));
      expect(parsed.password).toBe("my-persisted-password");

      expect(verifyPassword("my-persisted-password")).toBe(true);
      expect(verifyPassword("wrong")).toBe(false);
    });

    test("supports default empty or 'minclaw' when unconfigured", () => {
      expect(verifyPassword("")).toBe(true);
      expect(verifyPassword("minclaw")).toBe(true);
      expect(verifyPassword("random-unconfigured-pass")).toBe(false);
    });
  });

  describe("Web API Endpoints & Auth Gating", () => {
    test("GET /api/auth/status returns correct state without prior auth", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      process.env.MINCLAW_TEST_TOUCHID_AVAILABLE = "true";

      const req = new Request("http://localhost:8787/api/auth/status", {
        headers: { host: "localhost:8787" },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.authenticated).toBe(false);
      expect(data.locked).toBe(false);
      expect(data.touchIdAvailable).toBe(true);
    });

    test("GET /api/auth/status reports locked: true when screen is locked", async () => {
      process.env.MINCLAW_TEST_LOCKED = "true";
      process.env.MINCLAW_TEST_TOUCHID_AVAILABLE = "true";

      const req = new Request("http://localhost:8787/api/auth/status", {
        headers: { host: "localhost:8787" },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.authenticated).toBe(false);
      expect(data.locked).toBe(true);
    });

    test("unauthenticated access to gated /api/overview returns 401 with locked flag", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";

      const req = new Request("http://localhost:8787/api/overview", {
        headers: { host: "localhost:8787" },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.error).toBe("Authentication required");
      expect(data.locked).toBe(false);
    });

    test("unauthenticated access to gated /api/memory/permanent returns 401", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";

      const req = new Request("http://localhost:8787/api/memory/permanent", {
        headers: { host: "localhost:8787" },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(401);
    });

    test("authenticated request with minclaw_session cookie succeeds on gated endpoints", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token = createSession();

      const req = new Request("http://localhost:8787/api/overview", {
        headers: {
          host: "localhost:8787",
          cookie: `minclaw_session=${token}`,
        },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.daemon).toBeDefined();
    });

    test("POST /api/auth/touchid issues session on success and sets HttpOnly cookie", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      process.env.MINCLAW_TEST_TOUCHID = "true";

      const req = new Request("http://localhost:8787/api/auth/touchid", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "http://localhost:8787",
        },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("minclaw_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Max-Age=3600");
    });

    test("POST /api/auth/touchid returns 401 when Touch ID verification fails", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      process.env.MINCLAW_TEST_TOUCHID = "false";

      const req = new Request("http://localhost:8787/api/auth/touchid", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "http://localhost:8787",
        },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    test("POST /api/auth/password verifies password and issues session cookie", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      process.env.MINCLAW_WEB_PASSWORD = "test-master-password";

      // Valid password
      const validReq = new Request("http://localhost:8787/api/auth/password", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "http://localhost:8787",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "test-master-password" }),
      });
      const validRes = await handleRequest(validReq);
      expect(validRes.status).toBe(200);

      const validData = await validRes.json();
      expect(validData.ok).toBe(true);
      expect(validRes.headers.get("set-cookie")).toContain("minclaw_session=");

      // Invalid password
      const invalidReq = new Request("http://localhost:8787/api/auth/password", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "http://localhost:8787",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      const invalidRes = await handleRequest(invalidReq);
      expect(invalidRes.status).toBe(401);

      const invalidData = await invalidRes.json();
      expect(invalidData.ok).toBe(false);
      expect(invalidData.error).toContain("Invalid password");
    });

    test("POST /api/auth/lock revokes session and clears session cookie", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token = createSession();
      expect(validateSession(token)).toBe(true);

      const req = new Request("http://localhost:8787/api/auth/lock", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "http://localhost:8787",
          cookie: `minclaw_session=${token}`,
        },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);

      // Cleared cookie header (Max-Age=0)
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("minclaw_session=;");
      expect(setCookie).toContain("Max-Age=0");

      // Session is now revoked
      expect(validateSession(token)).toBe(false);
    });

    test("screen lock invalidates active session cookie during ongoing API calls", async () => {
      process.env.MINCLAW_TEST_LOCKED = "false";
      const token = createSession();

      // First call succeeds
      const req1 = new Request("http://localhost:8787/api/overview", {
        headers: {
          host: "localhost:8787",
          cookie: `minclaw_session=${token}`,
        },
      });
      const res1 = await handleRequest(req1);
      expect(res1.status).toBe(200);

      // Now screen locks
      process.env.MINCLAW_TEST_LOCKED = "true";

      const req2 = new Request("http://localhost:8787/api/overview", {
        headers: {
          host: "localhost:8787",
          cookie: `minclaw_session=${token}`,
        },
      });
      const res2 = await handleRequest(req2);
      expect(res2.status).toBe(401);

      const data2 = await res2.json();
      expect(data2.locked).toBe(true);
    });

    test("CSRF protection rejects cross-site attempts to POST /api/auth/touchid", async () => {
      const evilReq = new Request("http://localhost:8787/api/auth/touchid", {
        method: "POST",
        headers: {
          host: "localhost:8787",
          origin: "https://evil.com",
          "sec-fetch-site": "cross-site",
        },
      });
      const res = await handleRequest(evilReq);
      expect(res.status).toBe(403);
    });

    test("static assets continue to serve without authentication", async () => {
      const req = new Request("http://localhost:8787/index.html", {
        headers: { host: "localhost:8787" },
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("MinClaw Dashboard Locked");
      expect(text).toContain("lockOverlay");
    });
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname, join, resolve } from "path";
import { getStateDir, ensureStateDir } from "./credentials.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../");
const BIN_PATH = join(PROJECT_ROOT, "bin", "minclaw-touchid");
const SWIFT_SRC = join(import.meta.dir, "touchid.swift");

let compileAttempted = false;

/**
 * Ensure the native Touch ID helper binary is compiled.
 * Auto-compiles on first access if missing.
 */
export function ensureTouchIdBinary(): string {
  if (existsSync(BIN_PATH)) {
    return BIN_PATH;
  }

  if (compileAttempted) {
    return BIN_PATH;
  }
  compileAttempted = true;

  if (process.platform !== "darwin" || !existsSync(SWIFT_SRC)) {
    return BIN_PATH;
  }

  try {
    const binDir = dirname(BIN_PATH);
    if (!existsSync(binDir)) {
      mkdirSync(binDir, { recursive: true, mode: 0o700 });
    }

    const proc = Bun.spawnSync(
      [
        "swiftc",
        "-O",
        "-framework",
        "Foundation",
        "-framework",
        "CoreGraphics",
        "-framework",
        "LocalAuthentication",
        SWIFT_SRC,
        "-o",
        BIN_PATH,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    if (proc.exitCode === 0) {
      try {
        chmodSync(BIN_PATH, 0o755);
      } catch {}
    }
  } catch (err) {
    console.warn("[touchid] Warning: Failed to auto-compile minclaw-touchid:", err);
  }

  return BIN_PATH;
}

/**
 * Check whether macOS is currently locked.
 * Supports MINCLAW_TEST_LOCKED environment variable for testing.
 */
export function isScreenLocked(): boolean {
  if (process.env.MINCLAW_TEST_LOCKED !== undefined) {
    const val = process.env.MINCLAW_TEST_LOCKED.toLowerCase().trim();
    return val === "1" || val === "true";
  }

  if (process.platform !== "darwin") {
    return false;
  }

  try {
    ensureTouchIdBinary();
    if (!existsSync(BIN_PATH)) {
      return false;
    }

    const proc = Bun.spawnSync([BIN_PATH, "is-locked"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Exit code 0 means locked, 1 means not locked
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check whether Touch ID / Biometrics or Passcode evaluation is available on this system.
 */
export function isTouchIdAvailable(): boolean {
  if (process.env.MINCLAW_TEST_TOUCHID_AVAILABLE !== undefined) {
    const val = process.env.MINCLAW_TEST_TOUCHID_AVAILABLE.toLowerCase().trim();
    return val === "1" || val === "true";
  }

  if (process.platform !== "darwin") {
    return false;
  }

  try {
    ensureTouchIdBinary();
    if (!existsSync(BIN_PATH)) {
      return false;
    }

    const proc = Bun.spawnSync([BIN_PATH, "check"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Prompt user for Touch ID biometric verification.
 * Supports MINCLAW_TEST_TOUCHID environment variable for testing.
 */
export async function verifyTouchId(reason = "Unlock MinClaw Dashboard"): Promise<boolean> {
  if (process.env.MINCLAW_TEST_TOUCHID !== undefined) {
    const val = process.env.MINCLAW_TEST_TOUCHID.toLowerCase().trim();
    return val === "1" || val === "true";
  }

  if (process.platform !== "darwin") {
    return false;
  }

  try {
    ensureTouchIdBinary();
    if (!existsSync(BIN_PATH)) {
      return false;
    }

    const proc = Bun.spawn([BIN_PATH, "prompt", reason], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // 60-second timeout
    let timer: Timer | null = null;
    const timeoutPromise = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve(-1);
      }, 60000);
    });

    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    if (timer) clearTimeout(timer);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get stored master password from MINCLAW_WEB_PASSWORD or ~/.minclaw/auth.json.
 */
export function getStoredPassword(): string | null {
  if (process.env.MINCLAW_WEB_PASSWORD !== undefined) {
    return process.env.MINCLAW_WEB_PASSWORD;
  }

  const authPath = join(getStateDir(), "auth.json");
  if (existsSync(authPath)) {
    try {
      const data = JSON.parse(readFileSync(authPath, "utf-8"));
      if (typeof data.password === "string") {
        return data.password;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Save master password to ~/.minclaw/auth.json with 0600 permissions.
 */
export function saveStoredPassword(password: string): void {
  ensureStateDir();
  const authPath = join(getStateDir(), "auth.json");
  writeFileSync(authPath, JSON.stringify({ password }, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(authPath, 0o600);
  } catch {}
}

/**
 * Verify input password against configured password or default.
 */
export function verifyPassword(inputPassword: string): boolean {
  const configured = getStoredPassword();
  if (configured !== null) {
    return inputPassword === configured;
  }
  // When no password has been explicitly configured, allow empty or "minclaw" default
  return inputPassword === "" || inputPassword === "minclaw";
}

// ---------------------------------------------------------------------------
// In-Memory Session Manager
// ---------------------------------------------------------------------------

export interface WebSession {
  token: string;
  createdAt: number;
  lastActiveAt: number;
}

export const SESSION_TTL_MS = 3600 * 1000; // 1-hour sliding idle TTL

const activeSessions = new Map<string, WebSession>();

/**
 * Generate a cryptographically secure random session token.
 */
export function createSession(): string {
  const token = crypto.randomUUID();
  const now = Date.now();
  activeSessions.set(token, {
    token,
    createdAt: now,
    lastActiveAt: now,
  });
  return token;
}

/**
 * Validate a session token.
 * Refreshes sliding idle TTL on success.
 * Invalidates all sessions if macOS screen is locked.
 */
export function validateSession(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;

  // Screen-lock invalidation: When isScreenLocked() returns true, invalidate all active sessions immediately!
  if (isScreenLocked()) {
    clearAllSessions();
    return false;
  }

  const session = activeSessions.get(token);
  if (!session) return false;

  // Check 1-hour sliding idle TTL
  if (now - session.lastActiveAt > SESSION_TTL_MS) {
    activeSessions.delete(token);
    return false;
  }

  // Update lastActiveAt on authenticated requests
  session.lastActiveAt = now;
  return true;
}

/**
 * Revoke an active session.
 */
export function revokeSession(token: string): boolean {
  return activeSessions.delete(token);
}

/**
 * Clear all active sessions.
 */
export function clearAllSessions(): void {
  activeSessions.clear();
}

/**
 * Return count of active, unexpired sessions.
 */
export function getActiveSessionCount(): number {
  if (isScreenLocked()) {
    clearAllSessions();
    return 0;
  }
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (now - session.lastActiveAt > SESSION_TTL_MS) {
      activeSessions.delete(token);
    }
  }
  return activeSessions.size;
}

/**
 * Extract minclaw_session cookie from incoming request.
 */
export function extractSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)minclaw_session=([^;]+)/);
  if (!match || !match[1]) return null;
  const token = decodeURIComponent(match[1]).trim();
  return token || null;
}

/**
 * Generate Set-Cookie header for session token.
 */
export function createSessionCookieHeader(token: string, maxAge = 3600): string {
  return `minclaw_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/**
 * Generate Set-Cookie header to clear session cookie.
 */
export function clearSessionCookieHeader(): string {
  return `minclaw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

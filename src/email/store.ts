import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { EmailAccount, GoogleOAuthConfig } from "./types.ts";

const STATE_DIR = join(homedir(), ".minclaw");
const ACCOUNTS_FILE = join(STATE_DIR, "email-accounts.json");
const GOOGLE_OAUTH_FILE = join(STATE_DIR, "google-oauth.json");

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const envId = process.env.GOOGLE_CLIENT_ID?.trim();
  const envSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  if (existsSync(GOOGLE_OAUTH_FILE)) {
    try {
      const data = JSON.parse(readFileSync(GOOGLE_OAUTH_FILE, "utf-8")) as GoogleOAuthConfig;
      if (data.clientId && data.clientSecret) {
        return data;
      }
    } catch {}
  }

  return null;
}

export function saveGoogleOAuthConfig(config: GoogleOAuthConfig): void {
  ensureStateDir();
  writeFileSync(GOOGLE_OAUTH_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function getEmailAccounts(): EmailAccount[] {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try {
    const raw = readFileSync(ACCOUNTS_FILE, "utf-8");
    return JSON.parse(raw) as EmailAccount[];
  } catch {
    return [];
  }
}

export function getEmailAccount(id: string): EmailAccount | undefined {
  const accounts = getEmailAccounts();
  return accounts.find((a) => a.id === id);
}

export function saveEmailAccount(account: EmailAccount): void {
  ensureStateDir();
  const accounts = getEmailAccounts();
  const existingIndex = accounts.findIndex((a) => a.id === account.id || a.email === account.email);
  if (existingIndex >= 0) {
    accounts[existingIndex] = { ...accounts[existingIndex], ...account };
  } else {
    accounts.push(account);
  }
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf-8");
}

export function removeEmailAccount(id: string): boolean {
  ensureStateDir();
  const accounts = getEmailAccounts();
  const next = accounts.filter((a) => a.id !== id && a.email !== id);
  if (next.length === accounts.length) return false;
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(next, null, 2), "utf-8");
  return true;
}

/**
 * Shared fetch helper with timeout and transient error retry for Google APIs
 */
export async function fetchGoogleWithRetry(
  url: string | URL,
  init?: RequestInit,
  retries = 1,
  timeoutMs = 15_000
): Promise<Response> {
  let attempt = 0;
  while (true) {
    try {
      const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
      return await fetch(url, { ...init, signal });
    } catch (err: any) {
      attempt++;
      const isTransient =
        err?.name === "TimeoutError" ||
        /socket connection was closed|Unable to connect|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network/i.test(
          String(err?.message || err)
        );
      if (attempt <= retries && isTransient) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Returns a valid Google Access Token, refreshing it via OAuth if expired or close to expiring.
 */
export async function refreshGoogleAccessToken(account: EmailAccount, force = false): Promise<string> {
  if (account.type !== "google" || !account.google) {
    throw new Error(`Account ${account.email} is not a Google OAuth account.`);
  }

  const { accessToken, refreshToken, expiresAt, clientId, clientSecret } = account.google;
  const now = Date.now();

  // If token has at least 5 minutes left and force is false, reuse it
  if (!force && expiresAt && now < expiresAt - 5 * 60 * 1000) {
    return accessToken;
  }

  if (!refreshToken) {
    throw new Error(`Google account ${account.email} has no refresh token.`);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetchGoogleWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    account.status = "error";
    account.errorMessage = `Token refresh failed: ${errText}`;
    saveEmailAccount(account);
    throw new Error(`Failed to refresh Google access token for ${account.email}: ${errText}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  account.google.accessToken = data.access_token;
  account.google.expiresAt = Date.now() + data.expires_in * 1000;
  account.status = "connected";
  account.errorMessage = undefined;
  saveEmailAccount(account);

  return data.access_token;
}

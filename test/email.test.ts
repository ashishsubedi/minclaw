import { describe, it, expect, beforeEach } from "bun:test";
import {
  getEmailAccounts,
  saveEmailAccount,
  removeEmailAccount,
  saveGoogleOAuthConfig,
  getGoogleOAuthConfig,
} from "../src/email/store.ts";
import { listImapUnreadMessages } from "../src/email/imap.ts";
import type { EmailAccount } from "../src/email/types.ts";

describe("Email Store & Multi-Account Management", () => {
  beforeEach(() => {
    // Clean up test accounts
    const accounts = getEmailAccounts();
    for (const a of accounts) {
      if (a.id.startsWith("test_")) {
        removeEmailAccount(a.id);
      }
    }
  });

  it("saves and retrieves multiple email accounts", () => {
    const googleAcc: EmailAccount = {
      id: "test_google_1",
      type: "google",
      email: "test.user@gmail.com",
      displayName: "Test User 1",
      google: {
        accessToken: "test_token_1",
        refreshToken: "test_refresh_1",
        expiresAt: Date.now() + 3600000,
        clientId: "test_client_id",
        clientSecret: "test_secret",
      },
      createdAt: Date.now(),
      status: "connected",
    };

    const imapAcc: EmailAccount = {
      id: "test_imap_1",
      type: "imap",
      email: "student@university.edu",
      displayName: "University Email",
      imap: {
        host: "imap.university.edu",
        port: 993,
        tls: true,
        user: "student@university.edu",
        pass: "secret123",
      },
      createdAt: Date.now(),
      status: "connected",
    };

    saveEmailAccount(googleAcc);
    saveEmailAccount(imapAcc);

    const accounts = getEmailAccounts();
    const foundGoogle = accounts.find((a) => a.id === "test_google_1");
    const foundImap = accounts.find((a) => a.id === "test_imap_1");

    expect(foundGoogle).toBeDefined();
    expect(foundGoogle?.email).toBe("test.user@gmail.com");
    expect(foundGoogle?.type).toBe("google");

    expect(foundImap).toBeDefined();
    expect(foundImap?.email).toBe("student@university.edu");
    expect(foundImap?.type).toBe("imap");
    expect(foundImap?.imap?.host).toBe("imap.university.edu");

    // Clean up
    removeEmailAccount("test_google_1");
    removeEmailAccount("test_imap_1");
    expect(getEmailAccounts().some((a) => a.id === "test_google_1")).toBe(false);
  });

  it("saves and retrieves Google OAuth configuration", () => {
    const origId = process.env.GOOGLE_CLIENT_ID;
    const origSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    try {
      saveGoogleOAuthConfig({
        clientId: "my_test_client_id.apps.googleusercontent.com",
        clientSecret: "my_test_client_secret",
      });

      const cfg = getGoogleOAuthConfig();
      expect(cfg).toBeDefined();
      expect(cfg?.clientId).toBe("my_test_client_id.apps.googleusercontent.com");
      expect(cfg?.clientSecret).toBe("my_test_client_secret");
    } finally {
      if (origId) process.env.GOOGLE_CLIENT_ID = origId;
      if (origSecret) process.env.GOOGLE_CLIENT_SECRET = origSecret;
    }
  });

  it("listImapUnreadMessages requests expanded page and filters out \\Seen envelopes", async () => {
    const originalSpawn = Bun.spawn;
    let capturedArgs: string[] = [];

    const mockEnvelopes = [
      {
        id: "101",
        subject: "Seen message with string flag",
        flags: ["seen"],
        from: [{ name: "Alice", email: "alice@example.com" }],
        date: new Date().toISOString(),
      },
      {
        id: "102",
        subject: "Seen message with raw \\Seen object",
        flags: [{ raw: "\\Seen", iana: "seen" }],
        from: [{ name: "Bob", email: "bob@example.com" }],
        date: new Date().toISOString(),
      },
      {
        id: "103",
        subject: "Urgent unread message 1",
        flags: [],
        from: [{ name: "Charlie", email: "charlie@example.com" }],
        date: new Date().toISOString(),
      },
      {
        id: "104",
        subject: "Important unread message 2",
        flags: [],
        from: [{ name: "Dana", email: "dana@example.com" }],
        date: new Date().toISOString(),
      },
    ];

    (Bun as any).spawn = (args: string[], options?: any) => {
      if (args[0] === "himalaya") {
        capturedArgs = [...args];
        return {
          stdout: new Response(JSON.stringify(mockEnvelopes)).body,
          stderr: new Response("").body,
          exited: Promise.resolve(0),
        };
      }
      return originalSpawn(args as any, options);
    };

    try {
      const imapAcc: EmailAccount = {
        id: "test_imap_filter",
        type: "imap",
        email: "test@uni.edu",
        displayName: "Test IMAP",
        createdAt: Date.now(),
        status: "connected",
      };

      const results = await listImapUnreadMessages(imapAcc, 5);
      expect(results.length).toBe(2);
      expect(results[0]!.id).toBe("103");
      expect(results[0]!.subject).toBe("Urgent unread message 1");
      expect(results[1]!.id).toBe("104");
      expect(results[1]!.subject).toBe("Important unread message 2");
      expect(results.every((r) => r.unread)).toBe(true);

      // Verify expanded fetch count (Math.max(5 * 3, 20) = 20)
      const sIndex = capturedArgs.indexOf("-s");
      expect(sIndex).toBeGreaterThan(-1);
      expect(capturedArgs[sIndex + 1]).toBe("20");
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});

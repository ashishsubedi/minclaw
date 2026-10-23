export type GoogleAccountData = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  clientId: string;
  clientSecret: string;
  scope?: string;
};

export type ImapAccountData = {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpTls?: boolean;
  smtpUser?: string;
  smtpPass?: string;
};

export type EmailAccount = {
  id: string; // e.g. "google_user_gmail_com" or "imap_student_uni_edu"
  type: "google" | "imap";
  email: string;
  displayName: string;
  avatarUrl?: string;
  google?: GoogleAccountData;
  imap?: ImapAccountData;
  createdAt: number;
  lastChecked?: number;
  status: "connected" | "error";
  errorMessage?: string;
};

export type EmailMessageSummary = {
  id: string;
  threadId?: string;
  accountId: string;
  accountEmail: string;
  accountType: "google" | "imap";
  from: string;
  to?: string;
  subject: string;
  date: string;
  snippet?: string;
  unread: boolean;
};

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

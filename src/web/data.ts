import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { getStateDir } from "../auth/credentials.ts";
import { loadConfig, reloadConfig, type Config } from "../config.ts";
import { getAllSkillStatuses } from "../skills/loader.ts";
import { getHeartbeatStatus } from "../scheduler/heartbeat.ts";
import { listJobs, type ScheduledJob } from "../scheduler/scheduler.ts";
import { PID_FILENAME, SOCKET_FILENAME } from "../daemon/protocol.ts";
import { getMessages, type SessionMessage } from "../session.ts";
import { searchMemory } from "../memory/store.ts";

export type UsageSummary = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
  costSource: "catalog" | "estimated-openai" | "unavailable";
};

export type SessionSummary = {
  key: string;
  channel: string;
  sender: string;
  messageCount: number;
  lastActive: number;
  preview: string;
  usage: UsageSummary;
};

export type SessionDetail = SessionSummary & {
  messages: SessionMessage[];
};

export type DashboardOverview = {
  daemon: {
    running: boolean;
    pid?: number;
    socketExists: boolean;
    stateDir: string;
  };
  config: Config;
  sessions: {
    total: number;
    active: SessionSummary[];
    usage: UsageSummary;
  };
  jobs: ScheduledJob[];
  skills: Awaited<ReturnType<typeof getAllSkillStatuses>>;
  heartbeat: ReturnType<typeof getHeartbeatStatus>;
};

export type DashboardConfig = {
  raw: string;
  parsed: Config;
};

type RawUsage = SessionMessage["usage"];
const CONFIG_PATH = resolve(import.meta.dir, "..", "..", "minclaw.json5");

function getSessionDir(): string {
  return resolve(loadConfig().sessions.dir);
}

function readDaemonPid(): number | undefined {
  const pidPath = join(getStateDir(), PID_FILENAME);
  if (!existsSync(pidPath)) return undefined;
  const parsed = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeUsage(usage?: RawUsage): UsageSummary {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    costTotal: usage?.cost?.total ?? 0,
    costSource: usage?.costSource ?? "unavailable",
  };
}

export function aggregateUsage(messages: SessionMessage[]): UsageSummary {
  const totals: UsageSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
    costSource: "unavailable",
  };

  let sawUsage = false;
  let sawEstimated = false;

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    const usage = normalizeUsage(msg.usage);
    sawUsage = true;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.totalTokens += usage.totalTokens;
    totals.costTotal += usage.costTotal;
    if (usage.costSource === "estimated-openai") {
      sawEstimated = true;
    }
  }

  if (sawUsage) {
    totals.costSource = sawEstimated ? "estimated-openai" : "catalog";
  }

  return totals;
}

function parseSessionKey(fileName: string): { key: string; channel: string; sender: string } {
  const key = fileName.replace(/\.jsonl$/, "");
  const colonIndex = key.indexOf(":");
  return {
    key,
    channel: colonIndex >= 0 ? key.slice(0, colonIndex) : "unknown",
    sender: colonIndex >= 0 ? key.slice(colonIndex + 1) : key,
  };
}

function summarizeSessionFile(filePath: string): SessionSummary {
  const file = readFileSync(filePath, "utf-8");
  const lines = file.split("\n").filter((line) => line.trim());
  const { key, channel, sender } = parseSessionKey(filePath.split("/").pop() || filePath);
  const messages = lines.map((line) => JSON.parse(line) as SessionMessage);
  const stat = statSync(filePath);

  let preview = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user") {
      preview = message.content.replace(/\n/g, " ").slice(0, 96);
      break;
    }
  }

  if (!preview && messages.length > 0) {
    preview = messages[messages.length - 1]?.content.replace(/\n/g, " ").slice(0, 96) ?? "";
  }

  return {
    key,
    channel,
    sender,
    messageCount: messages.length,
    lastActive: stat.mtimeMs,
    preview,
    usage: aggregateUsage(messages),
  };
}

export function listDashboardSessions(): SessionSummary[] {
  const dir = getSessionDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => summarizeSessionFile(join(dir, file)))
    .sort((a, b) => b.lastActive - a.lastActive);
}

export function getDashboardSession(sessionKey: string): SessionDetail | null {
  const dir = getSessionDir();
  const filePath = join(dir, `${sessionKey}.jsonl`);
  if (!existsSync(filePath)) return null;

  const messages = getMessages(sessionKey);
  const summary = summarizeSessionFile(filePath);
  return {
    ...summary,
    messages,
  };
}

export async function getDashboardOverview(): Promise<DashboardOverview> {
  const sessions = listDashboardSessions();
  const skills = await getAllSkillStatuses();
  const sessionsUsage = sessions.reduce<UsageSummary>(
    (acc, session) => ({
      input: acc.input + session.usage.input,
      output: acc.output + session.usage.output,
      cacheRead: acc.cacheRead + session.usage.cacheRead,
      cacheWrite: acc.cacheWrite + session.usage.cacheWrite,
      totalTokens: acc.totalTokens + session.usage.totalTokens,
      costTotal: acc.costTotal + session.usage.costTotal,
      costSource: acc.costSource,
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costTotal: 0,
      costSource: "unavailable",
    }
  );

  return {
    daemon: {
      running: isDaemonRunning(),
      pid: readDaemonPid(),
      socketExists: existsSync(join(getStateDir(), SOCKET_FILENAME)),
      stateDir: getStateDir(),
    },
    config: loadConfig(),
    sessions: {
      total: sessions.length,
      active: sessions.slice(0, 12),
      usage: sessionsUsage,
    },
    jobs: listJobs(),
    skills,
    heartbeat: getHeartbeatStatus(),
  };
}

export function searchDashboardMemory(query: string) {
  return searchMemory(query);
}

export function getDashboardConfig(): DashboardConfig {
  return {
    raw: readFileSync(CONFIG_PATH, "utf-8"),
    parsed: loadConfig(),
  };
}

export function saveDashboardConfig(raw: string): DashboardConfig {
  writeFileSync(CONFIG_PATH, raw, "utf-8");
  return {
    raw,
    parsed: reloadConfig(),
  };
}

export function getDashboardSessionMessages(sessionKey: string): SessionDetail | null {
  return getDashboardSession(sessionKey);
}
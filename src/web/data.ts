import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import JSON5 from "json5";
import { getStateDir } from "../auth/credentials.ts";
import { loadConfig, reloadConfig, type Config } from "../config.ts";
import { getAllSkillStatuses } from "../skills/loader.ts";
import { getHeartbeatStatus } from "../scheduler/heartbeat.ts";
import { listJobs, type ScheduledJob } from "../scheduler/scheduler.ts";
import { PID_FILENAME, SOCKET_FILENAME } from "../daemon/protocol.ts";
import { getAllMessages, type SessionMessage } from "../session.ts";
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

export type ExtensionSummary = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  status: "running" | "idle" | "offline";
  hotkey?: string;
  mode?: string;
  stt?: { engine?: string; model?: string };
  tts?: { engine?: string; voice?: string };
  pid?: number;
};

export type PermanentMemoryResult = {
  ok: boolean;
  path: string;
  content: string;
  lastModified?: number;
};

export type DashboardOverview = {
  daemon: {
    running: boolean;
    pid?: number;
    socketExists: boolean;
    stateDir: string;
    memoryRssMb?: number;
    uptimeSeconds?: number;
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
  extensions?: ExtensionSummary[];
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
  if (!existsSync(filePath)) {
    if (sessionKey.startsWith("web:") || sessionKey.startsWith("telegram:") || sessionKey.startsWith("whatsapp:") || sessionKey.startsWith("voice:")) {
      const idx = sessionKey.indexOf(":");
      return {
        key: sessionKey,
        channel: idx > 0 ? sessionKey.slice(0, idx) : "web",
        sender: idx > 0 ? sessionKey.slice(idx + 1) : sessionKey,
        lastActive: Date.now(),
        messageCount: 0,
        preview: "New conversation ready",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costTotal: 0,
          costSource: "catalog",
        },
        messages: [],
      };
    }
    return null;
  }

  const messages = getAllMessages(sessionKey);
  const summary = summarizeSessionFile(filePath);
  return {
    ...summary,
    messages,
  };
}

export function getExtensionsStatus(): ExtensionSummary[] {
  const extensions: ExtensionSummary[] = [];
  const voiceDir = resolve(import.meta.dir, "..", "..", "extensions", "voice-mac");
  const manifestPath = join(voiceDir, "extension.json5");

  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON5.parse(raw) as {
        name?: string;
        version?: string;
        description?: string;
        hotkey?: string;
        ui?: { mode?: string };
        stt?: { engine?: string; model?: string };
        tts?: { engine?: string; voice?: string };
      };

      let pid: number | undefined;
      try {
        const out = execSync("pgrep -f minclaw-voice", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const p = parseInt(out.split("\n")[0] || "", 10);
        if (Number.isFinite(p)) pid = p;
      } catch {}

      extensions.push({
        id: "voice-mac",
        name: manifest.name || "voice-mac",
        version: manifest.version || "1.0.0",
        description: manifest.description || "Voice companion for macOS",
        status: pid ? "running" : "offline",
        hotkey: manifest.hotkey || "right-option",
        mode: manifest.ui?.mode || "notch",
        stt: manifest.stt,
        tts: manifest.tts,
        pid,
      });
    } catch {
      // ignore parse errors
    }
  }

  return extensions;
}

export function getPermanentMemoryContent(): PermanentMemoryResult {
  const candidates = [
    resolve(import.meta.dir, "..", "..", "brain", "permanent-memory.md"),
    resolve(process.cwd(), "brain", "permanent-memory.md"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const stat = statSync(p);
        return {
          ok: true,
          path: p,
          content,
          lastModified: stat.mtimeMs,
        };
      } catch {}
    }
  }

  return {
    ok: false,
    path: candidates[0] || "brain/permanent-memory.md",
    content: "",
  };
}

export function getTemporaryMemoryContent(): PermanentMemoryResult {
  const config = loadConfig();
  const candidates = [
    resolve(process.cwd(), config.memory.indexFile),
    resolve(import.meta.dir, "..", "..", "memory", "temporary-memory.md"),
    resolve(process.cwd(), "memory", "temporary-memory.md"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const stat = statSync(p);
        return {
          ok: true,
          path: p,
          content,
          lastModified: stat.mtimeMs,
        };
      } catch {}
    }
  }

  return {
    ok: false,
    path: candidates[0] || "memory/temporary-memory.md",
    content: "",
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

  const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  const uptimeSeconds = Math.round(process.uptime());
  const extensions = getExtensionsStatus();

  return {
    daemon: {
      running: isDaemonRunning(),
      pid: readDaemonPid(),
      socketExists: existsSync(join(getStateDir(), SOCKET_FILENAME)),
      stateDir: getStateDir(),
      memoryRssMb: rssMb,
      uptimeSeconds,
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
    extensions,
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
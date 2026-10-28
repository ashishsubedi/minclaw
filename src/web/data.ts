import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import os from "os";
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

export type TelemetrySnapshot = {
  timestamp: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  load1m: number;
  totalTokens: number;
};

export type TelemetryData = {
  process: {
    pid?: number;
    running: boolean;
    uptimeSeconds: number;
    formattedUptime: string;
    socketPath: string;
    socketExists: boolean;
    stateDir: string;
    bunVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    heapUsedPercent: number;
    externalMb: number;
    arrayBuffersMb: number;
    gcAvailable: boolean;
  };
  cpu: {
    percent: number;
    userSeconds: number;
    systemSeconds: number;
    totalSeconds: number;
    userMs: number;
    systemMs: number;
  };
  storage: {
    totalMb: number;
    stateDirMb: number;
    sessionsDirMb: number;
    mediaDirMb: number;
    logsDirMb: number;
    stateDirPath: string;
    sessionsDirPath: string;
    mediaDirPath: string;
  };
  host: {
    platform: string;
    osRelease: string;
    arch: string;
    cpuModel: string;
    cpuCores: number;
    loadAverage: [number, number, number];
    totalMemoryGb: number;
    freeMemoryGb: number;
    usedMemoryGb: number;
    memoryUsagePercent: number;
    systemUptimeSeconds: number;
    formattedSystemUptime: string;
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cacheHitRate: number;
    costTotal: number;
    costSource: "catalog" | "estimated-openai" | "unavailable";
  };
  models: {
    primary: {
      provider: string;
      name: string;
    };
    fallbacks: Array<{ provider: string; name: string }>;
    watermarkLimit: number;
  };
  traffic: {
    totalSessions: number;
    totalMessages: number;
    compactedSessionsCount: number;
    channels: Record<string, { sessions: number; messages: number; tokens: number; cost: number }>;
  };
  subsystems: {
    heartbeat: {
      enabled: boolean;
      cronExpr: string;
      status: ReturnType<typeof getHeartbeatStatus>;
    };
    scheduler: {
      totalJobs: number;
      jobs: ScheduledJob[];
    };
    extensions: ExtensionSummary[];
  };
  history: TelemetrySnapshot[];
};

export type DashboardOverview = {
  daemon: {
    running: boolean;
    pid?: number;
    socketExists: boolean;
    stateDir: string;
    memoryRssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
    cpuLoad?: number[];
    cpuModel?: string;
    cpuCount?: number;
    hostMemUsagePercent?: number;
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
  if (process.env.MINCLAW_SESSIONS_DIR) {
    return resolve(process.env.MINCLAW_SESSIONS_DIR);
  }
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
    if (sessionKey.startsWith("web:") || sessionKey.startsWith("telegram:") || sessionKey.startsWith("whatsapp:") || sessionKey.startsWith("voice:") || sessionKey.startsWith("terminal:")) {
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

function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

const MAX_SNAPSHOTS = 30;
const telemetryHistory: TelemetrySnapshot[] = [];

let lastCpuSample = {
  cpu: process.cpuUsage(),
  time: performance.now(),
};

function getDirSize(dir: string): number {
  let total = 0;
  if (!existsSync(dir)) return 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const p = join(dir, entry);
      try {
        const stat = statSync(p);
        if (stat.isFile()) total += stat.size;
        else if (stat.isDirectory()) total += getDirSize(p);
      } catch {}
    }
  } catch {}
  return total;
}

export function recordTelemetrySnapshot(
  rssMb: number,
  heapUsedMb: number,
  heapTotalMb: number,
  load1m: number,
  totalTokens: number
) {
  const now = Date.now();
  const last = telemetryHistory[telemetryHistory.length - 1];
  if (last && now - last.timestamp < 1500) {
    last.rssMb = rssMb;
    last.heapUsedMb = heapUsedMb;
    last.heapTotalMb = heapTotalMb;
    last.load1m = load1m;
    last.totalTokens = totalTokens;
    return;
  }
  telemetryHistory.push({
    timestamp: now,
    rssMb,
    heapUsedMb,
    heapTotalMb,
    load1m,
    totalTokens,
  });
  if (telemetryHistory.length > MAX_SNAPSHOTS) {
    telemetryHistory.shift();
  }
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

  const mem = process.memoryUsage();
  const rssMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
  const heapTotalMb = Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10;
  const heapUsedMb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
  const uptimeSeconds = Math.round(process.uptime());
  const extensions = getExtensionsStatus();
  const loadAvg = os.loadavg().map((v) => Math.round(v * 100) / 100);

  recordTelemetrySnapshot(rssMb, heapUsedMb, heapTotalMb, loadAvg[0] ?? 0, sessionsUsage.totalTokens);

  return {
    daemon: {
      running: isDaemonRunning(),
      pid: readDaemonPid(),
      socketExists: existsSync(join(getStateDir(), SOCKET_FILENAME)),
      stateDir: getStateDir(),
      memoryRssMb: rssMb,
      heapUsedMb,
      heapTotalMb,
      uptimeSeconds,
      cpuLoad: loadAvg,
      cpuModel: os.cpus()[0]?.model || "Host CPU",
      cpuCount: os.cpus().length,
      hostMemUsagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
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

export async function getTelemetryData(): Promise<TelemetryData> {
  const mem = process.memoryUsage();
  const rssMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
  const heapTotalMb = Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10;
  const heapUsedMb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
  const heapUsedPercent = heapTotalMb > 0 ? Math.round((heapUsedMb / heapTotalMb) * 100) : 0;
  const externalMb = Math.round((mem.external / (1024 * 1024)) * 10) / 10;
  const arrayBuffersMb = Math.round(((mem.arrayBuffers || 0) / (1024 * 1024)) * 10) / 10;

  const loadAvg = os.loadavg().map((v) => Math.round(v * 100) / 100) as [number, number, number];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const totalMemoryGb = Math.round((totalMem / (1024 * 1024 * 1024)) * 10) / 10;
  const freeMemoryGb = Math.round((freeMem / (1024 * 1024 * 1024)) * 10) / 10;
  const usedMemoryGb = Math.round((usedMem / (1024 * 1024 * 1024)) * 10) / 10;
  const memoryUsagePercent = Math.round((usedMem / totalMem) * 100);

  const sessions = listDashboardSessions();
  const sessionDir = getSessionDir();
  let compactedSessionsCount = 0;
  let totalMessages = 0;

  const channels: Record<string, { sessions: number; messages: number; tokens: number; cost: number }> = {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let costTotal = 0;
  let costSource: "catalog" | "estimated-openai" | "unavailable" = "unavailable";

  for (const s of sessions) {
    totalMessages += s.messageCount;
    inputTokens += s.usage.input;
    outputTokens += s.usage.output;
    cacheReadTokens += s.usage.cacheRead;
    cacheWriteTokens += s.usage.cacheWrite;
    totalTokens += s.usage.totalTokens;
    costTotal += s.usage.costTotal;
    if (s.usage.costSource !== "unavailable") {
      costSource = s.usage.costSource;
    }

    const ch = s.channel || "other";
    if (!channels[ch]) {
      channels[ch] = { sessions: 0, messages: 0, tokens: 0, cost: 0 };
    }
    channels[ch].sessions += 1;
    channels[ch].messages += s.messageCount;
    channels[ch].tokens += s.usage.totalTokens;
    channels[ch].cost += s.usage.costTotal;

    const compactedPath = join(sessionDir, `${s.key}.compacted.json`);
    if (existsSync(compactedPath)) {
      compactedSessionsCount += 1;
    }
  }

  const cacheDenom = inputTokens + cacheReadTokens;
  const cacheHitRate = cacheDenom > 0 ? Math.round((cacheReadTokens / cacheDenom) * 1000) / 10 : 0;

  // MinClaw Process CPU calculation
  const now = performance.now();
  const elapsedMs = Math.max(1, now - lastCpuSample.time);
  const diff = process.cpuUsage(lastCpuSample.cpu);
  const cpuPercent = Math.min(100, Math.round(((diff.user + diff.system) / 1000 / elapsedMs) * 100 * 10) / 10);
  lastCpuSample = { cpu: process.cpuUsage(), time: now };

  const totalCpu = process.cpuUsage();
  const userSeconds = Math.round((totalCpu.user / 1e6) * 10) / 10;
  const systemSeconds = Math.round((totalCpu.system / 1e6) * 10) / 10;
  const totalSeconds = Math.round(((totalCpu.user + totalCpu.system) / 1e6) * 10) / 10;

  // MinClaw Storage Footprint
  const stateDir = getStateDir();
  const sessionsDir = getSessionDir();
  const mediaDir = resolve(import.meta.dir, "..", "..", "media");
  const logsDir = join(stateDir, "logs");

  const stateDirBytes = getDirSize(stateDir);
  const sessionsDirBytes = getDirSize(sessionsDir);
  const mediaDirBytes = getDirSize(mediaDir);
  const logsDirBytes = getDirSize(logsDir);
  const totalStorageBytes = stateDirBytes + sessionsDirBytes + mediaDirBytes;

  const stateDirMb = Math.round((stateDirBytes / (1024 * 1024)) * 100) / 100;
  const sessionsDirMb = Math.round((sessionsDirBytes / (1024 * 1024)) * 100) / 100;
  const mediaDirMb = Math.round((mediaDirBytes / (1024 * 1024)) * 100) / 100;
  const logsDirMb = Math.round((logsDirBytes / (1024 * 1024)) * 100) / 100;
  const storageTotalMb = Math.round((totalStorageBytes / (1024 * 1024)) * 100) / 100;

  recordTelemetrySnapshot(rssMb, heapUsedMb, heapTotalMb, loadAvg[0] ?? 0, totalTokens);

  const config = loadConfig();
  const uptimeSeconds = Math.round(process.uptime());
  const sysUptimeSeconds = Math.round(os.uptime());

  return {
    process: {
      pid: readDaemonPid() ?? process.pid,
      running: isDaemonRunning(),
      uptimeSeconds,
      formattedUptime: formatDuration(uptimeSeconds),
      socketPath: join(getStateDir(), SOCKET_FILENAME),
      socketExists: existsSync(join(getStateDir(), SOCKET_FILENAME)),
      stateDir: getStateDir(),
      bunVersion: typeof Bun !== "undefined" ? Bun.version : "1.3.14",
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    memory: {
      rssMb,
      heapTotalMb,
      heapUsedMb,
      heapUsedPercent,
      externalMb,
      arrayBuffersMb,
      gcAvailable: typeof (Bun as any).gc === "function",
    },
    cpu: {
      percent: cpuPercent,
      userSeconds,
      systemSeconds,
      totalSeconds,
      userMs: Math.round(totalCpu.user / 1000),
      systemMs: Math.round(totalCpu.system / 1000),
    },
    storage: {
      totalMb: storageTotalMb,
      stateDirMb,
      sessionsDirMb,
      mediaDirMb,
      logsDirMb,
      stateDirPath: stateDir,
      sessionsDirPath: sessionsDir,
      mediaDirPath: mediaDir,
    },
    host: {
      platform: os.platform(),
      osRelease: os.release(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model || "Apple Silicon / Host CPU",
      cpuCores: os.cpus().length,
      loadAverage: loadAvg,
      totalMemoryGb,
      freeMemoryGb,
      usedMemoryGb,
      memoryUsagePercent,
      systemUptimeSeconds: sysUptimeSeconds,
      formattedSystemUptime: formatDuration(sysUptimeSeconds),
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      totalTokens,
      cacheHitRate,
      costTotal: Math.round(costTotal * 10000) / 10000,
      costSource,
    },
    models: {
      primary: {
        provider: config.model.provider,
        name: config.model.name,
      },
      fallbacks: config.model.fallbacks || [],
      watermarkLimit: 75000,
    },
    traffic: {
      totalSessions: sessions.length,
      totalMessages,
      compactedSessionsCount,
      channels,
    },
    subsystems: {
      heartbeat: {
        enabled: config.heartbeat?.enabled ?? true,
        cronExpr: config.heartbeat?.cronExpr || "*/15 * * * *",
        status: getHeartbeatStatus(),
      },
      scheduler: {
        totalJobs: listJobs().length,
        jobs: listJobs(),
      },
      extensions: getExtensionsStatus(),
    },
    history: [...telemetryHistory],
  };
}

export function runGarbageCollection(): { ok: boolean; beforeRssMb: number; afterRssMb: number; freedMb: number } {
  const beforeRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  if (typeof (Bun as any).gc === "function") {
    (Bun as any).gc(true);
  }
  const afterRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  const freedMb = Math.max(0, Math.round((beforeRssMb - afterRssMb) * 10) / 10);
  return {
    ok: true,
    beforeRssMb,
    afterRssMb,
    freedMb,
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
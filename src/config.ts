import JSON5 from "json5";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export type ChannelConfig = {
  enabled: boolean;
  allowFrom: string[];
};

export type Config = {
  model: {
    provider: string;
    name: string;
    baseUrl?: string;
    fallbacks?: Array<{
      provider: string;
      name: string;
      baseUrl?: string;
    }>;
  };
  workspace: string;
  owner?: {
    channel: string;
    recipient: string;
  };
  channels: {
    telegram: ChannelConfig;
    whatsapp: ChannelConfig;
    slack: ChannelConfig;
  };
  sessions: {
    dir: string;
    maxTurns: number;
    maxToolIterations?: number;
    keepRecentTurns?: number;
    compactAfterTurns?: number;
  };
  memory: {
    dir: string;
    indexFile: string;
  };
  brain: {
    dir: string;
  };
  heartbeat: {
    enabled: boolean;
    cronExpr: string;
  };
  skills?: {
    dir: string;
    autoSync: boolean;
  };
  web?: {
    enabled?: boolean;
    port?: number;
  };
};

const CONFIG_PATH = resolve(
  import.meta.dir,
  "..",
  "minclaw.json5"
);

const LOCAL_CONFIG_PATH = resolve(
  import.meta.dir,
  "..",
  "minclaw.local.json5"
);

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  _config = JSON5.parse(raw) as Config;

  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      const localRaw = readFileSync(LOCAL_CONFIG_PATH, "utf-8");
      const localConfig = JSON5.parse(localRaw) as Partial<Config>;
      _config = {
        ..._config,
        ...localConfig,
        owner: { ..._config.owner, ...localConfig.owner } as any,
        channels: {
          ..._config.channels,
          ...localConfig.channels,
          telegram: { ..._config.channels?.telegram, ...localConfig.channels?.telegram } as any,
        },
      };
    } catch (err) {
      console.warn(`[config] Failed to parse local config: ${err}`);
    }
  }

  // Apply environment variable overrides for sensitive user settings
  const envOwnerId = process.env.TELEGRAM_OWNER_ID?.trim() || process.env.MINCLAW_OWNER_RECIPIENT?.trim();
  if (envOwnerId) {
    if (!_config.owner) {
      _config.owner = { channel: "telegram", recipient: envOwnerId };
    } else {
      _config.owner.recipient = envOwnerId;
    }
  }

  const envAllowedUsers = process.env.TELEGRAM_ALLOWED_USERS?.trim();
  if (envAllowedUsers && _config.channels?.telegram) {
    const list = envAllowedUsers.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) {
      _config.channels.telegram.allowFrom = list;
    }
  }

  return _config;
}

export function reloadConfig(): Config {
  _config = null;
  return loadConfig();
}

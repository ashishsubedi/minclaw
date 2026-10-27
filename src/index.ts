import { writeFileSync, unlinkSync, watch } from "fs";
import { resolve, join } from "path";
import { loadConfig, reloadConfig } from "./config.ts";
import type { ChannelAdapter } from "./channels/types.ts";
import { createTelegramAdapter } from "./channels/telegram.ts";
import { createWhatsAppAdapter } from "./channels/whatsapp.ts";
import { createSlackAdapter } from "./channels/slack.ts";
import { handleMessage } from "./router.ts";
import { ensureMemoryDirs, rebuildMemoryIndex } from "./memory/store.ts";
import {
  initScheduler,
  setJobCallback,
  stopScheduler,
  isAgenticJob,
} from "./scheduler/scheduler.ts";
import { startHeartbeat, stopHeartbeat } from "./scheduler/heartbeat.ts";
import { runAgent, killActiveAgyProcesses, clearAgySession } from "./agent.ts";
import { startDaemonServer, setActiveChannels, sendToTerminalSession } from "./daemon/server.ts";
import { getChannelSender } from "./channels/registry.ts";
import { getStateDir, ensureStateDir } from "./auth/credentials.ts";
import { PID_FILENAME } from "./daemon/protocol.ts";
import { startWebServer } from "./web/server.ts";

/**
 * MinClaw — daemon entry point.
 *
 * Boots enabled channels, wires them to the message router,
 * starts the heartbeat, scheduler, and Unix socket server, then waits.
 */

async function main() {
  console.log("MinClaw starting...\n");

  ensureStateDir();
  const config = loadConfig();
  ensureMemoryDirs();
  rebuildMemoryIndex();

  // --- PID file ---
  const pidPath = join(getStateDir(), PID_FILENAME);
  writeFileSync(pidPath, String(process.pid), "utf-8");
  process.env.MINCLAW_IS_DAEMON = "1";
  process.env.MINCLAW_DAEMON_PID = String(process.pid);

  // --- Daemon socket server ---
  const daemonServer = startDaemonServer();

  // --- Web UI server ---
  let webServer: ReturnType<typeof startWebServer> | null = null;
  if (config.web?.enabled !== false) {
    try {
      webServer = startWebServer(config.web?.port);
    } catch (err) {
      console.warn(`[web] Failed to start web dashboard: ${err}`);
    }
  }

  // --- Scheduler ---
  initScheduler();

  setJobCallback(async (job) => {
    try {
      const reminderText = job.message || "Reminder";

      const replyFn = async (text: string) => {
        if (job.channel === "terminal") {
          const delivered = sendToTerminalSession(job.sender, text);
          if (!delivered) {
            console.warn(
              `[scheduler] Job "${job.name}" not delivered: terminal session ${job.sender} is offline`
            );
          }
          return;
        }

        const sender = getChannelSender(job.channel);
        if (!sender?.sendText) {
          console.warn(
            `[scheduler] Job "${job.name}" not delivered: channel "${job.channel}" has no text sender`
          );
          return;
        }

        await sender.sendText({ recipient: job.sender, text });
      };

      if (isAgenticJob(job)) {
        console.log(`[scheduler] Running agentic scheduled job "${job.name}" (${job.id})...`);
        let sentViaTool = false;
        const wrappedReply = async (text: string) => {
          sentViaTool = true;
          await replyFn(text);
        };

        clearAgySession(`scheduler:${job.id}`);
        const result = await runAgent(
          `scheduler:${job.id}`,
          `[Scheduled Task: ${job.name}]\n${job.message}\n\nExecute this scheduled task thoroughly using your tools and provide a clear, concise response for the user.`,
          undefined,
          wrappedReply,
          { channel: job.channel, sender: job.sender }
        );

        if (!sentViaTool && result.text && result.text.trim() && result.text.trim() !== "(no response)") {
          await replyFn(result.text);
          console.log(
            `[scheduler] Delivered agentic output for job "${job.name}" to ${job.channel}:${job.sender} (${result.text.length} chars)`
          );
        }
      } else {
        await replyFn(reminderText);
        console.log(`[scheduler] Delivered job "${job.name}" to ${job.channel}:${job.sender}`);
      }
    } catch (err) {
      console.error(`[scheduler] Job error: ${err}`);
    }
  });

  // --- Heartbeat ---
  const heartbeatCallback = async (prompt: string) => {
    const currentConfig = loadConfig();
    const owner = currentConfig.owner;
    if (!owner?.recipient) {
      console.log("[heartbeat] No owner recipient configured. Skipping proactive alert.");
      return;
    }

    clearAgySession(`heartbeat:${owner.recipient}`);

    let sentViaTool = false;
    const replyFn = async (text: string) => {
      sentViaTool = true;
      const sender = getChannelSender(owner.channel);
      if (sender?.sendText) {
        await sender.sendText({ recipient: owner.recipient, text });
      } else {
        console.log(`[heartbeat:reply] (${owner.channel}:${owner.recipient}): ${text}`);
      }
    };

    const result = await runAgent(
      `heartbeat:${owner.recipient}`,
      prompt,
      undefined,
      replyFn,
      { channel: owner.channel, sender: owner.recipient }
    );
    console.log(`[heartbeat] Agent: ${result.text.slice(0, 200)}`);

    if (!sentViaTool && result.text && result.text.trim() && result.text.trim() !== "(no response)") {
      await replyFn(result.text);
      console.log(
        `[heartbeat] Delivered proactive update to ${owner.channel}:${owner.recipient} (${result.text.length} chars)`
      );
    }
  };
  startHeartbeat(heartbeatCallback);

  // --- Channels ---
  // Each channel starts independently — one failing won't crash the others
  const activeAdapters: ChannelAdapter[] = [];

  async function startChannel(
    name: string,
    create: () => ChannelAdapter
  ): Promise<void> {
    try {
      const adapter = create();
      adapter.onMessage(handleMessage);
      await adapter.start();
      activeAdapters.push(adapter);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${name}] Failed to start: ${errMsg}`);
    }
  }

  if (config.channels.telegram.enabled) {
    await startChannel("telegram", () =>
      createTelegramAdapter(config.channels.telegram)
    );
  }

  if (config.channels.whatsapp.enabled) {
    await startChannel("whatsapp", () =>
      createWhatsAppAdapter(config.channels.whatsapp)
    );
  }

  if (config.channels.slack.enabled) {
    await startChannel("slack", () =>
      createSlackAdapter(config.channels.slack)
    );
  }

  setActiveChannels(activeAdapters.map((a) => a.name));

  if (activeAdapters.length === 0) {
    console.log(
      "No channels enabled. Edit minclaw.json5 and set a channel to enabled: true"
    );
    console.log("Then set the required env vars (TELEGRAM_BOT_TOKEN, etc.)");
    console.log("\nRunning in headless mode (heartbeat + scheduler only)...\n");
  } else {
    console.log(
      `\nChannels active: ${activeAdapters.map((a) => a.name).join(", ")}`
    );
  }

  // --- Config watcher ---
  const configPath = resolve(import.meta.dir, "..", "minclaw.json5");
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  watch(configPath, (event) => {
    if (event !== "change") return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log("[config] Change detected, reloading...");
      try {
        reloadConfig();
        stopHeartbeat();
        startHeartbeat(heartbeatCallback);
        console.log(
          "[config] Reloaded. Heartbeat/scheduler updated. Channel changes require daemon restart."
        );
      } catch (err) {
        console.error(`[config] Reload error: ${err}`);
      }
    }, 300);
  });

  console.log("MinClaw is running. Press Ctrl+C to stop.\n");

  // --- Graceful shutdown ---
  const shutdown = async () => {
    console.log("\nShutting down...");
    killActiveAgyProcesses();
    daemonServer.stop();
    webServer?.stop();
    stopHeartbeat();
    stopScheduler();
    for (const adapter of activeAdapters) {
      await adapter.stop();
    }
    try {
      unlinkSync(pidPath);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

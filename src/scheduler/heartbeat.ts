import { Cron } from "croner";
import { loadHeartbeatPrompt } from "../brain/loader.ts";
import { loadConfig } from "../config.ts";
import { runReflexCheck } from "./reflex.ts";

/**
 * Heartbeat — a recurring cron that triggers the agent to do something.
 * Default: every hour, "Check for pending tasks, review memory, and report status."
 *
 * The heartbeat runs a fast, zero-token reflex check first.
 * If no state changes or delegated tasks are found, it skips the LLM call entirely.
 */

type HeartbeatCallback = (prompt: string) => void | Promise<void>;

let cronJob: Cron | null = null;
let isRunning = false;

export function startHeartbeat(onBeat: HeartbeatCallback): void {
  const config = loadConfig();
  if (!config.heartbeat.enabled) {
    console.log("[heartbeat] Disabled in config");
    return;
  }

  if (cronJob) {
    cronJob.stop();
  }

  cronJob = new Cron(config.heartbeat.cronExpr, async () => {
    if (isRunning) {
      console.log("[heartbeat] Skipping — previous beat still running");
      return;
    }

    isRunning = true;
    let timeoutId: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Heartbeat timed out after 240000ms"));
      }, 240_000);
      timeoutId?.unref?.();
    });

    try {
      await Promise.race([
        (async () => {
          const nowIso = new Date().toISOString();
          console.log(`[heartbeat] Beat at ${nowIso}`);

          // 1. Run zero-token reflex check with deferred commits
          const reflex = await runReflexCheck({ deferCommit: true });

          if (!reflex.hasDelta) {
            console.log("[heartbeat] Reflex check: idle (no actionable state changes). Skipping LLM call.");
            return;
          }

          console.log(`[heartbeat] Reflex check: state change detected (${reflex.items.length} items). Invoking agent...`);
          const basePrompt = await loadHeartbeatPrompt();
          const enrichedPrompt = `${basePrompt}\n\n## Actionable Reflex Triggers\n${reflex.summary}\n\nTriage these triggers: execute tasks, update Logseq status, or message the user via Telegram if urgent.`;

          await onBeat(enrichedPrompt);
          reflex.commit?.();
          console.log("[heartbeat] Reflex state committed successfully.");
        })(),
        timeoutPromise,
      ]);
    } catch (err) {
      console.error(`[heartbeat] Error: ${err}`);
    } finally {
      clearTimeout(timeoutId);
      isRunning = false;
    }
  });

  const next = cronJob.nextRun();
  console.log(
    `[heartbeat] Started (${config.heartbeat.cronExpr}), next: ${next?.toISOString()}`
  );
}

export function stopHeartbeat(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log("[heartbeat] Stopped");
  }
}

export function getHeartbeatStatus(): {
  enabled: boolean;
  running: boolean;
  nextRun: string | null;
  cronExpr: string;
} {
  const config = loadConfig();
  return {
    enabled: config.heartbeat.enabled,
    running: !!cronJob,
    nextRun: cronJob?.nextRun()?.toISOString() || null,
    cronExpr: config.heartbeat.cronExpr,
  };
}

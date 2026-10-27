import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ReflexItem } from "../scheduler/reflex.ts";

export type SelfImprovementTask = {
  id: string;
  title: string;
  description: string;
  toolName?: string;
  sourceSession?: string;
  createdAt: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  updatedAt?: string;
  notes?: string;
};

export function getSelfImprovementQueuePath(): string {
  const dir = process.env.MINCLAW_HOME || join(homedir(), ".minclaw");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "self-improvement-queue.json");
}

export function getSelfImprovementQueue(): SelfImprovementTask[] {
  const file = getSelfImprovementQueuePath();
  if (!existsSync(file)) {
    return [];
  }
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[self-improvement] Failed to parse queue from ${file}: ${err}`);
    return [];
  }
}

export function saveSelfImprovementQueue(tasks: SelfImprovementTask[]): void {
  const file = getSelfImprovementQueuePath();
  try {
    writeFileSync(file, JSON.stringify(tasks, null, 2), "utf-8");
  } catch (err) {
    console.error(`[self-improvement] Failed to save queue to ${file}: ${err}`);
  }
}

export function enqueueSelfImprovement(params: {
  title: string;
  description: string;
  toolName?: string;
  sourceSession?: string;
}): SelfImprovementTask {
  const tasks = getSelfImprovementQueue();
  const id = `si-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();

  const newTask: SelfImprovementTask = {
    id,
    title: params.title.trim(),
    description: params.description.trim(),
    toolName: params.toolName?.trim() || undefined,
    sourceSession: params.sourceSession || undefined,
    createdAt: now,
    status: "pending",
  };

  tasks.push(newTask);
  saveSelfImprovementQueue(tasks);
  console.log(`[self-improvement] 📥 Enqueued task "${newTask.title}" (ID: ${newTask.id})`);
  return newTask;
}

export function updateSelfImprovementStatus(
  id: string,
  status: SelfImprovementTask["status"],
  notes?: string
): boolean {
  const tasks = getSelfImprovementQueue();
  const target = tasks.find((t) => t.id === id);
  if (!target) {
    return false;
  }

  target.status = status;
  target.updatedAt = new Date().toISOString();
  if (notes) {
    target.notes = notes.trim();
  }

  saveSelfImprovementQueue(tasks);
  console.log(`[self-improvement] 🔄 Updated task ${id} status to ${status}`);
  return true;
}

export function getPendingSelfImprovements(): SelfImprovementTask[] {
  return getSelfImprovementQueue().filter((t) => t.status === "pending");
}

/**
 * Checks for pending self-improvement tasks during the zero-token reflex gate.
 * Returns ReflexItems with score=8 so background heartbeat can trigger autonomous execution.
 */
export function checkSelfImprovementQueue(commits?: Array<() => void>): ReflexItem[] {
  const pending = getPendingSelfImprovements();
  if (pending.length === 0) {
    return [];
  }

  // Pick the oldest pending item to avoid overwhelming the background agent
  const next = pending[0]!;

  const item: ReflexItem = {
    id: `self-improvement-${next.id}`,
    source: "self-improvement",
    title: `Pending Codebase Improvement: "${next.title}"`,
    details: [
      `Task ID: ${next.id}`,
      `Target Tool/Area: ${next.toolName || "general"}`,
      `Description: ${next.description}`,
      `Created At: ${next.createdAt}`,
      `Directive: Implement this self-improvement offline in the codebase (read files, edit, test with \`bun test\`), then call update_self_improvement status='completed' notes='...'`,
    ].join("\n"),
    score: 8,
  };

  if (commits) {
    commits.push(() => {
      // Mark in_progress when heartbeat commits
      updateSelfImprovementStatus(next.id, "in_progress", "Picked up by background heartbeat");
    });
  }

  return [item];
}

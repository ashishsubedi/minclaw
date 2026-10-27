import { resolve } from "node:path";
import { loadConfig } from "../config.ts";

export interface BrainFiles {
  system: string;
  permanentMemory: string;
  heartbeat: string;
  channels: string;
  operationalMemory: string;
}

function brainPath(filename: string, brainDir?: string): string {
  const dir = brainDir ?? loadConfig().brain.dir;
  return resolve(dir, filename);
}

async function readBrainFile(filename: string, brainDir?: string): Promise<string> {
  try {
    const path = brainPath(filename, brainDir);
    const file = Bun.file(path);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch {
    return "";
  }
}

export async function loadSystemPrompt(workspace: string, brainDir?: string): Promise<string> {
  const raw = await readBrainFile("system.md", brainDir);
  return raw.replace(/\{\{workspace\}\}/g, resolve(workspace));
}

export async function loadPersistentMemory(brainDir?: string): Promise<string> {
  // Preferred durable-memory file name. Fallback keeps legacy installs working.
  const permanent = await readBrainFile("permanent-memory.md", brainDir);
  if (permanent) return permanent;
  return readBrainFile("memory.md", brainDir);
}

export async function loadHeartbeatPrompt(brainDir?: string): Promise<string> {
  return readBrainFile("heartbeat.md", brainDir);
}

export async function loadChannels(brainDir?: string): Promise<string> {
  return readBrainFile("channels.md", brainDir);
}

export async function loadOperationalMemory(brainDir?: string): Promise<string> {
  return readBrainFile("operational-memory.md", brainDir);
}

export async function loadBrain(brainDir?: string): Promise<BrainFiles> {
  const [system, permanentMemoryRaw, memoryRaw, heartbeat, channels, operationalMemory] = await Promise.all([
    readBrainFile("system.md", brainDir),
    readBrainFile("permanent-memory.md", brainDir),
    readBrainFile("memory.md", brainDir),
    readBrainFile("heartbeat.md", brainDir),
    readBrainFile("channels.md", brainDir),
    readBrainFile("operational-memory.md", brainDir),
  ]);

  return {
    system,
    permanentMemory: permanentMemoryRaw || memoryRaw,
    heartbeat,
    channels,
    operationalMemory,
  };
}

export function buildBrainSystemPrompt(brain: BrainFiles, workspace?: string): string {
  const parts: string[] = [];
  if (brain.system) {
    parts.push(workspace ? brain.system.replace(/\{\{workspace\}\}/g, resolve(workspace)) : brain.system);
  }
  if (brain.channels) parts.push(brain.channels);
  if (brain.permanentMemory) parts.push(`## Permanent Memory\n\n${brain.permanentMemory}`);
  if (brain.operationalMemory) parts.push(`## Operational Memory & Runbook\n\n${brain.operationalMemory}`);
  return parts.join("\n\n");
}

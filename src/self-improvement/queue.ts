import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ReflexItem } from "../scheduler/reflex.ts";

export type TargetType = "skill" | "script" | "operational_runbook" | "general";

export type SelfImprovementTask = {
  id: string;
  title: string;
  description: string;
  toolName?: string;
  targetType?: TargetType;
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
  targetType?: TargetType;
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
    targetType: params.targetType || undefined,
    sourceSession: params.sourceSession || undefined,
    createdAt: now,
    status: "pending",
  };

  tasks.push(newTask);
  saveSelfImprovementQueue(tasks);
  console.log(`[self-improvement] 📥 Enqueued task "${newTask.title}" (ID: ${newTask.id}) [target: ${newTask.targetType || "general"}]`);
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
  const targetType = next.targetType || "general";

  const item: ReflexItem = {
    id: `self-improvement-${next.id}`,
    source: "self-improvement",
    title: `Pending Codebase Improvement: "${next.title}"`,
    details: [
      `Task ID: ${next.id}`,
      `Target Type: ${targetType}`,
      `Target Tool/Area: ${next.toolName || "general"}`,
      `Description: ${next.description}`,
      `Created At: ${next.createdAt}`,
      `Directive: Implement this self-improvement offline using scaffolding-first principles (target skills/, scripts/, or brain/operational-memory.md; do NOT modify src/ or run test suites on core daemon files), then call update_self_improvement status='completed' notes='...'`,
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

/**
 * Generates an OpenClaw-compatible SKILL.md template with YAML frontmatter.
 */
export function generateSkillTemplate(params: {
  name: string;
  description: string;
  binaries?: string[];
  envVars?: string[];
  instructions?: string;
}): string {
  const cleanName = params.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const cleanDescription = params.description.trim();
  const bins = params.binaries && params.binaries.length > 0 ? params.binaries : [];
  const env = params.envVars && params.envVars.length > 0 ? params.envVars : [];

  const requiresObj: Record<string, string[]> = {};
  if (bins.length > 0) requiresObj.bins = bins;
  if (env.length > 0) requiresObj.env = env;

  const openclawObj: Record<string, any> = {};
  if (Object.keys(requiresObj).length > 0) {
    openclawObj.requires = requiresObj;
  }

  const metadataJson = JSON.stringify(
    {
      openclaw: openclawObj,
    },
    null,
    2
  )
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  const title = cleanName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  const instructionsBody = params.instructions?.trim()
    ? params.instructions.trim()
    : [
        `## Overview`,
        `${cleanDescription}`,
        ``,
        `## When to Use`,
        `Trigger phrases and situations when this skill should be activated.`,
        ``,
        `## Procedural Instructions & Workflows`,
        `Step-by-step procedural workflows for the agent.`,
        ``,
        `## Bundled Resources`,
        `- Scripts: Executable deterministic code in \`scripts/\` (if needed)`,
        `- References: Context documentation in \`references/\` (if needed)`,
      ].join("\n");

  return [
    "---",
    `name: ${cleanName}`,
    `description: ${cleanDescription}`,
    "metadata:",
    metadataJson,
    "---",
    "",
    `# ${title}`,
    "",
    instructionsBody,
    "",
  ].join("\n");
}

/**
 * Generates a standalone script template with shebang and error handling.
 */
export function generateScriptTemplate(params: {
  name: string;
  description: string;
  language?: "python" | "typescript" | "bash";
}): string {
  const lang = params.language || "python";
  const name = params.name.trim();
  const description = params.description.trim();

  switch (lang) {
    case "python":
      return `#!/usr/bin/env python3
"""
${name} - ${description}

Deterministic helper script for MinClaw execution scaffolding.
"""

import sys
import os
import json
import argparse


def main():
    parser = argparse.ArgumentParser(description="${description.replace(/"/g, '\\"')}")
    # Add script arguments here
    args = parser.parse_args()

    try:
        # Implementation logic here
        pass
    except Exception as e:
        print(f"Error executing ${name}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
`;

    case "typescript":
      return `#!/usr/bin/env bun
/**
 * ${name} - ${description}
 *
 * Deterministic helper script for MinClaw execution scaffolding.
 */

import { parseArgs } from "util";

async function main() {
  try {
    // Implementation logic here
  } catch (error) {
    console.error(\`Error executing ${name}:\`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
`;

    case "bash":
      return `#!/usr/bin/env bash
#
# ${name} - ${description}
#
# Deterministic helper script for MinClaw execution scaffolding.
#

set -euo pipefail

# Implementation logic here
`;
  }
}

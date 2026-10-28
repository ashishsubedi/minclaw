import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import {
  getSelfImprovementQueuePath,
  getSelfImprovementQueue,
  enqueueSelfImprovement,
  updateSelfImprovementStatus,
  getPendingSelfImprovements,
  checkSelfImprovementQueue,
} from "../src/self-improvement/queue.ts";
import { executeTool } from "../src/tools.ts";
import { WATERMARK_CEILING_TOKENS } from "../src/memory/compaction.ts";
import { AGY_STATIC_DELEGATION_HEADER } from "../src/agent.ts";

describe("Decoupled Self-Improvement Queue & Execution Guardrails", () => {
  const queuePath = getSelfImprovementQueuePath();

  beforeEach(() => {
    if (existsSync(queuePath)) {
      unlinkSync(queuePath);
    }
  });

  afterEach(() => {
    if (existsSync(queuePath)) {
      unlinkSync(queuePath);
    }
  });

  it("1. enqueues, reads, and updates self-improvement tasks in ~/.minclaw", () => {
    const queueBefore = getSelfImprovementQueue();
    expect(queueBefore).toEqual([]);

    const task1 = enqueueSelfImprovement({
      title: "Add natural date parser for calendar",
      description: "Allow relative strings like 'tomorrow at 11am' in calendar tool",
      toolName: "calendar",
      sourceSession: "terminal:voice_macbook",
    });

    expect(task1.id).toMatch(/^si-\d+-[a-z0-9]+$/);
    expect(task1.title).toBe("Add natural date parser for calendar");
    expect(task1.status).toBe("pending");
    expect(task1.toolName).toBe("calendar");
    expect(task1.sourceSession).toBe("terminal:voice_macbook");

    const pending = getPendingSelfImprovements();
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe(task1.id);

    // Update status to in_progress and completed
    const updated = updateSelfImprovementStatus(task1.id, "completed", "Implemented in src/email/calendar.ts");
    expect(updated).toBe(true);

    const pendingAfter = getPendingSelfImprovements();
    expect(pendingAfter.length).toBe(0);

    const all = getSelfImprovementQueue();
    expect(all.length).toBe(1);
    expect(all[0]?.status).toBe("completed");
    expect(all[0]?.notes).toBe("Implemented in src/email/calendar.ts");
  });

  it("2. executes queue_self_improvement tool via executeTool", async () => {
    const res = await executeTool("queue_self_improvement", {
      title: "Support batch email archiving",
      description: "Add action='archive_batch' to email tool",
      toolName: "email",
    });

    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain("Self-improvement task queued successfully");
    expect(res.content[0]?.text).toContain("Support batch email archiving");

    const pending = getPendingSelfImprovements();
    expect(pending.length).toBe(1);
    expect(pending[0]?.title).toBe("Support batch email archiving");

    // Test error validation
    const errRes = await executeTool("queue_self_improvement", { title: "", description: "" });
    expect(errRes.isError).toBe(true);
    expect(errRes.content[0]?.text).toContain("Error: 'title' is required");
  });

  it("3. executes update_self_improvement tool via executeTool", async () => {
    const task = enqueueSelfImprovement({
      title: "Test item",
      description: "Test description",
    });

    const res = await executeTool("update_self_improvement", {
      id: task.id,
      status: "completed",
      notes: "Unit tests passing",
    });

    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain(`task '${task.id}' updated to status 'completed'`);

    // Invalid status test
    const errRes = await executeTool("update_self_improvement", {
      id: task.id,
      status: "invalid_status",
    });
    expect(errRes.isError).toBe(true);
  });

  it("4. reflex check detects pending self-improvement items for background heartbeat execution", () => {
    // Empty queue -> no reflex items
    expect(checkSelfImprovementQueue()).toEqual([]);

    const task = enqueueSelfImprovement({
      title: "Add offline summarization",
      description: "Generate offline rolling summaries",
      toolName: "memory",
    });

    const commits: Array<() => void> = [];
    const reflexItems = checkSelfImprovementQueue(commits);

    expect(reflexItems.length).toBe(1);
    expect(reflexItems[0]?.source).toBe("self-improvement");
    expect(reflexItems[0]?.title).toContain("Add offline summarization");
    expect(reflexItems[0]?.details).toContain(task.id);
    expect(commits.length).toBe(1);

    // Running commits transitions the task to in_progress
    commits[0]!();
    const all = getSelfImprovementQueue();
    expect(all[0]?.status).toBe("in_progress");
  });

  it("5. confirms 75k token watermark and autonomous step budget directives", () => {
    expect(WATERMARK_CEILING_TOKENS).toBe(75000);
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("Strict Autonomous Step Budget");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("Live Turn Decoupled Self-Improvement");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("queue_self_improvement");
  });
});

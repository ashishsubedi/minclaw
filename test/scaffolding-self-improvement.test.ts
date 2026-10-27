import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import {
  getSelfImprovementQueuePath,
  getSelfImprovementQueue,
  enqueueSelfImprovement,
  checkSelfImprovementQueue,
  generateSkillTemplate,
  generateScriptTemplate,
  type TargetType,
} from "../src/self-improvement/queue.ts";
import { parseSkillFrontmatter } from "../src/skills/frontmatter.ts";
import { executeTool } from "../src/tools.ts";
import { AGY_STATIC_DELEGATION_HEADER } from "../src/agent.ts";

describe("Scaffolding-First Self-Improvement Harness (Harness² Phase 2)", () => {
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

  it("1. enqueues self-improvement tasks with targetType ('skill', 'script', 'operational_runbook', 'general')", () => {
    const targetTypes: TargetType[] = ["skill", "script", "operational_runbook", "general"];

    for (const targetType of targetTypes) {
      const task = enqueueSelfImprovement({
        title: `Task for ${targetType}`,
        description: `Description for ${targetType}`,
        targetType,
      });

      expect(task.targetType).toBe(targetType);
      expect(task.status).toBe("pending");
    }

    const queue = getSelfImprovementQueue();
    expect(queue.length).toBe(4);
    expect(queue[0]?.targetType).toBe("skill");
    expect(queue[1]?.targetType).toBe("script");
    expect(queue[2]?.targetType).toBe("operational_runbook");
    expect(queue[3]?.targetType).toBe("general");

    // Task without targetType defaults to undefined internally (or general in reflex)
    const taskDefault = enqueueSelfImprovement({
      title: "Task with default target",
      description: "No targetType provided",
    });
    expect(taskDefault.targetType).toBeUndefined();
  });

  it("2. generateSkillTemplate produces valid markdown that can be parsed by parseSkillFrontmatter without errors", () => {
    const template = generateSkillTemplate({
      name: "pdf-invoice-parser",
      description: "Extract line items and totals from PDF invoices using pdfplumber",
      binaries: ["python3", "pdfimages"],
      envVars: ["INVOICE_STORAGE_KEY"],
      instructions: "## Extraction Steps\n1. Run pdfimages to extract charts\n2. Run python script to extract tables",
    });

    expect(template.startsWith("---\n")).toBe(true);
    expect(template).toContain("name: pdf-invoice-parser");
    expect(template).toContain("description: Extract line items and totals from PDF invoices using pdfplumber");

    const parsed = parseSkillFrontmatter(template, "skills/pdf-invoice-parser/SKILL.md");
    expect(parsed.name).toBe("pdf-invoice-parser");
    expect(parsed.description).toBe("Extract line items and totals from PDF invoices using pdfplumber");
    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata?.requires?.bins).toEqual(["python3", "pdfimages"]);
    expect(parsed.metadata?.requires?.env).toEqual(["INVOICE_STORAGE_KEY"]);
    expect(parsed.body).toContain("# Pdf Invoice Parser");
    expect(parsed.body).toContain("## Extraction Steps");

    // Test with minimal parameters (no bins, no env, default instructions)
    const minimalTemplate = generateSkillTemplate({
      name: "minimal-utility",
      description: "A minimal skill without dependencies",
    });
    const minimalParsed = parseSkillFrontmatter(minimalTemplate, "skills/minimal-utility/SKILL.md");
    expect(minimalParsed.name).toBe("minimal-utility");
    expect(minimalParsed.description).toBe("A minimal skill without dependencies");
    expect(minimalParsed.body).toContain("# Minimal Utility");
    expect(minimalParsed.body).toContain("## Procedural Instructions & Workflows");
    expect(minimalParsed.body).toContain("## Bundled Resources");
  });

  it("3. generateScriptTemplate generates standalone scripts for python, typescript, and bash", () => {
    // Python script
    const pyScript = generateScriptTemplate({
      name: "extract_tables",
      description: "Extract tabular data from CSV or Excel",
      language: "python",
    });
    expect(pyScript.startsWith("#!/usr/bin/env python3")).toBe(true);
    expect(pyScript).toContain("extract_tables - Extract tabular data from CSV or Excel");
    expect(pyScript).toContain("import argparse");
    expect(pyScript).toContain("try:");
    expect(pyScript).toContain("except Exception as e:");
    expect(pyScript).toContain('if __name__ == "__main__":');

    // TypeScript / Bun script
    const tsScript = generateScriptTemplate({
      name: "sync_notion",
      description: "Sync database records to Notion",
      language: "typescript",
    });
    expect(tsScript.startsWith("#!/usr/bin/env bun")).toBe(true);
    expect(tsScript).toContain("sync_notion - Sync database records to Notion");
    expect(tsScript).toContain("async function main()");
    expect(tsScript).toContain("try {");
    expect(tsScript).toContain("catch (error)");
    expect(tsScript).toContain("main();");

    // Bash script
    const bashScript = generateScriptTemplate({
      name: "backup_db",
      description: "Create snapshot and compress into tarball",
      language: "bash",
    });
    expect(bashScript.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(bashScript).toContain("backup_db - Create snapshot and compress into tarball");
    expect(bashScript).toContain("set -euo pipefail");

    // Default language fallback (python)
    const defaultScript = generateScriptTemplate({
      name: "default_tool",
      description: "Test default fallback",
    });
    expect(defaultScript.startsWith("#!/usr/bin/env python3")).toBe(true);
  });

  it("4. checkSelfImprovementQueue formats reflex items including targetType", () => {
    const taskSkill = enqueueSelfImprovement({
      title: "Add Weather Radar Skill",
      description: "Create radar map viewing skill",
      toolName: "weather",
      targetType: "skill",
    });

    const reflexItems = checkSelfImprovementQueue();
    expect(reflexItems.length).toBe(1);
    expect(reflexItems[0]?.details).toContain(`Task ID: ${taskSkill.id}`);
    expect(reflexItems[0]?.details).toContain("Target Type: skill");
    expect(reflexItems[0]?.details).toContain("Target Tool/Area: weather");
    expect(reflexItems[0]?.details).toContain("scaffolding-first principles");

    // Clear and test default fallback to 'general'
    unlinkSync(queuePath);
    const taskGeneral = enqueueSelfImprovement({
      title: "Improve response formatting",
      description: "Better bullet points",
    });

    const reflexItems2 = checkSelfImprovementQueue();
    expect(reflexItems2.length).toBe(1);
    expect(reflexItems2[0]?.details).toContain(`Task ID: ${taskGeneral.id}`);
    expect(reflexItems2[0]?.details).toContain("Target Type: general");
  });

  it("5. queue_self_improvement tool passes targetType through to the queue", async () => {
    const res = await executeTool("queue_self_improvement", {
      title: "Scrape HN frontpage",
      description: "Create standalone script to fetch Top 30 HN items",
      toolName: "scripts",
      targetType: "script",
    });

    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain("Self-improvement task queued successfully");
    expect(res.content[0]?.text).toContain("Target Type: script");

    const queue = getSelfImprovementQueue();
    expect(queue.length).toBe(1);
    expect(queue[0]?.title).toBe("Scrape HN frontpage");
    expect(queue[0]?.targetType).toBe("script");
    expect(queue[0]?.toolName).toBe("scripts");

    // Test with targetType = 'operational_runbook'
    const res2 = await executeTool("queue_self_improvement", {
      title: "Document ffmpeg quirks",
      description: "Record AAC audio stream mapping constraints",
      targetType: "operational_runbook",
    });
    expect(res2.isError).toBe(false);
    expect(res2.content[0]?.text).toContain("Target Type: operational_runbook");

    const queueAfter = getSelfImprovementQueue();
    expect(queueAfter.length).toBe(2);
    expect(queueAfter[1]?.targetType).toBe("operational_runbook");
  });

  it("6. verifies brain/system.md documents scaffolding-first invariants and targets", () => {
    const systemMd = readFileSync(join(process.cwd(), "brain/system.md"), "utf-8");
    expect(systemMd).toContain("Scaffolding-First Self-Improvement (Harness² Paradigm)");
    expect(systemMd).toContain("Under NO circumstances should offline self-improvement modify `src/` TypeScript source code or run `bun test` on core files");
    expect(systemMd).toContain("OpenClaw-compatible Skills");
    expect(systemMd).toContain("skills/<name>/SKILL.md");
    expect(systemMd).toContain("skills/skill-creator/SKILL.md");
    expect(systemMd).toContain("Standalone Helper Scripts");
    expect(systemMd).toContain("scripts/<name>.(py|ts|sh)");
    expect(systemMd).toContain("Operational Heuristics");
    expect(systemMd).toContain("brain/operational-memory.md");
  });

  it("7. verifies AGY_STATIC_DELEGATION_HEADER Directive 4 enforces scaffolding targets and targetType", () => {
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("Live Turn Decoupled Self-Improvement");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("Following Google Research's Harness² framework");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("skills/<name>/SKILL.md");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("skills/skill-creator/SKILL.md");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("scripts/<name>.(py|ts|sh)");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain("brain/operational-memory.md");
    expect(AGY_STATIC_DELEGATION_HEADER).toContain('"skill", "script", "operational_runbook", or "general"');
    expect(AGY_STATIC_DELEGATION_HEADER).toContain('targetType="skill|script|operational_runbook|general"');
  });

  it("8. verifies scripts/README.md documents purpose and conventions", () => {
    const readme = readFileSync(join(process.cwd(), "scripts/README.md"), "utf-8");
    expect(readme).toContain("MinClaw Deterministic Helper Scripts");
    expect(readme).toContain("Harness²");
    expect(readme).toContain("Portable Shebangs");
    expect(readme).toContain("Executable Permissions");
    expect(readme).toContain("Clean Output Stream Separation");
    expect(readme).toContain("set -euo pipefail");
  });

  it("9. preserves existing skill-creator skill without duplication", () => {
    const skillCreatorPath = join(process.cwd(), "skills/skill-creator/SKILL.md");
    expect(existsSync(skillCreatorPath)).toBe(true);
    const content = readFileSync(skillCreatorPath, "utf-8");
    expect(content).toContain("name: skill-creator");
    expect(content).toContain("Create, edit, improve, tidy, review, audit, or restructure AgentSkills");
  });
});
